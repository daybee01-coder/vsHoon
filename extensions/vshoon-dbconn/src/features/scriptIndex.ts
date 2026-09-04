import { createHash } from 'node:crypto';

/**
 * 저장하지 않은 SQL 초안 캐시의 색인 모델.
 *
 * 내용은 확장의 전역 저장소에 파일로 두고, 여기 색인만 globalState 에 남긴다.
 * 색인을 globalState 에 두면 목록을 그릴 때 파일을 전부 읽지 않아도 되고,
 * 내용을 파일로 두면 큰 스크립트가 globalState 를 부풀리지 않는다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

export interface ScriptCacheEntry {
  /** 원본 문서 uri 에서 만든 키. 캐시 파일 이름으로도 쓴다. */
  key: string;
  /** 원본 문서 uri. 같은 편집기를 다시 저장하면 같은 항목을 덮어쓴다. */
  uri: string;
  /** 한 번도 파일로 저장된 적 없는 초안인지 (untitled). */
  untitled: boolean;
  /** 목록에 보여줄 한 줄 요약. */
  label: string;
  savedAt: number;
  /** 원본 글자 수 — 목록에서 크기 감을 준다. */
  length: number;
}

/** 파일 이름으로 안전한 키. uri 를 그대로 쓰면 경로 구분자가 섞인다. */
export function cacheKey(uri: string): string {
  return createHash('sha1').update(uri).digest('hex').slice(0, 16);
}

/**
 * 목록에 쓸 한 줄 요약.
 * 주석으로 시작하는 스크립트가 흔하므로 주석 기호는 벗겨서 보여준다 —
 * "-- Ctrl+Enter: ..." 만 잔뜩 나열되면 무엇이 무엇인지 구분되지 않는다.
 */
export function summarize(text: string): string {
  const lines = text.split(/\r?\n/);
  let fallback = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const uncommented = line.replace(/^(--+|#+|\/\*+)\s*/, '').replace(/\*\/\s*$/, '').trim();
    if (uncommented.length === 0) {
      continue;
    }
    // 주석이 아닌 첫 줄을 우선하고, 없으면 첫 주석 줄이라도 쓴다.
    if (line === uncommented) {
      return clip(uncommented);
    }
    if (fallback.length === 0) {
      fallback = uncommented;
    }
  }
  return fallback.length > 0 ? clip(fallback) : '(빈 스크립트)';
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

export interface PruneOptions {
  maxEntries: number;
  retentionDays: number;
  now: number;
}

/**
 * 보관 정책을 적용한다.
 *
 * 두 가지를 함께 본다: 너무 오래된 것과 너무 많은 것.
 * 초안 캐시는 사용자가 지우지 않는 저장소라서, 상한이 없으면
 * 몇 달 뒤에는 수천 개가 쌓인다.
 */
export function pruneEntries(
  entries: readonly ScriptCacheEntry[],
  options: PruneOptions,
): { keep: ScriptCacheEntry[]; drop: ScriptCacheEntry[] } {
  const sorted = [...entries].sort((a, b) => b.savedAt - a.savedAt);
  const cutoff =
    options.retentionDays > 0 ? options.now - options.retentionDays * 24 * 60 * 60 * 1000 : 0;

  const keep: ScriptCacheEntry[] = [];
  const drop: ScriptCacheEntry[] = [];
  for (const entry of sorted) {
    const tooOld = cutoff > 0 && entry.savedAt < cutoff;
    const tooMany = keep.length >= Math.max(1, options.maxEntries);
    if (tooOld || tooMany) {
      drop.push(entry);
    } else {
      keep.push(entry);
    }
  }
  return { keep, drop };
}

/** globalState 에서 읽은 값을 신뢰하지 않고 검증한다. */
export function normalizeEntries(raw: unknown): ScriptCacheEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: ScriptCacheEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key : undefined;
    const uri = typeof record.uri === 'string' ? record.uri : undefined;
    if (!key || !uri || seen.has(key) || !/^[0-9a-f]{6,64}$/.test(key)) {
      continue;
    }
    seen.add(key);
    entries.push({
      key,
      uri,
      untitled: record.untitled === true,
      label: typeof record.label === 'string' ? record.label : '(제목 없음)',
      savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
      length: typeof record.length === 'number' ? record.length : 0,
    });
  }
  return entries.sort((a, b) => b.savedAt - a.savedAt);
}
