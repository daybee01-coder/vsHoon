/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 검색 매칭을 담당하는 워커 스레드.
 *
 * 왜 워커인가:
 * `(a+)+$` 같은 패턴은 백트래킹이 폭발해 정규식 한 번이 영원히 끝나지 않을 수 있다.
 * JS 에는 정규식 타임아웃이 없고, 실행 중에는 취소 신호를 확인할 방법도 없다.
 * 확장 호스트에서 직접 돌리면 VS Code 전체가 멈추므로, 매칭은 여기서 하고
 * 부모가 시간을 재다가 필요하면 terminate() 로 통째로 끊는다.
 *
 * 왜 계속 살아 있는가:
 * 입력할 때마다 워커를 새로 띄우고 파일을 전부 다시 읽으면 키 입력마다 디스크를 훑게 된다.
 * 한 번 읽은 내용을 메모리에 두고, 부모가 알려 준 변경 파일과 일정 시간이 지난 항목만 다시 확인한다.
 * 진행 중인 검색은 공유 메모리의 "현재 검색 id" 가 바뀌는 즉시 멈춘다.
 *
 * 여기서는 vscode 모듈을 쓸 수 없다. 파일 읽기는 node fs 로 한다.
 */
import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { MatchItem } from './types';
import { buildMatcher, decodeText, findMatches, isBinary } from './matcher';
import { LiteralIndex, literalBits } from './literalIndex';
import { PersistentCache } from './persistentCache';
import { filterWorkspacePaths, WorkspaceScope } from './workspaceScope';

/** 워커를 만들 때 한 번 전달하는 값 */
export interface WorkerOptions {
  /** Int32Array 한 칸. 계속 진행해도 되는 검색 id 이며, 부모가 바꾸면 진행 중 검색이 멈춘다. */
  currentSearch: SharedArrayBuffer;
  /** 메모리에 보관할 파일 내용의 상한(바이트, 근사값) */
  cacheBytes: number;
  cacheRoots?: string[];
}

export interface WorkerSearchRequest {
  type: 'search';
  id: number;
  /** false 이면 다른 검색이 시작되어도 끝까지 수행한다. (모두 바꾸기) */
  preemptible: boolean;
  /** 검사할 파일의 OS 경로 */
  paths: readonly string[];
  /** 저장하지 않은 편집 내용 (경로 → 텍스트). 디스크 대신 이 내용을 검사한다. */
  dirty: Record<string, string>;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  maxBytes: number;
  maxMatchesPerFile: number;
  maxResultFiles: number;
  /**
   * 전체 일치 개수 상한. 화면이 보여 줄 수 없는 결과를 만들고 복사하지 않게 한다.
   * 0 이거나 없으면 제한하지 않는다. (모두 바꾸기의 대상 수집)
   */
  maxTotalMatches?: number;
  /**
   * 이 시간(ms) 안에 확인한 캐시 항목은 다시 stat 하지 않는다. 입력 중 연속 검색이 파일마다
   * 디스크를 확인하지 않게 한다. 변경은 감시 이벤트와 패널을 열 때의 재검증이 반영한다. 기본값 0.
   */
  freshMs?: number;
}

/**
 * 검색이나 사전 읽기의 대상. paths 를 주면 그 파일만 쓰고, 없으면 워커가 보관한 워크스페이스 목록을
 * scope 로 거른다. 키 입력마다 수만 개의 경로를 복사해 보내지 않게 한다.
 */
export interface WorkerTarget {
  paths?: readonly string[];
  scope?: WorkspaceScope;
}

/** 워커로 보내는 검색 요청. dirty 가 없으면 워커가 보관한 미저장 내용을 쓴다. */
export type WorkerSearchMessage = Omit<WorkerSearchRequest, 'paths' | 'dirty'> & WorkerTarget & { dirty?: Record<string, string> };

export type WorkerRequest =
  | WorkerSearchMessage
  /** 검색 전에 미리 읽어 둘 파일. 새 요청이 오면 이전 예열은 버린다. */
  | ({ type: 'warm'; id: number; maxBytes: number } & WorkerTarget)
  /** 워크스페이스 전체 파일 목록을 바꾼다. */
  | { type: 'files'; paths: string[] }
  /** 새로 생긴 파일을 목록에 더한다. 지운 파일은 invalidate 가 목록에서도 뺀다. */
  | { type: 'filesAdd'; paths: string[] }
  /** 미저장 내용의 변경분 */
  | { type: 'dirty'; set: Record<string, string>; clear: string[] }
  | { type: 'refresh'; paths: string[]; maxBytes: number }
  | { type: 'roots'; roots: string[] }
  /** 보관 중인 모든 항목을 백그라운드에서 다시 확인한다. */
  | { type: 'revalidate'; maxBytes: number }
  /** 바뀐 파일의 캐시를 버린다. paths 가 없으면 전부 버린다. */
  | { type: 'invalidate'; paths?: string[] };

