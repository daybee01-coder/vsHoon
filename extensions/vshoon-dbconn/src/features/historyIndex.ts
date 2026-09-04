import type { DialectId } from '../types';
import { summarize } from './scriptIndex';

/**
 * 쿼리 실행 이력의 저장 모델.
 *
 * 이력은 "어제 돌린 그 쿼리"를 다시 찾기 위한 것이다. 그래서 SQL 원문과
 * 최소한의 실행 결과(시각·소요·행 수·오류)만 남기고, 결과 데이터는 담지 않는다 —
 * 결과까지 남기면 저장소가 순식간에 커지고 민감한 값이 오래 남는다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

export type QueryOrigin =
  /** 편집기에서 Ctrl+Enter 등으로 실행. */
  | 'editor'
  /** 트리의 "상위 200건 조회" 같은 미리보기. */
  | 'preview'
  /** 결과 그리드에서 값 수정·행 삭제로 만들어진 UPDATE/DELETE. */
  | 'grid-edit'
  /** 실행 계획 조회. */
  | 'explain';

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  profileId: string;
  connectionName: string;
  dialect: DialectId;
  origin: QueryOrigin;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  rowCount?: number;
  affectedRows?: number;
  error?: string;
  /** 같은 SQL 을 연달아 실행한 횟수. 목록이 같은 줄로 도배되지 않게 접어 센다. */
  runs: number;
}

/** 한 항목에 담는 SQL 길이 상한. 이력은 백업이 아니다. */
const MAX_SQL_CHARS = 20_000;

/** 목록에 보여줄 한 줄 요약. 초안 캐시와 같은 규칙을 쓴다. */
export function historyLabel(sql: string): string {
  return summarize(sql);
}

export function clipSql(sql: string): string {
  return sql.length <= MAX_SQL_CHARS ? sql : `${sql.slice(0, MAX_SQL_CHARS)}\n-- …(잘림)`;
}

/**
 * 새 항목을 목록 앞에 넣는다.
 *
 * 바로 앞 항목과 같은 연결·같은 SQL 이면 새로 쌓지 않고 실행 횟수만 올린다.
 * 같은 쿼리를 고쳐 가며 반복 실행하는 것이 정상적인 사용 방식이라,
 * 그대로 쌓으면 이력이 같은 줄로 가득 차 쓸모가 없어진다.
 */
export function appendEntry(
  entries: readonly QueryHistoryEntry[],
  entry: QueryHistoryEntry,
): QueryHistoryEntry[] {
  const previous = entries[0];
  if (previous && previous.profileId === entry.profileId && previous.sql === entry.sql) {
    const merged: QueryHistoryEntry = {
      ...entry,
      id: previous.id,
      runs: previous.runs + 1,
    };
    return [merged, ...entries.slice(1)];
  }
  return [entry, ...entries];
}

export interface HistoryPruneOptions {
  maxEntries: number;
  retentionDays: number;
  now: number;
}

export function pruneHistory(
  entries: readonly QueryHistoryEntry[],
  options: HistoryPruneOptions,
): QueryHistoryEntry[] {
  const cutoff =
    options.retentionDays > 0 ? options.now - options.retentionDays * 24 * 60 * 60 * 1000 : 0;
  return [...entries]
    .sort((a, b) => b.startedAt - a.startedAt)
    .filter((entry) => cutoff === 0 || entry.startedAt >= cutoff)
    .slice(0, Math.max(1, options.maxEntries));
}

/** 실행 하나를 한 줄로 요약한다 — 목록의 부제로 쓴다. */
export function describeRun(entry: QueryHistoryEntry, now = Date.now()): string {
  const parts = [formatHistoryTime(entry.startedAt, now), entry.connectionName];
  if (entry.runs > 1) {
    parts.push(`${entry.runs}회`);
  }
  parts.push(`${entry.durationMs.toLocaleString()}ms`);
  if (entry.status === 'error') {
    parts.push('오류');
  } else if (entry.rowCount !== undefined) {
    parts.push(`${entry.rowCount.toLocaleString()}행`);
  } else if (entry.affectedRows !== undefined) {
    parts.push(`${entry.affectedRows.toLocaleString()}행 영향`);
  }
  const origin = ORIGIN_LABELS[entry.origin];
  if (origin) {
    parts.push(origin);
  }
  return parts.join(' · ');
}

/** 편집기 실행은 기본이라 굳이 적지 않는다 — 나머지만 어디서 왔는지 밝힌다. */
const ORIGIN_LABELS: Record<QueryOrigin, string | undefined> = {
  editor: undefined,
  preview: '미리보기',
  'grid-edit': '그리드 편집',
  explain: '실행 계획',
};

/** 오늘 것은 시각만, 지난 것은 날짜까지. */
export function formatHistoryTime(timestamp: number, now = Date.now()): string {
  const when = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return isSameDay(when, new Date(now)) ? time : `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}

/** 목록을 날짜별로 묶는다. 이력은 최신순이므로 묶음도 그 순서를 따른다. */
export interface HistoryDayGroup {
  /** 그 날 0시의 타임스탬프 — 묶음을 구분하는 키. */
  key: number;
  label: string;
  entries: QueryHistoryEntry[];
}

export function groupByDay(
  entries: readonly QueryHistoryEntry[],
  now = Date.now(),
): HistoryDayGroup[] {
  const groups: HistoryDayGroup[] = [];
  for (const entry of entries) {
    const key = startOfDay(entry.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
      continue;
    }
    groups.push({ key, label: dayLabel(entry.startedAt, now), entries: [entry] });
  }
  return groups;
}

export function dayLabel(timestamp: number, now = Date.now()): string {
  const day = startOfDay(timestamp);
  const today = startOfDay(now);
  const dayMs = 24 * 60 * 60 * 1000;
  if (day === today) {
    return '오늘';
  }
  if (day === startOfDay(today - dayMs)) {
    return '어제';
  }
  const when = new Date(timestamp);
  return `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
}

function startOfDay(timestamp: number): number {
  const when = new Date(timestamp);
  return new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** globalState 에서 읽은 값을 신뢰하지 않고 검증한다. */
export function normalizeHistory(raw: unknown): QueryHistoryEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: QueryHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    const sql = typeof record.sql === 'string' ? record.sql : undefined;
    if (!id || !sql) {
      continue;
    }
    entries.push({
      id,
      sql,
      profileId: typeof record.profileId === 'string' ? record.profileId : '',
      connectionName: typeof record.connectionName === 'string' ? record.connectionName : '',
      dialect: isDialect(record.dialect) ? record.dialect : 'postgres',
      origin: isOrigin(record.origin) ? record.origin : 'editor',
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
      status: record.status === 'error' ? 'error' : 'ok',
      rowCount: typeof record.rowCount === 'number' ? record.rowCount : undefined,
      affectedRows: typeof record.affectedRows === 'number' ? record.affectedRows : undefined,
      error: typeof record.error === 'string' ? record.error : undefined,
      runs: typeof record.runs === 'number' && record.runs > 0 ? Math.floor(record.runs) : 1,
    });
  }
  return entries.sort((a, b) => b.startedAt - a.startedAt);
}

function isDialect(value: unknown): value is DialectId {
  return value === 'mysql' || value === 'mariadb' || value === 'postgres' || value === 'oracle';
}

function isOrigin(value: unknown): value is QueryOrigin {
  return value === 'editor' || value === 'preview' || value === 'grid-edit' || value === 'explain';
}
