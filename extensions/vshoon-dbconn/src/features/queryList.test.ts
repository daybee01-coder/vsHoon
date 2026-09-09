/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectQueryFiles, isQueryFile, type QueryFolderEntry } from './queryList';

/**
 * 조회 횟수와 동시 실행 최고치를 기록하는 가짜 폴더.
 *
 * `stat` 은 즉시 끝나지 않아야 동시성을 관찰할 수 있으므로 한 틱 뒤에 끝난다.
 */
function folder(entries: QueryFolderEntry[], failing: ReadonlySet<string> = new Set()) {
  const stats: string[] = [];
  let active = 0;
  let peak = 0;
  return {
    stats,
    peak: () => peak,
    source: {
      entries: async () => entries,
      stat: async (name: string) => {
        stats.push(name);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active--;
        if (failing.has(name)) {
          throw new Error(`gone: ${name}`);
        }
        return { modifiedAt: entries.findIndex((entry) => entry.name === name), size: name.length };
      },
    },
  };
}

function sqlFiles(count: number): QueryFolderEntry[] {
  return Array.from({ length: count }, (_, index) => ({ name: `q${index}.sql`, isFile: true }));
}

describe('isQueryFile', () => {
  it('폴더와 SQL 이 아닌 파일은 제외하고 대소문자는 가리지 않는다', () => {
    const entries: QueryFolderEntry[] = [
      { name: 'a.sql', isFile: true },
      { name: 'B.SQL', isFile: true },
      { name: 'notes.txt', isFile: true },
      { name: 'sub.sql', isFile: false },
    ];
    assert.deepEqual(entries.filter(isQueryFile).map((entry) => entry.name), ['a.sql', 'B.SQL']);
  });
});

describe('collectQueryFiles', () => {
  it('조회 수는 그대로이고 동시 실행은 한도까지만, 목록은 최신순', async () => {
    const fake = folder(sqlFiles(50));
    const files = await collectQueryFiles(fake.source, 8);

    assert.deepEqual(
      {
        stats: fake.stats.length,
        peak: fake.peak(),
        first: files[0],
        last: files.at(-1),
        count: files.length,
      },
      {
        stats: 50,
        peak: 8,
        first: { name: 'q49.sql', modifiedAt: 49, size: 7 },
        last: { name: 'q0.sql', modifiedAt: 0, size: 6 },
        count: 50,
      },
    );
  });

  it('조회가 실패한 파일만 빠지고 나머지 목록은 유지된다', async () => {
    const fake = folder(sqlFiles(4), new Set(['q1.sql', 'q3.sql']));
    const files = await collectQueryFiles(fake.source, 2);

    assert.deepEqual(files.map((file) => file.name), ['q2.sql', 'q0.sql']);
  });

  it('SQL 이 아닌 항목은 조회하지 않는다', async () => {
    const fake = folder([
      { name: 'keep.sql', isFile: true },
      { name: 'notes.txt', isFile: true },
      { name: 'archive', isFile: false },
    ]);
    const files = await collectQueryFiles(fake.source, 4);

    assert.deepEqual({ stats: fake.stats, names: files.map((file) => file.name) }, {
      stats: ['keep.sql'],
      names: ['keep.sql'],
    });
  });

  it('수정 시각이 같으면 폴더 열거 순서를 유지한다', async () => {
    const entries = sqlFiles(6);
    const files = await collectQueryFiles(
      {
        entries: async () => entries,
        stat: async (name: string) => {
          await new Promise((resolve) => setTimeout(resolve, name === 'q0.sql' ? 5 : 0));
          return { modifiedAt: 100, size: 1 };
        },
      },
      3,
    );

    assert.deepEqual(files.map((file) => file.name), entries.map((entry) => entry.name));
  });

  it('빈 폴더와 잘못된 한도에서도 목록을 만든다', async () => {
    const empty = await collectQueryFiles(folder([]).source, 8);
    const fake = folder(sqlFiles(3));
    const sequential = await collectQueryFiles(fake.source, 0);

    assert.deepEqual({ empty, peak: fake.peak(), count: sequential.length }, {
      empty: [],
      peak: 1,
      count: 3,
    });
  });
});
