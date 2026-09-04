import type { DialectId } from '../types';
import { tokenize, type Token } from './tokenizer';

export interface SqlStatement {
  /** 앞뒤 공백/주석을 제거한 실행 가능한 텍스트. */
  text: string;
  /** 문서 내 절대 오프셋. text 가 아니라 원문 범위 기준. */
  start: number;
  end: number;
  /** 이 문장이 실제 SQL 없이 주석/공백만인지. */
  empty: boolean;
}

/**
 * PL/SQL 블록의 시작을 알리는 키워드.
 * 이 문장은 내부 `;` 로 끝나지 않고 단독 `/` 줄로 끝난다.
 */
const PLSQL_BLOCK_STARTERS = new Set(['DECLARE', 'BEGIN']);
const PLSQL_CREATE_OBJECTS = new Set([
  'PROCEDURE',
  'FUNCTION',
  'PACKAGE',
  'TRIGGER',
  'TYPE',
  'LIBRARY',
]);

/**
 * 문서를 실행 단위 문장들로 나눈다.
 *
 * 세미콜론만 보고 자르면 문자열/주석/`$$`/PL-SQL 블록 안의 세미콜론에서
 * 잘못 끊긴다. 그래서 렉서를 통과한 토큰 위에서 경계를 찾는다.
 */
export function splitStatements(text: string, dialect: DialectId): SqlStatement[] {
  const tokens = tokenize(text, dialect);
  const statements: SqlStatement[] = [];

  let cursor = 0; // 현재 문장의 시작 오프셋
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;

    // MySQL 클라이언트의 DELIMITER 명령은 서버로 보낼 수 없다.
    // 지원하는 대신, 커스텀 구분자 구간을 하나의 문장으로 묶어 넘긴다.
    if (isMySqlDelimiterCommand(tokens, i, dialect)) {
      const consumed = consumeDelimiterSection(text, tokens, i, statements, cursor);
      i = consumed.nextIndex;
      cursor = consumed.nextCursor;
      continue;
    }

    // Oracle PL/SQL 블록: 단독 `/` 줄까지가 한 문장.
    if (dialect === 'oracle' && startsPlSqlBlock(tokens, i)) {
      const end = findPlSqlBlockEnd(text, tokens, i);
      pushStatement(statements, text, cursor, end.statementEnd);
      i = end.nextIndex;
      cursor = end.nextCursor;
      continue;
    }

    if (token.kind === 'semicolon') {
      pushStatement(statements, text, cursor, token.start);
      cursor = token.end;
      i++;
      continue;
    }

    i++;
  }

  // 세미콜론 없이 끝난 마지막 문장.
  if (cursor < text.length) {
    pushStatement(statements, text, cursor, text.length);
  }

  return statements.filter((s) => !s.empty);
}

/**
 * 커서 오프셋이 속한 문장을 찾는다.
 *
 * 커서가 문장과 문장 사이(공백/주석)에 있으면, 편집 중일 가능성이 높은
 * "바로 앞 문장"을 우선 고른다. 앞에 문장이 없으면 뒤 문장을 고른다.
 * DBeaver / DataGrip 의 Ctrl+Enter 와 같은 동작.
 */
export function statementAt(
  text: string,
  offset: number,
  dialect: DialectId,
): SqlStatement | undefined {
  const statements = splitStatements(text, dialect);
  if (statements.length === 0) {
    return undefined;
  }

  for (const stmt of statements) {
    if (offset >= stmt.start && offset <= stmt.end) {
      return stmt;
    }
  }

  // 사이에 낀 경우: 커서 앞쪽에서 가장 가까운 문장.
  let previous: SqlStatement | undefined;
  for (const stmt of statements) {
    if (stmt.end <= offset) {
      previous = stmt;
    } else {
      break;
    }
  }
  if (previous) {
    return previous;
  }
  return statements[0];
}

// ─── 내부 구현 ──────────────────────────────────────────────────────────────

function pushStatement(
  out: SqlStatement[],
  text: string,
  rawStart: number,
  rawEnd: number,
): void {
  const slice = text.slice(rawStart, rawEnd);
  const leading = slice.length - slice.trimStart().length;
  const trailing = slice.length - slice.trimEnd().length;
  const start = rawStart + leading;
  const end = rawEnd - trailing;
  const trimmed = slice.trim();

  out.push({
    text: trimmed,
    start,
    end,
    empty: trimmed.length === 0 || isOnlyComments(trimmed),
  });
}

function isOnlyComments(text: string): boolean {
  // 방언 무관하게 주석만 남았는지 판단하면 되므로 postgres 규칙으로 충분하다.
  return tokenize(text, 'postgres').every(
    (t) => t.kind === 'whitespace' || t.kind === 'line-comment' || t.kind === 'block-comment',
  );
}

function nextSignificantIndex(tokens: Token[], from: number): number {
  for (let i = from; i < tokens.length; i++) {
    const kind = tokens[i]!.kind;
    if (kind !== 'whitespace' && kind !== 'line-comment' && kind !== 'block-comment') {
      return i;
    }
  }
  return -1;
}

