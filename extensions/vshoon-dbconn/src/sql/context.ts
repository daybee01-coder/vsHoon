import type { DialectId } from '../types';
import { significant, tokenize, unquoteIdentifier, type Token } from './tokenizer';

/**
 * 커서 위치의 SQL 문맥 분석.
 *
 * 자동 완성이 "무엇을 제안할지" 정하려면 세 가지를 알아야 한다:
 *  1) 지금 입력 중인 단어와, 그 앞에 점(.)으로 붙은 한정자가 있는지
 *  2) 어느 절(SELECT/FROM/WHERE/…) 안에 있는지
 *  3) 이 문장이 어떤 테이블들을 참조하고 있고 별칭이 무엇인지
 *
 * 3번이 핵심이다. `SELECT u.| FROM users u` 에서 `u` 가 users 라는 걸
 * 알아야 컬럼을 제안할 수 있고, 이게 없으면 자동 완성이 무용지물이다.
 */

export type ClauseKind =
  | 'select'
  | 'from'
  | 'join'
  | 'on'
  | 'where'
  | 'group-by'
  | 'order-by'
  | 'having'
  | 'set'
  | 'insert-into'
  | 'values'
  | 'unknown';

export interface TableRef {
  schema: string | undefined;
  name: string;
  alias: string | undefined;
}

export interface CompletionContext {
  /** 지금 입력 중인 부분 단어 (없으면 빈 문자열). */
  prefix: string;
  /** `a.b.|` 형태에서 점 앞의 조각들. 없으면 빈 배열. */
  qualifiers: string[];
  clause: ClauseKind;
  /** 문장이 참조하는 테이블들. */
  tables: TableRef[];
  /** 문장의 선행 키워드 (SELECT/INSERT/…). */
  leadingKeyword: string;
  /** prefix 가 시작되는 문서 오프셋 — 치환 범위 계산에 쓴다. */
  replaceStart: number;
  /** 문자열 리터럴이나 주석 안이라 제안을 내면 안 되는 위치인지. */
  suppressed: boolean;
}

/** 별칭으로 쓸 수 없는(= 절을 여는) 키워드. */
const CLAUSE_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'FETCH', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
  'NATURAL', 'ON', 'USING', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS',
  'SET', 'VALUES', 'INTO', 'AS', 'AND', 'OR', 'NOT', 'WINDOW', 'FOR',
  'UPDATE', 'INSERT', 'DELETE', 'WITH', 'RETURNING', 'PARTITION', 'LATERAL',
  'STRAIGHT_JOIN', 'WHEN', 'THEN', 'ELSE', 'END', 'CASE', 'DISTINCT',
]);

/** 테이블 참조가 뒤따르는 키워드. */
const TABLE_INTRODUCERS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'STRAIGHT_JOIN']);

export function analyzeContext(
  statementText: string,
  /** 문장 텍스트 기준 커서 오프셋. */
  cursorOffset: number,
  dialect: DialectId,
  /** statementText 가 문서에서 시작하는 절대 오프셋. */
  statementStart = 0,
): CompletionContext {
  const allTokens = tokenize(statementText, dialect);
  const tokens = significant(allTokens);

  const { prefix, qualifiers, replaceStart, suppressed } = readPrefixAndQualifiers(
    allTokens,
    statementText,
    cursorOffset,
  );

  return {
    prefix,
    qualifiers,
    clause: detectClause(tokens, cursorOffset),
    tables: extractTableRefs(tokens),
    leadingKeyword: tokens[0]?.text.toUpperCase() ?? '',
    replaceStart: statementStart + replaceStart,
    suppressed,
  };
}

/**
 * 커서 바로 앞의 입력 중인 단어와 점 한정자를 읽는다.
 *
 * `SELECT sch.tbl.co|` → prefix="co", qualifiers=["sch","tbl"]
 * `SELECT u.|`         → prefix="",   qualifiers=["u"]
 * `SELECT |`           → prefix="",   qualifiers=[]
 */
function readPrefixAndQualifiers(
  tokens: Token[],
  text: string,
  cursor: number,
): { prefix: string; qualifiers: string[]; replaceStart: number; suppressed: boolean } {
  // 커서를 포함하거나 커서 바로 앞에서 끝나는 토큰을 찾는다.
  let index = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.start < cursor && cursor <= token.end) {
      index = i;
      break;
    }
  }

  let prefix = '';
  let replaceStart = cursor;
  let cursorIndex = index;

  if (index !== -1) {
    const token = tokens[index]!;
    if (token.kind === 'word' || token.kind === 'quoted-identifier') {
      prefix = text.slice(token.start, cursor);
      replaceStart = token.start;
      cursorIndex = index - 1;
    } else if (token.kind === 'punct' && token.text === '.') {
      cursorIndex = index;
    } else if (token.kind === 'string' || token.kind === 'line-comment' || token.kind === 'block-comment') {
      // 문자열/주석 안에서는 제안하지 않는다.
      return { prefix: '', qualifiers: [], replaceStart: cursor, suppressed: true };
    } else {
      cursorIndex = index;
    }
  } else {
    // 커서가 토큰 사이(공백)에 있다 — 바로 앞 토큰을 찾는다.
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i]!.end <= cursor) {
        cursorIndex = i;
        break;
      }
    }
  }

  // 점으로 이어진 한정자들을 뒤로 훑는다.
  const qualifiers: string[] = [];
  let i = cursorIndex;
  // 공백 토큰은 건너뛴다.
  const skipSpace = (from: number): number => {
    let j = from;
    while (j >= 0 && tokens[j]!.kind === 'whitespace') {
      j--;
    }
    return j;
  };

  i = skipSpace(i);
  while (i >= 0 && tokens[i]!.kind === 'punct' && tokens[i]!.text === '.') {
    // 점 앞에 공백이 있으면 한정자가 아니다 (`a . b` 는 드물지만 허용).
    i = skipSpace(i - 1);
    const token = tokens[i];
    if (!token || (token.kind !== 'word' && token.kind !== 'quoted-identifier')) {
      break;
    }
    qualifiers.unshift(unquoteIdentifier(token.text));
    i = skipSpace(i - 1);
  }

  return { prefix, qualifiers, replaceStart, suppressed: false };
}

