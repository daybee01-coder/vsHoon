import type {
  CellValue,
  ColumnInfo,
  DetailAttribute,
  DialectId,
  ForeignKeyInfo,
  IndexInfo,
  ObjectRef,
} from '../types';
import { quoteIdentifier, quoteQualified } from '../sql/identifier';

/**
 * 객체 상세 조회 결과를 화면용으로 다듬는 헬퍼.
 *
 * 세 방언이 같은 모양의 결과(인덱스 × 컬럼 한 행씩, 속성 한 행)를 돌려주므로
 * 묶고 포맷하는 규칙은 한곳에 둔다. 드라이버마다 따로 쓰면 정렬·단위·중복
 * 처리가 미묘하게 달라진다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

// ── 인덱스 ────────────────────────────────────────────────────────────────

export interface IndexColumnRow {
  name: string;
  unique: boolean;
  /** 컬럼 이름. 식(expression) 인덱스면 식 텍스트. */
  column: string;
}

/**
 * "인덱스 × 컬럼" 행을 인덱스 단위로 묶는다.
 * 호출부는 컬럼 순서대로 정렬된 행을 넘겨야 한다 — 인덱스에서 컬럼 순서는
 * 의미가 있고, 여기서는 순서를 보존만 한다.
 */
export function groupIndexRows(
  schema: string,
  table: string,
  rows: readonly IndexColumnRow[],
): IndexInfo[] {
  const byName = new Map<string, IndexInfo>();
  for (const row of rows) {
    let index = byName.get(row.name);
    if (!index) {
      index = { schema, table, name: row.name, unique: row.unique, columns: [] };
      byName.set(row.name, index);
    }
    if (row.column) {
      index.columns.push(row.column);
    }
  }
  return [...byName.values()];
}

// ── 외래 키 ───────────────────────────────────────────────────────────────

export interface ForeignKeyColumnRow {
  name: string;
  schema: string;
  table: string;
  column: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete?: string;
  onUpdate?: string;
}

/**
 * "외래 키 × 컬럼" 행을 제약 조건 단위로 묶는다.
 *
 * 복합 키는 columns 와 referencedColumns 의 **순서가 맞아야** 의미가 있다.
 * 호출부는 위치(ORDINAL_POSITION 등) 순으로 정렬된 행을 넘긴다.
 *
 * 같은 이름의 제약이 다른 테이블에도 있을 수 있어(Oracle 은 흔하다)
 * 이름만으로 묶지 않고 "출발 테이블 + 이름" 으로 묶는다.
 */
export function groupForeignKeyRows(rows: readonly ForeignKeyColumnRow[]): ForeignKeyInfo[] {
  const byKey = new Map<string, ForeignKeyInfo>();
  for (const row of rows) {
    const key = `${row.schema}.${row.table}.${row.name}`;
    let info = byKey.get(key);
    if (!info) {
      info = {
        name: row.name,
        schema: row.schema,
        table: row.table,
        columns: [],
        referencedSchema: row.referencedSchema,
        referencedTable: row.referencedTable,
        referencedColumns: [],
        onDelete: row.onDelete,
        onUpdate: row.onUpdate,
      };
      byKey.set(key, info);
    }
    if (row.column) {
      info.columns.push(row.column);
    }
    if (row.referencedColumn) {
      info.referencedColumns.push(row.referencedColumn);
    }
  }
  return [...byKey.values()];
}

/** PostgreSQL 의 confdeltype/confupdtype 한 글자 코드. */
export function pgReferentialAction(code: CellValue): string | undefined {
  switch (typeof code === 'string' ? code : '') {
    case 'a':
      return 'NO ACTION';
    case 'r':
      return 'RESTRICT';
    case 'c':
      return 'CASCADE';
    case 'n':
      return 'SET NULL';
    case 'd':
      return 'SET DEFAULT';
    default:
      return undefined;
  }
}

// ── 속성 ──────────────────────────────────────────────────────────────────

/**
 * `[라벨, 값]` 쌍을 속성 목록으로 만든다.
 * 값이 비어 있는 항목은 버린다 — 서버마다 채워 주는 열이 달라서,
 * 비워 두면 상세 화면이 "(없음)" 으로 도배된다.
 */
