/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { JarFileSystemProvider } from './archiveFileSystem';
import { ClassSourceService } from './classSourceService';
import { toClassSourceUri } from './classSourceUri';
import { definitionOwners, NavigationSource, resolveSourceDefinitions, SourceDefinition, typeReferenceAt, typeReferenceDefinitions } from './javaSymbols';
import { log } from './output';
import { StubCache } from './stubCache';
import { JarClassNames, WorkspaceJarClasses } from './workspaceJarClasses';
import { javaImports, JavaStub, javaStub, WorkspaceJavaIndex } from './workspaceJavaIndex';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES = 20000;
const EXCLUDE = '**/{.git,node_modules,target,build,out,dist}/**';
/** Change when `javaStub` produces different data, so stored stubs of an older parser are dropped. */
const JAVA_STUB_FORMAT = 'java-stub-1';
const JAR_CLASSES_FORMAT = 'jar-classes-1';

/** A file in the workspace-specific storage, or undefined without a workspace. */
export function indexFile(context: vscode.ExtensionContext, name: string): string | undefined {
	return context.storageUri?.scheme === 'file' ? vscode.Uri.joinPath(context.storageUri, 'index', name).fsPath : undefined;
}

/** Local Java navigation when a full Java language server has not been installed. */
class WorkspaceJavaNavigation implements vscode.DefinitionProvider, vscode.Disposable {
	private readonly index = new WorkspaceJavaIndex();
	private readonly jars: WorkspaceJarClasses;
	private readonly versions = new Map<string, string>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly edits = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly cancellation = new vscode.CancellationTokenSource();
	private generation = 0;
	private ready: Promise<void>;
	/** True once every workspace source of the current generation has been read. */
	private preloaded = false;

