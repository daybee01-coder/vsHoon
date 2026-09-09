/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { DirectoryScanner, LocalFileSession } from './localFileSession';

interface FakeEntry {
  readonly name: string;
  readonly direntKind: 'file' | 'directory' | 'symlink';
  /** `stat` 결과. 없으면 접근 불가/깨진 링크로 취급한다. */
  readonly target?: { isDirectory: boolean; size: number; mtimeMs: number; mode: number };
}

/** 동시 실행 수를 관찰할 수 있는 가짜 파일 시스템. 실제 디스크에 접근하지 않는다. */
class FakeScanner implements DirectoryScanner {
  statCalls = 0;
  peakConcurrentStats = 0;
  private activeStats = 0;

  constructor(private readonly entries: readonly FakeEntry[]) {}

  async readdir(_dirPath: string, _options: { withFileTypes: true }) {
    return this.entries.map((entry) => ({
      name: entry.name,
      isDirectory: () => entry.direntKind === 'directory',
      isSymbolicLink: () => entry.direntKind === 'symlink',
    }));
  }

  async stat(entryPath: string) {
    this.statCalls++;
    this.activeStats++;
    this.peakConcurrentStats = Math.max(this.peakConcurrentStats, this.activeStats);
    try {
      // 모든 호출이 겹칠 기회를 주고 나서 결과를 낸다. 한도가 없으면 최고 동시 수가 항목 수가 된다.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const entry = this.entries.find((candidate) => candidate.name === path.basename(entryPath));
      if (!entry?.target) {
        throw new Error(`EACCES: ${entryPath}`);
      }
      return {
        isDirectory: () => entry.target!.isDirectory,
        isFile: () => !entry.target!.isDirectory,
        size: entry.target.size,
        mtimeMs: entry.target.mtimeMs,
        mode: entry.target.mode,
      };
    } finally {
      this.activeStats--;
    }
  }
}

const file = (name: string, size: number): FakeEntry => ({
  name,
  direntKind: 'file',
  target: { isDirectory: false, size, mtimeMs: 100, mode: 0o100644 },
});

describe('LocalFileSession.readdir', () => {
  it('항목 순서와 값을 유지하면서 동시 stat 수를 한도로 묶는다', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => file(`file-${index}.txt`, index));
    const scanner = new FakeScanner(entries);
    const listed = await new LocalFileSession(scanner, 8).readdir('/dir');

    assert.deepStrictEqual(
      {
        names: listed.map((entry) => entry.name),
        sizes: listed.map((entry) => entry.size),
        statCalls: scanner.statCalls,
        peak: scanner.peakConcurrentStats,
      },
      {
        names: entries.map((entry) => entry.name),
        sizes: entries.map((_, index) => index),
        statCalls: 200,
        peak: 8,
      }
    );
  });

  it('심링크 대상과 접근 불가 항목의 기존 표시 규칙을 유지한다', async () => {
    const scanner = new FakeScanner([
      { name: 'linked-dir', direntKind: 'symlink', target: { isDirectory: true, size: 4096, mtimeMs: 1, mode: 0o40755 } },
      { name: 'broken-link', direntKind: 'symlink' },
      { name: 'no-access', direntKind: 'directory' },
      file('plain.txt', 12),
    ]);

    assert.deepStrictEqual(await new LocalFileSession(scanner, 2).readdir('/dir'), [
      { name: 'linked-dir', isDirectory: true, isSymbolicLink: true, size: undefined, mtime: 1, mode: 0o755 },
      { name: 'broken-link', isDirectory: false, isSymbolicLink: true, size: undefined, mtime: undefined, mode: undefined },
      { name: 'no-access', isDirectory: true, isSymbolicLink: false, size: undefined, mtime: undefined, mode: undefined },
      { name: 'plain.txt', isDirectory: false, isSymbolicLink: false, size: 12, mtime: 100, mode: 0o644 },
    ]);
  });

  it('한 세션의 여러 폴더 조회가 겹쳐도 한도를 함께 지킨다', async () => {
    const scanner = new FakeScanner(Array.from({ length: 50 }, (_, index) => file(`f-${index}`, index)));
    const session = new LocalFileSession(scanner, 4);

    await Promise.all([session.readdir('/a'), session.readdir('/b'), session.readdir('/c')]);

    assert.deepStrictEqual(
      { statCalls: scanner.statCalls, peak: scanner.peakConcurrentStats },
      { statCalls: 150, peak: 4 }
    );
  });
});
