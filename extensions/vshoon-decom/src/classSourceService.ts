/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArchiveOpenedEvent, JarFileSystemProvider } from './archiveFileSystem';
import { ClassSourceCache, ClassSourceMetadata, TypeIndexRow, TypeIndexUpdate } from './classSourceCache';
import { fromClassSourceUri, outerClassUri, toClassSourceUri } from './classSourceUri';
import { decompileArchive, decompileSingleClass, ensureCfrJar } from './cfr';
import { getConfig } from './config';
import { collectTypeNames } from './javaSymbols';
import { materializeClass } from './classMaterializer';
import { log } from './output';

/** How many decompiled sources stay in memory so a reopened class needs no disk read at all. */
const MEMORY_SOURCE_LIMIT = 48;

/** How long a class may take to appear before the status bar explains that CFR is running. */
const SLOW_OPEN_NOTICE_DELAY = 300;

/** Lets Explorer finish restoring before background CFR work starts. */
const BACKGROUND_START_DELAY = 5000;

/** Keeps restarted background work away from the user's immediate class-open path. */
const BACKGROUND_RESUME_DELAY = 5000;

/** How long a decompiler run may make no progress before it is stopped. */
const DECOMPILE_TIMEOUT = 120000;

/** Longest gap between two progress checks of a running decompiler. */
const DEADLINE_POLL = 15000;

interface SourceRequest {
	readonly classUri: vscode.Uri;
	readonly id: string;
	priority: 'user' | 'background';
	queued?: QueueItem;
}

interface QueueItem {
	readonly request: SourceRequest;
	preempted: boolean;
	resolve(source: string): void;
	reject(error: Error): void;
}

export interface CachedSourceDescriptor {
	uri: string;
	displayPath: string;
	rootFilePath: string;
	content: string;
	readonly: true;
}

export interface CachedSourceListRequest {
	scopeKind: 'workspace' | 'directory';
	scopePath: string;
	recursive: boolean;
	workspaceRoots: string[];
	maxFiles: number;
	maxBytes: number;
	maxTotalBytes: number;
}

export interface CachedSourceListResult {
	sources: CachedSourceDescriptor[];
	pending: number;
	truncated: boolean;
}

export interface ClassSourceServiceOptions {
	decompile?(context: vscode.ExtensionContext, classFilePath: string, token: vscode.CancellationToken): Promise<string>;
	decompileArchive?(context: vscode.ExtensionContext, archivePath: string, outputDirectory: string, token: vscode.CancellationToken): Promise<void>;
	cfrIdentity?(): Promise<string>;
	backgroundDelayMs?: number;
	decompileTimeoutMs?: number;
}

function sha256(parts: readonly (string | Uint8Array)[]): string {
	const hash = crypto.createHash('sha256');
	for (const part of parts) {
		hash.update(part);
		hash.update('\0');
	}
	return hash.digest('hex');
}

async function fileHash(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

async function classpathIdentity(classpathEntry: string): Promise<string> {
	const resolved = path.resolve(classpathEntry);
	try {
		const stat = await fs.promises.stat(resolved);
		return stat.isFile()
			? sha256([resolved, await fileHash(resolved)])
			: sha256([resolved, String(stat.mtimeMs), String(stat.size)]);
	} catch {
		return sha256([resolved, 'missing']);
	}
}

function isEqualOrInside(candidate: string, parent: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isInScope(metadata: ClassSourceMetadata, request: CachedSourceListRequest): boolean {
	const root = metadata.rootFilePath;
	if (request.scopeKind === 'workspace') {
		return request.workspaceRoots.some(workspaceRoot => isEqualOrInside(root, workspaceRoot));
	}
	if (!request.scopePath) {
		return false;
	}
	if (request.recursive) {
		return isEqualOrInside(root, request.scopePath);
	}
	return path.dirname(path.resolve(root)).toLowerCase() === path.resolve(request.scopePath).toLowerCase();
}

interface DeadlineOptions {
	timeoutMs: number;
	message: string;
	onExpire(): void;
	/** Reports work done so far; a new value restarts the deadline. */
	progress?(): Promise<number>;
}

/**
 * Fails a decompiler run that stops making progress, so one stuck CFR process cannot hold the
 * queue forever. Without a progress probe the deadline is absolute.
 */
function withDeadline<T>(work: Promise<T>, options: DeadlineOptions): Promise<T> {
	if (options.timeoutMs <= 0) {
		return work;
	}
	return new Promise<T>((resolve, reject) => {
		let deadline = Date.now() + options.timeoutMs;
		let lastProgress = -1;
		let checking = false;
		const timer = setInterval(() => {
			if (checking) {
				return;
			}
			checking = true;
			void (async () => {
				try {
					if (options.progress) {
						const value = await options.progress().then(result => result, () => lastProgress);
						if (value !== lastProgress) {
							lastProgress = value;
							deadline = Date.now() + options.timeoutMs;
						}
					}
					if (Date.now() >= deadline) {
						clearInterval(timer);
						options.onExpire();
						reject(new Error(options.message));
					}
				} finally {
					checking = false;
				}
			})();
		}, Math.max(20, Math.min(Math.floor(options.timeoutMs / 2), DEADLINE_POLL)));
		work.then(
			value => {
				clearInterval(timer);
				resolve(value);
			},
			error => {
				clearInterval(timer);
				reject(error);
			});
	});
}

/** Counts the sources a batch run has written so far, used as its progress signal. */
async function countOutputs(directory: string): Promise<number> {
	let total = 0;
	const visit = async (current: string): Promise<void> => {
		for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				await visit(path.join(current, entry.name));
			} else if (entry.isFile()) {
				total++;
			}
		}
	};
	await visit(directory);
	return total;
}