export interface WorkerFileResult {
  fsPath: string;
  matches: MatchItem[];
  truncated: boolean;
}

export type WorkerMessage =
  | { type: 'warmed'; id: number }
  /** 오래 걸리는 검색이 아직 진행 중임을 알린다. 정규식 하나가 멈춘 경우와 디스크 읽기가 느린 경우를 구분한다. */
  | { type: 'progress'; id: number }
  | { type: 'batch'; id: number; files: WorkerFileResult[] }
  | { type: 'done'; id: number; fileCount: number; matchCount: number; truncated: boolean; cancelled: boolean }
  | { type: 'error'; id: number; message: string };

const WARM_SLICE_MS = 8;

/** 검색 중 이 간격으로 진행을 알린다. 부모는 알림이 끊긴 시간만 시간 제한으로 잰다. */
const PROGRESS_MS = 1000;

/** 이보다 큰 파일은 앞부분만 먼저 읽어 바이너리이면 나머지를 읽지 않는다. (JAR 등) */
const SNIFF_THRESHOLD_BYTES = 64 * 1024;
const SNIFF_BYTES = 8192;

/** 내용을 읽지 않고 바이너리로 취급하는 확장자 */
const BINARY_EXTENSIONS = /\.(?:jar|war|ear|class|zip|gz|tgz|bz2|xz|7z|rar|png|jpe?g|gif|bmp|ico|webp|pdf|exe|dll|so|dylib|pdb|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|wav)$/i;

interface CacheEntry {
  /** 크기 제한을 넘었거나 바이너리이면 없다. */
  text: string | undefined;
  binary: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  index?: LiteralIndex;
  /** 마지막으로 디스크와 비교한 시각 */
  verifiedAt: number;
}

/** 파일 내용을 오래된 사용 순서로 밀어내며 보관한다. */
export class ContentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private readonly persistent: PersistentCache;

  constructor(private readonly limitBytes: number, roots: readonly string[] = [], private readonly readSource: (filePath: string) => Buffer = filePath => fs.readFileSync(filePath)) {
    this.persistent = new PersistentCache(roots, limitBytes);
  }

  setRoots(roots: readonly string[]): void {
    this.persistent.setRoots(roots);
  }

  /** force 가 아니면 디스크 캐시에 충분히 기록했을 때만 정리한다. 저장할 때마다 캐시 폴더를 훑지 않게 한다. */
  prune(force = false): void {
    this.persistent.prune(force);
  }

  get size(): number {
    return this.entries.size;
  }

  /** 보관 중인 파일 경로 */
  paths(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 파일 내용을 돌려준다. freshMs 안에 확인한 항목은 디스크와 다시 비교하지 않는다.
   */
  read(filePath: string, maxBytes: number, freshMs = 0): string | null {
    let entry = this.entries.get(filePath);
    const now = Date.now();
    if (entry && (freshMs <= 0 || now - entry.verifiedAt > freshMs)) {
      if (this.isUnchanged(filePath, entry)) {
        entry.verifiedAt = now;
      } else {
        this.delete(filePath);
        entry = undefined;
      }
    }
    if (entry && !entry.binary && entry.text === undefined && entry.size <= maxBytes) {
      // 이전 검색보다 크기 제한이 커졌다.
      this.delete(filePath);
      entry = undefined;
    }
    if (entry) {
      // 최근에 쓴 항목을 뒤로 보내 먼저 밀려나지 않게 한다.
      this.entries.delete(filePath);
      this.entries.set(filePath, entry);
    } else {
      entry = this.load(filePath, maxBytes);
    }
    if (!entry || entry.binary || entry.size > maxBytes || entry.text === undefined) {
      return null;
    }
    return entry.text;
  }

  /** Call after read(), which verifies the current file before consulting its index. */
  mayContain(filePath: string, bits: readonly number[]): boolean {
    return this.entries.get(filePath)?.index?.mayContain(bits) ?? true;
  }

  invalidate(paths?: readonly string[]): void {
    if (!paths) {
      this.entries.clear();
      this.bytes = 0;
      return;
    }
    for (const filePath of paths) {
      this.delete(filePath);
      this.persistent.delete(filePath);
    }
  }

  private isUnchanged(filePath: string, entry: CacheEntry): boolean {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || stat.ctimeMs !== entry.ctimeMs || stat.ino !== entry.ino) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private load(filePath: string, maxBytes: number): CacheEntry | undefined {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return undefined;
      }
      if (BINARY_EXTENSIONS.test(filePath) || (stat.size > SNIFF_THRESHOLD_BYTES && stat.size <= maxBytes && startsBinary(filePath))) {
        return this.store(filePath, { text: undefined, binary: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, verifiedAt: Date.now() });
      }
      const restored = this.persistent.read(filePath, stat, maxBytes);
      const entry: CacheEntry = { text: restored?.text, binary: restored?.binary ?? false, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, index: restored?.bits ? new LiteralIndex('', restored.bits) : undefined, verifiedAt: Date.now() };
      const needsRead = (!restored || (!entry.binary && entry.text === undefined)) && stat.size <= maxBytes;
      if (needsRead) {
        const buffer = this.readSource(filePath);
        if (isBinary(buffer)) {
          entry.binary = true;
        } else {
          entry.text = decodeText(buffer);
          entry.index = new LiteralIndex(entry.text);
        }
      }
      if (!restored || needsRead) {
        this.persistent.write(filePath, { text: entry.text, binary: entry.binary, size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs, ino: entry.ino, bits: entry.index?.bytes });
      }
      return this.store(filePath, entry);
    } catch {
      this.persistent.delete(filePath);
      return undefined;
    }
  }

  private store(filePath: string, entry: CacheEntry): CacheEntry {
    this.entries.set(filePath, entry);
    this.bytes += cost(entry);
    this.evict();
    return entry;
  }

  private evict(): void {
    while (this.bytes > this.limitBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string;
      this.delete(oldest);
    }
  }

  private delete(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry) {
      this.bytes -= cost(entry);
      this.entries.delete(filePath);
    }
  }
}

