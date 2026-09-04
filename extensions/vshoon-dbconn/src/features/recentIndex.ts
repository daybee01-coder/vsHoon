/**
 * 최근 연 SQL 편집기 목록의 모델.
 *
 * 초안 캐시(scriptIndex.ts)와는 다루는 것이 다르다. 초안 캐시는 **파일이 아닌 것**을
 * 지키는 장치라 저장되는 순간 항목을 지운다. 여기 목록은 반대로 **파일로 저장된
 * SQL** 만 기억한다 — 내용을 복사해 두지 않고 경로만 남기므로, 파일이 진실이다.
 *
 * 그래서 두 목록은 겹치지 않는다: 초안은 저장되는 순간 이쪽으로 넘어온다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

export interface RecentScriptEntry {
  /** 문서 uri 문자열. 목록의 식별자이기도 하다. */
  uri: string;
  /** 목록에 굵게 보여줄 이름 (파일 이름). */
  label: string;
  /** 이름 옆에 보여줄 위치 — 워크스페이스 기준 상대 경로면 더 좋다. */
  folder: string;
  /** 마지막으로 편집기에서 본 시각. */
  usedAt: number;
}

/** 목록에 남길 최대 개수. 넘치면 오래된 것부터 밀려난다. */
export const MAX_RECENT = 30;

/**
 * 방금 본 문서를 목록 맨 앞으로 올린다.
 *
 * 같은 파일을 다시 열면 새 항목이 생기는 게 아니라 시각만 갱신되어야 한다 —
 * 목록이 같은 이름으로 뒤덮이면 "최근"이라는 말이 무의미해진다.
 */
export function touchRecent(
  entries: readonly RecentScriptEntry[],
  entry: RecentScriptEntry,
  max = MAX_RECENT,
): RecentScriptEntry[] {
  const others = entries.filter((e) => e.uri !== entry.uri);
  return [entry, ...others].slice(0, Math.max(1, max));
}

/** 목록에서 하나를 뺀다 (파일이 사라졌거나 사용자가 지웠을 때). */
export function removeRecent(
  entries: readonly RecentScriptEntry[],
  uri: string,
): RecentScriptEntry[] {
  return entries.filter((e) => e.uri !== uri);
}

/**
 * 굳이 다시 저장할 만한 변화인지.
 *
 * 편집기 탭을 오갈 때마다 globalState 에 쓰면 탭 전환이 디스크 쓰기가 된다.
 * 이미 맨 앞에 있고 방금 본 항목이라면 그냥 둔다.
 */
export function needsTouch(
  entries: readonly RecentScriptEntry[],
  uri: string,
  now: number,
  quietMs = 60_000,
): boolean {
  const head = entries[0];
  return !(head?.uri === uri && now - head.usedAt < quietMs);
}

/** globalState 에서 읽은 값을 신뢰하지 않고 검증한다. */
export function normalizeRecents(raw: unknown): RecentScriptEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: RecentScriptEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const uri = typeof record.uri === 'string' ? record.uri : undefined;
    if (!uri || seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    entries.push({
      uri,
      label: typeof record.label === 'string' && record.label ? record.label : '(이름 없음)',
      folder: typeof record.folder === 'string' ? record.folder : '',
      usedAt: typeof record.usedAt === 'number' ? record.usedAt : 0,
    });
  }
  return entries.sort((a, b) => b.usedAt - a.usedAt).slice(0, MAX_RECENT);
}
