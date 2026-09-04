import type { DialectId } from '../types';

/**
 * SQL 스캐너.
 *
 * 완전한 파서가 아니라 "문자열/주석/식별자 경계를 정확히 아는" 렉서다.
 * 문장 분리와 자동 완성 컨텍스트 판별에는 이 정도면 충분하고,
 * 방언별 파서를 4개 유지하는 비용을 피할 수 있다.
 */

export type TokenKind =
  | 'whitespace'
  | 'line-comment'
  | 'block-comment'
  | 'string' // 작은따옴표 리터럴, 달러 인용 문자열
  | 'quoted-identifier' // "..." `...` [...]
  | 'number'
  | 'word' // 키워드 또는 식별자
  | 'punct' // 연산자, 구분자
  | 'semicolon'
  | 'variable'; // :bind, @var, ?, $1

export interface Token {
  kind: TokenKind;
  /** 원문 그대로의 텍스트. */
  text: string;
  start: number;
  end: number;
}

interface DialectLexRules {
  /** `#` 를 줄 주석으로 취급 (MySQL/MariaDB). */
  hashComment: boolean;
  /** 문자열 안에서 백슬래시 이스케이프 인정 (MySQL 기본값). */
  backslashEscapes: boolean;
  /** 백틱 식별자 인용 (MySQL/MariaDB). */
  backtickIdentifiers: boolean;
  /** `$tag$ ... $tag$` 달러 인용 (PostgreSQL). */
  dollarQuoting: boolean;
  /** 블록 주석 중첩 허용 (PostgreSQL). */
  nestedBlockComments: boolean;
}

export function lexRulesFor(dialect: DialectId): DialectLexRules {
  switch (dialect) {
    case 'mysql':
    case 'mariadb':
      return {
        hashComment: true,
        backslashEscapes: true,
        backtickIdentifiers: true,
        dollarQuoting: false,
        nestedBlockComments: false,
      };
    case 'postgres':
      return {
        hashComment: false,
        backslashEscapes: false,
        backtickIdentifiers: false,
        dollarQuoting: true,
        nestedBlockComments: true,
      };
    case 'oracle':
      return {
        hashComment: false,
        backslashEscapes: false,
        backtickIdentifiers: false,
        dollarQuoting: false,
        nestedBlockComments: false,
      };
  }
}

