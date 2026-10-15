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

/** 워커를 만들 때 한 번 전달하는 값 */
export interface WorkerOptions {
  /** Int32Array 한 칸. 계속 진행해도 되는 검색 id 이며, 부모가 바꾸면 진행 중 검색이 멈춘다. */
  currentSearch: SharedArrayBuffer;
  /** 메모리에 보관할 파일 내용의 상한(바이트, 근사값) */
  cacheBytes: number;
}

export interface WorkerSearchRequest {
  type: 'search';
  id: number;
  /** false 이면 다른 검색이 시작되어도 끝까지 수행한다. (모두 바꾸기) */
  preemptible: boolean;
  /** 검사할 파일의 OS 경로 */
  paths: string[];
  /** 저장하지 않은 편집 내용 (경로 → 텍스트). 디스크 대신 이 내용을 검사한다. */
  dirty: Record<string, string>;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  maxBytes: number;
  maxMatchesPerFile: number;
  maxResultFiles: number;
}

export type WorkerRequest =
  | WorkerSearchRequest
  /** 검색 전에 미리 읽어 둘 파일. 새 요청이 오면 이전 예열은 버린다. */
  | { type: 'warm'; paths: string[]; maxBytes: number }
  /** 바뀐 파일의 캐시를 버린다. paths 가 없으면 전부 버린다. */
  | { type: 'invalidate'; paths?: string[] };

export interface WorkerFileResult {
  fsPath: string;
  matches: MatchItem[];
  truncated: boolean;
}

export type WorkerMessage =
  | { type: 'batch'; id: number; files: WorkerFileResult[] }
  | { type: 'done'; id: number; fileCount: number; matchCount: number; truncated: boolean; cancelled: boolean }
  | { type: 'error'; id: number; message: string };

/** 캐시한 내용을 디스크와 다시 비교하기까지의 시간. 그 사이 변경은 부모의 invalidate 가 알려 준다. */
const REVALIDATE_MS = 2000;
const WARM_CHUNK = 200;

interface CacheEntry {
  /** 크기 제한을 넘었거나 바이너리이면 없다. */
  text: string | undefined;
  binary: boolean;
  size: number;
  mtimeMs: number;
  checkedAt: number;
}

/** 파일 내용을 오래된 사용 순서로 밀어내며 보관한다. */
export class ContentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(
    private readonly limitBytes: number,
    private readonly now: () => number = Date.now
  ) { }

  get size(): number {
    return this.entries.size;
  }

  read(filePath: string, maxBytes: number): string | null {
    const now = this.now();
    let entry = this.entries.get(filePath);
    if (entry && now - entry.checkedAt > REVALIDATE_MS && !this.isUnchanged(filePath, entry, now)) {
      this.delete(filePath);
      entry = undefined;
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
      entry = this.load(filePath, maxBytes, now);
    }
    if (!entry || entry.binary || entry.size > maxBytes || entry.text === undefined) {
      return null;
    }
    return entry.text;
  }

  invalidate(paths?: readonly string[]): void {
    if (!paths) {
      this.entries.clear();
      this.bytes = 0;
      return;
    }
    for (const filePath of paths) {
      this.delete(filePath);
    }
  }

  private isUnchanged(filePath: string, entry: CacheEntry, now: number): boolean {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) {
        return false;
      }
      entry.checkedAt = now;
      return true;
    } catch {
      return false;
    }
  }

  private load(filePath: string, maxBytes: number, now: number): CacheEntry | undefined {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return undefined;
      }
      const entry: CacheEntry = { text: undefined, binary: false, size: stat.size, mtimeMs: stat.mtimeMs, checkedAt: now };
      if (stat.size <= maxBytes) {
        const buffer = fs.readFileSync(filePath);
        if (isBinary(buffer)) {
          entry.binary = true;
        } else {
          entry.text = decodeText(buffer);
        }
      }
      this.entries.set(filePath, entry);
      this.bytes += cost(entry);
      this.evict();
      return entry;
    } catch {
      return undefined;
    }
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

function cost(entry: CacheEntry): number {
  return (entry.text?.length ?? 0) * 2 + 64;
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
    if (fileCount >= request.maxResultFiles) {
      truncated = true;
      break;
    }
    const dirty = request.dirty[filePath];
    const text = dirty !== undefined ? dirty : cache.read(filePath, request.maxBytes);
    if (text === null) {
      continue;
    }
    // 파일마다 새 인스턴스를 써서 lastIndex 가 섞이지 않게 한다.
    const local = new RegExp(matcher.source, matcher.flags);
    const found = findMatches(text, local, request.maxMatchesPerFile);
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
  const cache = new ContentCache(options.cacheBytes);
  let warm: { paths: string[]; maxBytes: number; next: number } | undefined;

  // 검색 요청이 끼어들 수 있게 조금씩 나눠 읽는다.
  const warmStep = () => {
    const job = warm;
    if (!job) {
      return;
    }
    const end = Math.min(job.paths.length, job.next + WARM_CHUNK);
    for (; job.next < end; job.next++) {
      cache.read(job.paths[job.next], job.maxBytes);
    }
    if (job.next < job.paths.length) {
      setImmediate(warmStep);
    } else if (warm === job) {
      warm = undefined;
    }
  };

  port.on('message', (request: WorkerRequest) => {
    switch (request.type) {
      case 'search':
        search(request, cache, () => Atomics.load(currentSearch, 0) === request.id, message => port.postMessage(message));
        break;
      case 'warm': {
        const running = warm !== undefined;
        warm = { paths: request.paths, maxBytes: request.maxBytes, next: 0 };
        if (!running) {
          setImmediate(warmStep);
        }
        break;
      }
      case 'invalidate':
        cache.invalidate(request.paths);
        break;
    }
  });
}

if (parentPort && workerData) {
  serve(workerData as WorkerOptions);
}