/** 커서 앞쪽에서 가장 가까운 절 키워드를 찾는다. */
function detectClause(tokens: Token[], cursor: number): ClauseKind {
  let clause: ClauseKind = 'unknown';
  let depth = 0;

  for (const token of tokens) {
    if (token.start >= cursor) {
      break;
    }
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (token.kind !== 'word') {
      continue;
    }
    const upper = token.text.toUpperCase();
    const mapped = clauseFor(upper);
    if (mapped) {
      clause = mapped;
    }
  }
  return clause;
}

function clauseFor(keyword: string): ClauseKind | undefined {
  switch (keyword) {
    case 'SELECT':
      return 'select';
    case 'FROM':
      return 'from';
    case 'JOIN':
    case 'STRAIGHT_JOIN':
      return 'join';
    case 'ON':
    case 'USING':
      return 'on';
    case 'WHERE':
      return 'where';
    case 'GROUP':
      return 'group-by';
    case 'ORDER':
      return 'order-by';
    case 'HAVING':
      return 'having';
    case 'SET':
      return 'set';
    case 'INTO':
      return 'insert-into';
    case 'VALUES':
      return 'values';
    default:
      return undefined;
  }
}

/**
 * FROM / JOIN / UPDATE / INTO 뒤의 테이블 참조와 별칭을 수집한다.
 *
 * 서브쿼리(`FROM (SELECT …) x`)는 내부를 파고들지 않고 건너뛴다 —
 * 별칭만 알면 되는데 그 컬럼은 메타데이터로 알 수 없기 때문이다.
 */
export function extractTableRefs(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'word' || !TABLE_INTRODUCERS.has(token.text.toUpperCase())) {
      continue;
    }
    // `DELETE FROM t`, `INSERT INTO t`, `UPDATE t`, `... JOIN t`
    let j = i + 1;

    // 쉼표로 이어지는 다중 테이블을 모두 읽는다.
    for (;;) {
      const parsed = parseTableRef(tokens, j);
      if (!parsed) {
        break;
      }
      refs.push(parsed.ref);
      j = parsed.next;

      if (tokens[j]?.kind === 'punct' && tokens[j]!.text === ',') {
        j++;
        continue;
      }
      break;
    }
    i = j - 1;
  }

  return dedupe(refs);
}

interface ParsedRef {
  ref: TableRef;
  next: number;
}

function parseTableRef(tokens: Token[], start: number): ParsedRef | undefined {
  let i = start;
  const first = tokens[i];
  if (!first) {
    return undefined;
  }

  // 서브쿼리 / 함수 호출 — 괄호를 통째로 건너뛰고 별칭만 취한다.
  if (first.kind === 'punct' && first.text === '(') {
    i = skipParens(tokens, i);
    const alias = readAlias(tokens, i);
    return {
      ref: { schema: undefined, name: '', alias: alias.name },
      next: alias.next,
    };
  }

  if (first.kind !== 'word' && first.kind !== 'quoted-identifier') {
    return undefined;
  }
  if (first.kind === 'word' && CLAUSE_KEYWORDS.has(first.text.toUpperCase())) {
    return undefined;
  }

  const parts: string[] = [unquoteIdentifier(first.text)];
  i++;

  // schema.table (또는 db.schema.table — 마지막 둘만 쓴다)
  while (
    tokens[i]?.kind === 'punct' &&
    tokens[i]!.text === '.' &&
    (tokens[i + 1]?.kind === 'word' || tokens[i + 1]?.kind === 'quoted-identifier')
  ) {
    parts.push(unquoteIdentifier(tokens[i + 1]!.text));
    i += 2;
  }

  const alias = readAlias(tokens, i);
  const name = parts[parts.length - 1]!;
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;

  return {
    ref: { schema, name, alias: alias.name },
    next: alias.next,
  };
}

function readAlias(tokens: Token[], start: number): { name: string | undefined; next: number } {
  let i = start;
  const token = tokens[i];
  if (!token) {
    return { name: undefined, next: i };
  }

  if (token.kind === 'word' && token.text.toUpperCase() === 'AS') {
    i++;
    const aliasToken = tokens[i];
    if (aliasToken && (aliasToken.kind === 'word' || aliasToken.kind === 'quoted-identifier')) {
      return { name: unquoteIdentifier(aliasToken.text), next: i + 1 };
    }
    return { name: undefined, next: i };
  }

  if (token.kind === 'quoted-identifier') {
    return { name: unquoteIdentifier(token.text), next: i + 1 };
  }

  if (token.kind === 'word' && !CLAUSE_KEYWORDS.has(token.text.toUpperCase())) {
    return { name: token.text, next: i + 1 };
  }

  return { name: undefined, next: i };
}

function skipParens(tokens: Token[], start: number): number {
  let depth = 0;
  let i = start;
  for (; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'punct') {
      continue;
    }
    if (token.text === '(') {
      depth++;
    } else if (token.text === ')') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return i;
}

function dedupe(refs: TableRef[]): TableRef[] {
  const seen = new Set<string>();
  const out: TableRef[] = [];
  for (const ref of refs) {
    const key = `${ref.schema ?? ''}|${ref.name}|${ref.alias ?? ''}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(ref);
  }
  return out;
}
