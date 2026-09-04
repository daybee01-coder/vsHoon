import type { DialectId } from '../types';
import { significant, tokenize, unquoteIdentifier, type Token } from './tokenizer';

/**
 * 구문 분류 및 위험도 판정.
 *
 * 목적이 둘이다.
 *  1) 읽기 전용 연결에서 쓰기 구문을 클라이언트 단에서 미리 차단한다.
 *     (서버 측 읽기 전용 세션이 1차 방어선이고, 이건 즉각적인 피드백용 2차선)
 *  2) WHERE 없는 DELETE 처럼 되돌리기 어려운 구문에 확인 절차를 붙인다.
 */

export type StatementCategory =
  | 'select' // 결과 집합을 돌려주는 읽기 구문
  | 'dml' // INSERT / UPDATE / DELETE / MERGE
  | 'ddl' // CREATE / ALTER / DROP / TRUNCATE
  | 'dcl' // GRANT / REVOKE
  | 'tcl' // COMMIT / ROLLBACK / SAVEPOINT / BEGIN
  | 'utility' // EXPLAIN / SHOW / USE / SET / CALL ...
  | 'unknown';

export type RiskLevel = 'none' | 'elevated' | 'high';

export interface StatementAnalysis {
  category: StatementCategory;
  /** 결과 그리드를 띄워야 하는 구문인지. */
  producesRows: boolean;
  /** 데이터/스키마를 변경하는 구문인지. */
  mutates: boolean;
  risk: RiskLevel;
  /** 사용자에게 보여줄 위험 사유. */
  reasons: string[];
  /** 선행 키워드 (표시용). */
  leadingKeyword: string;
}

const SELECT_STARTERS = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES']);
const DML_STARTERS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT']);
const DDL_STARTERS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'COMMENT',
  'VACUUM',
  'ANALYZE',
  'REINDEX',
  'CLUSTER',
]);
const DCL_STARTERS = new Set(['GRANT', 'REVOKE']);
const TCL_STARTERS = new Set(['COMMIT', 'ROLLBACK', 'SAVEPOINT', 'BEGIN', 'START', 'END', 'RELEASE']);
const UTILITY_STARTERS = new Set([
  'EXPLAIN',
  'DESCRIBE',
  'DESC',
  'SHOW',
  'USE',
  'SET',
  'CALL',
  'EXEC',
  'EXECUTE',
  'PRAGMA',
  'LOCK',
  'UNLOCK',
  'DECLARE',
  'DO',
  'PREPARE',
  'DEALLOCATE',
  'LISTEN',
  'NOTIFY',
  'COPY',
  'FLUSH',
  'RESET',
  'CHECKPOINT',
  'DISCARD',
  'REFRESH',
]);

/** 되돌릴 수 없거나 광범위한 영향을 주는 구문. */
const HIGH_RISK_DDL = new Set(['DROP', 'TRUNCATE']);

export function analyzeStatement(sql: string, dialect: DialectId): StatementAnalysis {
  const tokens = significant(tokenize(sql, dialect));
  const first = tokens[0];

  if (!first) {
    return {
      category: 'unknown',
      producesRows: false,
      mutates: false,
      risk: 'none',
      reasons: [],
      leadingKeyword: '',
    };
  }

  const head = first.text.toUpperCase();
  const category = categorize(head, tokens, dialect);
  const reasons: string[] = [];
  let risk: RiskLevel = 'none';

  if (category === 'ddl') {
    const objectWord = tokens[1]?.text.toUpperCase() ?? '';
    if (HIGH_RISK_DDL.has(head)) {
      risk = 'high';
      reasons.push(`${head} ${objectWord} 는 되돌릴 수 없습니다.`);
    } else if (head === 'ALTER') {
      risk = 'elevated';
      reasons.push('스키마를 변경합니다.');
    }
  }

  if (category === 'dml') {
    if ((head === 'UPDATE' || head === 'DELETE') && !hasWhereClause(tokens)) {
      risk = 'high';
      reasons.push(`WHERE 절이 없는 ${head} 는 테이블 전체 행에 적용됩니다.`);
    } else if (head === 'UPDATE' || head === 'DELETE') {
      risk = 'elevated';
    }
  }

  if (category === 'dcl') {
    risk = 'elevated';
    reasons.push('권한을 변경합니다.');
  }

  return {
    category,
    producesRows: producesRows(category, head, tokens, dialect),
    mutates: category === 'dml' || category === 'ddl' || category === 'dcl',
    risk,
    reasons,
    leadingKeyword: head,
  };
}

function categorize(head: string, tokens: Token[], dialect: DialectId): StatementCategory {
  if (SELECT_STARTERS.has(head)) {
    // WITH ... INSERT/UPDATE/DELETE (PostgreSQL 데이터 변경 CTE) 는 쓰기 구문이다.
    if (head === 'WITH' && dialect === 'postgres' && containsDataModifyingCte(tokens)) {
      return 'dml';
    }
    return 'select';
  }
  if (DML_STARTERS.has(head)) {
    return 'dml';
  }
  if (DDL_STARTERS.has(head)) {
    return 'ddl';
  }
  if (DCL_STARTERS.has(head)) {
    return 'dcl';
  }
  if (TCL_STARTERS.has(head)) {
    // Oracle/PLpgSQL 의 익명 블록 시작 BEGIN 은 트랜잭션 제어가 아니다.
    if (head === 'BEGIN' && looksLikeAnonymousBlock(tokens)) {
      return 'utility';
    }
    return 'tcl';
  }
  if (UTILITY_STARTERS.has(head)) {
    return 'utility';
  }
  return 'unknown';
}

