/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import * as vscode from 'vscode';
import { projectDirectory } from './discovery';
import { CONFIGURATION_ID_PROPERTY, createBootLaunchConfiguration, createMavenAttachConfiguration, createMavenInvocation } from './launch';
import { log } from './output';
import { StoredConfiguration } from './store';

export type RunMode = 'run' | 'debug';

export const JAVA_DEBUG_EXTENSION_ID = 'vscjava.vscode-java-debug';
export const TASK_TYPE = 'vshoon-spring';

/** How long a stop waits for the process to go away before a restart starts the next one. */
const STOP_TIMEOUT_MS = 15_000;

interface ActiveRun {
	readonly id: string;
	readonly mode: RunMode;
	session?: vscode.DebugSession;
	execution?: vscode.TaskExecution;
	stopping: boolean;
	readonly ended: Promise<void>;
	readonly end: () => void;
}

/**
 * Starts, stops and restarts run configurations, and tracks which of them are running.
 *
 * Spring Boot runs as a `java` launch session, so stopping it means stopping the session. A Maven-hosted
 * server is a task, optionally with an attached debug session; the task is the process, so stopping either
 * one stops both, which is what IntelliJ and Eclipse do for a debugged server.
 */
export class SpringRunner implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly active = new Map<string, ActiveRun>();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor() {
		this.disposables.push(
			this.changeEmitter,
			vscode.debug.onDidStartDebugSession(session => this.onSessionStarted(session)),
			vscode.debug.onDidTerminateDebugSession(session => this.onSessionTerminated(session)),
			vscode.tasks.onDidEndTask(event => this.onTaskEnded(event.execution))
		);
	}

	mode(id: string): RunMode | undefined {
		return this.active.get(id)?.mode;
	}

	async start(entry: StoredConfiguration, mode: RunMode): Promise<void> {
		const { configuration } = entry;
		if (this.active.has(configuration.id)) {
			await this.stop(configuration.id);
		}
		if ((configuration.kind === 'boot' || mode === 'debug') && !await ensureJavaDebugger()) {
			return;
		}
		const run = this.track(configuration.id, mode);
		try {
			const started = configuration.kind === 'boot' ? await this.startBoot(entry, mode) : await this.startMaven(entry, run, mode);
			if (!started) {
				this.finish(configuration.id);
			}
		} catch (error) {
			this.finish(configuration.id);
			log(`${configuration.name} 실행 실패: ${error}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('{0} 실행에 실패했습니다: {1}', configuration.name, String(error)));
		}
	}

	async stop(id: string): Promise<void> {
		const run = this.active.get(id);
		if (!run) {
			return;
		}
		run.stopping = true;
		if (run.session) {
			await vscode.debug.stopDebugging(run.session);
		}
		run.execution?.terminate();
		await Promise.race([run.ended, new Promise<void>(resolve => setTimeout(resolve, STOP_TIMEOUT_MS))]);
		this.finish(id);
	}

	async restart(entry: StoredConfiguration, mode?: RunMode): Promise<void> {
		const next = mode ?? this.mode(entry.configuration.id) ?? 'run';
		await this.stop(entry.configuration.id);
		await this.start(entry, next);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async startBoot(entry: StoredConfiguration, mode: RunMode): Promise<boolean> {
		const console = vscode.workspace.getConfiguration('vshoon.spring', entry.folder).get<string>('console', 'internalConsole');
		const launch = createBootLaunchConfiguration(entry.configuration, projectDirectory(entry.folder, entry.configuration).fsPath, console, process.platform);
		log(`${entry.configuration.name}: ${mode === 'debug' ? '디버그' : '실행'} — ${launch.mainClass}`);
		return vscode.debug.startDebugging(entry.folder, { ...launch }, { noDebug: mode === 'run' });
	}

	private async startMaven(entry: StoredConfiguration, run: ActiveRun, mode: RunMode): Promise<boolean> {
		const { folder, configuration } = entry;
		const directory = projectDirectory(folder, configuration);
		const debugPort = mode === 'debug' ? await freePort() : undefined;
		const invocation = createMavenInvocation(configuration, process.env.MAVEN_OPTS, debugPort);
		const executable = await mavenExecutable(folder, directory);
		log(`${configuration.name}: ${executable} ${invocation.args.join(' ')} (MAVEN_OPTS=${invocation.env.MAVEN_OPTS})`);

		const options: vscode.ShellExecutionOptions = {
			cwd: directory.fsPath,
			env: { ...invocation.env },
			// Run under cmd.exe on Windows so `-D` options and `mvn.cmd` behave the same whatever the user's default shell is.
			...(process.platform === 'win32' ? { executable: 'cmd.exe', shellArgs: ['/d', '/c'] } : {})
		};
		const task = new vscode.Task(
			{ type: TASK_TYPE, configurationId: configuration.id },
			folder,
			configuration.name,
			'Spring',
			new vscode.ShellExecution(executable, [...invocation.args], options)
		);
		task.isBackground = true;
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
		run.execution = await vscode.tasks.executeTask(task);
		if (debugPort) {
			// The debugger keeps retrying until the JDWP agent of the freshly started Maven JVM listens.
			const attached = await vscode.debug.startDebugging(folder, { ...createMavenAttachConfiguration(configuration, debugPort) });
			if (!attached) {
				log(`${configuration.name}: 디버거를 연결하지 못했습니다. 서버는 계속 실행됩니다.`);
			}
		}
		return true;
	}

	private track(id: string, mode: RunMode): ActiveRun {
		let end!: () => void;
		const ended = new Promise<void>(resolve => end = resolve);
		const run: ActiveRun = { id, mode, stopping: false, ended, end };
		this.active.set(id, run);
		this.changeEmitter.fire();
		return run;
	}

	private finish(id: string): void {
		const run = this.active.get(id);
		if (!run) {
			return;
		}
		this.active.delete(id);
		run.end();
		this.changeEmitter.fire();
	}

	private onSessionStarted(session: vscode.DebugSession): void {
		const run = this.runOf(session);
		if (run && !run.session) {
			run.session = session;
		}
	}

	private onSessionTerminated(session: vscode.DebugSession): void {
		const run = this.runOf(session);
		if (!run || run.session !== session) {
			return;
		}
		run.session = undefined;
		if (!run.execution) {
			this.finish(run.id);
		} else if (!run.stopping) {
			// Stopping a debugged server from the debug toolbar stops the server, not only the debugger.
			run.stopping = true;
			run.execution.terminate();
		}
	}

	private onTaskEnded(execution: vscode.TaskExecution): void {
		if (execution.task.definition.type !== TASK_TYPE) {
			return;
		}
		const run = this.active.get(execution.task.definition.configurationId);
		if (!run || !run.execution) {
			return;
		}
		if (run.session) {
			void vscode.debug.stopDebugging(run.session);
		}
		this.finish(run.id);
	}

	private runOf(session: vscode.DebugSession): ActiveRun | undefined {
		const id = session.configuration[CONFIGURATION_ID_PROPERTY];
		return typeof id === 'string' ? this.active.get(id) : undefined;
	}
}

/** Checks that the Java debugger is installed, and offers to install it when it is not. */
async function ensureJavaDebugger(): Promise<boolean> {
	if (vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID)) {
		return true;
	}
	const install = vscode.l10n.t('설치');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('Spring 앱을 디버그하려면 Java 디버거 확장({0})이 필요합니다.', JAVA_DEBUG_EXTENSION_ID),
		install
	);
	if (choice === install) {
		await vscode.commands.executeCommand('workbench.extensions.installExtension', JAVA_DEBUG_EXTENSION_ID);
	}
	return false;
}

/**
 * The Maven launcher for a project: the `vshoon.spring.maven.executable` setting, else the nearest Maven
 * wrapper between the project and its workspace folder, else `mvn` from `PATH`.
 */
async function mavenExecutable(folder: vscode.WorkspaceFolder, directory: vscode.Uri): Promise<string> {
	const configured = vscode.workspace.getConfiguration('vshoon.spring', folder).get<string>('maven.executable', '').trim();
	if (configured) {
		return configured;
	}
	const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
	for (let current = directory; current.path.startsWith(folder.uri.path); current = vscode.Uri.joinPath(current, '..')) {
		const candidate = vscode.Uri.joinPath(current, wrapper);
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate.fsPath;
		} catch {
			// Not here; try the parent.
		}
		if (current.path === folder.uri.path) {
			break;
		}
	}
	return 'mvn';
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')));
		});
	});
}