interface JavaOutput {
	filePath: string;
	segments: string[];
}

async function collectJavaOutputs(root: string): Promise<JavaOutput[]> {
	const result: JavaOutput[] = [];
	const visit = async (directory: string, segments: string[]): Promise<void> => {
		for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
			const childSegments = [...segments, entry.name];
			const childPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(childPath, childSegments);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.java')) {
				result.push({ filePath: childPath, segments: childSegments });
			}
		}
	};
	await visit(root, []);
	return result;
}

function outputForClass(classUri: vscode.Uri, outputs: readonly JavaOutput[]): JavaOutput | undefined {
	const classSegments = classUri.path.split('/').filter(Boolean);
	classSegments[classSegments.length - 1] = path.posix.basename(outerClassUri(classUri).path).replace(/\.class$/i, '.java');
	const expectedName = classSegments[classSegments.length - 1];
	let best: JavaOutput | undefined;
	let bestScore = 0;
	let ambiguous = false;
	for (const output of outputs) {
		if (output.segments[output.segments.length - 1] !== expectedName) {
			continue;
		}
		let score = 0;
		while (score < output.segments.length && score < classSegments.length
			&& output.segments[output.segments.length - score - 1] === classSegments[classSegments.length - score - 1]) {
			score++;
		}
		if (score > bestScore) {
			best = output;
			bestScore = score;
			ambiguous = false;
		} else if (score === bestScore) {
			ambiguous = true;
		}
	}
	return ambiguous ? undefined : best;
}