// \uC2DD\uBCC4\uC790 \uBB38\uC790 \uC9D1\uD569. \uBE44-ASCII \uB97C \uD1B5\uC9F8\uB85C \uD5C8\uC6A9\uD574 \uD55C\uAE00 \uCEEC\uB7FC\uBA85\uB3C4 \uD55C \uB2E8\uC5B4\uB85C \uBB36\uB294\uB2E4.
// `$` \uB294 \uC2DC\uC791 \uBB38\uC790\uC5D0\uC11C \uC81C\uC678\uD55C\uB2E4 \u2014 PostgreSQL \uB2EC\uB7EC \uC778\uC6A9($$)\uACFC \uACB9\uCE58\uAE30 \uB54C\uBB38.
// \uB2E4\uB9CC \uC774\uC5B4\uC9C0\uB294 \uBB38\uC790\uB85C\uB294 \uD5C8\uC6A9\uD574\uC57C Oracle \uC758 `V$SESSION` \uAC19\uC740 \uC774\uB984\uC774 \uCABC\uAC1C\uC9C0\uC9C0 \uC54A\uB294\uB2E4.
const WORD_START = /[A-Za-z_#\u0080-\uFFFF]/;
const WORD_PART = /[A-Za-z0-9_#$\u0080-\uFFFF]/;

export function tokenize(text: string, dialect: DialectId): Token[] {
  const rules = lexRulesFor(dialect);
  const tokens: Token[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const start = i;
    const ch = text[i]!;

    // ── 공백
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') {
      while (i < len && /\s/.test(text[i]!)) {
        i++;
      }
      tokens.push({ kind: 'whitespace', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 줄 주석: -- ... 또는 # ...
    if ((ch === '-' && text[i + 1] === '-') || (rules.hashComment && ch === '#')) {
      while (i < len && text[i] !== '\n') {
        i++;
      }
      tokens.push({ kind: 'line-comment', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 블록 주석: /* ... */
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (rules.nestedBlockComments && text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      tokens.push({ kind: 'block-comment', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 달러 인용 문자열 (PostgreSQL): $$ ... $$ / $tag$ ... $tag$
    if (rules.dollarQuoting && ch === '$') {
      const tag = readDollarTag(text, i);
      if (tag !== undefined) {
        const closeAt = text.indexOf(tag, i + tag.length);
        i = closeAt === -1 ? len : closeAt + tag.length;
        tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i });
        continue;
      }
      // $1 같은 위치 매개변수
      if (/[0-9]/.test(text[i + 1] ?? '')) {
        i++;
        while (i < len && /[0-9]/.test(text[i]!)) {
          i++;
        }
        tokens.push({ kind: 'variable', text: text.slice(start, i), start, end: i });
        continue;
      }
    }

    // ── 작은따옴표 문자열
    if (ch === "'") {
      i = scanQuoted(text, i, "'", rules.backslashEscapes);
      tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 큰따옴표 식별자 (MySQL 은 ANSI_QUOTES 미설정 시 문자열이지만,
    //    경계 판별 목적에서는 동일하게 다뤄도 안전하다)
    if (ch === '"') {
      i = scanQuoted(text, i, '"', rules.backslashEscapes);
      tokens.push({ kind: 'quoted-identifier', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 백틱 식별자
    if (rules.backtickIdentifiers && ch === '`') {
      i = scanQuoted(text, i, '`', false);
      tokens.push({ kind: 'quoted-identifier', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 바인드 변수 / 세션 변수
    if (ch === ':' && WORD_START.test(text[i + 1] ?? '')) {
      i += 2;
      while (i < len && WORD_PART.test(text[i]!)) {
        i++;
      }
      tokens.push({ kind: 'variable', text: text.slice(start, i), start, end: i });
      continue;
    }
    if (ch === '@') {
      i++;
      if (text[i] === '@') {
        i++;
      }
      while (i < len && WORD_PART.test(text[i]!)) {
        i++;
      }
      tokens.push({ kind: 'variable', text: text.slice(start, i), start, end: i });
      continue;
    }
    if (ch === '?') {
      i++;
      tokens.push({ kind: 'variable', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 숫자
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      i++;
      while (i < len && /[0-9.]/.test(text[i]!)) {
        i++;
      }
      if (i < len && /[eE]/.test(text[i]!)) {
        const save = i;
        i++;
        if (i < len && /[+-]/.test(text[i]!)) {
          i++;
        }
        if (i < len && /[0-9]/.test(text[i]!)) {
          while (i < len && /[0-9]/.test(text[i]!)) {
            i++;
          }
        } else {
          i = save;
        }
      }
      tokens.push({ kind: 'number', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 단어(키워드/식별자)
    if (WORD_START.test(ch)) {
      i++;
      while (i < len && WORD_PART.test(text[i]!)) {
        i++;
      }
      tokens.push({ kind: 'word', text: text.slice(start, i), start, end: i });
      continue;
    }

    // ── 세미콜론
    if (ch === ';') {
      i++;
      tokens.push({ kind: 'semicolon', text: ';', start, end: i });
      continue;
    }

    // ── 그 외 구두점/연산자
    i++;
    tokens.push({ kind: 'punct', text: text.slice(start, i), start, end: i });
  }

  return tokens;
}

/** `$tag$` 형태의 여는 태그를 읽는다. 아니면 undefined. */
function readDollarTag(text: string, at: number): string | undefined {
  if (text[at] !== '$') {
    return undefined;
  }
  let j = at + 1;
  while (j < text.length && WORD_PART.test(text[j]!) && text[j] !== '$') {
    j++;
  }
  if (text[j] === '$') {
    return text.slice(at, j + 1);
  }
  return undefined;
}

/**
 * 여는 인용부호 위치에서 시작해 닫는 위치 다음 인덱스를 반환한다.
 * 인용부호 두 번 반복('')은 이스케이프로 간주한다.
 */
function scanQuoted(text: string, at: number, quote: string, backslashEscapes: boolean): number {
  const len = text.length;
  let i = at + 1;
  while (i < len) {
    const c = text[i]!;
    if (backslashEscapes && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return len; // 미종료 문자열 — 문서 끝까지
}

/** 주석과 공백을 제외한 의미 있는 토큰만 남긴다. */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter(
    (t) => t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment',
  );
}

/** 인용부호를 벗겨 실제 식별자 이름을 얻는다. */
export function unquoteIdentifier(text: string): string {
  if (text.length >= 2) {
    const first = text[0]!;
    const last = text[text.length - 1]!;
    if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
      return text.slice(1, -1).replace(new RegExp(first + first, 'g'), first);
    }
    if (first === '[' && last === ']') {
      return text.slice(1, -1);
    }
  }
  return text;
}
