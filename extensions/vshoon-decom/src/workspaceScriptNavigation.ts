/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { collectScriptDeclarations, isScriptCode, ScriptDeclaration } from './scriptSymbols';
import { fileStamp, StubCache } from './stubCache';
import { indexFile } from './workspaceJavaNavigation';

const SCRIPT_GLOB = '**/*.{js,mjs,cjs,jsx}';
const EXCLUDE = '**/{.git,node_modules,bower_components,target,build,out,dist}/**';
const MAX_SCRIPTS = 20000;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
/** More same-named declarations than this are too ambiguous to be useful as a jump target. */
const MAX_RESULTS = 30;
/** Change when `collectScriptDeclarations` produces different data. */
const SCRIPT_STUB_FORMAT = 'script-declarations-1';

/**
 * Cross-file navigation for plain scripts and pages (HTML, JSP) that call global functions declared
 * in other script files. The JavaScript service only connects such files when a project
 * configuration lists them; this index finds the declarations by name instead.
 */
class WorkspaceScriptNavigation implements vscode.DefinitionProvider, vscode.Disposable {
	/** Declarations per script URI. */
	private readonly scripts = new Map<string, ScriptDeclaration[]>();
	private readonly names = new Map<string, Set<string>>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private loading: Promise<void> | undefined;
	private generation = 0;

	/** @param stored Declarations of unchanged scripts from earlier sessions. */
	constructor(private readonly stored: StubCache<ScriptDeclaration[]>) {
		const watcher = vscode.workspace.createFileSystemWatcher(SCRIPT_GLOB);
		this.subscriptions.push(
			watcher,
			watcher.onDidCreate(uri => { void this.refresh(uri); }),
			watcher.onDidChange(uri => { void this.refresh(uri); }),
			watcher.onDidDelete(uri => {
				this.remove(uri.toString());
				this.stored.delete(uri.toString());
			}),
			vscode.workspace.onDidSaveTextDocument(document => { void this.refresh(document.uri); }),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.generation++;
				this.scripts.clear();
				this.names.clear();
				this.loading = undefined;
			})
		);
	}

	async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
		if (!range) {
			return [];
		}
		const word = document.getText(range);
		const content = document.getText();
		if (!isScriptCode(content, document.offsetAt(range.start), word)) {
			return [];
		}
		// A declaration in the same file or page shadows globals declared elsewhere.
		const local = collectScriptDeclarations(content).filter(declaration => declaration.name === word);
		if (local.length > 0) {
			return local.map(declaration => this.location(document.uri, declaration));
		}
		await this.load();
		if (token.isCancellationRequested) {
			return [];
		}
		const current = document.uri.toString();
		const result: vscode.Location[] = [];
		for (const uri of this.names.get(word) ?? []) {
			if (uri === current) {
				continue;
			}
			for (const declaration of this.scripts.get(uri) ?? []) {
				if (declaration.name === word) {
					result.push(this.location(vscode.Uri.parse(uri), declaration));
				}
			}
		}
		return result.length <= MAX_RESULTS ? result : [];
	}

	dispose(): void {
		this.generation++;
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.scripts.clear();
		this.names.clear();
	}

	private location(uri: vscode.Uri, declaration: ScriptDeclaration): vscode.Location {
		return new vscode.Location(uri, new vscode.Range(declaration.line, declaration.column, declaration.line, declaration.column + declaration.name.length));
	}

	/** Reads every workspace script once; later changes arrive through the watcher. */
	private load(): Promise<void> {
		if (!this.loading) {
			const generation = this.generation;
			this.loading = (async () => {
				try {
					const files = await vscode.workspace.findFiles(SCRIPT_GLOB, EXCLUDE, MAX_SCRIPTS);
					await this.stored.load();
					for (let offset = 0; offset < files.length && generation === this.generation; offset += 16) {
						await Promise.all(files.slice(offset, offset + 16).map(uri => this.refresh(uri)));
					}
					if (files.length < MAX_SCRIPTS && generation === this.generation) {
						this.stored.retain(new Set(files.map(uri => uri.toString())));
					}
				} catch {
					// A closing workspace interrupts discovery; the next request retries.
					if (generation === this.generation) {
						this.loading = undefined;
					}
				}
			})();
		}
		return this.loading;
	}

	private async refresh(uri: vscode.Uri): Promise<void> {
		const key = uri.toString();
		if (uri.scheme !== 'file' || /\.min\.js$/i.test(uri.path) || /\/(?:node_modules|bower_components|target|build|out|dist|\.git)\//.test(uri.path)) {
			return;
		}
		const generation = this.generation;
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_SCRIPT_BYTES) {
				this.remove(key);
				return;
			}
			const stamp = fileStamp(stat);
			await this.stored.load();
			let declarations = this.stored.get(key, stamp);
			if (!declarations) {
				declarations = collectScriptDeclarations(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
				this.stored.set(key, stamp, declarations);
			}
			if (generation === this.generation) {
				this.remove(key);
				this.scripts.set(key, declarations);
				for (const declaration of declarations) {
					let uris = this.names.get(declaration.name);
					if (!uris) {
						uris = new Set();
						this.names.set(declaration.name, uris);
					}
					uris.add(key);
				}
			}
		} catch {
			this.remove(key);
		}
	}

	private remove(key: string): void {
		for (const declaration of this.scripts.get(key) ?? []) {
			const uris = this.names.get(declaration.name);
			uris?.delete(key);
			if (uris?.size === 0) {
				this.names.delete(declaration.name);
			}
		}
		this.scripts.delete(key);
	}
}

export function registerWorkspaceScriptNavigation(context: vscode.ExtensionContext): void {
	const stored = new StubCache<ScriptDeclaration[]>(indexFile(context, 'script-declarations.json'), SCRIPT_STUB_FORMAT);
	const provider = new WorkspaceScriptNavigation(stored);
	const selector: vscode.DocumentSelector = ['javascript', 'javascriptreact', 'html'].map(language => ({ scheme: 'file', language }));
	context.subscriptions.push(provider, stored, vscode.languages.registerDefinitionProvider(selector, provider));
}
