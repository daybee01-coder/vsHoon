/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { findMainClasses, findMavenProjects, serverGoalFor } from './discovery';
import { DEFAULT_SERVER_GOALS, formatEnvironment, normalizeConfiguration, parseEnvironment, SpringRunConfiguration } from './model';
import { log } from './output';

export const CONFIGURATION_FORM_VIEW_TYPE = 'vshoonSpring.configurationForm';

/** A Maven project the form offers, with the main classes found in it. */
interface ProjectChoice {
	readonly project: string;
	readonly label: string;
	readonly projectName?: string;
	readonly springBoot: boolean;
	readonly serverGoal?: string;
	readonly mainClasses: readonly string[];
}

/** What the form edits. `env` travels as `KEY=VALUE` lines, the way the text area shows it. */
interface FormValues {
	readonly name: string;
	readonly kind: string;
	readonly project: string;
	readonly mainClass: string;
	readonly goal: string;
	readonly profiles: string;
	readonly port: string;
	readonly vmArgs: string;
	readonly args: string;
	readonly env: string;
	readonly javaHome: string;
}

let current: ConfigurationForm | undefined;

/**
 * Opens the run configuration form, which VShoon shows as a modal, and resolves with the saved
 * configuration, or `undefined` when the user cancels. Only one form is open at a time.
 */
export function editConfiguration(extensionUri: vscode.Uri, folder: vscode.WorkspaceFolder, configuration: SpringRunConfiguration): Promise<SpringRunConfiguration | undefined> {
	current?.close();
	const form = new ConfigurationForm(extensionUri, folder, configuration);
	current = form;
	return form.result;
}

class ConfigurationForm {