/** 파일 앞부분만 읽어 바이너리인지 확인한다. */
function startsBinary(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(SNIFF_BYTES);
    return isBinary(head.subarray(0, fs.readSync(fd, head, 0, SNIFF_BYTES, 0)));
  } finally {
    fs.closeSync(fd);
  }
}

function cost(entry: CacheEntry): number {
  return (entry.text?.length ?? 0) * 2 + (entry.index?.bytes.byteLength ?? 0) + 64;
}

/**
 * 요청 하나를 수행한다. isCurrent 가 false 가 되면 그 자리에서 멈추고 cancelled 로 끝낸다.
 */
export function search(
  request: WorkerSearchRequest,
  cache: ContentCache,
  isCurrent: () => boolean,
  post: (message: WorkerMessage) => void
): void {
  const id = request.id;
  const bits = literalBits(request.pattern, request.regex);
  let matcher: RegExp;
  try {
    matcher = buildMatcher(request.pattern, {
      regex: request.regex,
      caseSensitive: request.caseSensitive,
      wholeWord: request.wholeWord
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: 'error', id, message: `정규식이 올바르지 않습니다: ${message}` });
    return;
  }

  let buffer: WorkerFileResult[] = [];
  let fileCount = 0;
  let matchCount = 0;
  let truncated = false;
  let cancelled = false;
  // 첫 결과는 기다리지 않고 바로 보낸다.
  let lastFlush = 0;
  let lastProgress = Date.now();

  const flush = (force: boolean) => {
    if (buffer.length > 0 && (force || buffer.length >= 50 || Date.now() - lastFlush > 120)) {
      post({ type: 'batch', id, files: buffer });
      buffer = [];
      lastFlush = Date.now();
    }
  };

  for (const filePath of request.paths) {
    if (request.preemptible && !isCurrent()) {
      cancelled = true;
      break;
    }
    // 남은 일치 개수만큼만 찾는다.
    const limit = request.maxTotalMatches ? Math.min(request.maxMatchesPerFile, request.maxTotalMatches - matchCount) : request.maxMatchesPerFile;
    if (fileCount >= request.maxResultFiles || limit <= 0) {
      truncated = true;
      break;
    }
    const now = Date.now();
    if (now - lastProgress >= PROGRESS_MS) {
      lastProgress = now;
      post({ type: 'progress', id });
    }
    const dirty = request.dirty[filePath];
    let text = dirty !== undefined ? dirty : cache.read(filePath, request.maxBytes, request.freshMs);
    if (text === null) {
      continue;
    }
    if (dirty === undefined && bits.length > 0 && !cache.mayContain(filePath, bits)) {
      continue;
    }
    // 일반 검색어는 줄에 걸치지 않으므로 전체 텍스트에 없으면 줄을 나누지 않고 건너뛴다.
    if (!request.regex && !new RegExp(matcher.source, matcher.flags).test(text)) {
      continue;
    }
    // 파일마다 새 인스턴스를 써서 lastIndex 가 섞이지 않게 한다.
    let found = findMatches(text, new RegExp(matcher.source, matcher.flags), limit);
    if (found.matches.length > 0 && dirty === undefined && request.freshMs) {
      // 확인을 생략한 항목이라도 결과로 보여 줄 파일은 디스크와 비교해 오래된 줄을 내보내지 않는다.
      const current = cache.read(filePath, request.maxBytes);
      if (current !== text) {
        text = current;
        found = text === null ? { matches: [], truncated: false } : findMatches(text, new RegExp(matcher.source, matcher.flags), limit);
      }
    }
    if (found.matches.length === 0) {
      continue;
    }
    fileCount++;
    matchCount += found.matches.length;
    buffer.push({ fsPath: filePath, matches: found.matches, truncated: found.truncated });
    flush(false);
  }

  if (!cancelled) {
    flush(true);
  }
  post({ type: 'done', id, fileCount, matchCount, truncated, cancelled });
}