export function buildAttributes(
  pairs: readonly (readonly [string, CellValue | undefined])[],
): DetailAttribute[] {
  const attributes: DetailAttribute[] = [];
  for (const [label, value] of pairs) {
    if (value === null || value === undefined) {
      continue;
    }
    const text = typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value).trim();
    if (text.length === 0) {
      continue;
    }
    attributes.push({ label, value: text });
  }
  return attributes;
}

/** 바이트 수를 사람이 읽는 단위로. 숫자가 아니면 undefined. */
export function formatBytes(value: CellValue): string | undefined {
  const bytes = toFiniteNumber(value);
  if (bytes === undefined) {
    return undefined;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 100 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

/** 행 수 같은 정수에 천 단위 구분자를 넣는다. */
export function formatCount(value: CellValue): string | undefined {
  const count = toFiniteNumber(value);
  return count === undefined ? undefined : count.toLocaleString();
}

/**
 * 인덱스 컬럼을 인용한다. 식 인덱스(`lower(name)`)는 식별자가 아니므로
 * 그대로 둔다 — 인용하면 그런 이름의 컬럼을 가리키는 잘못된 DDL 이 된다.
 */
function quoteIndexColumn(column: string, dialect: DialectId): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(column) ? quoteIdentifier(column, dialect) : column;
}

function toFiniteNumber(value: CellValue): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// ── 근사 DDL ──────────────────────────────────────────────────────────────

/**
 * 서버가 DDL 을 주지 않는 경우(PostgreSQL 테이블, 권한이 없는 Oracle 등)
 * 메타데이터로 CREATE TABLE 을 조립한다.
 *
 * 이건 **근사치**다. 제약 조건·파티션·스토리지 옵션은 담기지 않으므로
 * 화면에서 반드시 근사임을 표시해야 한다. 그래도 컬럼 목록을 눈으로 훑는 것보다
 * 훨씬 빠르게 구조를 파악할 수 있어서 값을 한다.
 */
export function buildApproximateDdl(
  ref: ObjectRef,
  columns: readonly ColumnInfo[],
  indexes: readonly IndexInfo[],
  dialect: DialectId,
): string | undefined {
  if (columns.length === 0) {
    return undefined;
  }

  const lines: string[] = [`CREATE TABLE ${quoteQualified(ref.schema, ref.name, dialect)} (`];
  const body: string[] = [];

  for (const column of columns) {
    let line = `  ${quoteIdentifier(column.name, dialect)} ${column.typeName}`;
    if (column.defaultValue !== undefined && column.defaultValue !== '') {
      line += ` DEFAULT ${column.defaultValue}`;
    }
    if (!column.nullable) {
      line += ' NOT NULL';
    }
    body.push(line);
  }

  const primaryKey = columns.filter((c) => c.isPrimaryKey);
  if (primaryKey.length > 0) {
    const names = primaryKey.map((c) => quoteIdentifier(c.name, dialect)).join(', ');
    body.push(`  PRIMARY KEY (${names})`);
  }

  lines.push(body.join(',\n'));
  lines.push(');');

  // 기본 키 인덱스는 위에서 이미 표현했으므로 다시 적지 않는다.
  const primaryKeyNames = new Set(primaryKey.map((c) => c.name.toLowerCase()));
  for (const index of indexes) {
    const isPrimaryKeyIndex =
      index.unique &&
      index.columns.length === primaryKeyNames.size &&
      index.columns.every((c) => primaryKeyNames.has(c.toLowerCase()));
    if (isPrimaryKeyIndex || index.columns.length === 0) {
      continue;
    }
    const unique = index.unique ? 'UNIQUE ' : '';
    lines.push(
      `CREATE ${unique}INDEX ${quoteIdentifier(index.name, dialect)} ` +
        `ON ${quoteQualified(ref.schema, ref.name, dialect)} ` +
        `(${index.columns.map((c) => quoteIndexColumn(c, dialect)).join(', ')});`,
    );
  }

  return lines.join('\n');
}