/** Owns the shared source queue and persistent decompilation cache. */
export class ClassSourceService implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly cache: ClassSourceCache;
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly userQueue: QueueItem[] = [];
	private readonly backgroundQueue: QueueItem[] = [];
	private readonly archiveBacklog: ArchiveOpenedEvent[] = [];
	private readonly pending = new Map<string, { request: SourceRequest; promise: Promise<string> }>();
	private readonly scheduledArchives = new Set<string>();
	private readonly knownSourceUris = new Map<string, vscode.Uri>();
	private readonly memorySources = new Map<string, string>();
	private readonly typeIndexRebuilds = new Map<string, Promise<Map<string, TypeIndexRow[]>>>();
	private cfrIdentity: Promise<string> | undefined;
	private active: QueueItem | undefined;
	private activeCancellation: vscode.CancellationTokenSource | undefined;
	private activeArchiveCancellation: vscode.CancellationTokenSource | undefined;
	private archiveBacklogRunning = false;
	private archiveStartTimer: NodeJS.Timeout | undefined;
	private backgroundResumeAt = 0;
	private archiveCancellationGeneration = 0;
	private epoch = 0;
	private cacheWrites = 0;
	private backgroundFailureCount = 0;
	private disposed = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly archiveProvider: JarFileSystemProvider,
		private readonly options: ClassSourceServiceOptions = {}
	) {
		this.cache = new ClassSourceCache(context);
		this.subscriptions.push(
			archiveProvider.onDidOpenArchive(event => this.scheduleArchive(event)),
			archiveProvider.onDidChangeFile(() => void this.clearCache()),
			vscode.window.onDidChangeActiveTextEditor(() => this.preemptArchiveBackground()),
			vscode.window.onDidChangeTextEditorSelection(() => this.preemptArchiveBackground()),
			vscode.window.onDidChangeWindowState(state => {
				if (state.focused) {
					this.preemptArchiveBackground();
				}
			}),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('decom') || event.affectsConfiguration('vshoon.decom')) {
					this.cfrIdentity = undefined;
					void this.clearCache();
				}
			})
		);
	}

	provideTextDocumentContent(sourceUri: vscode.Uri): Promise<string> {
		this.knownSourceUris.set(sourceUri.toString(), sourceUri);
		const content = this.getSourceUriContent(sourceUri);
		this.reportSlowOpen(content);
		return content;
	}

	getSource(requestedUri: vscode.Uri, priority: 'user' | 'background' = 'user'): Promise<string> {
		if (priority === 'user') {
			this.preemptArchiveBackground();
		}
		const classUri = outerClassUri(requestedUri);
		const id = classUri.toString();
		const existing = this.pending.get(id);
		if (existing) {
			if (priority === 'user') {
				this.promote(existing.request);
			}
			return existing.promise;
		}
		const request: SourceRequest = { classUri, id, priority };
		const promise = this.resolveSource(request).finally(() => {
			if (this.pending.get(id)?.request === request) {
				this.pending.delete(id);
			}
		});
		this.pending.set(id, { request, promise });
		return promise;
	}

	getSourceUriContent(sourceUri: vscode.Uri): Promise<string> {
		return this.getSource(fromClassSourceUri(sourceUri), 'user');
	}

	async listCachedSources(request: CachedSourceListRequest, token?: vscode.CancellationToken): Promise<CachedSourceListResult> {
		const entries = await this.cache.entries();
		const rootChecks = new Map<string, Promise<boolean>>();
		const sources: CachedSourceDescriptor[] = [];
		let totalBytes = 0;
		let truncated = false;
		for (const entry of entries) {
			if (token?.isCancellationRequested) {
				truncated = true;
				break;
			}
			if (sources.length >= request.maxFiles || totalBytes >= request.maxTotalBytes) {
				truncated = true;
				break;
			}
			if (!isInScope(entry.metadata, request) || !await this.isRootCurrent(entry.metadata, rootChecks)) {
				continue;
			}
			try {
				const stat = await fs.promises.stat(entry.sourcePath);
				if (stat.size > request.maxBytes || totalBytes + stat.size > request.maxTotalBytes) {
					truncated = true;
					continue;
				}
				const cached = await this.cache.read(entry.metadata.key);
				if (!cached) {
					continue;
				}
				const content = cached.source;
				totalBytes += Buffer.byteLength(content);
				sources.push({
					uri: entry.metadata.sourceUri,
					displayPath: entry.metadata.displayPath,
					rootFilePath: entry.metadata.rootFilePath,
					content,
					readonly: true
				});
			} catch {
				// A cache entry can disappear while another window clears it.
			}
		}
		return { sources, pending: this.pendingCount(), truncated };
	}

	/**
	 * Returns the prepared sources of the same JAR that can declare one of the given types. The
	 * type index keeps a single navigation from reading every class of a large JAR.
	 */
	async getNavigationSources(sourceUri: vscode.Uri, typeNames: readonly string[]): Promise<CachedSourceDescriptor[]> {
		const current = await this.cache.metadataBySourceUri(sourceUri.toString());
		if (!current || typeNames.length === 0) {
			return [];
		}
		const index = await this.typeIndex(current.rootFilePath);
		const rootChecks = new Map<string, Promise<boolean>>();
		const visited = new Set<string>([current.key]);
		const result: CachedSourceDescriptor[] = [];
		for (const typeName of typeNames) {
			for (const row of index.get(typeName) ?? []) {
				if (visited.has(row.key)) {
					continue;
				}
				visited.add(row.key);
				const cached = await this.cache.read(row.key);
				if (!cached
					|| cached.metadata.rootFilePath !== current.rootFilePath
					|| !await this.isRootCurrent(cached.metadata, rootChecks)) {
					continue;
				}
				result.push({
					uri: cached.metadata.sourceUri,
					displayPath: cached.metadata.displayPath,
					rootFilePath: cached.metadata.rootFilePath,
					content: cached.source,
					readonly: true
				});
			}
		}
		return result;
	}

	/** Reads the persisted type index of one JAR, indexing entries written before it existed. */
	private async typeIndex(rootFilePath: string): Promise<Map<string, TypeIndexRow[]>> {
		const persisted = await this.cache.readTypeIndex(rootFilePath);
		if (persisted) {
			return persisted;
		}
		let rebuild = this.typeIndexRebuilds.get(rootFilePath);
		if (!rebuild) {
			rebuild = (async () => {
				const updates: TypeIndexUpdate[] = [];
				for (const entry of await this.cache.entries()) {
					if (entry.metadata.rootFilePath !== rootFilePath) {
						continue;
					}
					const cached = await this.cache.read(entry.metadata.key);
					if (cached) {
						updates.push({ sourceUri: cached.metadata.sourceUri, key: cached.metadata.key, typeNames: collectTypeNames(cached.source) });
					}
				}
				await this.cache.mergeTypeIndex(rootFilePath, updates);
				return await this.cache.readTypeIndex(rootFilePath) ?? new Map<string, TypeIndexRow[]>();
			})();
			this.typeIndexRebuilds.set(rootFilePath, rebuild);
		}
		return rebuild;
	}

	async clearCache(): Promise<void> {
		this.epoch++;
		this.archiveCancellationGeneration++;
		this.activeCancellation?.cancel();
		this.activeArchiveCancellation?.cancel();
		this.archiveBacklog.length = 0;
		this.cancelQueuedBackground();
		this.scheduledArchives.clear();
		this.memorySources.clear();
		this.typeIndexRebuilds.clear();
		await this.cache.clear();
		for (const sourceUri of this.knownSourceUris.values()) {
			this._onDidChange.fire(sourceUri);
		}
	}

	cancelPrecompile(): void {
		this.archiveCancellationGeneration++;
		this.archiveBacklog.length = 0;
		this.activeArchiveCancellation?.cancel();
		if (this.active?.request.priority === 'background') {
			this.activeCancellation?.cancel();
		}
		this.cancelQueuedBackground();
	}

	dispose(): void {
		this.disposed = true;
		this.archiveCancellationGeneration++;
		if (this.archiveStartTimer) {
			clearTimeout(this.archiveStartTimer);
			this.archiveStartTimer = undefined;
		}
		this.activeCancellation?.cancel();
		this.activeCancellation?.dispose();
		this.activeArchiveCancellation?.cancel();
		this.activeArchiveCancellation?.dispose();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.subscriptions.length = 0;
		this.archiveBacklog.length = 0;
		for (const item of [...this.userQueue.splice(0), ...this.backgroundQueue.splice(0)]) {
			item.reject(new Error(vscode.l10n.t('Decom이 종료되었습니다.')));
		}
		this._onDidChange.dispose();
		this.knownSourceUris.clear();
		this.memorySources.clear();
	}

	private scheduleArchive(event: ArchiveOpenedEvent): void {
		const config = vscode.workspace.getConfiguration('vshoon.decom');
		if (!config.get<boolean>('precompileOnExpand', true) || this.scheduledArchives.has(event.root.authority)) {
			return;
		}
		this.scheduledArchives.add(event.root.authority);
		this.archiveBacklog.push(event);
		this.scheduleArchiveBacklog();
	}

	private scheduleArchiveBacklog(): void {
		if (this.archiveStartTimer || this.archiveBacklogRunning || this.disposed) {
			return;
		}
		const configuredDelay = this.options.backgroundDelayMs ?? BACKGROUND_START_DELAY;
		const delay = Math.max(configuredDelay, this.backgroundResumeAt - Date.now(), 0);
		this.archiveStartTimer = setTimeout(() => {
			this.archiveStartTimer = undefined;
			void this.runArchiveBacklog();
		}, delay);
	}

	private async runArchiveBacklog(): Promise<void> {
		if (this.archiveBacklogRunning || this.disposed) {
			return;
		}
		this.archiveBacklogRunning = true;
		try {
			while (!this.disposed) {
				const wait = this.backgroundResumeAt - Date.now();
				if (wait > 0) {
					await new Promise(resolve => setTimeout(resolve, wait));
					continue;
				}
				const event = this.archiveBacklog.shift();
				if (!event) {
					return;
				}
				const cancellation = new vscode.CancellationTokenSource();
				const cancellationGeneration = this.archiveCancellationGeneration;
				this.activeArchiveCancellation = cancellation;
				try {
					await this.precompileArchive(event, cancellation.token);
				} catch (error) {
					if (cancellation.token.isCancellationRequested && !this.disposed && cancellationGeneration === this.archiveCancellationGeneration) {
						this.archiveBacklog.unshift(event);
					} else {
						log(`JAR 일괄 디컴파일 실패: ${event.resource.toString()} - ${error instanceof Error ? error.message : String(error)}`);
					}
				} finally {
					cancellation.dispose();
					if (this.activeArchiveCancellation === cancellation) {
						this.activeArchiveCancellation = undefined;
					}
				}
			}
		} finally {
			this.archiveBacklogRunning = false;
			if (this.archiveBacklog.length > 0) {
				this.scheduleArchiveBacklog();
			}
		}
	}

	private async precompileArchive(event: ArchiveOpenedEvent, token: vscode.CancellationToken): Promise<void> {
		const location = this.archiveProvider.getArchiveLocation(event.root);
		if (!location) {
			throw new Error(vscode.l10n.t('Decom: JAR 위치를 확인할 수 없습니다.'));
		}
		const rootStat = await fs.promises.stat(location.rootFilePath);
		const toolIdentity = await this.getCfrIdentity();
		const archiveUri = event.root.toString();
		const marker = await this.cache.readArchiveMarker(archiveUri);
		if (marker
			&& path.resolve(marker.rootFilePath) === path.resolve(location.rootFilePath)
			&& marker.rootMtime === rootStat.mtimeMs
			&& marker.rootSize === rootStat.size
			&& marker.toolIdentity === toolIdentity) {
			log(`JAR 사전 디컴파일 캐시 재사용: ${event.resource.toString()} (${marker.preparedSources}개 소스)`);
			return;
		}

		const maxClasses = Math.max(1, vscode.workspace.getConfiguration('vshoon.decom').get<number>('precompileMaxClasses', 5000));
		const families = new Map<string, vscode.Uri>();
		for (const classUri of this.archiveProvider.listClassFiles(event.root)) {
			const outerUri = outerClassUri(classUri);
			families.set(outerUri.toString(), outerUri);
			if (families.size > maxClasses) {
				log(`JAR 사전 디컴파일 생략: ${event.resource.toString()} (클래스 묶음이 제한 ${maxClasses}개를 초과함)`);
				return;
			}
		}
		if (families.size === 0 || token.isCancellationRequested) {
			return;
		}

		const parent = path.join(this.context.globalStorageUri.fsPath, 'archive-input');
		await fs.promises.mkdir(parent, { recursive: true });
		const temporaryDirectory = await fs.promises.mkdtemp(path.join(parent, 'precompile-'));
		const outputDirectory = path.join(temporaryDirectory, 'sources');
		await fs.promises.mkdir(outputDirectory, { recursive: true });
		let archivePath = event.resource.scheme === 'file' ? event.resource.fsPath : '';
		try {
			if (!archivePath) {
				archivePath = path.join(temporaryDirectory, 'nested.jar');
				await fs.promises.writeFile(archivePath, await this.archiveProvider.readFile(event.resource));
			}
			log(`JAR 일괄 디컴파일 시작: ${event.resource.toString()} (${families.size}개 클래스 묶음)`);
			const started = Date.now();
			await this.runWithDeadline(
				token,
				runToken => (this.options.decompileArchive ?? decompileArchive)(this.context, archivePath, outputDirectory, runToken),
				seconds => vscode.l10n.t('Decom: JAR 일괄 디컴파일이 {0}초 동안 진행되지 않아 중단했습니다.', seconds),
				() => countOutputs(outputDirectory));
			if (token.isCancellationRequested) {
				throw new Error(vscode.l10n.t('Decom 디컴파일 작업이 취소되었습니다.'));
			}
			const outputs = await collectJavaOutputs(outputDirectory);
			const indexUpdates: TypeIndexUpdate[] = [];
			let preparedSources = 0;
			for (const classUri of families.values()) {
				if (token.isCancellationRequested) {
					throw new Error(vscode.l10n.t('Decom 디컴파일 작업이 취소되었습니다.'));
				}
				const output = outputForClass(classUri, outputs);
				if (!output) {
					continue;
				}
				const source = await fs.promises.readFile(output.filePath, 'utf8');
				const sourceUri = toClassSourceUri(classUri);
				const key = sha256(['archive-batch-v1', sourceUri.toString(), toolIdentity, source]);
				await this.cache.write({
					key,
					classUri: classUri.toString(),
					sourceUri: sourceUri.toString(),
					displayPath: this.archiveProvider.getArchiveLocation(classUri)?.displayPath ?? classUri.path,
					rootFilePath: location.rootFilePath,
					rootMtime: rootStat.mtimeMs,
					rootSize: rootStat.size
				}, source);
				indexUpdates.push({ sourceUri: sourceUri.toString(), key, typeNames: collectTypeNames(source) });
				this.rememberSource(sourceUri.toString(), source);
				this._onDidChange.fire(sourceUri);
				preparedSources++;
			}
			await this.cache.mergeTypeIndex(location.rootFilePath, indexUpdates);
			await this.cache.writeArchiveMarker({
				archiveUri,
				rootFilePath: location.rootFilePath,
				rootMtime: rootStat.mtimeMs,
				rootSize: rootStat.size,
				toolIdentity,
				preparedSources
			});
			const maxCacheMb = Math.max(16, vscode.workspace.getConfiguration('vshoon.decom').get<number>('cacheMaxSizeMb', 512));
			await this.cache.trim(maxCacheMb * 1024 * 1024);
			log(`JAR 일괄 디컴파일 완료: ${event.resource.toString()} (${preparedSources}개 소스, ${Date.now() - started}ms)`);
		} finally {
			await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	private preemptArchiveBackground(): void {
		const resumeDelay = this.options.backgroundDelayMs ?? BACKGROUND_RESUME_DELAY;
		this.backgroundResumeAt = Date.now() + resumeDelay;
		if (this.archiveStartTimer) {
			clearTimeout(this.archiveStartTimer);
			this.archiveStartTimer = undefined;
			this.scheduleArchiveBacklog();
		}
		this.activeArchiveCancellation?.cancel();
	}

	private async resolveSource(request: SourceRequest): Promise<string> {
		const cached = await this.readCachedSource(request.classUri);
		if (cached !== undefined) {
			return cached;
		}
		if (this.disposed) {
			throw new Error(vscode.l10n.t('Decom이 종료되었습니다.'));
		}
		return new Promise<string>((resolve, reject) => {
			this.enqueue({ request, preempted: false, resolve, reject });
			if (request.priority === 'user') {
				this.preemptBackground(request);
			}
			this.pump();
		});
	}

	private pump(): void {
		if (this.active || this.disposed) {
			return;
		}
		const item = this.userQueue.shift() ?? this.backgroundQueue.shift();
		if (!item) {
			return;
		}
		this.active = item;
		const cancellation = new vscode.CancellationTokenSource();
		this.activeCancellation = cancellation;
		const timeoutMs = this.decompileTimeoutMs();
		let timedOut = false;
		const settle = (action: () => void) => {
			cancellation.dispose();
			if (this.activeCancellation === cancellation) {
				this.activeCancellation = undefined;
			}
			this.active = undefined;
			item.request.queued = undefined;
			action();
			this.pump();
		};
		const work = withDeadline(this.createSource(item.request.classUri, cancellation.token), {
			timeoutMs,
			message: vscode.l10n.t('Decom: 디컴파일이 {0}초 안에 끝나지 않아 중단했습니다.', Math.round(timeoutMs / 1000)),
			onExpire: () => {
				timedOut = true;
				cancellation.cancel();
			}
		});
		void work.then(
			source => settle(() => item.resolve(source)),
			error => {
				if (item.preempted && !timedOut && !this.disposed) {
					item.preempted = false;
					settle(() => this.enqueue(item));
					return;
				}
				this.logBackgroundFailure(item, error);
				settle(() => item.reject(error instanceof Error ? error : new Error(String(error))));
			}
		);
	}

	private enqueue(item: QueueItem): void {
		item.request.queued = item;
		(item.request.priority === 'user' ? this.userQueue : this.backgroundQueue).push(item);
	}

	/** Moves a class the user just opened ahead of the precompile backlog. */
	private promote(request: SourceRequest): void {
		if (request.priority === 'user') {
			return;
		}
		request.priority = 'user';
		const queued = request.queued;
		const index = queued ? this.backgroundQueue.indexOf(queued) : -1;
		if (queued && index >= 0) {
			this.backgroundQueue.splice(index, 1);
			this.userQueue.push(queued);
		}
		this.preemptBackground(request);
	}

	/** Stops the running precompile job so the user's class starts without waiting for CFR. */
	private preemptBackground(requester: SourceRequest): void {
		const active = this.active;
		if (!active || active.preempted || active.request === requester || active.request.priority !== 'background') {
			return;
		}
		active.preempted = true;
		this.activeCancellation?.cancel();
	}

	private logBackgroundFailure(item: QueueItem, error: unknown): void {
		if (item.request.priority !== 'background') {
			return;
		}
		this.backgroundFailureCount++;
		if (this.backgroundFailureCount <= 5) {
			log(`백그라운드 디컴파일 실패: ${item.request.id} - ${error instanceof Error ? error.message : String(error)}`);
		} else if (this.backgroundFailureCount === 6) {
			log('백그라운드 디컴파일 실패가 반복되어 이후 오류 로그를 생략합니다.');
		}
	}

	/** Returns a prepared source from memory or the persistent cache without materializing bytes. */
	private async readCachedSource(classUri: vscode.Uri): Promise<string | undefined> {
		const sourceUri = toClassSourceUri(classUri);
		const id = sourceUri.toString();
		const remembered = this.memorySources.get(id);
		if (remembered !== undefined) {
			this.rememberSource(id, remembered);
			return remembered;
		}
		const cached = await this.cache.findBySourceUri(id);
		if (!cached || !await this.isRootCurrent(cached.metadata)) {
			return undefined;
		}
		this.rememberSource(id, cached.source);
		return cached.source;
	}

	private rememberSource(sourceUri: string, source: string): void {
		this.memorySources.delete(sourceUri);
		this.memorySources.set(sourceUri, source);
		for (const oldest of this.memorySources.keys()) {
			if (this.memorySources.size <= MEMORY_SOURCE_LIMIT) {
				break;
			}
			this.memorySources.delete(oldest);
		}
	}

	/** Runs one decompiler job under the configured deadline, cancelling it when the deadline passes. */
	private async runWithDeadline<T>(
		token: vscode.CancellationToken,
		start: (runToken: vscode.CancellationToken) => Promise<T>,
		message: (seconds: number) => string,
		progress?: () => Promise<number>
	): Promise<T> {
		const timeoutMs = this.decompileTimeoutMs();
		const cancellation = new vscode.CancellationTokenSource();
		const link = token.onCancellationRequested(() => cancellation.cancel());
		if (token.isCancellationRequested) {
			cancellation.cancel();
		}
		try {
			return await withDeadline(start(cancellation.token), {
				timeoutMs,
				message: message(Math.round(timeoutMs / 1000)),
				onExpire: () => cancellation.cancel(),
				progress
			});
		} finally {
			link.dispose();
			cancellation.dispose();
		}
	}

	/** Milliseconds a decompiler run may make no progress before it is stopped; 0 disables the limit. */
	private decompileTimeoutMs(): number {
		if (this.options.decompileTimeoutMs !== undefined) {
			return this.options.decompileTimeoutMs;
		}
		const seconds = vscode.workspace.getConfiguration('vshoon.decom').get<number>('decompileTimeoutSec', DECOMPILE_TIMEOUT / 1000);
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
	}

	private pendingCount(): number {
		return this.userQueue.length + this.backgroundQueue.length + this.archiveBacklog.length + (this.active ? 1 : 0) + (this.activeArchiveCancellation ? 1 : 0);
	}

	/** Explains a wait the user can see, without flashing a notice for a class served from cache. */
	private reportSlowOpen(work: Promise<string>): void {
		const settled = work.then(() => undefined, () => undefined);
		const timer = setTimeout(() => {
			void vscode.window.withProgress({
				location: vscode.ProgressLocation.Window,
				title: vscode.l10n.t('Decom: 클래스를 디컴파일하는 중...')
			}, () => settled);
		}, SLOW_OPEN_NOTICE_DELAY);
		void settled.finally(() => clearTimeout(timer));
	}

	private async createSource(classUri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		const startedAt = this.epoch;
		const materialized = await materializeClass(this.context, classUri);
		try {
			const inputFingerprint = materialized.family
				? sha256(materialized.family.flatMap(entry => [entry.name, entry.bytes]))
				: await this.classInputFingerprint(materialized.filePath);
			const toolIdentity = await this.getCfrIdentity();
			// The fingerprint covers the whole outer/inner family, so the target name has to be part of
			// the key as well. Without it a nested class would reuse the entry of its outer class.
			const key = sha256([inputFingerprint, toolIdentity, path.posix.basename(classUri.path)]);
			const existing = await this.cache.read(key);
			if (existing) {
				this.rememberSource(existing.metadata.sourceUri, existing.source);
				return existing.source;
			}
			const source = await (this.options.decompile ?? decompileSingleClass)(this.context, materialized.filePath, token);
			if (token.isCancellationRequested) {
				throw new Error(vscode.l10n.t('Decom 디컴파일 작업이 취소되었습니다.'));
			}
			const sourceUri = toClassSourceUri(classUri);
			const location = this.archiveProvider.getArchiveLocation(classUri);
			const rootFilePath = location?.rootFilePath ?? classUri.fsPath;
			const rootStat = await fs.promises.stat(rootFilePath);
			if (startedAt !== this.epoch) {
				return source;
			}
			await this.cache.write({
				key,
				classUri: classUri.toString(),
				sourceUri: sourceUri.toString(),
				displayPath: location?.displayPath ?? classUri.fsPath,
				rootFilePath,
				rootMtime: rootStat.mtimeMs,
				rootSize: rootStat.size
			}, source);
			await this.cache.mergeTypeIndex(rootFilePath, [{ sourceUri: sourceUri.toString(), key, typeNames: collectTypeNames(source) }]);
			this.rememberSource(sourceUri.toString(), source);
			this.cacheWrites++;
			if (this.cacheWrites === 1 || this.cacheWrites % 50 === 0) {
				const maxCacheMb = Math.max(16, vscode.workspace.getConfiguration('vshoon.decom').get<number>('cacheMaxSizeMb', 512));
				await this.cache.trim(maxCacheMb * 1024 * 1024);
			}
			this._onDidChange.fire(sourceUri);
			return source;
		} finally {
			materialized.dispose();
		}
	}

	private async classInputFingerprint(classFilePath: string): Promise<string> {
		const stat = await fs.promises.stat(classFilePath);
		if (!stat.isFile()) {
			throw new Error(vscode.l10n.t('Decom: Class 입력 파일을 찾을 수 없습니다.'));
		}
		const directory = path.dirname(classFilePath);
		const targetName = path.basename(classFilePath);
		const outerStem = targetName.slice(0, -'.class'.length).split('$', 1)[0];
		const names = (await fs.promises.readdir(directory))
			.filter(name => name === `${outerStem}.class` || (name.startsWith(`${outerStem}$`) && name.endsWith('.class')))
			.sort();
		const parts: (string | Buffer)[] = [];
		for (const name of names) {
			parts.push(name, await fs.promises.readFile(path.join(directory, name)));
		}
		return sha256(parts);
	}

	private getCfrIdentity(): Promise<string> {
		if (this.options.cfrIdentity) {
			return this.options.cfrIdentity();
		}
		this.cfrIdentity ??= (async () => {
			const cfrPath = await ensureCfrJar(this.context);
			const config = getConfig();
			const extraClasspathIdentity = await Promise.all(config.extraClasspath.map(classpathIdentity));
			return sha256([
				await fileHash(cfrPath),
				config.javaExecutable,
				config.cfrExtraOptions,
				...extraClasspathIdentity
			]);
		})();
		return this.cfrIdentity;
	}

	private isRootCurrent(metadata: ClassSourceMetadata, checks?: Map<string, Promise<boolean>>): Promise<boolean> {
		const resolved = path.resolve(metadata.rootFilePath);
		const key = `${process.platform === 'win32' ? resolved.toLowerCase() : resolved}\0${metadata.rootSize}\0${metadata.rootMtime}`;
		const existing = checks?.get(key);
		if (existing) {
			return existing;
		}
		const result = fs.promises.stat(metadata.rootFilePath).then(stat => stat.isFile()
			&& stat.size === metadata.rootSize
			&& stat.mtimeMs === metadata.rootMtime, () => false);
		checks?.set(key, result);
		return result;
	}

	private cancelQueuedBackground(): void {
		for (const item of this.backgroundQueue.splice(0)) {
			item.request.queued = undefined;
			item.reject(new Error(vscode.l10n.t('Decom 백그라운드 디컴파일이 취소되었습니다.')));
		}
	}
}
