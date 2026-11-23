/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { FileResult, MatchItem, SearchQuery } from './types';
import { decodeText, isBinary } from './matcher';
import { WorkerMessage, WorkerOptions, WorkerRequest, WorkerSearchMessage, WorkerTarget } from './searchWorker';
import { DirtyTextTracker } from './dirtyTexts';
import { maskToRegExp, scopeOf, splitMask } from './workspaceScope';
import { isInSkippedDirectory, SKIPPED_DIRECTORIES } from './indexablePath';

export { buildMatcher, escapeRegExp, expandReplacement, findMatches, splitLines } from './matcher';

/**
 * 매칭 워커가 이 시간 동안 아무 응답이 없으면 강제로 끊는다.
 * 정규식 백트래킹이 폭발하면(예: `(a+)+$`) 영원히 끝나지 않기 때문이다.
 * 워커는 검색 중 주기적으로 진행을 알리므로, 캐시가 비어 디스크를 오래 읽는 검색은 끊지 않는다.
 */
const SEARCH_TIMEOUT_MS = 15000;

/**
 * 입력 중 연속 검색에서 이 시간 안에 확인한 파일은 다시 stat 하지 않는다.
 * 변경은 감시 이벤트로 바로 반영하고, 패널을 열거나 창으로 돌아올 때 백그라운드에서 전체를 다시 확인한다.
 */
const FRESH_MS = 5000;

/** 생성 이벤트가 몰릴 때(빌드, checkout) 파일 목록 재열거를 이만큼 모은다. */
const ENUMERATE_DELAY_MS = 1000;

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
  /** 검색 한 번에 결과로 보낼 전체 일치 개수 상한 */
  maxTotalMatches: number;
  excludeGlobs: string[];
  maxPreviewSizeKb: number;
}

export function getConfig(): EngineConfig {
  const c = vscode.workspace.getConfiguration('vsearch', null);
  return {
    maxFileSizeKb: c.get<number>('maxFileSizeKb', 5120),
    maxFiles: c.get<number>('maxFiles', 20000),
    maxResultFiles: c.get<number>('maxResultFiles', 3000),
    maxMatchesPerFile: c.get<number>('maxMatchesPerFile', 500),
    maxTotalMatches: c.get<number>('maxTotalMatches', 20000),
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
    const conf = vscode.workspace.getConfiguration(undefined, null).get<Record<string, unknown>>(key) ?? {};
    for (const [pattern, value] of Object.entries(conf)) {
      if (value === true) {
        out.push(pattern);
      }
    }
  }
  return out;
}

