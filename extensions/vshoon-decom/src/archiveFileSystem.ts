/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yauzl from 'yauzl';
import { normalizeEntryName } from './entryPaths';
import { longPath } from './longpath';
import { log } from './output';

export const JAR_FILE_SYSTEM_SCHEME = 'vshoon-jar';
const MAX_ARCHIVE_ENTRIES = 250_000;
const MAX_ENTRY_SIZE = 512 * 1024 * 1024;

interface ArchiveNode {
	name: string;
	type: vscode.FileType;
	size: number;
	mtime: number;
	entry?: yauzl.Entry;
	children?: Map<string, ArchiveNode>;
}

type ArchiveSource =
	| { kind: 'file'; key: string; filePath: string }
	| { kind: 'entry'; key: string; uri: vscode.Uri };

interface ArchiveIndex {
	id: string;
	root: ArchiveNode;
	rootUri: vscode.Uri;
	zipFile: yauzl.ZipFile;
}

export interface ArchiveOpenedEvent {
	resource: vscode.Uri;
	root: vscode.Uri;
}

export interface ArchiveLocation {
	displayPath: string;
	rootFilePath: string;
}

function archiveId(key: string): string {
	return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function localSourceKey(filePath: string): string {
	const resolved = path.resolve(filePath);
	return `file:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
}

function archiveRootUri(id: string): vscode.Uri {
	return vscode.Uri.from({ scheme: JAR_FILE_SYSTEM_SCHEME, authority: id, path: '/' });
}

function archiveSegments(entryName: string): string[] | undefined {
	const normalized = normalizeEntryName(entryName);
	if (!normalized || normalized.length > 4096 || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) {
		return undefined;
	}
	const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.');
	return segments.length > 0 && !segments.includes('..') ? segments : undefined;
}

function entryMtime(entry: yauzl.Entry): number {
	try {
		return entry.getLastModDate().getTime();
	} catch {
		return 0;
	}
}

function addEntry(root: ArchiveNode, entry: yauzl.Entry): boolean {
	const segments = archiveSegments(entry.fileName);
	if (!segments) {
		return false;
	}
	const isDirectory = normalizeEntryName(entry.fileName).endsWith('/');
	let parent = root;
	for (let index = 0; index < segments.length; index++) {
		const name = segments[index];
		const last = index === segments.length - 1;
		const type = last && !isDirectory ? vscode.FileType.File : vscode.FileType.Directory;
		const existing = parent.children?.get(name);
		if (existing && existing.type !== type && (last || existing.type !== vscode.FileType.Directory)) {
			return false;
		}
		if (existing) {
			if (last && type === vscode.FileType.File) {
				existing.entry = entry;
				existing.size = entry.uncompressedSize;
				existing.mtime = entryMtime(entry);
			}
			parent = existing;
			continue;
		}
		const node: ArchiveNode = {
			name,
			type,
			size: type === vscode.FileType.File ? entry.uncompressedSize : 0,
			mtime: entryMtime(entry),
			entry: type === vscode.FileType.File ? entry : undefined,
			children: type === vscode.FileType.Directory ? new Map() : undefined
		};
		parent.children!.set(name, node);
		parent = node;
	}
	return true;
}

function openFileArchive(filePath: string): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(longPath(filePath), {
			autoClose: false, lazyEntries: true, strictFileNames: false, validateEntrySizes: true
		}, (error, zipFile) => error ? reject(error) : resolve(zipFile));
	});
}

function openBufferArchive(buffer: Buffer): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.fromBuffer(buffer, {
			autoClose: false, lazyEntries: true, strictFileNames: false, validateEntrySizes: true
		}, (error, zipFile) => error ? reject(error) : resolve(zipFile));
	});
}

async function indexArchive(id: string, zipFile: yauzl.ZipFile, size: number, mtime: number): Promise<ArchiveIndex> {
	if (zipFile.entryCount > MAX_ARCHIVE_ENTRIES) {
		zipFile.close();
		throw new Error(vscode.l10n.t('Decom: JAR 항목 수가 안전 제한({0})을 초과했습니다.', MAX_ARCHIVE_ENTRIES));
	}
	const root: ArchiveNode = { name: '', type: vscode.FileType.Directory, size, mtime, children: new Map() };
	let skipped = 0;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			zipFile.removeListener('error', onError);
			zipFile.removeListener('end', onEnd);
			zipFile.removeListener('entry', onEntry);
		};
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onEnd = () => { cleanup(); resolve(); };
		const onEntry = (entry: yauzl.Entry) => {
			if (!addEntry(root, entry)) {
				skipped++;
			}
			zipFile.readEntry();
		};
		zipFile.on('error', onError);
		zipFile.on('end', onEnd);
		zipFile.on('entry', onEntry);
		zipFile.readEntry();
	});
	if (skipped > 0) {
		log(`VFS 인덱스에서 안전하지 않거나 충돌한 JAR 항목 ${skipped}개를 건너뛰었습니다.`);
	}
	zipFile.on('error', error => log(`JAR VFS 오류: ${error.message}`));
	return { id, root, rootUri: archiveRootUri(id), zipFile };
}

/**
 * Read-only archive provider. Local archives keep only their ZIP index and file handle in memory.
 * Nested archives are materialized in memory only when their own Explorer node is expanded.
 */
export class JarFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this._onDidChangeFile.event;
	private readonly _onDidOpenArchive = new vscode.EventEmitter<ArchiveOpenedEvent>();
	readonly onDidOpenArchive = this._onDidOpenArchive.event;

	private readonly sources = new Map<string, ArchiveSource>();
	private readonly indexes = new Map<string, ArchiveIndex>();
	private readonly pending = new Map<string, Promise<ArchiveIndex>>();
	private readonly watchers = new Map<string, fs.FSWatcher>();
	private epoch = 0;
	private disposed = false;

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}

	async openArchive(resource: vscode.Uri): Promise<vscode.Uri> {
		let source: ArchiveSource;
		if (resource.scheme === 'file') {
			if (path.extname(resource.fsPath).toLowerCase() !== '.jar') {
				throw vscode.FileSystemError.FileNotFound(resource);
			}
			const key = localSourceKey(resource.fsPath);
			source = { kind: 'file', key, filePath: path.resolve(resource.fsPath) };
		} else if (resource.scheme === JAR_FILE_SYSTEM_SCHEME) {
			if (path.posix.extname(resource.path).toLowerCase() !== '.jar') {
				throw vscode.FileSystemError.FileNotFound(resource);
			}
			await this.assertFile(resource);
			const key = `entry:${resource.toString()}`;
			source = { kind: 'entry', key, uri: resource };
		} else {
			throw vscode.FileSystemError.Unavailable(vscode.l10n.t('Decom은 로컬 또는 JAR 내부의 JAR만 펼칠 수 있습니다.'));
		}
		const id = archiveId(source.key);
		if (!this.sources.has(id)) {
			this.sources.set(id, source);
			if (source.kind === 'file') {
				this.watchLocalArchive(id, source.filePath);
			}
		}
		const index = await this.getIndex(id);
		log(`JAR VFS 인덱스 준비 완료: ${resource.toString()} (${index.zipFile.entryCount}개 항목)`);
		this._onDidOpenArchive.fire({ resource, root: index.rootUri });
		return index.rootUri;
	}

	listClassFiles(root: vscode.Uri): vscode.Uri[] {
		const index = this.indexes.get(root.authority);
		if (!index || root.scheme !== JAR_FILE_SYSTEM_SCHEME || root.path !== '/') {
			return [];
		}
		const result: vscode.Uri[] = [];
		const visit = (node: ArchiveNode, segments: string[]) => {
			if (node.type === vscode.FileType.File) {
				if (node.name.toLowerCase().endsWith('.class')) {
					result.push(vscode.Uri.joinPath(root, ...segments));
				}
				return;
			}
			for (const child of node.children?.values() ?? []) {
				visit(child, [...segments, child.name]);
			}
		};
		visit(index.root, []);
		return result;
	}

	getArchiveLocation(uri: vscode.Uri): ArchiveLocation | undefined {
		if (uri.scheme !== JAR_FILE_SYSTEM_SCHEME) {
			return undefined;
		}
		const source = this.sources.get(uri.authority);
		if (!source) {
			return undefined;
		}
		if (source.kind === 'file') {
			return {
				displayPath: `${source.filePath}!${uri.path}`,
				rootFilePath: source.filePath
			};
		}
		const parent = this.getArchiveLocation(source.uri);
		return parent ? {
			displayPath: `${parent.displayPath}!${uri.path}`,
			rootFilePath: parent.rootFilePath
		} : undefined;
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const node = await this.getNode(uri);
		return { type: node.type, ctime: 0, mtime: node.mtime, size: node.size, permissions: vscode.FilePermission.Readonly };
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const node = await this.getNode(uri);
		if (node.type !== vscode.FileType.Directory || !node.children) {
			throw vscode.FileSystemError.FileNotADirectory(uri);
		}
		return Array.from(node.children.values(), child => [child.name, child.type]);
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const index = await this.getIndex(uri.authority);
		const node = this.findNode(index, uri);
		if (node.type === vscode.FileType.Directory || !node.entry) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (node.entry.uncompressedSize > MAX_ENTRY_SIZE) {
			throw vscode.FileSystemError.Unavailable(vscode.l10n.t('Decom: 항목 크기가 읽기 제한({0}MB)을 초과했습니다.', MAX_ENTRY_SIZE / 1024 / 1024));
		}
		return new Promise<Buffer>((resolve, reject) => {
			index.zipFile.openReadStream(node.entry!, (error, stream) => {
				if (error) {
					reject(error);
					return;
				}
				const chunks: Buffer[] = [];
				let total = 0;
				stream.on('data', (chunk: Buffer) => {
					total += chunk.length;
					if (total > MAX_ENTRY_SIZE) {
						stream.destroy(new Error(vscode.l10n.t('Decom: 압축 해제된 항목이 읽기 제한을 초과했습니다.')));
						return;
					}
					chunks.push(chunk);
				});
				stream.on('error', reject);
				stream.on('end', () => resolve(Buffer.concat(chunks, total)));
			});
		});
	}

	createDirectory(uri: vscode.Uri): never { throw vscode.FileSystemError.NoPermissions(uri); }
	writeFile(uri: vscode.Uri): never { throw vscode.FileSystemError.NoPermissions(uri); }
	delete(uri: vscode.Uri): never { throw vscode.FileSystemError.NoPermissions(uri); }
	rename(oldUri: vscode.Uri): never { throw vscode.FileSystemError.NoPermissions(oldUri); }

	refresh(): void {
		this.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.invalidate(false);
		for (const watcher of this.watchers.values()) {
			watcher.close();
		}
		this.watchers.clear();
		this.sources.clear();
		this._onDidChangeFile.dispose();
		this._onDidOpenArchive.dispose();
	}

	private async assertFile(uri: vscode.Uri): Promise<void> {
		const node = await this.getNode(uri);
		if (node.type !== vscode.FileType.File) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
	}

	private async getNode(uri: vscode.Uri): Promise<ArchiveNode> {
		const index = await this.getIndex(uri.authority);
		return this.findNode(index, uri);
	}

	private findNode(index: ArchiveIndex, uri: vscode.Uri): ArchiveNode {
		if (uri.scheme !== JAR_FILE_SYSTEM_SCHEME || uri.authority !== index.id) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		let node = index.root;
		for (const segment of uri.path.split('/').filter(Boolean)) {
			node = node.children?.get(segment)!;
			if (!node) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
		}
		return node;
	}

	private getIndex(id: string): Promise<ArchiveIndex> {
		const existing = this.indexes.get(id);
		if (existing) {
			return Promise.resolve(existing);
		}
		const active = this.pending.get(id);
		if (active) {
			return active;
		}
		const source = this.sources.get(id);
		if (!source || this.disposed) {
			return Promise.reject(vscode.FileSystemError.FileNotFound(archiveRootUri(id)));
		}
		const startedAt = this.epoch;
		const loading = this.loadIndex(id, source).then(index => {
			this.clearPending(id, loading);
			if (this.disposed) {
				index.zipFile.close();
				throw vscode.FileSystemError.Unavailable('Decom');
			}
			if (startedAt !== this.epoch) {
				index.zipFile.close();
				return this.getIndex(id);
			}
			this.indexes.set(id, index);
			return index;
		}, error => {
			this.clearPending(id, loading);
			throw error;
		});
		this.pending.set(id, loading);
		return loading;
	}

	private clearPending(id: string, operation: Promise<ArchiveIndex>): void {
		if (this.pending.get(id) === operation) {
			this.pending.delete(id);
		}
	}

	private async loadIndex(id: string, source: ArchiveSource): Promise<ArchiveIndex> {
		if (source.kind === 'file') {
			const stat = await fs.promises.stat(longPath(source.filePath));
			const zipFile = await openFileArchive(source.filePath);
			try {
				return await indexArchive(id, zipFile, stat.size, stat.mtimeMs);
			} catch (error) {
				zipFile.close();
				throw error;
			}
		}
		const bytes = Buffer.from(await this.readFile(source.uri));
		const sourceStat = await this.stat(source.uri);
		const zipFile = await openBufferArchive(bytes);
		try {
			return await indexArchive(id, zipFile, bytes.length, sourceStat.mtime);
		} catch (error) {
			zipFile.close();
			throw error;
		}
	}

	private watchLocalArchive(id: string, filePath: string): void {
		try {
			const watcher = fs.watch(filePath, { persistent: false }, () => this.invalidate());
			watcher.on('error', error => log(`JAR 변경 감시 오류: ${error.message}`));
			this.watchers.set(id, watcher);
		} catch (error) {
			log(`JAR 변경 감시를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private invalidate(fireEvent = true): void {
		this.epoch++;
		for (const index of this.indexes.values()) {
			index.zipFile.close();
		}
		this.indexes.clear();
		this.pending.clear();
		if (fireEvent) {
			const changes = Array.from(this.sources, ([id]) => ({ type: vscode.FileChangeType.Changed, uri: archiveRootUri(id) }));
			if (changes.length > 0) {
				this._onDidChangeFile.fire(changes);
			}
		}
	}
}