function startsPlSqlBlock(tokens: Token[], index: number): boolean {
  const token = tokens[index]!;
  if (token.kind !== 'word') {
    return false;
  }
  const upper = token.text.toUpperCase();

  if (PLSQL_BLOCK_STARTERS.has(upper)) {
    return true;
  }

  // CREATE [OR REPLACE] {PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE} ...
  if (upper !== 'CREATE') {
    return false;
  }
  let i = nextSignificantIndex(tokens, index + 1);
  if (i === -1) {
    return false;
  }
  if (tokens[i]!.text.toUpperCase() === 'OR') {
    i = nextSignificantIndex(tokens, i + 1);
    if (i === -1 || tokens[i]!.text.toUpperCase() !== 'REPLACE') {
      return false;
    }
    i = nextSignificantIndex(tokens, i + 1);
    if (i === -1) {
      return false;
    }
  }
  // EDITIONABLE / NONEDITIONABLE 수식어를 건너뛴다.
  while (i !== -1 && /^(NON)?EDITIONABLE$/.test(tokens[i]!.text.toUpperCase())) {
    i = nextSignificantIndex(tokens, i + 1);
  }
  if (i === -1) {
    return false;
  }
  return PLSQL_CREATE_OBJECTS.has(tokens[i]!.text.toUpperCase());
}

/**
 * PL/SQL 블록의 끝을 찾는다. SQL*Plus 관례대로 자기 줄에 단독으로 있는 `/`.
 * 그런 줄이 없으면 문서 끝까지를 블록으로 본다.
 */
function findPlSqlBlockEnd(
  text: string,
  tokens: Token[],
  from: number,
): { statementEnd: number; nextIndex: number; nextCursor: number } {
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punct' || token.text !== '/') {
      continue;
    }
    if (!isAloneOnLine(text, token.start, token.end)) {
      continue;
    }
    return { statementEnd: token.start, nextIndex: i + 1, nextCursor: token.end };
  }
  return { statementEnd: text.length, nextIndex: tokens.length, nextCursor: text.length };
}

/** 해당 범위가 줄에서 유일한 내용인지(앞뒤가 공백뿐인지). */
function isAloneOnLine(text: string, start: number, end: number): boolean {
  let i = start - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) {
    i--;
  }
  if (i >= 0 && text[i] !== '\n' && text[i] !== '\r') {
    return false;
  }
  let j = end;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) {
    j++;
  }
  return j >= text.length || text[j] === '\n';
}

function isMySqlDelimiterCommand(tokens: Token[], index: number, dialect: DialectId): boolean {
  if (dialect !== 'mysql' && dialect !== 'mariadb') {
    return false;
  }
  const token = tokens[index]!;
  return (
    token.kind === 'word' &&
    token.text.toUpperCase() === 'DELIMITER' &&
    isAtLineStart(tokens, index)
  );
}

function isAtLineStart(tokens: Token[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.kind === 'whitespace') {
      if (t.text.includes('\n')) {
        return true;
      }
      continue;
    }
    if (t.kind === 'line-comment' || t.kind === 'block-comment') {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * `DELIMITER $$ ... $$ DELIMITER ;` 구간을 처리한다.
 * DELIMITER 자체는 서버 명령이 아니므로 제거하고, 그 사이 본문을
 * 하나의 문장으로 만들어 넘긴다(라우틴 정의는 통째로 보내야 한다).
 */
function consumeDelimiterSection(
  text: string,
  tokens: Token[],
  index: number,
  out: SqlStatement[],
  cursor: number,
): { nextIndex: number; nextCursor: number } {
  // DELIMITER 앞에 남아 있던 내용을 먼저 확정한다.
  if (cursor < tokens[index]!.start) {
    pushStatement(out, text, cursor, tokens[index]!.start);
  }

  // 구분자 문자열 읽기 — 줄 끝까지의 공백 아닌 텍스트.
  const lineEnd = indexOfLineEnd(text, tokens[index]!.end);
  const delimiter = text.slice(tokens[index]!.end, lineEnd).trim();
  if (!delimiter) {
    return { nextIndex: skipPastOffset(tokens, lineEnd), nextCursor: lineEnd };
  }

  // 세미콜론으로 되돌리는 명령이면 본문 없이 종료.
  const bodyStart = lineEnd;
  const bodyEnd = text.indexOf(delimiter, bodyStart);
  if (delimiter === ';' || bodyEnd === -1) {
    const end = bodyEnd === -1 ? text.length : bodyEnd;
    if (delimiter !== ';') {
      pushStatement(out, text, bodyStart, end);
    }
    return { nextIndex: skipPastOffset(tokens, end), nextCursor: end };
  }

  pushStatement(out, text, bodyStart, bodyEnd);
  const after = bodyEnd + delimiter.length;
  return { nextIndex: skipPastOffset(tokens, after), nextCursor: after };
}

function indexOfLineEnd(text: string, from: number): number {
  const at = text.indexOf('\n', from);
  return at === -1 ? text.length : at;
}

function skipPastOffset(tokens: Token[], offset: number): number {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.start >= offset) {
      return i;
    }
  }
  return tokens.length;
}
