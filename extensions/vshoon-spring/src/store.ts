/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { parseConfigurationFile, serializeConfigurationFile, SpringRunConfiguration } from './model';
import { log } from './output';

const CONFIGURATION_FILE = '.vscode/vshoon-spring.json';

/** A run configuration together with the workspace folder that owns it. */
export interface StoredConfiguration {
	readonly folder: vscode.WorkspaceFolder;
	readonly configuration: SpringRunConfiguration;
}

/**
 * Keeps the run configurations of every workspace folder.
 *
 * Each folder's list lives in its own `.vscode/vshoon-spring.json`, so it can be committed with the
 * project. Configurations found by discovery stay in memory until the user changes one of them; opening
 * a project never writes into it by itself.
 */
export class ConfigurationStore implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly byFolder = new Map<string, SpringRunConfiguration[]>();
	/** Folders whose list came from discovery and has not been saved yet. */
	private readonly unsaved = new Set<string>();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor() {
		const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIGURATION_FILE}`);
		this.disposables.push(
			this.changeEmitter,
			watcher,
			watcher.onDidChange(uri => this.reloadFor(uri)),
			watcher.onDidCreate(uri => this.reloadFor(uri)),
			watcher.onDidDelete(uri => this.reloadFor(uri)),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.reload())
		);
	}

	/** All configurations, in folder order. */
	all(): StoredConfiguration[] {
		const result: StoredConfiguration[] = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			for (const configuration of this.byFolder.get(folder.uri.toString()) ?? []) {
				result.push({ folder, configuration });
			}
		}
		return result;
	}

	get(id: string): StoredConfiguration | undefined {
		return this.all().find(entry => entry.configuration.id === id);
	}

	/** Whether the folder already has a saved file, which discovery must then leave alone. */
	hasSavedFile(folder: vscode.WorkspaceFolder): boolean {
		return this.byFolder.has(folder.uri.toString()) && !this.unsaved.has(folder.uri.toString());
	}

	async reload(): Promise<void> {
		this.byFolder.clear();
		this.unsaved.clear();
		await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => this.load(folder)));
		this.changeEmitter.fire();
	}

	/** Shows discovered configurations for a folder that has no saved file. */
	setDiscovered(folder: vscode.WorkspaceFolder, configurations: readonly SpringRunConfiguration[]): void {
		const key = folder.uri.toString();
		if (this.hasSavedFile(folder)) {
			return;
		}
		this.byFolder.set(key, [...configurations]);
		this.unsaved.add(key);
		this.changeEmitter.fire();
	}

	/** Adds the configuration, or replaces the one with the same id. */
	async upsert(folder: vscode.WorkspaceFolder, configuration: SpringRunConfiguration): Promise<void> {
		const list = [...this.byFolder.get(folder.uri.toString()) ?? []];
		const index = list.findIndex(entry => entry.id === configuration.id);
		if (index >= 0) {
			list[index] = configuration;
		} else {
			list.push(configuration);
		}
		await this.save(folder, list);
	}

	/** Writes the folder's current list, including discovered configurations, to its file. */
	async persist(folder: vscode.WorkspaceFolder): Promise<void> {
		await this.save(folder, [...this.byFolder.get(folder.uri.toString()) ?? []]);
	}

	async remove(folder: vscode.WorkspaceFolder, id: string): Promise<void> {
		await this.save(folder, (this.byFolder.get(folder.uri.toString()) ?? []).filter(entry => entry.id !== id));
	}

	fileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
		return vscode.Uri.joinPath(folder.uri, CONFIGURATION_FILE);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async save(folder: vscode.WorkspaceFolder, configurations: SpringRunConfiguration[]): Promise<void> {
		const key = folder.uri.toString();
		this.byFolder.set(key, configurations);
		this.unsaved.delete(key);
		this.changeEmitter.fire();
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
		await vscode.workspace.fs.writeFile(this.fileUri(folder), Buffer.from(serializeConfigurationFile(configurations), 'utf8'));
	}

	private async load(folder: vscode.WorkspaceFolder): Promise<void> {
		try {
			const content = await vscode.workspace.fs.readFile(this.fileUri(folder));
			this.byFolder.set(folder.uri.toString(), parseConfigurationFile(Buffer.from(content).toString('utf8')));
		} catch (error) {
			if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
				log(`실행 구성 파일을 읽지 못했습니다: ${this.fileUri(folder).fsPath} — ${error}`);
			}
		}
	}

	private async reloadFor(uri: vscode.Uri): Promise<void> {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder || this.fileUri(folder).toString() !== uri.toString()) {
			return;
		}
		const key = folder.uri.toString();
		this.byFolder.delete(key);
		this.unsaved.delete(key);
		await this.load(folder);
		this.changeEmitter.fire();
	}
}
