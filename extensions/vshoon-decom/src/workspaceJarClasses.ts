/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as yauzl from 'yauzl';
import { longPath } from './longpath';
import { fileStamp, StubCache } from './stubCache';

const MAX_JARS = 5000;
const READ_CONCURRENCY = 8;
const EXCLUDE = '**/{.git,node_modules}/**';

/** Fully qualified names of the top-level classes of one JAR. */
export type JarClassNames = string[];

/** Fully qualified names of the top-level classes in one JAR, read from its central directory only. */
export function readJarClassNames(jarPath: string): Promise<string[]> {
	return new Promise(resolve => {
		yauzl.open(longPath(jarPath), { autoClose: true, lazyEntries: true, strictFileNames: false }, (error, zipFile) => {
			if (error || !zipFile) {
				resolve([]);
				return;
			}
			const names: string[] = [];
			zipFile.on('entry', (entry: yauzl.Entry) => {
				const match = /^(?<name>(?:[\w$]+\/)*[\w]+)\.class$/.exec(entry.fileName.replace(/\\/g, '/'));
				// Nested classes live in their outer class's decompiled source.
				if (match && !match.groups!.name.startsWith('META-INF/')) {
					names.push(match.groups!.name.replace(/\//g, '.'));
				}
				zipFile.readEntry();
			});
			zipFile.once('end', () => resolve(names));
			zipFile.once('error', () => resolve(names));
			zipFile.readEntry();
		});
	});
}

/**
 * Maps fully qualified class names to the workspace JARs that contain them, so that source
 * navigation can continue into library classes the way an IDE with a classpath does.
 */
export class WorkspaceJarClasses implements vscode.Disposable {
	private classes: Promise<Map<string, vscode.Uri>> | undefined;
	/** Incremented when JARs or folders change, so a stale scan stops early. */
	private generation = 0;
	private readonly subscriptions: vscode.Disposable[] = [];

	/** @param stored Class names of unchanged JARs from earlier sessions. */
	constructor(private readonly stored: StubCache<JarClassNames>) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.jar');
		const reset = () => {
			this.generation++;
			this.classes = undefined;
		};
		this.subscriptions.push(watcher, watcher.onDidCreate(reset), watcher.onDidChange(reset), watcher.onDidDelete(reset), vscode.workspace.onDidChangeWorkspaceFolders(reset));
	}

	/** The workspace JAR that contains the class, preferring the first JAR found. */
	async find(qualifiedName: string): Promise<vscode.Uri | undefined> {
		return (await this.load()).get(qualifiedName);
	}

	/** Starts reading the JAR directories in the background. */
	prepare(): void {
		void this.load();
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.generation++;
		this.classes = undefined;
	}

	private load(): Promise<Map<string, vscode.Uri>> {
		if (!this.classes) {
			const generation = this.generation;
			this.classes = (async () => {
				const result = new Map<string, vscode.Uri>();
				try {
					const jars = await vscode.workspace.findFiles('**/*.jar', EXCLUDE, MAX_JARS);
					await this.stored.load();
					for (let offset = 0; offset < jars.length && this.generation === generation; offset += READ_CONCURRENCY) {
						const batch = jars.slice(offset, offset + READ_CONCURRENCY).filter(uri => uri.scheme === 'file');
						const names = await Promise.all(batch.map(uri => this.classNames(uri)));
						batch.forEach((uri, index) => {
							for (const name of names[index]) {
								if (!result.has(name)) {
									result.set(name, uri);
								}
							}
						});
					}
					if (jars.length < MAX_JARS && this.generation === generation) {
						this.stored.retain(new Set(jars.map(uri => uri.toString())));
					}
				} catch {
					// A closing workspace interrupts discovery; the next lookup retries.
				}
				return result;
			})();
		}
		return this.classes;
	}

	/** Reads a JAR directory unless an unchanged copy of the JAR was read before. */
	private async classNames(uri: vscode.Uri): Promise<JarClassNames> {
		const key = uri.toString();
		try {
			const stamp = fileStamp(await vscode.workspace.fs.stat(uri));
			let names = this.stored.get(key, stamp);
			if (!names) {
				names = await readJarClassNames(uri.fsPath);
				this.stored.set(key, stamp, names);
			}
			return names;
		} catch {
			this.stored.delete(key);
			return [];
		}
	}
}
