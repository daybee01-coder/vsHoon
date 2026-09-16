/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const CACHE_VERSION = 2;

function createNonce(): string {
	return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface ClassSourceMetadata {
	version: number;
	key: string;
	classUri: string;
	sourceUri: string;
	displayPath: string;
	rootFilePath: string;
	rootMtime: number;
	rootSize: number;
	sourceHash: string;
	createdAt: number;
}

export interface CachedClassSource {
	metadata: ClassSourceMetadata;
	source: string;
}

export interface TypeIndexRow {
	sourceUri: string;
	key: string;
}

export interface TypeIndexUpdate {
	sourceUri: string;
	key: string;
	typeNames: readonly string[];
}

interface TypeIndexFile {
	version: number;
	rootFilePath: string;
	types: Record<string, TypeIndexRow[]>;
}

export interface ArchiveCacheMarker {
	version: number;
	archiveUri: string;
	rootFilePath: string;
	rootMtime: number;
	rootSize: number;
	toolIdentity: string;
	preparedSources: number;
}

export class ClassSourceCache {
	private readonly cacheRoot: string;
	private indexRebuild: Promise<void> | undefined;

	constructor(context: vscode.ExtensionContext) {
		this.cacheRoot = path.join(context.globalStorageUri.fsPath, 'class-sources-v2');
	}

	async read(key: string): Promise<CachedClassSource | undefined> {
		try {
			const [metadataText, source] = await Promise.all([
				fs.promises.readFile(this.metadataPath(key), 'utf8'),
				fs.promises.readFile(this.sourcePath(key), 'utf8')
			]);
			const metadata = JSON.parse(metadataText) as ClassSourceMetadata;
			const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
			return metadata.version === CACHE_VERSION && metadata.key === key && metadata.sourceHash === sourceHash
				? { metadata, source }
				: undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Resolves the entry published for a source URI. The index keeps this off the full cache scan
	 * so that opening a prepared class does not read every other entry first.
	 */
	async metadataBySourceUri(sourceUri: string): Promise<ClassSourceMetadata | undefined> {
		const indexed = await this.readIndexed(sourceUri);
		if (indexed) {
			return indexed;
		}
		await this.buildMissingIndexes();
		return this.readIndexed(sourceUri);
	}

	async findBySourceUri(sourceUri: string): Promise<CachedClassSource | undefined> {
		const metadata = await this.metadataBySourceUri(sourceUri);
		return metadata ? this.read(metadata.key) : undefined;
	}

	async entries(): Promise<{ metadata: ClassSourceMetadata; sourcePath: string }[]> {
		let names: string[];
		try {
			names = await fs.promises.readdir(this.cacheRoot);
		} catch {
			return [];
		}
		const result: { metadata: ClassSourceMetadata; sourcePath: string }[] = [];
		for (const name of names) {
			if (!name.endsWith('.json')) {
				continue;
			}
			try {
				const metadata = JSON.parse(await fs.promises.readFile(path.join(this.cacheRoot, name), 'utf8')) as ClassSourceMetadata;
				const sourcePath = this.sourcePath(metadata.key);
				if (metadata.version === CACHE_VERSION && metadata.key && fs.existsSync(sourcePath)) {
					result.push({ metadata, sourcePath });
				}
			} catch {
				// A partially written or externally damaged cache entry is ignored.
			}
		}
		return result;
	}

	async write(metadata: Omit<ClassSourceMetadata, 'version' | 'createdAt' | 'sourceHash'>, source: string): Promise<void> {
		await fs.promises.mkdir(this.cacheRoot, { recursive: true });
		const complete: ClassSourceMetadata = {
			...metadata,
			version: CACHE_VERSION,
			createdAt: Date.now(),
			sourceHash: crypto.createHash('sha256').update(source).digest('hex')
		};
		const nonce = createNonce();
		const sourceTemporary = path.join(this.cacheRoot, `${metadata.key}.${nonce}.java.tmp`);
		const metadataTemporary = path.join(this.cacheRoot, `${metadata.key}.${nonce}.json.tmp`);
		try {
			await fs.promises.writeFile(sourceTemporary, source, 'utf8');
			await this.publishTemporary(sourceTemporary, this.sourcePath(metadata.key));
			await fs.promises.writeFile(metadataTemporary, JSON.stringify(complete), 'utf8');
			await this.publishTemporary(metadataTemporary, this.metadataPath(metadata.key));
			await this.writeIndex(metadata.sourceUri, metadata.key);
		} finally {
			await Promise.allSettled([
				fs.promises.rm(sourceTemporary, { force: true }),
				fs.promises.rm(metadataTemporary, { force: true })
			]);
		}
	}

	async clear(): Promise<void> {
		await fs.promises.rm(this.cacheRoot, { recursive: true, force: true });
		this.indexRebuild = Promise.resolve();
	}

	async readArchiveMarker(archiveUri: string): Promise<ArchiveCacheMarker | undefined> {
		try {
			const marker = JSON.parse(await fs.promises.readFile(this.archiveMarkerPath(archiveUri), 'utf8')) as ArchiveCacheMarker;
			return marker.version === CACHE_VERSION && marker.archiveUri === archiveUri ? marker : undefined;
		} catch {
			return undefined;
		}
	}

	async writeArchiveMarker(marker: Omit<ArchiveCacheMarker, 'version'>): Promise<void> {
		await fs.promises.mkdir(this.cacheRoot, { recursive: true });
		const temporary = path.join(this.cacheRoot, `${createNonce()}.archive.tmp`);
		try {
			await fs.promises.writeFile(temporary, JSON.stringify({ ...marker, version: CACHE_VERSION }), 'utf8');
			await this.publishTemporary(temporary, this.archiveMarkerPath(marker.archiveUri));
		} finally {
			await fs.promises.rm(temporary, { force: true });
		}
	}

	/**
	 * Returns the sources of one JAR grouped by the type names they declare. Navigation reads the
	 * few entries that can hold a declaration instead of every prepared class of the same JAR.
	 */
	async readTypeIndex(rootFilePath: string): Promise<Map<string, TypeIndexRow[]> | undefined> {
		try {
			const file = JSON.parse(await fs.promises.readFile(this.typeIndexPath(rootFilePath), 'utf8')) as TypeIndexFile;
			if (file.version !== CACHE_VERSION || !file.types) {
				return undefined;
			}
			return new Map(Object.entries(file.types));
		} catch {
			return undefined;
		}
	}

	async mergeTypeIndex(rootFilePath: string, updates: readonly TypeIndexUpdate[]): Promise<void> {
		if (updates.length === 0) {
			return;
		}
		await fs.promises.mkdir(this.cacheRoot, { recursive: true });
		const types = await this.readTypeIndex(rootFilePath) ?? new Map<string, TypeIndexRow[]>();
		const replaced = new Set(updates.map(update => update.sourceUri));
		for (const [name, rows] of [...types]) {
			const kept = rows.filter(row => !replaced.has(row.sourceUri));
			if (kept.length === 0) {
				types.delete(name);
			} else if (kept.length !== rows.length) {
				types.set(name, kept);
			}
		}
		for (const update of updates) {
			for (const name of update.typeNames) {
				types.set(name, [...types.get(name) ?? [], { sourceUri: update.sourceUri, key: update.key }]);
			}
		}
		const file: TypeIndexFile = { version: CACHE_VERSION, rootFilePath, types: Object.fromEntries(types) };
		const temporary = path.join(this.cacheRoot, `${createNonce()}.types.tmp`);
		try {
			await fs.promises.writeFile(temporary, JSON.stringify(file), 'utf8');
			await this.publishTemporary(temporary, this.typeIndexPath(rootFilePath));
		} finally {
			await fs.promises.rm(temporary, { force: true });
		}
	}

	async trim(maxBytes: number): Promise<void> {
		const entries = await this.entries();
		const sized: ({ metadata: ClassSourceMetadata; sourcePath: string; stat: fs.Stats })[] = [];
		for (const entry of entries) {
			try {
				sized.push({ ...entry, stat: await fs.promises.stat(entry.sourcePath) });
			} catch {
				// Another window may remove an entry while this cache is being trimmed.
			}
		}
		let total = sized.reduce((sum, entry) => sum + entry.stat.size, 0);
		let removed = false;
		for (const entry of sized.sort((left, right) => left.metadata.createdAt - right.metadata.createdAt)) {
			if (total <= maxBytes) {
				break;
			}
			await Promise.allSettled([
				fs.promises.rm(entry.sourcePath, { force: true }),
				fs.promises.rm(this.metadataPath(entry.metadata.key), { force: true }),
				fs.promises.rm(this.indexPath(entry.metadata.sourceUri), { force: true })
			]);
			total -= entry.stat.size;
			removed = true;
		}
		if (removed) {
			for (const name of await fs.promises.readdir(this.cacheRoot)) {
				if (name.endsWith('.archive')) {
					await fs.promises.rm(path.join(this.cacheRoot, name), { force: true });
				}
			}
		}
	}

	/**
	 * Indexes entries written before the index existed. A lookup that finds nothing must not scan
	 * the whole cache again, so this runs at most once for the lifetime of the cache.
	 */
	private async buildMissingIndexes(): Promise<void> {
		this.indexRebuild ??= (async () => {
			const newest = new Map<string, ClassSourceMetadata>();
			for (const entry of await this.entries()) {
				const known = newest.get(entry.metadata.sourceUri);
				if (!known || known.createdAt < entry.metadata.createdAt) {
					newest.set(entry.metadata.sourceUri, entry.metadata);
				}
			}
			for (const metadata of newest.values()) {
				if (!await this.hasIndex(metadata.sourceUri)) {
					await this.writeIndex(metadata.sourceUri, metadata.key);
				}
			}
		})();
		await this.indexRebuild;
	}

	private async hasIndex(sourceUri: string): Promise<boolean> {
		try {
			await fs.promises.stat(this.indexPath(sourceUri));
			return true;
		} catch {
			return false;
		}
	}

	private async readIndexed(sourceUri: string): Promise<ClassSourceMetadata | undefined> {
		try {
			const key = (await fs.promises.readFile(this.indexPath(sourceUri), 'utf8')).trim();
			const metadata = JSON.parse(await fs.promises.readFile(this.metadataPath(key), 'utf8')) as ClassSourceMetadata;
			await fs.promises.stat(this.sourcePath(key));
			return metadata.version === CACHE_VERSION && metadata.key === key && metadata.sourceUri === sourceUri
				? metadata
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async writeIndex(sourceUri: string, key: string): Promise<void> {
		const temporary = path.join(this.cacheRoot, `${createNonce()}.ref.tmp`);
		try {
			await fs.promises.writeFile(temporary, key, 'utf8');
			await this.publishTemporary(temporary, this.indexPath(sourceUri));
		} catch {
			await fs.promises.rm(temporary, { force: true });
		}
	}

	private indexPath(sourceUri: string): string {
		return path.join(this.cacheRoot, `${crypto.createHash('sha256').update(sourceUri).digest('hex')}.ref`);
	}

	private typeIndexPath(rootFilePath: string): string {
		const resolved = path.resolve(rootFilePath);
		const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
		return path.join(this.cacheRoot, `${crypto.createHash('sha256').update(identity).digest('hex')}.types`);
	}

	private archiveMarkerPath(archiveUri: string): string {
		return path.join(this.cacheRoot, `${crypto.createHash('sha256').update(archiveUri).digest('hex')}.archive`);
	}

	private sourcePath(key: string): string {
		return path.join(this.cacheRoot, `${key}.java`);
	}

	private metadataPath(key: string): string {
		return path.join(this.cacheRoot, `${key}.json`);
	}

	private async publishTemporary(temporaryPath: string, destinationPath: string): Promise<void> {
		try {
			await fs.promises.rename(temporaryPath, destinationPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST' && code !== 'EPERM') {
				throw error;
			}
			await fs.promises.rm(destinationPath, { force: true });
			await fs.promises.rename(temporaryPath, destinationPath);
		}
	}
}
