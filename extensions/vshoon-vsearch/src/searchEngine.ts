/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { FileResult, MatchItem, SearchQuery } from './types';
import { decodeText, escapeRegExp, isBinary } from './matcher';
import { WorkerMessage, WorkerOptions, WorkerRequest, WorkerSearchRequest } from './searchWorker';
import { collectDirtyTexts } from './dirtyTexts';

export { buildMatcher, escapeRegExp, expandReplacement, findMatches, splitLines } from './matcher';

/**
 * 매칭 워커가 이 시간 안에 끝나지 않으면 강제로 끊는다.
 * 정규식 백트래킹이 폭발하면(예: `(a+)+$`) 영원히 끝나지 않기 때문이다.
 */
const SEARCH_TIMEOUT_MS = 15000;

export interface SearchStats {
  fileCount: number;
  matchCount: number;
  truncated: boolean;
}

export interface EngineConfig {
  maxFileSizeKb: number;
  maxFiles: number;
  maxResultFiles: number;
  maxMatchesPerFile: number;
  excludeGlobs: string[];
  maxPreviewSizeKb: number;
}

export function getConfig(): EngineConfig {
  const c = vscode.workspace.getConfiguration('vsearch');
  return {
    maxFileSizeKb: c.get<number>('maxFileSizeKb', 5120),
    maxFiles: c.get<number>('maxFiles', 20000),
    maxResultFiles: c.get<number>('maxResultFiles', 3000),
    maxMatchesPerFile: c.get<number>('maxMatchesPerFile', 500),
    excludeGlobs: c.get<string[]>('excludeGlobs', []),
    maxPreviewSizeKb: c.get<number>('maxPreviewSizeKb', 2048)
  };
}

/* ------------------------------------------------------------------ *
 * 파일 읽기
 * ------------------------------------------------------------------ */

/**
 * Electron 은 `.asar` 를 건드리면 아카이브로 열고 프로세스가 끝날 때까지 핸들을 쥐고 있다.
 * 그러면 패키지 빌드가 그 파일을 지우지 못하므로 검색 대상에서 아예 뺀다. (어차피 바이너리다)
 */
function isAsar(filePath: string): boolean {
  return /\.asar$/i.test(filePath);
}

/** 편집 중(저장되지 않은) 문서는 디스크 대신 메모리 내용을 사용한다. */
function dirtyDocumentText(uri: vscode.Uri): string | undefined {
  const key = uri.toString();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.toString() === key) {
      return doc.getText();
    }
  }
  return undefined;
}

/**
 * 검색용으로 파일 내용을 읽는다.
 * - 크기 제한 초과 / 바이너리 파일은 null 을 돌려준다.
 * - file 스킴은 node fs 로 (빠름), 그 외(원격 등)는 workspace.fs 로 읽는다.
 */
