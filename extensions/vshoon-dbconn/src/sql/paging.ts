import type { DialectId } from '../types';
import { analyzeStatement } from './guard';
import { significant, tokenize } from './tokenizer';

/**
 * 결과 페이징과 서버 측 정렬.
 *
 * 원본 SQL 을 파생 테이블로 감싸고 바깥에서 ORDER BY / LIMIT / OFFSET 을 건다.
 * 원본 문장을 파싱해 절을 끼워 넣는 방식보다 안전하다 — 사용자가 쓴 SQL 의
 * 구조를 건드리지 않고, 세 방언에서 같은 형태로 동작한다.
 *
 * 정렬은 **컬럼 위치**(ORDER BY 3)로 건다. 이름으로 걸면 함수 결과처럼
 * 이름이 이상한 컬럼에서 인용이 어긋나는데, 위치는 세 방언 모두 지원한다.
 *
 * 값은 전부 정수로 검증해 문자열로 조립한다. 사용자 입력이 이 경로로
 * 들어오는 지점은 없다 (컬럼 위치는 결과 컬럼 개수로 한계가 정해진다).
 */

export interface PageOrder {
  /** 0-based 결과 컬럼 인덱스. */
  index: number;
  dir: 'asc' | 'desc';
}

export interface PageRequest {
  limit: number;
  offset: number;
  orderBy?: PageOrder;
}

/** 파생 테이블 별칭. MySQL 은 별칭이 없으면 파생 테이블을 거부한다. */
const PAGE_ALIAS = 'dbconn_page';

/**
 * 감싸도 의미가 변하지 않는 구문인지.
 *
 * 보수적으로 본다. SELECT 가 아니거나, 결과를 변수/테이블로 흘리는 절이 있으면
 * 페이징을 걸지 않는다 — 애매하면 원본을 그대로 두는 편이 낫다.
 */
export function isPageable(sql: string, dialect: DialectId): boolean {
  if (analyzeStatement(sql, dialect).category !== 'select') {
    return false;
  }

  const tokens = significant(tokenize(sql, dialect));
  if (tokens.length === 0) {
    return false;
  }

  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (depth !== 0 || token.kind !== 'word') {
      continue;
    }
    const upper = token.text.toUpperCase();
    // SELECT ... INTO 는 결과 집합을 만들지 않는다.
    if (upper === 'INTO') {
      return false;
    }
    // FOR UPDATE / LOCK IN SHARE MODE 는 파생 테이블 안에 들어갈 수 없다.
    if (upper === 'FOR' && tokens[i + 1]?.text.toUpperCase() === 'UPDATE') {
      return false;
    }
    if (upper === 'LOCK' && tokens[i + 1]?.text.toUpperCase() === 'IN') {
      return false;
    }
  }
  return true;
}

/** 결과 컬럼 이름이 겹치면 `SELECT *` 로 감쌀 수 없다 (MySQL·Oracle 이 거부). */
export function hasDuplicateColumnNames(names: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

export function buildPagedQuery(sql: string, dialect: DialectId, request: PageRequest): string {
  const limit = toPositiveInt(request.limit, '한 번에 가져올 행 수');
  const offset = toNonNegativeInt(request.offset, '건너뛸 행 수');

  const inner = sql.replace(/[\s;]+$/, '');
  const order = request.orderBy ? buildOrderBy(request.orderBy) : '';
  const tail =
    dialect === 'oracle'
      ? `\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
      : `\nLIMIT ${limit} OFFSET ${offset}`;

  return `SELECT * FROM (\n${inner}\n) ${PAGE_ALIAS}${order}${tail}`;
}

function buildOrderBy(order: PageOrder): string {
  const position = toNonNegativeInt(order.index, '정렬 컬럼 위치') + 1;
  return `\nORDER BY ${position} ${order.dir === 'desc' ? 'DESC' : 'ASC'}`;
}

function toPositiveInt(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label} 가 올바르지 않습니다.`);
  }
  return Math.floor(value);
}

function toNonNegativeInt(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} 가 올바르지 않습니다.`);
  }
  return Math.floor(value);
}