/** 익명 PL/SQL 블록의 BEGIN 인지 (뒤에 문장이 이어지는지)로 구분. */
function looksLikeAnonymousBlock(tokens: Token[]): boolean {
  const next = tokens[1]?.text.toUpperCase();
  if (!next) {
    return false;
  }
  // BEGIN; / BEGIN TRANSACTION / BEGIN WORK / BEGIN ISOLATION ... 는 트랜잭션 제어.
  return !['TRANSACTION', 'WORK', 'ISOLATION', 'READ', 'DEFERRABLE', 'NOT'].includes(next);
}

function containsDataModifyingCte(tokens: Token[]): boolean {
  for (const token of tokens) {
    const upper = token.text.toUpperCase();
    if (upper === 'INSERT' || upper === 'UPDATE' || upper === 'DELETE' || upper === 'MERGE') {
      return true;
    }
  }
  return false;
}

function producesRows(
  category: StatementCategory,
  head: string,
  tokens: Token[],
  dialect: DialectId,
): boolean {
  if (category === 'select') {
    return true;
  }
  if (category === 'utility') {
    return ['EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'CALL', 'EXEC', 'EXECUTE'].includes(head);
  }
  // PostgreSQL / Oracle 의 RETURNING 절은 결과 집합을 만든다.
  if (category === 'dml' && (dialect === 'postgres' || dialect === 'oracle')) {
    return tokens.some((t) => t.text.toUpperCase() === 'RETURNING');
  }
  return false;
}

/** 최상위 레벨(괄호 밖)에 WHERE 가 있는지. 서브쿼리의 WHERE 는 세지 않는다. */
function hasWhereClause(tokens: Token[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (depth === 0 && token.kind === 'word' && token.text.toUpperCase() === 'WHERE') {
      return true;
    }
  }
  return false;
}

/**
 * 구문이 겨냥하는 객체 이름.
 *
 * 확인 대화상자에서 "무엇을 바꾸는지"를 사용자가 직접 입력하게 만들 때 쓴다.
 * 연결 이름을 입력하게 하는 것보다 대상 이름을 입력하게 하는 편이 안전하다 —
 * 손이 기억한 대로 누르는 것을 막는 것이 목적이기 때문이다.
 *
 * 한정 이름(`public.users`)은 마지막 조각만 돌려준다. 사용자가 실제로
 * 타이핑할 이름이 그쪽이다.
 */
export function targetObjectName(sql: string, dialect: DialectId): string | undefined {
  const tokens = significant(tokenize(sql, dialect));
  const head = tokens[0]?.text.toUpperCase();
  if (!head) {
    return undefined;
  }

  switch (head) {
    case 'UPDATE':
      return readName(tokens, 1);
    case 'DELETE':
      return afterKeyword(tokens, 'FROM');
    case 'INSERT':
    case 'REPLACE':
    case 'MERGE':
      return afterKeyword(tokens, 'INTO');
    case 'TRUNCATE':
    case 'DROP':
    case 'ALTER':
    case 'CREATE':
      return readName(tokens, skipObjectKeywords(tokens, 1));
    default:
      return undefined;
  }
}

/** TABLE / VIEW / IF EXISTS / OR REPLACE 같은 수식어를 건너뛴다. */
const OBJECT_KEYWORDS = new Set([
  'TABLE',
  'VIEW',
  'MATERIALIZED',
  'INDEX',
  'SEQUENCE',
  'SCHEMA',
  'DATABASE',
  'FUNCTION',
  'PROCEDURE',
  'PACKAGE',
  'TRIGGER',
  'TYPE',
  'SYNONYM',
  'IF',
  'EXISTS',
  'NOT',
  'OR',
  'REPLACE',
  'UNIQUE',
  'TEMPORARY',
  'TEMP',
  'GLOBAL',
  'LOCAL',
  'ONLY',
  'CONCURRENTLY',
]);

function skipObjectKeywords(tokens: Token[], from: number): number {
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || token.kind !== 'word' || !OBJECT_KEYWORDS.has(token.text.toUpperCase())) {
      break;
    }
    index++;
  }
  return index;
}

function afterKeyword(tokens: Token[], keyword: string): string | undefined {
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i]!.kind === 'word' && tokens[i]!.text.toUpperCase() === keyword) {
      return readName(tokens, skipObjectKeywords(tokens, i + 1));
    }
  }
  return undefined;
}

/** `schema.table` 형태를 따라가 마지막 조각을 돌려준다. */
function readName(tokens: Token[], from: number): string | undefined {
  const first = tokens[from];
  if (!first || (first.kind !== 'word' && first.kind !== 'quoted-identifier')) {
    return undefined;
  }
  let last = first;
  let index = from + 1;
  while (tokens[index]?.text === '.') {
    const next = tokens[index + 1];
    if (!next || (next.kind !== 'word' && next.kind !== 'quoted-identifier')) {
      break;
    }
    last = next;
    index += 2;
  }
  const name = unquoteIdentifier(last.text);
  return name.length > 0 ? name : undefined;
}

export class ReadOnlyViolationError extends Error {
  constructor(public readonly analysis: StatementAnalysis) {
    super(
      `읽기 전용 연결입니다. ${analysis.leadingKeyword} 구문은 실행할 수 없습니다. ` +
        '연결 설정에서 읽기 전용을 해제하세요.',
    );
    this.name = 'ReadOnlyViolationError';
  }
}

/** 읽기 전용 연결에서 허용되는 구문인지 확인하고, 아니면 예외를 던진다. */
export function assertAllowedInReadOnly(analysis: StatementAnalysis): void {
  if (analysis.mutates) {
    throw new ReadOnlyViolationError(analysis);
  }
}
