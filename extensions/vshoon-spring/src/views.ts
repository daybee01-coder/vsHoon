/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { goalLabel } from './model';
import { RunMode, SpringRunner } from './runner';
import { ConfigurationStore, StoredConfiguration } from './store';

const SELECTED_KEY = 'vshoon.spring.selectedConfiguration';

/** The configuration list in the Spring view. Context values drive which inline buttons show. */
export class ConfigurationTreeProvider implements vscode.TreeDataProvider<StoredConfiguration> {

	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(
		private readonly store: ConfigurationStore,
		private readonly runner: SpringRunner
	) { }

	refresh(): void {
		this.changeEmitter.fire();
	}

	getChildren(element?: StoredConfiguration): StoredConfiguration[] {
		return element ? [] : this.store.all();
	}

	getTreeItem(entry: StoredConfiguration): vscode.TreeItem {
		const { configuration } = entry;
		const mode = this.runner.mode(configuration.id);
		const item = new vscode.TreeItem(configuration.name);
		item.id = configuration.id;
		item.contextValue = mode ? 'springConfiguration.running' : 'springConfiguration.stopped';
		item.iconPath = iconFor(mode);
		item.description = describe(entry, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
		item.tooltip = tooltipFor(entry, mode);
		item.command = { command: 'vshoon.spring.select', title: vscode.l10n.t('선택'), arguments: [entry] };
		return item;
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}

/**
 * The status bar group that stands in for IntelliJ's run toolbar: the selected configuration, and run and
 * debug buttons that turn into restart and stop while it runs.
 */
export class RunStatusBar implements vscode.Disposable {

	private readonly selector = vscode.window.createStatusBarItem('vshoon.spring.selector', vscode.StatusBarAlignment.Left, 50);
	private readonly primary = vscode.window.createStatusBarItem('vshoon.spring.primary', vscode.StatusBarAlignment.Left, 49);
	private readonly secondary = vscode.window.createStatusBarItem('vshoon.spring.secondary', vscode.StatusBarAlignment.Left, 48);

	constructor(
		private readonly state: vscode.Memento,
		private readonly store: ConfigurationStore,
		private readonly runner: SpringRunner
	) {
		this.selector.name = this.primary.name = this.secondary.name = vscode.l10n.t('Spring 실행');
		this.selector.command = 'vshoon.spring.selectConfiguration';
	}

	/** The configuration the status bar buttons act on. Falls back to the first one. */
	selected(): StoredConfiguration | undefined {
		const id = this.state.get<string>(SELECTED_KEY);
		return (id ? this.store.get(id) : undefined) ?? this.store.all()[0];
	}

	async select(entry: StoredConfiguration): Promise<void> {
		await this.state.update(SELECTED_KEY, entry.configuration.id);
		this.update();
	}

	update(): void {
		const entry = this.selected();
		if (!entry) {
			this.selector.hide();
			this.primary.hide();
			this.secondary.hide();
			return;
		}
		const mode = this.runner.mode(entry.configuration.id);
		this.selector.text = `$(${mode === 'debug' ? 'debug-alt' : mode ? 'run' : 'symbol-class'}) ${entry.configuration.name}`;
		this.selector.tooltip = vscode.l10n.t('실행 구성 선택');
		if (mode) {
			this.primary.text = '$(debug-restart)';
			this.primary.tooltip = vscode.l10n.t('{0} 재시작', entry.configuration.name);
			this.primary.command = { command: 'vshoon.spring.restart', title: '', arguments: [entry] };
			this.secondary.text = '$(debug-stop)';
			this.secondary.tooltip = vscode.l10n.t('{0} 정지', entry.configuration.name);
			this.secondary.command = { command: 'vshoon.spring.stop', title: '', arguments: [entry] };
		} else {
			this.primary.text = '$(play)';
			this.primary.tooltip = vscode.l10n.t('{0} 실행', entry.configuration.name);
			this.primary.command = { command: 'vshoon.spring.run', title: '', arguments: [entry] };
			this.secondary.text = '$(debug-alt)';
			this.secondary.tooltip = vscode.l10n.t('{0} 디버그', entry.configuration.name);
			this.secondary.command = { command: 'vshoon.spring.debug', title: '', arguments: [entry] };
		}
		this.selector.show();
		this.primary.show();
		this.secondary.show();
	}

	dispose(): void {
		this.selector.dispose();
		this.primary.dispose();
		this.secondary.dispose();
	}
}

/** Run and Debug lenses above the `main` method of a `@SpringBootApplication` class. */
export class MainClassCodeLensProvider implements vscode.CodeLensProvider {

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const text = document.getText();
		if (!text.includes('@SpringBootApplication')) {
			return [];
		}
		const main = /\bpublic\s+static\s+void\s+main\s*\(/.exec(text);
		if (!main) {
			return [];
		}
		const range = document.lineAt(document.positionAt(main.index).line).range;
		return [
			new vscode.CodeLens(range, { title: vscode.l10n.t('$(play) 실행'), command: 'vshoon.spring.runMainClass', arguments: [document.uri, 'run' satisfies RunMode] }),
			new vscode.CodeLens(range, { title: vscode.l10n.t('$(debug-alt) 디버그'), command: 'vshoon.spring.runMainClass', arguments: [document.uri, 'debug' satisfies RunMode] })
		];
	}
}

function iconFor(mode: RunMode | undefined): vscode.ThemeIcon {
	if (mode === 'debug') {
		return new vscode.ThemeIcon('debug-alt', new vscode.ThemeColor('debugIcon.startForeground'));
	}
	if (mode === 'run') {
		return new vscode.ThemeIcon('run', new vscode.ThemeColor('debugIcon.startForeground'));
	}
	return new vscode.ThemeIcon('symbol-class');
}

function describe(entry: StoredConfiguration, multiRoot: boolean): string {
	const { configuration } = entry;
	const parts = [configuration.kind === 'boot' ? 'Boot' : goalLabel(configuration.goal ?? 'Maven')];
	if (configuration.port) {
		parts.push(`:${configuration.port}`);
	}
	if (configuration.profiles) {
		parts.push(`[${configuration.profiles}]`);
	}
	if (multiRoot) {
		parts.push(`— ${entry.folder.name}`);
	}
	return parts.join(' ');
}

function tooltipFor(entry: StoredConfiguration, mode: RunMode | undefined): vscode.MarkdownString {
	const { configuration } = entry;
	const lines = [`**${configuration.name}**`, ''];
	lines.push(configuration.kind === 'boot'
		? vscode.l10n.t('메인 클래스: `{0}`', configuration.mainClass ?? '')
		: vscode.l10n.t('Maven 골: `{0}`', configuration.goal ?? ''));
	lines.push(vscode.l10n.t('프로젝트: `{0}`', configuration.project || entry.folder.name));
	if (mode) {
		lines.push('', mode === 'debug' ? vscode.l10n.t('디버그 중') : vscode.l10n.t('실행 중'));
	}
	return new vscode.MarkdownString(lines.join('  \n'));
}
