import type { DialectId } from '../types';

/**
 * 식별자 인용.
 *
 * 메타데이터에서 읽어온 테이블/컬럼 이름은 "신뢰된 출처"처럼 보이지만,
 * 이름 자체에 인용부호나 세미콜론이 들어간 객체를 만들 수 있으므로
 * SQL 을 문자열로 조립하는 모든 지점에서 반드시 이 함수를 거쳐야 한다.
 *
 * 값(리터럴)은 절대 여기로 오면 안 된다 — 값은 바인드 파라미터를 쓴다.
 */

/** 식별자 안에 들어갈 수 없는 문자 — NUL 과 제어 문자. */
// eslint-disable-next-line no-control-regex -- 제어 문자를 걸러내는 것이 목적이다
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export class UnsafeIdentifierError extends Error {
  constructor(name: string) {
    super(`식별자에 허용되지 않는 문자가 있습니다: ${JSON.stringify(name)}`);
    this.name = 'UnsafeIdentifierError';
  }
}

/**
 * 식별자를 방언에 맞게 인용한다.
 * 인용부호는 배가(doubling)해서 이스케이프하므로, 이름이 무엇이든
 * 문자열 리터럴 경계를 탈출할 수 없다.
 */
export function quoteIdentifier(name: string, dialect: DialectId): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UnsafeIdentifierError(String(name));
  }
  if (CONTROL_CHARS.test(name)) {
    throw new UnsafeIdentifierError(name);
  }
  if (dialect === 'mysql' || dialect === 'mariadb') {
    // MySQL 백틱 식별자 안에서는 백틱만 배가하면 된다.
    // (백틱 식별자에는 U+0000 을 제외한 모든 문자가 올 수 있다)
    return '`' + name.replace(/`/g, '``') + '`';
  }
  // PostgreSQL / Oracle: 표준 큰따옴표 인용.
  return '"' + name.replace(/"/g, '""') + '"';
}

/** `schema.table` 형태로 인용해 조립한다. schema 가 없으면 테이블만. */
export function quoteQualified(
  schema: string | undefined,
  name: string,
  dialect: DialectId,
): string {
  const quotedName = quoteIdentifier(name, dialect);
  if (!schema) {
    return quotedName;
  }
  return `${quoteIdentifier(schema, dialect)}.${quotedName}`;
}

/**
 * 인용 없이 그대로 써도 되는 단순 식별자인지.
 * 자동 완성이 불필요한 따옴표를 넣지 않도록 판단하는 데 쓴다.
 */
export function needsQuoting(name: string, dialect: DialectId): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    return true;
  }
  if (RESERVED_WORDS.has(name.toUpperCase())) {
    return true;
  }
  // Oracle 은 인용하지 않은 식별자를 대문자로 정규화한다.
  // 따라서 소문자가 섞인 이름은 인용해야 원래 이름을 가리킨다.
  if (dialect === 'oracle') {
    return name !== name.toUpperCase();
  }
  // PostgreSQL 은 소문자로 정규화한다.
  if (dialect === 'postgres') {
    return name !== name.toLowerCase();
  }
  return false;
}

/** 자동 완성 삽입용 — 필요할 때만 인용한다. */
export function quoteIfNeeded(name: string, dialect: DialectId): string {
  return needsQuoting(name, dialect) ? quoteIdentifier(name, dialect) : name;
}

/**
 * 방언의 식별자 대소문자 정규화 규칙에 맞춰 비교 키를 만든다.
 * 메타데이터 조회 결과와 사용자가 입력한 이름을 맞추는 데 쓴다.
 */
export function foldIdentifier(name: string): string {
  return name.toLowerCase();
}

/** 여러 방언에서 공통적으로 예약어인 단어들 (인용 필요 판단용). */
const RESERVED_WORDS = new Set([
  'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CHECK',
  'COLUMN', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'CURRENT_USER', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT',
  'DROP', 'ELSE', 'END', 'EXCEPT', 'EXISTS', 'FALSE', 'FOR', 'FOREIGN', 'FROM',
  'FULL', 'GRANT', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT',
  'INTERSECT', 'INTO', 'IS', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NATURAL', 'NOT',
  'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'REFERENCES',
  'RIGHT', 'SELECT', 'SESSION_USER', 'SET', 'SOME', 'TABLE', 'THEN', 'TO',
  'TRUE', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'USING', 'VALUES', 'WHEN',
  'WHERE', 'WITH',
]);