export async function readTextFile(uri: vscode.Uri, maxBytes: number): Promise<string | null> {
  const dirty = dirtyDocumentText(uri);
  if (dirty !== undefined) {
    return dirty;
  }
  if (isAsar(uri.path)) {
    return null;
  }
  try {
    if (uri.scheme === 'file') {
      const stat = await fs.promises.stat(uri.fsPath);
      if (!stat.isFile() || stat.size > maxBytes) {
        return null;
      }
      const buf = await fs.promises.readFile(uri.fsPath);
      return isBinary(buf) ? null : decodeText(buf);
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxBytes) {
      return null;
    }
    const buf = await vscode.workspace.fs.readFile(uri);
    return isBinary(buf) ? null : decodeText(buf);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 대상 파일 수집
 * ------------------------------------------------------------------ */

function splitMask(mask: string): string[] {
  return mask
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function maskToGlobBody(mask: string): string | undefined {
  const parts = splitMask(mask);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.length === 1 ? parts[0] : `{${parts.join(',')}}`;
}

/** files.exclude / search.exclude 설정 중 켜져 있는 패턴을 모은다. */
function defaultExcludePatterns(): string[] {
  const out: string[] = [];
  for (const key of ['files.exclude', 'search.exclude']) {
    const conf = vscode.workspace.getConfiguration().get<Record<string, unknown>>(key) ?? {};
    for (const [pattern, value] of Object.entries(conf)) {
      if (value === true) {
        out.push(pattern);
      }
    }
  }
  return out;
}

function buildExcludeGlob(config: EngineConfig): string | undefined {
  const patterns = new Set<string>([...defaultExcludePatterns(), ...config.excludeGlobs]);
  const list = [...patterns];
  if (list.length === 0) {
    return undefined;
  }
  return list.length === 1 ? list[0] : `{${list.join(',')}}`;
}

function isInsideWorkspace(dirPath: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const normalized = path.resolve(dirPath).toLowerCase();
  return folders.some((f) => {
    const root = path.resolve(f.uri.fsPath).toLowerCase();
    return normalized === root || normalized.startsWith(root + path.sep);
  });
}

function maskToRegExp(mask: string): RegExp {
  const body = splitMask(mask)
    .map((s) => '^' + escapeRegExp(s).replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$')
    .join('|');
  return new RegExp(body || '.*', 'i');
}

const FALLBACK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'out',
  'dist',
  'build',
  'target',
  '.idea',
  '.vscode-test'
]);

/** 워크스페이스 밖 디렉터리를 검색할 때 사용하는 직접 순회 방식. */
async function walkDirectory(
  root: string,
  recursive: boolean,
  maskRe: RegExp | undefined,
  limit: number,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const result: vscode.Uri[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && result.length < limit) {
    if (token.isCancellationRequested) {
      break;
    }
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.length >= limit) {
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !FALLBACK_SKIP_DIRS.has(entry.name)) {
          stack.push(full);
        }
      } else if (entry.isFile() && !isAsar(entry.name)) {
        if (!maskRe || maskRe.test(entry.name)) {
          result.push(vscode.Uri.file(full));
        }
      }
    }
  }
  return result;
}

/** 검색 대상 파일 목록을 만든다. */
export async function collectFiles(
  query: SearchQuery,
  config: EngineConfig,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const useDirectory = query.scopeKind === 'directory' && query.scopePath.trim().length > 0;

  // 워크스페이스 밖 경로는 findFiles 가 지원하지 않으므로 직접 순회한다.
  if (useDirectory && !isInsideWorkspace(query.scopePath)) {
    const maskRe = query.fileMask.trim() ? maskToRegExp(query.fileMask) : undefined;
    return walkDirectory(path.resolve(query.scopePath), query.recursive, maskRe, config.maxFiles, token);
  }

  const globBody = maskToGlobBody(query.fileMask) ?? '*';
  let include: vscode.GlobPattern;
  if (useDirectory) {
    const base = vscode.Uri.file(path.resolve(query.scopePath));
    include = new vscode.RelativePattern(base, query.recursive ? `**/${globBody}` : globBody);
  } else {
    include = `**/${globBody}`;
  }
  const exclude = buildExcludeGlob(config);
  return vscode.workspace.findFiles(include, exclude, config.maxFiles, token);
}

/* ------------------------------------------------------------------ *
 * 검색 실행
 * ------------------------------------------------------------------ */

export function toFileResult(uri: vscode.Uri, matches: MatchItem[], truncated: boolean): FileResult {
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const relPath = vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
  const slash = relPath.lastIndexOf('/');
  return {
    uri: uri.toString(),
    fsPath: uri.fsPath,
    relPath,
    dir: slash >= 0 ? relPath.slice(0, slash) : '',
    name: slash >= 0 ? relPath.slice(slash + 1) : relPath,
    matches,
    truncated
  };
}

/** 메모리에 보관할 파일 내용의 상한 */
const CONTENT_CACHE_BYTES = 256 * 1024 * 1024;
/** 파일 목록을 이 시간보다 오래 쓰면 결과는 그대로 쓰고 다음 검색을 위해 뒤에서 새로 만든다. */
const FILE_LIST_REFRESH_MS = 10_000;
const FILE_LIST_CACHE_SIZE = 4;

interface FileList {
  readonly paths: string[];
  readonly createdAt: number;
}

interface FileListEntry {
  list: Promise<FileList>;
  refreshing: boolean;
  readonly watcher: vscode.Disposable | undefined;
}

interface CompletedSearch {
  readonly listKey: string;
  readonly list: FileList;
  readonly query: SearchQuery;
  readonly matchedPaths: string[];
}

interface PendingSearch {
  readonly stats: SearchStats;
  readonly matchedPaths: string[];
  readonly onBatch: (files: FileResult[]) => void;
  readonly resolve: (stats: SearchStats) => void;
  readonly reject: (error: Error) => void;
}

