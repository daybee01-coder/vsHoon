/**
 * 순수 매칭 로직. **vscode 모듈에 의존하지 않는다.**
 *
 * 검색 워커(searchWorker.ts)와 확장 호스트 양쪽에서 쓰이므로 여기에는 Node 기본 기능만 둔다.
 */
import { MatchItem } from './types';

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 검색 옵션(정규식 / 대소문자 / 단어단위)에 맞는 RegExp 를 만든다.
 * 잘못된 정규식이면 예외를 던진다.
 */
export function buildMatcher(
  pattern: string,
  opts: { regex: boolean; caseSensitive: boolean; wholeWord: boolean }
): RegExp {
  let source = opts.regex ? pattern : escapeRegExp(pattern);
  if (opts.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  const flags = opts.caseSensitive ? 'g' : 'gi';
  return new RegExp(source, flags);
}

export interface LineInfo {
  start: number;
  text: string;
}

/** 줄 단위로 자르되 각 줄의 시작 오프셋을 유지한다. (\r\n, \n, \r 모두 지원) */
export function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  const re = /\r\n|\n|\r/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push({ start, text: text.slice(start, m.index) });
    start = re.lastIndex;
  }
  lines.push({ start, text: text.slice(start) });
  return lines;
}

const PREVIEW_BEFORE = 60;
const PREVIEW_MAX = 300;

/**
 * 한 줄이 이보다 길면 매칭을 건너뛴다.
 * 압축(minified) 파일 같은 초장문 한 줄에서 정규식이 폭주하는 것을 막는다.
 */
export const MAX_LINE_LENGTH = 20000;

function toMatchItem(lineNo: number, lineText: string, column: number, length: number): MatchItem {
  const ctxStart = column > PREVIEW_BEFORE ? column - PREVIEW_BEFORE : 0;
  const sliced = lineText.slice(ctxStart, ctxStart + PREVIEW_MAX);
  const ellipsis = ctxStart > 0 ? '…' : '';
  return {
    line: lineNo,
    column,
    length,
    preview: ellipsis + sliced,
    previewColumn: column - ctxStart + ellipsis.length
  };
}

/**
 * 텍스트 전체에서 일치 항목을 찾는다.
 *
 * 길이 0 매치(`x*` 처럼 빈 문자열에도 맞는 패턴)는 **결과에 넣지 않는다.**
 * 화면에 표시할 것도 없고, 바꾸기에 쓰이면 "빈 범위 치환" = 문자 삽입이 되어 버린다.
 */
export function findMatches(
  text: string,
  matcher: RegExp,
  maxMatches: number
): { matches: MatchItem[]; truncated: boolean } {
  const matches: MatchItem[] = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].text;
    if (lineText.length === 0 || lineText.length > MAX_LINE_LENGTH) {
      continue;
    }
    matcher.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(lineText)) !== null) {
      if (m[0].length === 0) {
        matcher.lastIndex++; // 길이 0 매치는 건너뛴다 (무한루프도 방지)
        continue;
      }
      matches.push(toMatchItem(i, lineText, m.index, m[0].length));
      if (matches.length >= maxMatches) {
        return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}

/** `$&`, `$1` 같은 치환 패턴을 실제 값으로 확장한다. (정규식 모드 전용) */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  if (replacement.indexOf('$') === -1) {
    return replacement;
  }
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_s, g: string) => {
    if (g === '$') {
      return '$';
    }
    if (g === '&') {
      return match[0];
    }
    const idx = parseInt(g, 10);
    return match[idx] ?? '';
  });
}

/* ------------------------------------------------------------------ *
 * 파일 읽기 (워커와 공용)
 * ------------------------------------------------------------------ */

export function isBinary(buffer: Uint8Array): boolean {
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

export function decodeText(buffer: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
