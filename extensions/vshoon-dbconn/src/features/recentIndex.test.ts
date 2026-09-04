import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_RECENT,
  needsTouch,
  normalizeRecents,
  removeRecent,
  touchRecent,
  type RecentScriptEntry,
} from './recentIndex';

function entry(uri: string, usedAt: number): RecentScriptEntry {
  return { uri, label: uri, folder: '', usedAt };
}

describe('touchRecent', () => {
  it('방금 본 것을 맨 앞으로 올린다', () => {
    const list = [entry('a', 3), entry('b', 2)];
    const next = touchRecent(list, entry('b', 9));
    assert.deepEqual(
      next.map((e) => e.uri),
      ['b', 'a'],
    );
    assert.equal(next[0]!.usedAt, 9);
  });

  it('같은 파일이 두 번 들어가지 않는다', () => {
    const next = touchRecent([entry('a', 1)], entry('a', 2));
    assert.equal(next.length, 1);
  });

  it('상한을 넘으면 오래된 것부터 밀려난다', () => {
    let list: RecentScriptEntry[] = [];
    for (let i = 0; i < MAX_RECENT + 5; i++) {
      list = touchRecent(list, entry(`f${i}`, i));
    }
    assert.equal(list.length, MAX_RECENT);
    assert.equal(list[0]!.uri, `f${MAX_RECENT + 4}`);
    assert.ok(!list.some((e) => e.uri === 'f0'));
  });
});

describe('needsTouch', () => {
  it('맨 앞에 있고 방금 본 것이면 다시 쓰지 않는다', () => {
    const list = [entry('a', 1_000)];
    assert.equal(needsTouch(list, 'a', 1_500), false);
  });

  it('시간이 지났으면 다시 쓴다', () => {
    const list = [entry('a', 1_000)];
    assert.equal(needsTouch(list, 'a', 1_000 + 60_001), true);
  });

  it('맨 앞이 아니면 올려야 하므로 다시 쓴다', () => {
    const list = [entry('a', 2_000), entry('b', 1_000)];
    assert.equal(needsTouch(list, 'b', 2_100), true);
  });

  it('목록이 비어 있으면 쓴다', () => {
    assert.equal(needsTouch([], 'a', 1), true);
  });
});

describe('removeRecent', () => {
  it('지정한 것만 뺀다', () => {
    const next = removeRecent([entry('a', 2), entry('b', 1)], 'a');
    assert.deepEqual(
      next.map((e) => e.uri),
      ['b'],
    );
  });
});

describe('normalizeRecents', () => {
  it('배열이 아니면 빈 목록', () => {
    assert.deepEqual(normalizeRecents(undefined), []);
    assert.deepEqual(normalizeRecents({ uri: 'a' }), []);
  });

  it('망가진 항목과 중복은 건너뛴다', () => {
    const raw = [
      { uri: 'file:///a.sql', label: 'a.sql', folder: 'sql', usedAt: 2 },
      { label: 'uri 없음' },
      null,
      { uri: 'file:///a.sql', label: '중복', folder: '', usedAt: 9 },
    ];
    const entries = normalizeRecents(raw);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.label, 'a.sql');
  });

  it('최근 순으로 정렬한다', () => {
    const entries = normalizeRecents([
      { uri: 'b', usedAt: 1 },
      { uri: 'a', usedAt: 5 },
    ]);
    assert.deepEqual(
      entries.map((e) => e.uri),
      ['a', 'b'],
    );
  });

  it('빠진 값은 안전한 기본값으로 채운다', () => {
    const entries = normalizeRecents([{ uri: 'file:///x.sql' }]);
    assert.deepEqual(entries[0], {
      uri: 'file:///x.sql',
      label: '(이름 없음)',
      folder: '',
      usedAt: 0,
    });
  });
});