function buildExcludeGlob(config: EngineConfig): string | undefined {
  const patterns = new Set<string>(['**/.vshoon/cache/**', ...defaultExcludePatterns(), ...config.excludeGlobs]);
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
        if (recursive && !SKIPPED_DIRECTORIES.has(entry.name)) {
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

/** 메모리 목록으로 처리할 수 없는 범위(워크스페이스 밖, 경로가 들어간 마스크)인지 확인한다. */
function needsFileSearch(query: SearchQuery): boolean {
  const useDirectory = query.scopeKind === 'directory' && query.scopePath.trim().length > 0;
  return (useDirectory && !isInsideWorkspace(query.scopePath)) || /[\\/]/.test(query.fileMask);
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
interface PendingSearch {
  readonly stats: SearchStats;
  /** 워커가 응답했으므로 시간 제한을 다시 시작한다. */
  readonly touch: () => void;
  readonly onBatch: (files: FileResult[]) => void;
  readonly resolve: (stats: SearchStats) => void;
  readonly reject: (error: Error) => void;
}

export interface SearchOptions {
  /** false 이면 다음 검색이 시작되어도 끝까지 수행한다. 기본값 true */
  preemptible?: boolean;
  /** 전체 일치 개수 상한. 0 이면 제한하지 않는다. 기본값은 설정의 maxTotalMatches */
  maxTotalMatches?: number;
}

/**
 * 입력할 때마다 곧바로 결과를 낼 수 있게 검색 사이의 상태를 보관한다.
 *
 * - 검색마다 파일 목록과 메타데이터를 확인해 감시 이벤트가 늦어도 변경을 반영한다.
 * - 내용과 trigram 인덱스는 워커가 보관하고, 바뀐 파일만 다시 읽고 인덱싱한다.
 */
export class SearchEngine implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<number, PendingSearch>();
  private readonly currentSearch = new Int32Array(new SharedArrayBuffer(4));
  private worker: Worker | undefined;
  private nextId = 1;
  private disposed = false;
  private readonly warming = new Map<number, () => void>();
  private readonly changedPaths = new Set<string>();
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 워크스페이스 전체 파일 목록. 검색마다 다시 열거하지 않고 감시 이벤트로 갱신한다. */
  private workspacePaths: Set<string> | undefined;
  /** 목록이 maxFiles 에서 잘렸으면 마스크·범위 검색은 findFiles 로 직접 찾는다. */
  private workspaceTruncated = false;
  private enumerating: Promise<Set<string>> | undefined;
  private enumerateTimer: ReturnType<typeof setTimeout> | undefined;
  private listGeneration = 0;
  private lastRevalidate = 0;
  private readonly dirtyTexts = new DirtyTextTracker();

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidDelete(uri => this.invalidate(uri)),
      watcher.onDidCreate(uri => {
        this.refresh(uri);
        if (this.isIndexable(uri)) {
          // 새 파일은 바로 검색 대상에 넣고, 제외 설정 반영은 곧이어 하는 재열거에 맡긴다.
          if (this.workspacePaths && !this.workspacePaths.has(uri.fsPath)) {
            this.workspacePaths.add(uri.fsPath);
            this.worker?.postMessage({ type: 'filesAdd', paths: [uri.fsPath] } satisfies WorkerRequest);
          }
          this.scheduleEnumerate();
        }
      }),
      watcher.onDidChange(uri => this.refresh(uri)),
      vscode.workspace.onDidSaveTextDocument(document => this.refresh(document.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.worker?.postMessage({ type: 'roots', roots: this.cacheRoots() } satisfies WorkerRequest);
        this.resetFileList();
        void this.startIndexing();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vsearch') || event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude')) {
          this.resetFileList();
          void this.startIndexing();
        }
      }),
      // 다른 프로그램에서 고친 파일은 감시 이벤트가 늦을 수 있으므로 창으로 돌아오면 다시 확인한다.
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) {
          this.prepare();
        }
      })
    );
  }

  /** Start as soon as the project is opened; no search panel is needed. */
  async startIndexing(): Promise<void> {
    try {
      await this.warm({ id: 0, query: '', regex: false, caseSensitive: false, wholeWord: false, scopeKind: 'workspace', scopePath: '', recursive: true, fileMask: '' }, getConfig());
    } catch {
      // A closing workspace or a worker restart can interrupt background preparation.
    }
  }

  /**
   * 검색창을 열거나 창으로 돌아왔을 때 호출한다. 입력을 막지 않고 백그라운드에서
   * 파일 목록을 다시 열거하고 보관 중인 내용을 디스크와 비교한다.
   */
  prepare(): void {
    const now = Date.now();
    if (this.disposed || now - this.lastRevalidate < FRESH_MS) {
      return;
    }
    this.lastRevalidate = now;
    if (this.workspacePaths) {
      this.scheduleEnumerate(0);
    }
    this.worker?.postMessage({ type: 'revalidate', maxBytes: getConfig().maxFileSizeKb * 1024 } satisfies WorkerRequest);
  }

  /** 검색어를 입력하기 전에 범위의 파일 목록과 내용을 미리 읽어 둔다. */
  async warm(query: SearchQuery, config: EngineConfig): Promise<void> {
    const source = new vscode.CancellationTokenSource();
    try {
      const target = await this.collectTarget(query, config, source.token);
      if (!this.disposed && target.paths?.length !== 0) {
        const id = this.nextId++;
        const request: WorkerRequest = { type: 'warm', id, ...target, maxBytes: config.maxFileSizeKb * 1024 };
        await new Promise<void>(resolve => {
          this.warming.set(id, resolve);
          this.ensureWorker().postMessage(request);
        });
      }
    } finally {
      source.dispose();
    }
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

    const target = await this.collectTarget(query, config, token);
    if (this.disposed || token.isCancellationRequested || target.paths?.length === 0 || (preemptible && Atomics.load(this.currentSearch, 0) !== id)) {
      return empty;
    }
    return this.match(id, preemptible, target, query, config, options.maxTotalMatches ?? config.maxTotalMatches, token, onBatch);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.changeTimer);
    clearTimeout(this.enumerateTimer);
    this.changedPaths.clear();
    this.rejectPending(new Error('검색이 중단되었습니다.'));
    void this.worker?.terminate();
    this.worker = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private match(
    id: number,
    preemptible: boolean,
    target: WorkerTarget,
    query: SearchQuery,
    config: EngineConfig,
    maxTotalMatches: number,
    token: vscode.CancellationToken,
    onBatch: (files: FileResult[]) => void
  ): Promise<SearchStats> {
    const worker = this.ensureWorker();
    // 바뀐 미저장 내용만 보낸다. 메시지 순서가 보장되므로 검색보다 먼저 반영된다.
    const dirty = this.dirtyTexts.changes(vscode.workspace.textDocuments);
    if (dirty) {
      worker.postMessage({ type: 'dirty', ...dirty } satisfies WorkerRequest);
    }
    const request: WorkerSearchMessage = {
      type: 'search',
      id,
      preemptible,
      ...target,
      pattern: query.query,
      regex: query.regex,
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      maxBytes: config.maxFileSizeKb * 1024,
      maxMatchesPerFile: config.maxMatchesPerFile,
      maxResultFiles: config.maxResultFiles,
      maxTotalMatches,
      freshMs: FRESH_MS
    };

    return new Promise<SearchStats>((resolve, reject) => {
      const stats: SearchStats = { fileCount: 0, matchCount: 0, truncated: false };
      const onTimeout = () => {
        // 멈추지 않는 정규식은 워커째 버린다. 보관하던 내용은 새 워커가 프로젝트 캐시에서 다시 읽는다.
        this.resetWorker(
          new Error(
            '검색이 너무 오래 걸려 중단했습니다. 정규식이 지나치게 복잡하지 않은지 확인해 주세요. ' +
              '(예: (a+)+ 처럼 수량자가 중첩된 패턴)'
          )
        );
        if (!this.disposed) {
          void this.startIndexing();
        }
      };
      let timer = setTimeout(onTimeout, SEARCH_TIMEOUT_MS);
      const cleanup = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        cancelSubscription.dispose();
      };
      const cancelSubscription = token.onCancellationRequested(() => {
        // 새 검색이 이미 id 를 바꿨다면 그대로 둔다.
        Atomics.compareExchange(this.currentSearch, 0, id, 0);
        cleanup();
        resolve(stats);
      });
      this.pending.set(id, {
        stats,
        touch: () => {
          clearTimeout(timer);
          timer = setTimeout(onTimeout, SEARCH_TIMEOUT_MS);
        },
        onBatch,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      worker.postMessage(request);
    });
  }

  private onWorkerMessage(message: WorkerMessage): void {
    // 워커가 응답하면 멈춘 것이 아니다. 앞선 검색 뒤에서 기다리는 검색의 시간 제한도 다시 시작한다.
    for (const waiting of this.pending.values()) {
      waiting.touch();
    }
    if (message.type === 'warmed') {
      this.warming.get(message.id)?.();
      this.warming.delete(message.id);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || message.type === 'progress') {
      return;
    }
    if (message.type === 'batch') {
      const results = message.files.map((file) => toFileResult(vscode.Uri.file(file.fsPath), file.matches, file.truncated));
      pending.stats.fileCount += results.length;
      for (const file of message.files) {
        pending.stats.matchCount += file.matches.length;
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
    const options: WorkerOptions = { currentSearch: this.currentSearch.buffer as SharedArrayBuffer, cacheBytes: CONTENT_CACHE_BYTES, cacheRoots: this.cacheRoots() };
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
    // 새 워커는 파일 목록과 미저장 내용을 모른다.
    this.dirtyTexts.reset();
    if (this.workspacePaths) {
      worker.postMessage({ type: 'files', paths: [...this.workspacePaths] } satisfies WorkerRequest);
    }
    return worker;
  }

  private resetWorker(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      pending.reject(error);
    }
    for (const resolve of this.warming.values()) {
      resolve();
    }
    this.warming.clear();
  }

  private invalidate(uri: vscode.Uri): void {
    if (uri.scheme === 'file' && !uri.path.includes('/.vshoon/cache/')) {
      this.changedPaths.delete(uri.fsPath);
      const paths = [uri.fsPath];
      // 목록에 있던 파일이면 그 항목만 지운다. 파일마다 전체 목록을 훑으면 대량 삭제(clean, checkout)가 느려진다.
      if (this.workspacePaths && !this.workspacePaths.delete(uri.fsPath)) {
        // 폴더가 지워지면 하위 파일의 이벤트가 따로 오지 않을 수 있다. 하위 파일의 캐시도 함께 버린다.
        const prefix = uri.fsPath + path.sep;
        for (const filePath of this.workspacePaths) {
          if (filePath.startsWith(prefix)) {
            this.workspacePaths.delete(filePath);
            this.changedPaths.delete(filePath);
            paths.push(filePath);
          }
        }
      }
      const request: WorkerRequest = { type: 'invalidate', paths };
      this.worker?.postMessage(request);
    }
  }

  private cacheRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  }

  private isIndexable(uri: vscode.Uri): boolean {
    return !this.disposed && uri.scheme === 'file' && !uri.path.includes('/.vshoon/cache/') && !isAsar(uri.path)
      && !isInSkippedDirectory(uri.fsPath, this.cacheRoots());
  }

  private refresh(uri: vscode.Uri): void {
    if (!this.isIndexable(uri)) {
      return;
    }
    this.changedPaths.add(uri.fsPath);
    if (this.changeTimer) {
      return;
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      const paths = [...this.changedPaths];
      this.changedPaths.clear();
      if (!this.disposed && paths.length > 0) {
        this.ensureWorker().postMessage({ type: 'refresh', paths, maxBytes: getConfig().maxFileSizeKb * 1024 } satisfies WorkerRequest);
      }
    }, 100);
  }

  /**
   * 검색 대상을 정한다. 워크스페이스 목록으로 처리할 수 있으면 워커가 보관한 목록을 거르는 조건만 보내고,
   * 그렇지 않으면 findFiles 로 찾은 경로를 보낸다.
   */
  private async collectTarget(query: SearchQuery, config: EngineConfig, token: vscode.CancellationToken): Promise<WorkerTarget> {
    const hasFilter = query.fileMask.trim().length > 0 || (query.scopeKind === 'directory' && query.scopePath.trim().length > 0);
    if (!needsFileSearch(query)) {
      if (!this.workspacePaths) {
        // 열거가 끝나면 목록이 워커로 먼저 전달된다.
        await this.enumerate(config);
      }
      if (this.workspacePaths && (!hasFilter || !this.workspaceTruncated)) {
        return { scope: scopeOf(query) };
      }
    }
    const files = await collectFiles(query, config, token);
    return { paths: files.filter(uri => uri.scheme === 'file' && !isAsar(uri.path)).map(uri => uri.fsPath) };
  }

  /** 워크스페이스 전체 목록을 한 번 열거한다. 동시에 들어온 요청은 같은 결과를 기다린다. */
  private enumerate(config: EngineConfig = getConfig()): Promise<Set<string>> {
    if (!this.enumerating) {
      // 목록을 초기화했으면 새 열거가 이미 자리를 차지하고 있으므로 지우지 않는다.
      const generation = this.listGeneration;
      this.enumerating = this.listWorkspace(config, generation).finally(() => {
        if (generation === this.listGeneration) {
          this.enumerating = undefined;
        }
      });
    }
    return this.enumerating;
  }

  private async listWorkspace(config: EngineConfig, generation: number): Promise<Set<string>> {
    const source = new vscode.CancellationTokenSource();
    try {
      const query: SearchQuery = { id: 0, query: '', regex: false, caseSensitive: false, wholeWord: false, scopeKind: 'workspace', scopePath: '', recursive: true, fileMask: '' };
      const files = await collectFiles(query, config, source.token);
      const paths = new Set(files.filter(uri => uri.scheme === 'file' && !isAsar(uri.path)).map(uri => uri.fsPath));
      if (generation === this.listGeneration && !this.disposed) {
        this.workspacePaths = paths;
        this.workspaceTruncated = files.length >= config.maxFiles;
        this.worker?.postMessage({ type: 'files', paths: [...paths] } satisfies WorkerRequest);
      }
      return paths;
    } finally {
      source.dispose();
    }
  }

  private scheduleEnumerate(delay = ENUMERATE_DELAY_MS): void {
    clearTimeout(this.enumerateTimer);
    this.enumerateTimer = setTimeout(() => {
      this.enumerateTimer = undefined;
      if (!this.disposed) {
        this.enumerate().catch(() => undefined);
      }
    }, delay);
  }

  private resetFileList(): void {
    this.listGeneration++;
    this.workspacePaths = undefined;
    this.enumerating = undefined;
    clearTimeout(this.enumerateTimer);
  }
}