	constructor(
		private readonly archives: JarFileSystemProvider,
		private readonly classSources: ClassSourceService,
		/** Declarations of unchanged sources from earlier sessions. */
		private readonly stubs: StubCache<JavaStub>,
		jarClasses: StubCache<JarClassNames>
	) {
		this.jars = new WorkspaceJarClasses(jarClasses);
		this.subscriptions.push(this.cancellation, this.jars);
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.java');
		this.subscriptions.push(
			watcher,
			watcher.onDidCreate(uri => { void this.refresh(uri); }),
			watcher.onDidChange(uri => { void this.refresh(uri); }),
			watcher.onDidDelete(uri => {
				this.versions.delete(uri.toString());
				this.index.delete(uri.toString());
				this.stubs.delete(uri.toString());
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.scheme === 'file' && event.document.languageId === 'java' && event.contentChanges.length > 0) {
					const key = event.document.uri.toString();
					clearTimeout(this.edits.get(key));
					this.edits.set(key, setTimeout(() => {
						this.edits.delete(key);
						this.updateDocument(event.document);
					}, 250));
				}
			}),
			vscode.workspace.onDidCloseTextDocument(document => {
				clearTimeout(this.edits.get(document.uri.toString()));
				this.edits.delete(document.uri.toString());
				this.versions.delete(document.uri.toString());
				void this.refresh(document.uri);
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.generation++;
				this.versions.clear();
				this.index.clear();
				this.ready = this.preload();
			})
		);
		this.ready = this.preload();
	}

	async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		// Stay available while an installed language server is starting or cannot start.
		// Upstream merges and deduplicates definition providers.
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
		if (!range || token.isCancellationRequested) {
			return [];
		}
		const content = document.getText();
		const word = document.getText(range);
		const offset = document.offsetAt(range.start);
		const current = { uri: document.uri.toString(), content };
		// Same-file navigation (locals, parameters, members of this file) needs neither workspace
		// discovery nor background indexing.
		const local = resolveSourceDefinitions(current, offset, word, [current]);
		if (local.length > 0 || token.isCancellationRequested) {
			return this.locations(local);
		}
		const generation = this.generation;
		// Prioritize likely files rather than waiting for an entire cold workspace to be indexed.
		const owners = this.preloaded ? [] : definitionOwners(content, offset, word).filter(owner => /^[A-Z]/.test(owner));
		if (owners.length > 0) {
			const name = owners.length === 1 ? owners[0] : `{${owners.join(',')}}`;
			const files = await vscode.workspace.findFiles(`**/${name}.java`, EXCLUDE, MAX_SOURCES, token);
			for (let offset = 0; offset < files.length && !token.isCancellationRequested && generation === this.generation; offset += 4) {
				await Promise.all(files.slice(offset, offset + 4).map(uri => this.refresh(uri)));
			}
		}
		if (token.isCancellationRequested || generation !== this.generation) {
			return [];
		}
		for (const open of vscode.workspace.textDocuments) {
			if (open.uri.scheme === 'file' && open.languageId === 'java') {
				this.updateDocument(open);
			}
		}
		// Supertypes and chained calls need the whole index; a partial one must not guess.
		let definitions = this.index.resolve(current, offset, word, this.preloaded);
		if (definitions.length === 0 && !this.preloaded && !token.isCancellationRequested) {
			await new Promise<void>(resolve => {
				const subscription = token.onCancellationRequested(() => {
					subscription.dispose();
					resolve();
				});
				void this.ready.then(() => {
					subscription.dispose();
					resolve();
				});
			});
			definitions = this.index.resolve(current, offset, word, this.preloaded);
		}
		if (token.isCancellationRequested || generation !== this.generation) {
			return [];
		}
		if (definitions.length > 0) {
			return this.locations(definitions);
		}
		return this.libraryLocations(current, offset, word, token);
	}

	/** Continues into a decompiled library class when the declaring type is not a workspace source. */
	private async libraryLocations(current: NavigationSource, offset: number, word: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const target = typeReferenceAt(current.content, offset, word);
		if (!target) {
			return [];
		}
		const imports = javaImports(current.content);
		const explicit = imports.explicit.get(target.type);
		const candidates = explicit ? [explicit] : [imports.packageName, ...imports.wildcards].filter(Boolean).map(prefix => `${prefix}.${target.type}`);
		try {
			for (const qualifiedName of candidates) {
				const jar = await this.jars.find(qualifiedName);
				if (!jar || token.isCancellationRequested) {
					continue;
				}
				const root = await this.archives.openArchive(jar);
				const classUri = vscode.Uri.joinPath(root, ...`${qualifiedName.replace(/\./g, '/')}.class`.split('/'));
				const sourceUri = toClassSourceUri(classUri);
				const content = await this.classSources.getSource(classUri, 'user');
				if (token.isCancellationRequested) {
					return [];
				}
				const definitions = typeReferenceDefinitions({ uri: sourceUri.toString(), content }, target);
				return definitions.length > 0 ? this.locations(definitions) : [new vscode.Location(sourceUri, new vscode.Position(0, 0))];
			}
		} catch (error) {
			log(`라이브러리 선언으로 이동하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
		}
		return [];
	}

	dispose(): void {
		this.generation++;
		this.cancellation.cancel();
		for (const timer of this.edits.values()) {
			clearTimeout(timer);
		}
		this.edits.clear();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.index.clear();
		this.versions.clear();
	}

	private locations(definitions: readonly SourceDefinition[]): vscode.Location[] {
		return definitions.map(definition => new vscode.Location(
			vscode.Uri.parse(definition.uri),
			new vscode.Range(definition.line, definition.column, definition.line, definition.column + definition.length)
		));
	}

	private updateDocument(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		const version = `document:${document.version}`;
		if (this.versions.get(key) !== version) {
			const content = document.getText();
			if (content.length <= MAX_SOURCE_BYTES) {
				this.index.update(key, content);
			} else {
				this.index.delete(key);
			}
			this.versions.set(key, version);
		}
	}

	private async refresh(uri: vscode.Uri): Promise<void> {
		if (this.cancellation.token.isCancellationRequested || uri.scheme !== 'file' || !uri.path.endsWith('.java')) {
			return;
		}
		const generation = this.generation;
		const key = uri.toString();
		try {
			const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === key);
			if (document) {
				this.updateDocument(document);
				return;
			}
			const stat = await vscode.workspace.fs.stat(uri);
			if (generation !== this.generation || this.cancellation.token.isCancellationRequested) {
				return;
			}
			const version = `disk:${stat.mtime}:${stat.ctime}:${stat.size}`;
			if (stat.size > MAX_SOURCE_BYTES) {
				this.versions.delete(key);
				this.index.delete(key);
				return;
			}
			if (this.versions.get(key) === version || (this.versions.size >= MAX_SOURCES && !this.versions.has(key))) {
				return;
			}
			await this.stubs.load();
			let stub = this.stubs.get(key, version);
			if (!stub) {
				const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
				stub = javaStub(content);
				this.stubs.set(key, version, stub);
			}
			if (generation === this.generation && !this.cancellation.token.isCancellationRequested) {
				const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === key);
				if (open) {
					this.updateDocument(open);
				} else {
					this.index.updateStub(key, stub);
					this.versions.set(key, version);
				}
			}
		} catch {
			if (generation === this.generation && !this.cancellation.token.isCancellationRequested) {
				this.versions.delete(key);
				this.index.delete(key);
			}
		}
	}

	private async preload(): Promise<void> {
		this.preloaded = false;
		const generation = this.generation;
		try {
			const files = await vscode.workspace.findFiles('**/*.java', EXCLUDE, MAX_SOURCES, this.cancellation.token);
			// Unchanged sources only cost a stat, so the batches can be wider than for a cold parse.
			for (let offset = 0; offset < files.length && generation === this.generation && !this.cancellation.token.isCancellationRequested; offset += 16) {
				await Promise.all(files.slice(offset, offset + 16).map(uri => this.refresh(uri)));
			}
			if (files.length < MAX_SOURCES && generation === this.generation && !this.cancellation.token.isCancellationRequested) {
				this.stubs.retain(new Set(files.map(uri => uri.toString())));
			}
		} catch {
			// Workspace removal or shutdown can interrupt discovery; direct navigation can retry.
		}
		if (generation === this.generation && !this.cancellation.token.isCancellationRequested) {
			this.preloaded = true;
			// Library classes are needed only after source navigation; read the JAR directories next.
			this.jars.prepare();
		}
	}
}

export function registerWorkspaceJavaNavigation(context: vscode.ExtensionContext, archives: JarFileSystemProvider, classSources: ClassSourceService): void {
	const stubs = new StubCache<JavaStub>(indexFile(context, 'java-stubs.json'), JAVA_STUB_FORMAT);
	const jarClasses = new StubCache<JarClassNames>(indexFile(context, 'jar-classes.json'), JAR_CLASSES_FORMAT);
	const provider = new WorkspaceJavaNavigation(archives, classSources, stubs, jarClasses);
	context.subscriptions.push(provider, stubs, jarClasses, vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'java' }, provider));
}
