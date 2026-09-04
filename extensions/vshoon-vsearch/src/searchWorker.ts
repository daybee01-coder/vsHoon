/**
 * 검색 매칭을 담당하는 워커 스레드.
 *
 * 왜 워커인가:
 * `(a+)+$` 같은 패턴은 백트래킹이 폭발해 정규식 한 번이 영원히 끝나지 않을 수 있다.
 * JS 에는 정규식 타임아웃이 없고, 실행 중에는 취소 신호를 확인할 방법도 없다.
 * 확장 호스트에서 직접 돌리면 VS Code 전체가 멈추므로, 매칭은 여기서 하고
 * 부모가 시간을 재다가 필요하면 terminate() 로 통째로 끊는다.
 *
 * 여기서는 vscode 모듈을 쓸 수 없다. 파일 읽기는 node fs 로 한다.
 */
import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import { MatchItem } from './types';
import { buildMatcher, decodeText, findMatches, isBinary } from './matcher';

export interface WorkerInput {
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

export interface WorkerFileResult {
  fsPath: string;
  matches: MatchItem[];
  truncated: boolean;
}

export type WorkerMessage =
  | { type: 'batch'; files: WorkerFileResult[] }
  | { type: 'done'; fileCount: number; matchCount: number; truncated: boolean }
  | { type: 'error'; message: string };

function readForSearch(filePath: string, maxBytes: number, dirty: Record<string, string>): string | null {
  const cached = dirty[filePath];
  if (cached !== undefined) {
    return cached;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) {
      return null;
    }
    const buf = fs.readFileSync(filePath);
    return isBinary(buf) ? null : decodeText(buf);
  } catch {
    return null;
  }
}

function run(input: WorkerInput): void {
  const port = parentPort;
  if (!port) {
    return;
  }

  let matcher: RegExp;
  try {
    matcher = buildMatcher(input.pattern, {
      regex: input.regex,
      caseSensitive: input.caseSensitive,
      wholeWord: input.wholeWord
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', message: `정규식이 올바르지 않습니다: ${message}` } as WorkerMessage);
    return;
  }

  let buffer: WorkerFileResult[] = [];
  let fileCount = 0;
  let matchCount = 0;
  let truncated = false;
  let lastFlush = Date.now();

  const flush = (force: boolean) => {
    if (buffer.length > 0 && (force || buffer.length >= 50 || Date.now() - lastFlush > 120)) {
      port.postMessage({ type: 'batch', files: buffer } as WorkerMessage);
      buffer = [];
      lastFlush = Date.now();
    }
  };

  for (const filePath of input.paths) {
    if (fileCount >= input.maxResultFiles) {
      truncated = true;
      break;
    }
    const text = readForSearch(filePath, input.maxBytes, input.dirty);
    if (text === null) {
      continue;
    }
    // 파일마다 새 인스턴스를 써서 lastIndex 가 섞이지 않게 한다.
    const local = new RegExp(matcher.source, matcher.flags);
    const found = findMatches(text, local, input.maxMatchesPerFile);
    if (found.matches.length === 0) {
      continue;
    }
    fileCount++;
    matchCount += found.matches.length;
    buffer.push({ fsPath: filePath, matches: found.matches, truncated: found.truncated });
    flush(false);
  }

  flush(true);
  port.postMessage({ type: 'done', fileCount, matchCount, truncated } as WorkerMessage);
}

if (parentPort && workerData) {
  run(workerData as WorkerInput);
}