export interface SearchOptions {
  /** false 이면 다음 검색이 시작되어도 끝까지 수행한다. 기본값 true */
  preemptible?: boolean;
}

/**
 * 입력할 때마다 곧바로 결과를 낼 수 있게 검색 사이의 상태를 보관한다.
 *
 * - 범위별 파일 목록: 파일 생성·삭제와 설정 변경 때 버린다.
 * - 파일 내용: 워커가 메모리에 보관하고, 바뀐 파일만 다시 읽는다.
 * - 직전 결과: 검색어가 직전 검색어를 포함하도록 길어지면 직전에 일치한 파일만 다시 검사한다.
 */
export class SearchEngine implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fileLists = new Map<string, FileListEntry>();
  private readonly pending = new Map<number, PendingSearch>();
  private readonly currentSearch = new Int32Array(new SharedArrayBuffer(4));
  private worker: Worker | undefined;
  private nextId = 1;
  private previous: CompletedSearch | undefined;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      ...this.watch(watcher),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === 'file' && event.contentChanges.length > 0) {
          this.previous = undefined;
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => this.invalidate(document.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.dropFileLists()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (['files.exclude', 'search.exclude', 'vsearch'].some((section) => event.affectsConfiguration(section))) {
          this.dropFileLists();
        }
      })
    );
  }

  /** 검색어를 입력하기 전에 범위의 파일 목록과 내용을 미리 읽어 둔다. */
  async warm(query: SearchQuery, config: EngineConfig): Promise<void> {
    const list = await this.getFileList(query, config, undefined);
    const request: WorkerRequest = { type: 'warm', paths: list.paths, maxBytes: config.maxFileSizeKb * 1024 };
    this.ensureWorker().postMessage(request);
  }

  /**
   * 검색을 실행한다. 결과는 onBatch 로 나눠 전달되어 UI 가 즉시 반응할 수 있다.
   *
   * 매칭은 워커 스레드에서 수행한다. 새 검색이 시작되거나 취소되면 진행 중인 매칭은 바로 멈추고,
   * SEARCH_TIMEOUT_MS 를 넘기면 워커를 강제 종료해서 폭주하는 정규식이 확장 호스트를 멈추지 못하게 한다.
   */
  async runSearch(
    query: SearchQuery,
    config: EngineConfig,
    token: vscode.CancellationToken,
    onBatch: (files: FileResult[]) => void,
    options: SearchOptions = {}
  ): Promise<SearchStats> {
    const empty: SearchStats = { fileCount: 0, matchCount: 0, truncated: false };
    if (query.query.length === 0) {
      return empty;
    }
    const preemptible = options.preemptible ?? true;
    const id = this.nextId++;
    if (preemptible) {
      // 이전 검색을 지금 멈춘다. 파일 목록을 기다리는 동안 워커가 헛돌지 않게 한다.
      Atomics.store(this.currentSearch, 0, id);
    }

    const listKey = fileListKey(query, config);
    const list = await this.getFileList(query, config, token);
    if (!list || token.isCancellationRequested || list.paths.length === 0) {
      return empty;
    }
    const paths = this.narrow(listKey, list, query) ?? list.paths;
    return this.match(id, preemptible, paths, query, config, token, onBatch, (matchedPaths) => {
      this.previous = { listKey, list, query, matchedPaths };
    });
  }

  dispose(): void {
    this.rejectPending(new Error('검색이 중단되었습니다.'));
    void this.worker?.terminate();
    this.worker = undefined;
    this.dropFileLists();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  /** 직전 검색 결과로 대상을 줄일 수 있으면 줄인 목록을 돌려준다. */
  private narrow(listKey: string, list: FileList, query: SearchQuery): string[] | undefined {
    const previous = this.previous;
    if (
      !previous ||
      previous.listKey !== listKey ||
      previous.list !== list ||
      query.regex ||
      query.wholeWord ||
      previous.query.regex ||
      previous.query.wholeWord ||
      previous.query.caseSensitive !== query.caseSensitive
    ) {
      return undefined;
    }
    if (query.caseSensitive) {
      return query.query.includes(previous.query.query) ? previous.matchedPaths : undefined;
    }
    // 대소문자 무시 비교가 toLowerCase 비교와 같다고 확신할 수 있는 ASCII 검색어만 줄인다.
    const ascii = /^[\x20-\x7e]*$/;
    if (!ascii.test(previous.query.query) || !ascii.test(query.query)) {
      return undefined;
    }
    return query.query.toLowerCase().includes(previous.query.query.toLowerCase()) ? previous.matchedPaths : undefined;
  }

  private match(
    id: number,
    preemptible: boolean,
    paths: string[],
    query: SearchQuery,
    config: EngineConfig,
    token: vscode.CancellationToken,
    onBatch: (files: FileResult[]) => void,
    onComplete: (matchedPaths: string[]) => void
  ): Promise<SearchStats> {
    const request: WorkerSearchRequest = {
      type: 'search',
      id,
      preemptible,
      paths,
      dirty: collectDirtyTexts(paths, vscode.workspace.textDocuments),
      pattern: query.query,
      regex: query.regex,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      maxBytes: config.maxFileSizeKb * 1024,
      maxMatchesPerFile: config.maxMatchesPerFile,
      maxResultFiles: config.maxResultFiles
    };

    return new Promise<SearchStats>((resolve, reject) => {
      const stats: SearchStats = { fileCount: 0, matchCount: 0, truncated: false };
      const matchedPaths: string[] = [];
      const cleanup = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        cancelSubscription.dispose();
      };
      const timer = setTimeout(() => {
        // 멈추지 않는 정규식은 워커째 버린다. 보관하던 내용은 다음 검색에서 다시 읽는다.
        this.resetWorker(
          new Error(
            '검색이 너무 오래 걸려 중단했습니다. 정규식이 지나치게 복잡하지 않은지 확인해 주세요. ' +
              '(예: (a+)+ 처럼 수량자가 중첩된 패턴)'
          )
        );
      }, SEARCH_TIMEOUT_MS);
      const cancelSubscription = token.onCancellationRequested(() => {
        // 새 검색이 이미 id 를 바꿨다면 그대로 둔다.
        Atomics.compareExchange(this.currentSearch, 0, id, 0);
        cleanup();
        resolve(stats);
      });
      this.pending.set(id, {
        stats,
        matchedPaths,
        onBatch,
        resolve: (result) => {
          cleanup();
          if (!result.truncated) {
            onComplete(matchedPaths);
          }
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      this.ensureWorker().postMessage(request);
    });
  }

  private onWorkerMessage(message: WorkerMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    if (message.type === 'batch') {
      const results = message.files.map((file) => toFileResult(vscode.Uri.file(file.fsPath), file.matches, file.truncated));
      pending.stats.fileCount += results.length;
      for (const file of message.files) {
        pending.stats.matchCount += file.matches.length;
        pending.matchedPaths.push(file.fsPath);
      }
      pending.onBatch(results);
    } else if (message.type === 'done') {
      // 도중에 멈춘 결과는 직전 결과로 쓰지 않도록 잘린 것으로 취급한다.
      pending.stats.truncated = message.truncated || message.cancelled;
      pending.resolve(pending.stats);
    } else {
      pending.reject(new Error(message.message));
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const options: WorkerOptions = { currentSearch: this.currentSearch.buffer as SharedArrayBuffer, cacheBytes: CONTENT_CACHE_BYTES };
    const worker = new Worker(path.join(__dirname, 'searchWorker.js'), { workerData: options });
    worker.on('message', (message: WorkerMessage) => this.onWorkerMessage(message));
    worker.on('error', (error: Error) => {
      if (this.worker === worker) {
        this.resetWorker(error);
      }
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.resetWorker(new Error(`검색 작업이 예기치 않게 끝났습니다. (code ${code})`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private resetWorker(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    this.previous = undefined;
    void worker?.terminate();
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      pending.reject(error);
    }
  }

  private watch(watcher: vscode.FileSystemWatcher): vscode.Disposable[] {
    return [
      watcher.onDidCreate(() => this.dropFileLists()),
      watcher.onDidDelete((uri) => {
        this.dropFileLists();
        this.invalidate(uri);
      }),
      watcher.onDidChange((uri) => this.invalidate(uri))
    ];
  }

  private invalidate(uri: vscode.Uri): void {
    this.previous = undefined;
    if (uri.scheme === 'file') {
      const request: WorkerRequest = { type: 'invalidate', paths: [uri.fsPath] };
      this.worker?.postMessage(request);
    }
  }

  private dropFileLists(): void {
    this.previous = undefined;
    for (const entry of this.fileLists.values()) {
      entry.watcher?.dispose();
    }
    this.fileLists.clear();
  }

  /** 범위의 파일 목록을 돌려준다. 검색이 취소되면 목록을 기다리지 않고 undefined 를 돌려준다. */
  private getFileList(query: SearchQuery, config: EngineConfig, token: undefined): Promise<FileList>;
  private getFileList(query: SearchQuery, config: EngineConfig, token: vscode.CancellationToken): Promise<FileList | undefined>;
  private async getFileList(query: SearchQuery, config: EngineConfig, token: vscode.CancellationToken | undefined): Promise<FileList | undefined> {
    const key = fileListKey(query, config);
    let entry = this.fileLists.get(key);
    if (entry) {
      // 최근에 쓴 범위를 뒤로 보내 먼저 밀려나지 않게 한다.
      this.fileLists.delete(key);
      this.fileLists.set(key, entry);
    } else {
      entry = { list: this.buildFileList(query, config), refreshing: false, watcher: this.createOutsideWatcher(query) };
      this.fileLists.set(key, entry);
      while (this.fileLists.size > FILE_LIST_CACHE_SIZE) {
        const oldestKey = this.fileLists.keys().next().value as string;
        this.fileLists.get(oldestKey)?.watcher?.dispose();
        this.fileLists.delete(oldestKey);
      }
    }
    const current = entry;
    let list: FileList | undefined;
    try {
      list = token ? await untilCancelled(current.list, token) : await current.list;
    } catch (error) {
      if (this.fileLists.get(key) === current) {
        this.fileLists.delete(key);
        current.watcher?.dispose();
      }
      throw error;
    }
    if (list && !current.refreshing && Date.now() - list.createdAt > FILE_LIST_REFRESH_MS) {
      // 감시에서 빠진 폴더의 생성·삭제도 결국 반영되도록 뒤에서 목록을 다시 만든다.
      current.refreshing = true;
      const refreshed = this.buildFileList(query, config);
      refreshed.then(
        () => {
          current.list = refreshed;
          current.refreshing = false;
        },
        () => {
          current.refreshing = false;
        }
      );
    }
    return list;
  }

  private async buildFileList(query: SearchQuery, config: EngineConfig): Promise<FileList> {
    // 목록은 여러 검색이 함께 쓰므로 한 검색의 취소로 끊지 않는다.
    const source = new vscode.CancellationTokenSource();
    try {
      const createdAt = Date.now();
      const files = await collectFiles(query, config, source.token);
      // 원격(file 스킴이 아닌) 파일은 워커의 node fs 로 읽을 수 없어 대상에서 뺀다.
      const paths = files.filter((uri) => uri.scheme === 'file' && !isAsar(uri.path)).map((uri) => uri.fsPath);
      return { paths, createdAt };
    } finally {
      source.dispose();
    }
  }

  /** 워크스페이스 밖 디렉터리는 워크스페이스 감시에 들어가지 않으므로 따로 감시한다. */
  private createOutsideWatcher(query: SearchQuery): vscode.Disposable | undefined {
    if (query.scopeKind !== 'directory' || query.scopePath.trim().length === 0 || isInsideWorkspace(query.scopePath)) {
      return undefined;
    }
    const base = vscode.Uri.file(path.resolve(query.scopePath));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, query.recursive ? '**/*' : '*'));
    const disposables = [watcher, ...this.watch(watcher)];
    return new vscode.Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
  }
}

function fileListKey(query: SearchQuery, config: EngineConfig): string {
  const useDirectory = query.scopeKind === 'directory' && query.scopePath.trim().length > 0;
  return JSON.stringify([
    useDirectory ? path.resolve(query.scopePath) : '',
    query.recursive,
    query.fileMask.trim(),
    config.maxFiles,
    config.excludeGlobs
  ]);
}

/** 토큰이 취소되면 promise 를 기다리지 않고 undefined 로 끝낸다. */
function untilCancelled<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T | undefined> {
  if (token.isCancellationRequested) {
    return Promise.resolve(undefined);
  }
  return new Promise<T | undefined>((resolve, reject) => {
    const subscription = token.onCancellationRequested(() => {
      subscription.dispose();
      resolve(undefined);
    });
    promise.then(
      (value) => {
        subscription.dispose();
        resolve(value);
      },
      (error) => {
        subscription.dispose();
        reject(error);
      }
    );
  });
}

