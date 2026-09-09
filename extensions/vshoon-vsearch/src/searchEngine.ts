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
import { WorkerInput, WorkerMessage } from './searchWorker';
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
 * ------------------------------------------------------------------ *//* ------------------------------------------------------------------ *
 * 파일 읽기
 * ------------------------------------------------------------------ */

/** 편집 중(저장되지 않은) 문서는 디스크 대신 메모리 내용을 사용한다. *//** 편집 중(저장되지 않은) 문서는 디스크 대신 메모리 내용을 사용한다. */
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
      } else if (entry.isFile()) {
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

/**
 * 검색을 실행한다. 결과는 onBatch 로 나눠 전달되어 UI 가 즉시 반응할 수 있다.
 *
 * 매칭은 워커 스레드에서 수행한다. 취소되거나 SEARCH_TIMEOUT_MS 를 넘기면 워커를 강제 종료해서
 * 폭주하는 정규식이 확장 호스트를 멈추지 못하게 한다.
 */
export async function runSearch(
  query: SearchQuery,
  config: EngineConfig,
  token: vscode.CancellationToken,
  onBatch: (files: FileResult[]) => void
): Promise<SearchStats> {
  if (query.query.length === 0) {
    return { fileCount: 0, matchCount: 0, truncated: false };
  }

  const files = await collectFiles(query, config, token);
  if (token.isCancellationRequested || files.length === 0) {
    return { fileCount: 0, matchCount: 0, truncated: false };
  }

  // 원격(file 스킴이 아닌) 파일은 워커의 node fs 로 읽을 수 없어 대상에서 뺀다.
  const paths = files.filter((uri) => uri.scheme === 'file').map((uri) => uri.fsPath);
  if (paths.length === 0) {
    return { fileCount: 0, matchCount: 0, truncated: false };
  }

  const input: WorkerInput = {
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
    const worker = new Worker(path.join(__dirname, 'searchWorker.js'), { workerData: input });
    const stats: SearchStats = { fileCount: 0, matchCount: 0, truncated: false };
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancelSub.dispose();
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            '검색이 너무 오래 걸려 중단했습니다. 정규식이 지나치게 복잡하지 않은지 확인해 주세요. ' +
              '(예: (a+)+ 처럼 수량자가 중첩된 패턴)'
          )
        )
      );
    }, SEARCH_TIMEOUT_MS);

    const cancelSub = token.onCancellationRequested(() => finish(() => resolve(stats)));

    worker.on('message', (message: WorkerMessage) => {
      if (settled) {
        return;
      }
      if (message.type === 'batch') {
        const results = message.files.map((file) =>
          toFileResult(vscode.Uri.file(file.fsPath), file.matches, file.truncated)
        );
        stats.fileCount += results.length;
        for (const file of results) {
          stats.matchCount += file.matches.length;
        }
        onBatch(results);
      } else if (message.type === 'done') {
        stats.truncated = message.truncated;
        finish(() => resolve(stats));
      } else if (message.type === 'error') {
        finish(() => reject(new Error(message.message)));
      }
    });

    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`검색 작업이 예기치 않게 끝났습니다. (code ${code})`)));
      } else {
        finish(() => resolve(stats));
      }
    });
  });
}
