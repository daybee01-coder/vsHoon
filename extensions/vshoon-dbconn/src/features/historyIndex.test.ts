import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendEntry,
  clipSql,
  dayLabel,
  describeRun,
  groupByDay,
  normalizeHistory,
  pruneHistory,
  type QueryHistoryEntry,
} from './historyIndex';

function entry(overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry {
  return {
    id: 'a1',
    sql: 'SELECT 1',
    profileId: 'p1',
    connectionName: '로컬',
    dialect: 'postgres',
    origin: 'editor',
    startedAt: 1_700_000_000_000,
    durationMs: 12,
    status: 'ok',
    rowCount: 1,
    runs: 1,
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('appendEntry', () => {
  it('같은 연결에서 같은 SQL 을 연달아 실행하면 접어서 센다', () => {
    const first = entry();
    const second = entry({ id: 'b2', startedAt: first.startedAt + 5000, durationMs: 20 });
    const list = appendEntry([first], second);

    assert.equal(list.length, 1, '같은 줄이 두 번 쌓이면 이력이 도배된다');
    assert.equal(list[0]!.runs, 2);
    assert.equal(list[0]!.durationMs, 20, '최근 실행의 소요 시간을 보여야 한다');
    assert.equal(list[0]!.id, 'a1', '기존 항목의 id 를 유지해 삭제 버튼이 어긋나지 않게 한다');
  });

  it('SQL 이 다르면 새 항목으로 쌓는다', () => {
    const list = appendEntry([entry()], entry({ id: 'b2', sql: 'SELECT 2' }));
    assert.equal(list.length, 2);
    assert.equal(list[0]!.sql, 'SELECT 2');
  });

  it('연결이 다르면 접지 않는다', () => {
    const list = appendEntry([entry()], entry({ id: 'b2', profileId: 'p2' }));
    assert.equal(list.length, 2);
  });
});

describe('pruneHistory', () => {
  const now = 1_700_000_000_000;

  it('건수 상한을 넘으면 오래된 것부터 버린다', () => {
    const entries = [
      entry({ id: 'a', startedAt: now - 1000 }),
      entry({ id: 'b', startedAt: now - 2000 }),
      entry({ id: 'c', startedAt: now - 3000 }),
    ];
    const kept = pruneHistory(entries, { maxEntries: 2, retentionDays: 0, now });
    assert.deepEqual(kept.map((e) => e.id), ['a', 'b']);
  });

  it('보관 기간이 지난 것은 버린다', () => {
    const entries = [
      entry({ id: 'fresh', startedAt: now - DAY }),
      entry({ id: 'stale', startedAt: now - 60 * DAY }),
    ];
    const kept = pruneHistory(entries, { maxEntries: 200, retentionDays: 30, now });
    assert.deepEqual(kept.map((e) => e.id), ['fresh']);
  });
});

describe('clipSql', () => {
  it('아주 긴 SQL 은 잘라서 표시를 남긴다', () => {
    const clipped = clipSql('SELECT ' + 'x'.repeat(30_000));
    assert.ok(clipped.length < 21_000);
    assert.ok(clipped.endsWith('(잘림)'));
  });

  it('짧은 SQL 은 그대로 둔다', () => {
    assert.equal(clipSql('SELECT 1'), 'SELECT 1');
  });
});

describe('normalizeHistory', () => {
  it('손상된 항목을 걸러 내고 최신순으로 정렬한다', () => {
    const entries = normalizeHistory([
      { id: 'a', sql: 'SELECT 1', startedAt: 10 },
      { id: 'b', sql: 'SELECT 2', startedAt: 30 },
      { id: 'c' },
      { sql: 'SELECT 3' },
      null,
    ]);
    assert.deepEqual(entries.map((e) => e.id), ['b', 'a']);
    assert.equal(entries[0]!.runs, 1, '누락된 실행 횟수는 1로 채운다');
    assert.equal(entries[0]!.status, 'ok');
  });

  it('배열이 아니면 빈 목록', () => {
    assert.deepEqual(normalizeHistory('nope'), []);
  });
});

describe('describeRun', () => {
  const now = new Date(2024, 4, 20, 15, 30).getTime();

  it('같은 날이면 시각만, 지난 날이면 날짜까지 적는다', () => {
    const today = describeRun(entry({ startedAt: new Date(2024, 4, 20, 9, 5).getTime() }), now);
    assert.ok(today.startsWith('09:05 · 로컬'), today);

    const past = describeRun(entry({ startedAt: new Date(2024, 4, 18, 9, 5).getTime() }), now);
    assert.ok(past.startsWith('05-18 09:05'), past);
  });

  it('실패한 실행은 행 수 대신 오류라고 적는다', () => {
    const text = describeRun(entry({ status: 'error', rowCount: undefined }), now);
    assert.ok(text.includes('오류'));
  });

  it('반복 실행 횟수와 출처를 덧붙인다', () => {
    const text = describeRun(entry({ runs: 3, origin: 'preview' }), now);
    assert.ok(text.includes('3회'), text);
    assert.ok(text.includes('미리보기'), text);
  });

  it('편집기 실행에는 출처를 적지 않는다 — 기본값이라 군더더기다', () => {
    const text = describeRun(entry({ origin: 'editor' }), now);
    assert.ok(!text.includes('미리보기') && !text.includes('실행 계획'));
  });
});

describe('groupByDay', () => {
  const now = new Date(2024, 4, 20, 15, 0).getTime();

  it('같은 날 실행을 하나로 묶고 목록 순서를 지킨다', () => {
    const groups = groupByDay(
      [
        entry({ id: '1', startedAt: new Date(2024, 4, 20, 14, 0).getTime() }),
        entry({ id: '2', startedAt: new Date(2024, 4, 20, 9, 0).getTime() }),
        entry({ id: '3', startedAt: new Date(2024, 4, 19, 22, 0).getTime() }),
        entry({ id: '4', startedAt: new Date(2024, 4, 17, 8, 0).getTime() }),
      ],
      now,
    );
    assert.deepEqual(groups.map((g) => g.label), ['오늘', '어제', '2024-05-17']);
    assert.deepEqual(groups[0]!.entries.map((e) => e.id), ['1', '2']);
  });

  it('빈 목록은 빈 묶음', () => {
    assert.deepEqual(groupByDay([], now), []);
  });
});

describe('dayLabel', () => {
  const now = new Date(2024, 0, 1, 12, 0).getTime();

  it('해가 바뀌는 경계에서도 어제를 알아본다', () => {
    assert.equal(dayLabel(new Date(2023, 11, 31, 23, 59).getTime(), now), '어제');
    assert.equal(dayLabel(new Date(2023, 11, 30, 1, 0).getTime(), now), '2023-12-30');
    assert.equal(dayLabel(new Date(2024, 0, 1, 0, 1).getTime(), now), '오늘');
  });
});
