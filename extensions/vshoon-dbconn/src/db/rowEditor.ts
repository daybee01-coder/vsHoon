import type { CellValue, DialectId, EditSource } from '../types';
import { quoteIdentifier, quoteQualified } from '../sql/identifier';
import type { Driver } from './driver';

/**
 * 그리드 편집을 SQL 로 바꾼다.
 *
 * 규칙 두 가지를 절대 어기지 않는다:
 *  - 식별자(테이블/컬럼)는 quoteIdentifier 를 거친다.
 *  - 값은 **언제나** 바인드 파라미터로 나간다. 문자열 조립에 값이 끼는 경로는 없다.
 *
 * WHERE 는 기본 키 전체로 구성하므로 최대 1행에만 영향을 준다.
 * 호출부는 실제 영향 행 수가 1인지 확인해서, 다르면 사용자에게 알려야 한다.
 */

export interface EditStatement {
  sql: string;
  params: unknown[];
  /** 사용자 확인 대화상자에 보여줄, 값이 채워진 형태의 미리보기. */
  preview: string;
}

export function buildUpdateStatement(
  driver: Driver,
  dialect: DialectId,
  source: EditSource,
  /** 수정할 컬럼의 결과 인덱스. */
  columnIndex: number,
  newValue: CellValue,
  /** 대상 행의 전체 셀 값 — 기본 키 값을 여기서 꺼낸다. */
  row: readonly CellValue[],
): EditStatement {
  const column = source.editableColumns.find((c) => c.index === columnIndex);
  if (!column) {
    throw new Error('이 컬럼은 수정할 수 없습니다.');
  }

  const params: unknown[] = [newValue];
  const setClause = `${quoteIdentifier(column.name, dialect)} = ${driver.placeholder(1)}`;
  const where = buildWhere(driver, dialect, source, row, params);

  const sql =
    `UPDATE ${quoteQualified(source.schema, source.table, dialect)}\n` +
    `   SET ${setClause}\n` +
    ` WHERE ${where.clause}`;

  return {
    sql,
    params,
    preview:
      `UPDATE ${source.schema}.${source.table}\n` +
      `   SET ${column.name} = ${literalForPreview(newValue)}\n` +
      ` WHERE ${where.preview}`,
  };
}

/**
 * 새 행 INSERT.
 *
 * 사용자가 값을 넣은 컬럼만 대상으로 한다. 손대지 않은 컬럼은 구문에서 빠지고
 * 서버의 기본값/시퀀스가 채운다 — 빈 칸을 NULL 로 밀어 넣으면 NOT NULL 컬럼이
 * 있는 테이블에 아무 행도 넣을 수 없다.
 *
 * 기본 키도 넣을 수 있다. 자동 증가가 아닌 테이블이 흔하기 때문이다.
 */
export function buildInsertStatement(
  driver: Driver,
  dialect: DialectId,
  source: EditSource,
  /** 결과 컬럼 인덱스와 넣을 값. 사용자가 건드린 셀만 온다. */
  cells: readonly { index: number; value: CellValue }[],
): EditStatement {
  if (cells.length === 0) {
    throw new Error('입력한 값이 없습니다. 한 컬럼 이상 채워야 행을 추가할 수 있습니다.');
  }

  const known = new Map<number, string>();
  for (const column of [...source.keyColumns, ...source.editableColumns]) {
    known.set(column.index, column.name);
  }

  const names: string[] = [];
  const placeholders: string[] = [];
  const params: unknown[] = [];
  const previews: string[] = [];

  for (const cell of cells) {
    const name = known.get(cell.index);
    if (!name) {
      // 편집 대상이 아닌 컬럼(가공된 값 등)에는 값을 넣을 수 없다.
      throw new Error('이 컬럼에는 값을 넣을 수 없습니다.');
    }
    if (names.includes(quoteIdentifier(name, dialect))) {
      continue; // 같은 컬럼이 두 번 오면 앞의 것만 쓴다.
    }
    params.push(cell.value);
    names.push(quoteIdentifier(name, dialect));
    placeholders.push(driver.placeholder(params.length));
    previews.push(`${name} = ${literalForPreview(cell.value)}`);
  }

  const table = quoteQualified(source.schema, source.table, dialect);
  return {
    sql: `INSERT INTO ${table}\n       (${names.join(', ')})\nVALUES (${placeholders.join(', ')})`,
    params,
    preview: `INSERT INTO ${source.schema}.${source.table}\n` + previews.map((p) => `   ${p}`).join('\n'),
  };
}

export function buildDeleteStatement(
  driver: Driver,
  dialect: DialectId,
  source: EditSource,
  row: readonly CellValue[],
): EditStatement {
  const params: unknown[] = [];
  const where = buildWhere(driver, dialect, source, row, params);

  return {
    sql: `DELETE FROM ${quoteQualified(source.schema, source.table, dialect)}\n WHERE ${where.clause}`,
    params,
    preview: `DELETE FROM ${source.schema}.${source.table}\n WHERE ${where.preview}`,
  };
}

interface WhereParts {
  clause: string;
  preview: string;
}

/**
 * 기본 키 전체로 WHERE 를 만든다.
 *
 * 기본 키에 NULL 이 들어 있으면 `= NULL` 은 아무것도 매칭하지 않으므로,
 * 그런 행은 편집을 거부한다. 실제로 일어나선 안 되는 상태지만
 * (기본 키는 NOT NULL), 결과가 조용히 0행 갱신으로 끝나는 것보다
 * 명확히 실패하는 편이 낫다.
 */
function buildWhere(
  driver: Driver,
  dialect: DialectId,
  source: EditSource,
  row: readonly CellValue[],
  params: unknown[],
): WhereParts {
  const conditions: string[] = [];
  const previews: string[] = [];

  for (const key of source.keyColumns) {
    const value = row[key.index] ?? null;
    if (value === null) {
      throw new Error(
        `기본 키 "${key.name}" 의 값이 NULL 이라 대상 행을 특정할 수 없습니다.`,
      );
    }
    params.push(value);
    conditions.push(
      `${quoteIdentifier(key.name, dialect)} = ${driver.placeholder(params.length)}`,
    );
    previews.push(`${key.name} = ${literalForPreview(value)}`);
  }

  if (conditions.length === 0) {
    // computeEditSource 가 이미 막지만, 방어적으로 한 번 더.
    throw new Error('기본 키 정보가 없어 WHERE 절을 만들 수 없습니다.');
  }

  return {
    clause: conditions.join('\n   AND '),
    preview: previews.join('\n   AND '),
  };
}

/**
 * 확인 대화상자에만 쓰는 표현.
 * 이 문자열이 실행되는 경로는 없다 — 실행에는 항상 바인드 파라미터를 쓴다.
 */
function literalForPreview(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const text = String(value);
  const shortened = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `'${shortened.replace(/'/g, "''")}'`;
}