function serve(options: WorkerOptions): void {
  const port = parentPort;
  if (!port) {
    return;
  }
  const currentSearch = new Int32Array(options.currentSearch);
  const cache = new ContentCache(options.cacheBytes, options.cacheRoots);
  let warm: { id: number; paths: readonly string[]; maxBytes: number; next: number } | undefined;
  const workspace = new Set<string>();
  /** workspace 를 배열로 바꾼 값. 목록이 바뀌면 버린다. */
  let workspaceList: string[] | undefined;
  const dirty: Record<string, string> = Object.create(null);
  const resolve = (target: WorkerTarget): readonly string[] => {
    if (target.paths) {
      return target.paths;
    }
    workspaceList ??= [...workspace];
    return target.scope ? filterWorkspacePaths(workspaceList, target.scope) : workspaceList;
  };
  const updates = new Set<string>();
  let updateMaxBytes = 0;
  let scheduled = false;

  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(warmStep);
    }
  };

  // 검색 요청이 끼어들 수 있게 조금씩 나눠 읽는다.
  const warmStep = () => {
    scheduled = false;
    const deadline = Date.now() + WARM_SLICE_MS;
    for (const filePath of updates) {
      updates.delete(filePath);
      cache.read(filePath, updateMaxBytes);
      if (Date.now() >= deadline) {
        schedule();
        return;
      }
    }
    const job = warm;
    while (job && job.next < job.paths.length && Date.now() < deadline) {
      cache.read(job.paths[job.next++], job.maxBytes);
    }
    if (job && job.next < job.paths.length) {
      schedule();
    } else {
      warm = undefined;
      // 사전 읽기가 끝나면 정리하고, 감시 이벤트로 다시 읽은 뒤에는 기록이 쌓였을 때만 정리한다.
      cache.prune(job !== undefined);
      if (job) {
        port.postMessage({ type: 'warmed', id: job.id } satisfies WorkerMessage);
      }
    }
  };

  port.on('message', (request: WorkerRequest) => {
    switch (request.type) {
      case 'search':
        search({ ...request, paths: resolve(request), dirty: request.dirty ?? dirty }, cache, () => Atomics.load(currentSearch, 0) === request.id, message => port.postMessage(message));
        break;
      case 'warm': {
        if (warm) {
          port.postMessage({ type: 'warmed', id: warm.id } satisfies WorkerMessage);
        }
        warm = { id: request.id, paths: resolve(request), maxBytes: request.maxBytes, next: 0 };
        schedule();
        break;
      }
      case 'files':
        workspace.clear();
        for (const filePath of request.paths) {
          workspace.add(filePath);
        }
        workspaceList = undefined;
        break;
      case 'filesAdd':
        for (const filePath of request.paths) {
          workspace.add(filePath);
        }
        workspaceList = undefined;
        break;
      case 'dirty':
        for (const filePath of request.clear) {
          delete dirty[filePath];
        }
        Object.assign(dirty, request.set);
        break;
      case 'refresh':
        for (const filePath of request.paths) {
          updates.add(filePath);
        }
        updateMaxBytes = request.maxBytes;
        schedule();
        break;
      case 'roots':
        cache.setRoots(request.roots);
        break;
      case 'revalidate':
        for (const filePath of cache.paths()) {
          updates.add(filePath);
        }
        updateMaxBytes = request.maxBytes;
        schedule();
        break;
      case 'invalidate':
        cache.invalidate(request.paths);
        for (const filePath of request.paths ?? []) {
          workspace.delete(filePath);
        }
        workspaceList = undefined;
        break;
    }
  });
}

if (parentPort && workerData) {
  serve(workerData as WorkerOptions);
}
