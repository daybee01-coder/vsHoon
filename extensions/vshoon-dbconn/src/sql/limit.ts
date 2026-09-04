import type { DialectId } from '../types';
import { analyzeStatement } from './guard';
import { significant, tokenize, type Token } from './tokenizer';

/**
 * 결과 행 수 제한.
 *
 * 클라이언트에서 잘라내는 것만으로는 부족하다 — 서버가 이미 수백만 행을
 * 말아 보낸 뒤라면 확장 호스트가 메모리로 죽는다. 그래서 가능하면
 * SQL 자체에 LIMIT 을 붙여 서버가 덜 보내게 만든다.
 *
 * 안전하게 붙일 수 있다고 확신할 때만 건드린다. 조금이라도 애매하면
 * 원본을 그대로 두고 클라이언트 측 절단에 맡긴다 — 사용자가 쓴 SQL 의
 * 의미를 바꾸는 것보다 낫다.
 */

export interface RowLimitResult {
  sql: string;
  /** 서버 측 제한을 적용했는지. false 면 클라이언트에서 잘라야 한다. */
  applied: boolean;
}

export function applyRowLimit(sql: string, limit: number, dialect: DialectId): RowLimitResult {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { sql, applied: false };
  }

  const analysis = analyzeStatement(sql, dialect);
  // 읽기 전용 SELECT 에만 적용한다. DML 에 LIMIT 을 붙이면 의미가 완전히 달라진다.
  if (analysis.category !== 'select') {
    return { sql, applied: false };
  }

  const tokens = significant(tokenize(sql, dialect));
  if (tokens.length === 0) {
    return { sql, applied: false };
  }

  // 이미 행 수를 제한하고 있으면 건드리지 않는다.
  if (hasTopLevelRowLimit(tokens, dialect)) {
    return { sql, applied: false };
  }

  // 세미콜론과 뒤따르는 공백을 걷어내고 붙인다.
  const trimmed = sql.replace(/[\s;]+$/, '');

  switch (dialect) {
    case 'mysql':
    case 'mariadb':
    case 'postgres':
      return { sql: `${trimmed}\nLIMIT ${Math.floor(limit)}`, applied: true };
    case 'oracle':
      // Oracle 은 드라이버의 maxRows 로 처리하므로 SQL 을 고치지 않는다.
      return { sql, applied: false };
  }
}

/**
 * 최상위 레벨(괄호 밖)에 행 수를 제한하는 절이 있는지.
 * 서브쿼리 안의 LIMIT 은 전체 결과 크기를 보장하지 않으므로 세지 않는다.
 */
function hasTopLevelRowLimit(tokens: Token[], dialect: DialectId): boolean {
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
    if (upper === 'LIMIT') {
      return true;
    }
    // FETCH FIRST/NEXT n ROWS ONLY (표준 SQL, PostgreSQL/Oracle 지원)
    if (upper === 'FETCH') {
      return true;
    }
    if (dialect === 'oracle' && upper === 'ROWNUM') {
      return true;
    }
    // INTO 절이 있는 SELECT 는 결과 집합을 만들지 않는다 — 손대면 안 된다.
    if (upper === 'INTO') {
      return true;
    }
    // FOR UPDATE 뒤에는 LIMIT 을 붙일 수 없다 (MySQL 은 순서가 반대).
    if (upper === 'FOR' && tokens[i + 1]?.text.toUpperCase() === 'UPDATE') {
      return true;
    }
  }
  return false;
}
