import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cacheKey,
  normalizeEntries,
  pruneEntries,
  summarize,
  type ScriptCacheEntry,
} from './scriptIndex';

function entry(key: string, savedAt: number, overrides: Partial<ScriptCacheEntry> = {}): ScriptCacheEntry {
  return {
    key,
    uri: `untitled:Untitled-${key}`,
    untitled: true,
    label: 'SELECT 1',
    savedAt,
    length: 8,
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('cacheKey', () => {
  it('같은 uri 는 같은 키, 다른 uri 는 다른 키', () => {
    assert.equal(cacheKey('untitled:Untitled-1'), cacheKey('untitled:Untitled-1'));
    assert.notEqual(cacheKey('untitled:Untitled-1'), cacheKey('untitled:Untitled-2'));
  });

  it('파일 이름으로 쓸 수 있는 문자만 나온다', () => {
    assert.match(cacheKey('file:///c:/보고서/쿼리 모음.sql'), /^[0-9a-f]{16}$/);
  });
});

describe('summarize', () => {
  it('주석이 아닌 첫 줄을 고른다', () => {
    const text = '-- 월별 매출\n\nSELECT sum(amount) FROM sales\n GROUP BY month';
    assert.equal(summarize(text), 'SELECT sum(amount) FROM sales');
  });

  it('주석뿐이면 주석 기호를 벗겨서 쓴다', () => {
    assert.equal(summarize('-- 나중에 정리할 쿼리\n\n'), '나중에 정리할 쿼리');
  });

  it('빈 스크립트를 구분한다', () => {
    assert.equal(summarize('   \n\n'), '(빈 스크립트)');
  });

  it('긴 줄은 자른다', () => {
    const label = summarize('SELECT ' + 'x'.repeat(200));
    assert.ok(label.length <= 81, `${label.length}자`);
    assert.ok(label.endsWith('…'));
  });
});

describe('pruneEntries', () => {
  const now = 1_700_000_000_000;

  it('개수 상한을 넘으면 오래된 것부터 버린다', () => {
    const entries = [entry('a', now - 1000), entry('b', now - 2000), entry('c', now - 3000)];
    const { keep, drop } = pruneEntries(entries, { maxEntries: 2, retentionDays: 0, now });
    assert.deepEqual(keep.map((e) => e.key), ['a', 'b']);
    assert.deepEqual(drop.map((e) => e.key), ['c']);
  });

  it('보관 기간이 지난 것은 개수와 무관하게 버린다', () => {
    const entries = [entry('fresh', now - DAY), entry('stale', now - 30 * DAY)];
    const { keep, drop } = pruneEntries(entries, { maxEntries: 50, retentionDays: 14, now });
    assert.deepEqual(keep.map((e) => e.key), ['fresh']);
    assert.deepEqual(drop.map((e) => e.key), ['stale']);
  });

  it('보관 기간 0 이면 기간 제한을 두지 않는다', () => {
    const entries = [entry('old', now - 365 * DAY)];
    const { keep } = pruneEntries(entries, { maxEntries: 50, retentionDays: 0, now });
    assert.equal(keep.length, 1);
  });
});

describe('normalizeEntries', () => {
  it('손상된 항목과 중복 키를 걸러 낸다', () => {
    const entries = normalizeEntries([
      { key: 'aabbccdd', uri: 'untitled:1', savedAt: 2, untitled: true, label: 'A', length: 1 },
      { key: 'aabbccdd', uri: 'untitled:1', savedAt: 3 },
      { key: '../evil', uri: 'untitled:2' },
      { uri: 'untitled:3' },
      null,
      'nope',
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.key, 'aabbccdd');
  });

  it('배열이 아니면 빈 목록', () => {
    assert.deepEqual(normalizeEntries(undefined), []);
    assert.deepEqual(normalizeEntries({ key: 'x' }), []);
  });

  it('최근 저장 순으로 정렬한다', () => {
    const entries = normalizeEntries([
      { key: 'aaaaaa', uri: 'u1', savedAt: 10 },
      { key: 'bbbbbb', uri: 'u2', savedAt: 30 },
      { key: 'cccccc', uri: 'u3', savedAt: 20 },
    ]);
    assert.deepEqual(entries.map((e) => e.key), ['bbbbbb', 'cccccc', 'aaaaaa']);
  });
});