	readonly result: Promise<SpringRunConfiguration | undefined>;
	private settle!: (value: SpringRunConfiguration | undefined) => void;
	private settled = false;
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly folder: vscode.WorkspaceFolder,
		private readonly configuration: SpringRunConfiguration
	) {
		this.result = new Promise(resolve => this.settle = resolve);
		this.panel = vscode.window.createWebviewPanel(
			CONFIGURATION_FORM_VIEW_TYPE,
			vscode.l10n.t('실행 구성 — {0}', configuration.name),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
			}
		);
		this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'spring.svg');
		this.panel.webview.html = this.html(this.panel.webview);
		this.disposables.push(
			this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message)),
			this.panel.onDidDispose(() => {
				vscode.Disposable.from(...this.disposables).dispose();
				if (current === this) {
					current = undefined;
				}
				this.finish(undefined);
			})
		);
	}

	close(): void {
		this.panel.dispose();
	}

	private finish(value: SpringRunConfiguration | undefined): void {
		if (!this.settled) {
			this.settled = true;
			this.settle(value);
		}
	}

	private async handleMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}
		const { type } = message as { type?: unknown };
		switch (type) {
			case 'ready':
				await this.initialize();
				return;
			case 'save':
				this.save((message as { values?: unknown }).values);
				return;
			case 'browseJavaHome':
				await this.browseJavaHome();
				return;
			case 'cancel':
				this.panel.dispose();
				return;
		}
	}

	private async initialize(): Promise<void> {
		const { configuration } = this;
		const values: FormValues = {
			name: configuration.name,
			kind: configuration.kind,
			project: configuration.project,
			mainClass: configuration.mainClass ?? '',
			goal: configuration.goal ?? '',
			profiles: configuration.profiles,
			port: configuration.port ? String(configuration.port) : '',
			vmArgs: configuration.vmArgs,
			args: configuration.args,
			env: formatEnvironment(configuration.env),
			javaHome: configuration.javaHome ?? ''
		};
		void this.panel.webview.postMessage({ type: 'init', values: { ...values, projectName: configuration.projectName ?? '' } });
		// Discovery reads sources; let the form show first and fill the suggestions in when they are ready.
		try {
			const projects: ProjectChoice[] = [];
			for (const project of await findMavenProjects(this.folder)) {
				const serverGoal = project.pom.springBoot ? undefined : serverGoalFor(project);
				projects.push({
					project: project.project,
					label: project.project || this.folder.name,
					...(project.pom.artifactId ? { projectName: project.pom.artifactId } : {}),
					springBoot: project.pom.springBoot,
					...(serverGoal ? { serverGoal } : {}),
					mainClasses: project.pom.springBoot ? await findMainClasses(project) : []
				});
			}
			void this.panel.webview.postMessage({ type: 'projects', projects });
		} catch (error) {
			log(`실행 구성 폼의 프로젝트 목록을 만들지 못했습니다: ${error}`);
		}
	}

	private save(raw: unknown): void {
		const values = readValues(raw);
		if (!values) {
			return;
		}
		const port = values.port.trim() ? Number(values.port.trim()) : undefined;
		if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
			this.status(vscode.l10n.t('포트는 1에서 65535 사이의 숫자여야 합니다.'));
			return;
		}
		const configuration = normalizeConfiguration({
			id: this.configuration.id,
			name: values.name,
			kind: values.kind,
			project: values.project,
			projectName: values.projectName,
			mainClass: values.mainClass,
			goal: values.goal,
			profiles: values.profiles,
			port,
			vmArgs: values.vmArgs,
			args: values.args,
			env: parseEnvironment(values.env),
			javaHome: values.javaHome
		});
		if (!configuration) {
			this.status(values.kind === 'boot'
				? vscode.l10n.t('이름과 메인 클래스를 입력하세요.')
				: vscode.l10n.t('이름과 Maven 골을 입력하세요.'));
			return;
		}
		this.finish(configuration);
		this.panel.dispose();
	}

	private async browseJavaHome(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: vscode.l10n.t('JDK 홈 폴더 선택')
		});
		if (picked?.[0]) {
			void this.panel.webview.postMessage({ type: 'javaHome', path: picked[0].fsPath });
		}
	}

	private status(message: string): void {
		void this.panel.webview.postMessage({ type: 'status', message });
	}

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`
		].join('; ');
		const t = (message: string) => escapeHtml(vscode.l10n.t(message));
		return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('form.css')}">
</head>
<body>
<form id="form" autocomplete="off" novalidate>
	<div id="content">
		<section class="group">
			<h2>${t('일반')}</h2>
			<div class="row"><label for="name">${t('이름')}</label><div class="field"><input type="text" id="name" required></div></div>
			<div class="row">
				<span class="label" id="kind-label">${t('종류')}</span>
				<div class="field radios" role="radiogroup" aria-labelledby="kind-label">
					<label class="radio"><input type="radio" name="kind" value="boot">${t('Spring Boot (메인 클래스)')}</label>
					<label class="radio"><input type="radio" name="kind" value="maven">${t('Spring (Maven 플러그인)')}</label>
				</div>
			</div>
			<div class="row">
				<label for="project">${t('프로젝트')}</label>
				<div class="field"><input type="text" id="project" list="project-list" placeholder="${t('워크스페이스 폴더 기준 경로. 비우면 루트')}"><datalist id="project-list"></datalist></div>
			</div>
			<div class="row" id="row-main">
				<label for="mainClass">${t('메인 클래스')}</label>
				<div class="field"><input type="text" id="mainClass" list="main-list" placeholder="com.example.DemoApplication"><datalist id="main-list"></datalist></div>
			</div>
			<div class="row" id="row-goal">
				<label for="goal">${t('Maven 골')}</label>
				<div class="field">
					<input type="text" id="goal" list="goal-list" placeholder="jetty:run">
					<datalist id="goal-list"><option value="${escapeHtml(DEFAULT_SERVER_GOALS.javax)}" label="Jetty 9.4 (javax, Spring 5)"><option value="${escapeHtml(DEFAULT_SERVER_GOALS.jakarta)}" label="Jetty 12 (jakarta, Spring 6)"><option value="jetty:run"><option value="tomcat7:run"><option value="tomcat:run"><option value="cargo:run"></datalist>
					<p class="hint">${t('서버는 Maven JVM 안에서 실행됩니다. pom.xml에 서버 플러그인이 없으면 Jetty 전체 좌표 골로 그대로 실행합니다. 디버그하면 디버거를 자동으로 연결합니다.')}</p>
				</div>
			</div>
		</section>
		<section class="group">
			<h2>${t('실행 옵션')}</h2>
			<div class="row"><label for="profiles">${t('프로파일')}</label><div class="field"><input type="text" id="profiles" placeholder="local,dev"></div></div>
			<div class="row">
				<label for="port">${t('포트')}</label>
				<div class="field">
					<input type="text" id="port" class="port" inputmode="numeric" placeholder="8080">
					<p class="hint" id="port-hint"></p>
				</div>
			</div>
			<div class="row"><label for="vmArgs">${t('VM 옵션')}</label><div class="field"><input type="text" id="vmArgs" placeholder="-Xmx1g -Dfile.encoding=UTF-8"></div></div>
			<div class="row"><label for="args" id="args-label">${t('프로그램 인자')}</label><div class="field"><input type="text" id="args"></div></div>
			<div class="row">
				<label for="env">${t('환경 변수')}</label>
				<div class="field"><textarea id="env" rows="4" placeholder="KEY=VALUE"></textarea><p class="hint">${t('한 줄에 하나씩 KEY=VALUE')}</p></div>
			</div>
			<div class="row">
				<label for="javaHome">JDK</label>
				<div class="field split"><input type="text" id="javaHome" placeholder="${t('비우면 기본 JDK')}"><button type="button" id="browse" class="secondary">${t('찾아보기…')}</button></div>
			</div>
		</section>
	</div>
	<div id="foot">
		<p id="status" role="status" aria-live="polite"></p>
		<div class="actions">
			<button type="button" id="cancel" class="secondary">${t('취소')}</button>
			<button type="submit" id="save">${t('저장')}</button>
		</div>
	</div>
</form>
<script nonce="${nonce}">window.SPRING_FORM_TEXT = ${JSON.stringify({
			bootArgs: vscode.l10n.t('프로그램 인자'),
			mavenArgs: vscode.l10n.t('Maven 인자'),
			bootPort: vscode.l10n.t('--server.port 로 전달합니다.'),
			mavenPort: vscode.l10n.t('플러그인 포트 속성으로 전달합니다. pom.xml에 포트를 직접 적었다면 그 값이 우선합니다.')
		}).replace(/</g, '\\u003c')};</script>
<script nonce="${nonce}" src="${media('form.js')}"></script>
</body>
</html>`;
	}
}

function readValues(raw: unknown): (FormValues & { projectName?: string }) | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const field = (name: string) => typeof value[name] === 'string' ? value[name] as string : '';
	return {
		name: field('name'),
		kind: field('kind'),
		project: field('project'),
		projectName: field('projectName'),
		mainClass: field('mainClass'),
		goal: field('goal'),
		profiles: field('profiles'),
		port: field('port'),
		vmArgs: field('vmArgs'),
		args: field('args'),
		env: field('env'),
		javaHome: field('javaHome')
	};
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}
