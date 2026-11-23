/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { editConfiguration } from './configForm';
import { discoverConfigurations } from './discovery';
import { classNameFromSourcePath, SpringRunConfiguration } from './model';
import { log, output } from './output';
import { RunMode, SpringRunner } from './runner';
import { ConfigurationStore, StoredConfiguration } from './store';
import { ConfigurationTreeProvider, MainClassCodeLensProvider, RunStatusBar } from './views';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const store = new ConfigurationStore();
	const runner = new SpringRunner();
	const tree = new ConfigurationTreeProvider(store, runner);
	const statusBar = new RunStatusBar(context.workspaceState, store, runner);
	const refresh = () => {
		tree.refresh();
		statusBar.update();
	};

	/** Resolves a command argument: a tree or status bar entry, or the selected configuration from the palette. */
	const resolve = async (entry?: StoredConfiguration): Promise<StoredConfiguration | undefined> => {
		const target = (entry && store.get(entry.configuration.id)) ?? statusBar.selected() ?? await pickConfiguration(store);
		if (!target) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Spring 실행 구성이 없습니다. 탐색기의 Spring 실행 뷰에서 자동 탐지하거나 추가하세요.'));
		}
		return target;
	};

	const start = async (mode: RunMode, entry?: StoredConfiguration) => {
		const target = await resolve(entry);
		if (target) {
			await statusBar.select(target);
			await runner.start(target, mode);
		}
	};

	const edit = async (folder: vscode.WorkspaceFolder, configuration: SpringRunConfiguration) => {
		const saved = await editConfiguration(context.extensionUri, folder, configuration);
		if (saved) {
			await store.upsert(folder, saved);
			await statusBar.select({ folder, configuration: saved });
		}
		return saved;
	};

	const detect = async (interactive: boolean) => {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (store.hasSavedFile(folder) && !interactive) {
				continue;
			}
			const found = await discoverConfigurations(folder);
			log(`${folder.name}: Spring 실행 구성 ${found.length}개 탐지`);
			if (!store.hasSavedFile(folder)) {
				store.setDiscovered(folder, found);
				continue;
			}
			// The folder has saved configurations: only add what is new, never overwrite the user's edits.
			const existing = store.all().filter(entry => sameFolder(entry.folder, folder)).map(entry => entry.configuration);
			const added = found.filter(candidate => !existing.some(configuration => sameTarget(configuration, candidate)));
			for (const configuration of added) {
				await store.upsert(folder, configuration);
			}
			if (interactive) {
				void vscode.window.showInformationMessage(added.length
					? vscode.l10n.t('{0}: 새 실행 구성 {1}개를 추가했습니다.', folder.name, added.length)
					: vscode.l10n.t('{0}: 새로 찾은 실행 구성이 없습니다.', folder.name));
			}
		}
	};

	context.subscriptions.push(
		output,
		store,
		runner,
		tree,
		statusBar,
		store.onDidChange(refresh),
		runner.onDidChange(refresh),
		vscode.window.registerTreeDataProvider('vshoonSpring.configurations', tree),
		vscode.languages.registerCodeLensProvider({ language: 'java', scheme: 'file' }, new MainClassCodeLensProvider()),
		vscode.commands.registerCommand('vshoon.spring.run', (entry?: StoredConfiguration) => start('run', entry)),
		vscode.commands.registerCommand('vshoon.spring.debug', (entry?: StoredConfiguration) => start('debug', entry)),
		vscode.commands.registerCommand('vshoon.spring.stop', async (entry?: StoredConfiguration) => {
			const target = await resolve(entry);
			if (target) {
				await runner.stop(target.configuration.id);
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.restart', async (entry?: StoredConfiguration) => {
			const target = await resolve(entry);
			if (target) {
				await runner.restart(target);
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.stopAll', async () => {
			await Promise.all(store.all().map(entry => runner.stop(entry.configuration.id)));
		}),
		vscode.commands.registerCommand('vshoon.spring.select', (entry: StoredConfiguration) => statusBar.select(entry)),
		vscode.commands.registerCommand('vshoon.spring.selectConfiguration', async () => {
			const picked = await pickConfiguration(store, statusBar.selected());
			if (picked) {
				await statusBar.select(picked);
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.add', async () => {
			const folder = await pickFolder();
			if (folder) {
				await edit(folder, { id: randomUUID(), name: vscode.l10n.t('새 실행 구성'), kind: 'boot', project: '', mainClass: '', profiles: '', vmArgs: '', args: '', env: {} });
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.edit', async (entry?: StoredConfiguration) => {
			const target = await resolve(entry);
			if (target) {
				await edit(target.folder, target.configuration);
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.duplicate', async (entry?: StoredConfiguration) => {
			const target = await resolve(entry);
			if (target) {
				await edit(target.folder, { ...target.configuration, id: randomUUID(), name: vscode.l10n.t('{0} 복사본', target.configuration.name) });
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.delete', async (entry?: StoredConfiguration) => {
			const target = await resolve(entry);
			if (!target) {
				return;
			}
			const remove = vscode.l10n.t('삭제');
			const choice = await vscode.window.showWarningMessage(vscode.l10n.t('실행 구성 \'{0}\'을(를) 삭제할까요?', target.configuration.name), { modal: true }, remove);
			if (choice === remove) {
				await runner.stop(target.configuration.id);
				await store.remove(target.folder, target.configuration.id);
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.detect', () => vscode.window.withProgress(
			{ location: { viewId: 'vshoonSpring.configurations' } },
			() => detect(true)
		)),
		vscode.commands.registerCommand('vshoon.spring.openConfigurationFile', async () => {
			const folder = await pickFolder();
			if (!folder) {
				return;
			}
			if (!store.hasSavedFile(folder)) {
				// Persist the discovered list first, so the file shows what the view shows.
				await store.persist(folder);
			}
			try {
				await vscode.window.showTextDocument(store.fileUri(folder));
			} catch {
				void vscode.window.showInformationMessage(vscode.l10n.t('{0}에 저장된 실행 구성이 없습니다.', folder.name));
			}
		}),
		vscode.commands.registerCommand('vshoon.spring.runMainClass', async (uri: vscode.Uri, mode: RunMode) => {
			const entry = await configurationForMainClass(store, uri);
			if (entry) {
				await statusBar.select(entry);
				await runner.start(entry, mode);
			}
		})
	);

	await store.reload();
	refresh();
	void detect(false).catch(error => log(`Spring 실행 구성 탐지 실패: ${error}`));
}

export function deactivate(): void {
	// Running sessions and tasks belong to the workbench; it stops them with the window.
}

/** Finds the configuration that launches the main class in `uri`, creating and saving one if none does. */
async function configurationForMainClass(store: ConfigurationStore, uri: vscode.Uri): Promise<StoredConfiguration | undefined> {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	const relative = folder ? vscode.workspace.asRelativePath(uri, false) : undefined;
	const mainClass = relative ? classNameFromSourcePath(relative) : undefined;
	if (!folder || !relative || !mainClass) {
		void vscode.window.showWarningMessage(vscode.l10n.t('src/main/java 아래의 클래스만 실행할 수 있습니다.'));
		return undefined;
	}
	const existing = store.all().find(entry => sameFolder(entry.folder, folder) && entry.configuration.kind === 'boot' && entry.configuration.mainClass === mainClass);
	if (existing) {
		return existing;
	}
	const index = relative.replace(/\\/g, '/').lastIndexOf('src/main/java/');
	const project = relative.slice(0, index).replace(/\/$/, '');
	const configuration: SpringRunConfiguration = {
		id: randomUUID(),
		name: mainClass.slice(mainClass.lastIndexOf('.') + 1),
		kind: 'boot',
		project,
		mainClass,
		profiles: '',
		vmArgs: '',
		args: '',
		env: {}
	};
	await store.upsert(folder, configuration);
	return { folder, configuration };
}

function sameFolder(a: vscode.WorkspaceFolder, b: vscode.WorkspaceFolder): boolean {
	return a.uri.toString() === b.uri.toString();
}

function sameTarget(a: SpringRunConfiguration, b: SpringRunConfiguration): boolean {
	return a.kind === b.kind && a.project === b.project && (a.kind === 'boot' ? a.mainClass === b.mainClass : a.goal === b.goal);
}

async function pickConfiguration(store: ConfigurationStore, selected?: StoredConfiguration): Promise<StoredConfiguration | undefined> {
	const entries = store.all();
	if (entries.length <= 1) {
		return entries[0];
	}
	const picked = await vscode.window.showQuickPick(entries.map(entry => ({
		label: entry.configuration.name,
		description: entry.configuration.kind === 'boot' ? entry.configuration.mainClass : entry.configuration.goal,
		detail: entry.configuration.project || entry.folder.name,
		picked: entry.configuration.id === selected?.configuration.id,
		entry
	})), { placeHolder: vscode.l10n.t('실행 구성 선택') });
	return picked?.entry;
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length <= 1) {
		if (folders.length === 0) {
			void vscode.window.showInformationMessage(vscode.l10n.t('먼저 폴더를 여세요.'));
		}
		return folders[0];
	}
	return vscode.window.showWorkspaceFolderPick();
}
