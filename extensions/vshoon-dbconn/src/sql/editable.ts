import type { CatalogSnapshot, ColumnMeta, DialectId, EditSource } from '../types';
import { analyzeContext } from './context';
import { foldIdentifier } from './identifier';
import { significant, tokenize, unquoteIdentifier, type Token } from './tokenizer';

/**
 * 결과 그리드를 편집 가능하게 만들 수 있는지 판정한다.
 *
 * 판정 기준은 의도적으로 보수적이다. 애매하면 읽기 전용으로 둔다 —
 * "어느 행을 고치는지 확실하지 않은 상태에서 만든 UPDATE" 는
 * 이 도구가 낼 수 있는 최악의 사고이기 때문이다.
 *
 * 편집을 허용하는 조건 전부:
 *  1. 단일 테이블 SELECT (조인·집계·집합 연산·DISTINCT 없음)
 *  2. 대상이 테이블 — 뷰는 갱신 가능 여부를 알 수 없으므로 제외
 *  3. 그 테이블에 기본 키가 있고, 기본 키 컬럼이 결과에 **모두** 포함됨
 *  4. 결과에 이름이 중복되는 컬럼이 없음 (어느 쪽을 고칠지 모호해짐)
 *
 * 셀 단위로는 한 가지를 더 본다: 그 컬럼이 **가공되지 않은 원본 컬럼**인지.
 * SELECT 목록을 읽어 UPPER(name) AS name 처럼 함수를 거친 값과
 * name AS nm 처럼 이름만 바뀐 값을 구분한다. 이름만 보고 맞추면
 * 가공된 값을 원본 컬럼으로 착각해 엉뚱한 UPDATE 를 만든다.
 */

/** 이 중 하나라도 최상위에 나타나면 단일 테이블 조회가 아니다. */
const DISQUALIFYING_KEYWORDS = new Set([
  'JOIN',
  'STRAIGHT_JOIN',
  'GROUP',
  'HAVING',
  'DISTINCT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'OVER',
  'WITH',
]);

/** 집계 함수가 있으면 원본 행이 1:1로 대응하지 않는다. */
const AGGREGATE_FUNCTIONS = new Set([
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_CONCAT',
  'STRING_AGG',
  'ARRAY_AGG',
  'LISTAGG',
  'JSONB_AGG',
  'JSON_AGG',
  'STDDEV',
  'VARIANCE',
]);

export interface EditabilityInput {
  sql: string;
  dialect: DialectId;
  columns: ColumnMeta[];
  snapshot: CatalogSnapshot | undefined;
  /** 읽기 전용 연결이면 무조건 편집 불가. */
  readOnlyConnection: boolean;
}

/** 편집이 불가능한 이유 — UI 에서 사용자에게 설명하는 데 쓴다. */
export type IneligibleReason =
  | 'read-only-connection'
  | 'not-a-simple-select'
  | 'no-metadata'
  | 'unknown-table'
  | 'not-a-table'
  | 'no-primary-key'
  | 'primary-key-not-selected'
  | 'ambiguous-columns'
  | 'no-editable-columns';

export type EditabilityResult =
  | { editable: true; source: EditSource }
  | { editable: false; reason: IneligibleReason };

export function computeEditSource(input: EditabilityInput): EditabilityResult {
  const { sql, dialect, columns, snapshot, readOnlyConnection } = input;

  if (readOnlyConnection) {
    return { editable: false, reason: 'read-only-connection' };
  }
  if (!snapshot) {
    return { editable: false, reason: 'no-metadata' };
  }

  const tokens = significant(tokenize(sql, dialect));
  if (tokens.length === 0 || tokens[0]!.text.toUpperCase() !== 'SELECT') {
    return { editable: false, reason: 'not-a-simple-select' };
  }

  // 최상위에 조인/집계/집합 연산이 있으면 원본 행을 특정할 수 없다.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'word') {
      continue;
    }
    const upper = token.text.toUpperCase();
    if (DISQUALIFYING_KEYWORDS.has(upper)) {
      return { editable: false, reason: 'not-a-simple-select' };
    }
    // 집계 함수 호출: 단어 바로 뒤에 여는 괄호.
    if (AGGREGATE_FUNCTIONS.has(upper) && tokens[i + 1]?.text === '(') {
      return { editable: false, reason: 'not-a-simple-select' };
    }
  }

  // 서브쿼리가 있으면 어느 테이블이 원본인지 단정할 수 없다.
  if (containsSubquery(tokens)) {
    return { editable: false, reason: 'not-a-simple-select' };
  }

  const context = analyzeContext(sql, sql.length, dialect);
  const refs = context.tables.filter((t) => t.name !== '');
  if (refs.length !== 1) {
    return { editable: false, reason: 'not-a-simple-select' };
  }
  const ref = refs[0]!;

  // 카탈로그에서 실제 테이블을 찾는다.
  const relation = snapshot.tables.find(
    (t) =>
      foldIdentifier(t.name) === foldIdentifier(ref.name) &&
      (ref.schema === undefined || foldIdentifier(t.schema) === foldIdentifier(ref.schema)),
  );
  if (!relation) {
    return { editable: false, reason: 'unknown-table' };
  }
  if (relation.kind !== 'table') {
    // 뷰는 서버가 갱신 가능한지 알 수 없다 — INSTEAD OF 트리거 여부까지 봐야 한다.
    return { editable: false, reason: 'not-a-table' };
  }

  const tableColumns = snapshot.columnsByTable.get(
    `${foldIdentifier(relation.schema)}.${foldIdentifier(relation.name)}`,
  );
  if (!tableColumns || tableColumns.length === 0) {
    return { editable: false, reason: 'no-metadata' };
  }

  const primaryKey = tableColumns.filter((c) => c.isPrimaryKey);
  if (primaryKey.length === 0) {
    return { editable: false, reason: 'no-primary-key' };
  }

  // 이름이 중복된 결과 컬럼은 어느 쪽을 가리키는지 알 수 없으므로 제외한다.
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const column of columns) {
    const key = foldIdentifier(column.name);
    if (seen.has(key)) {
      duplicated.add(key);
      continue;
    }
    seen.add(key);
  }

  // 각 결과 컬럼이 어느 테이블 컬럼에서 왔는지 — SELECT 목록을 읽어 맞춘다.
  const origins = resolveOrigins(sql, dialect, columns);

  // 같은 테이블 컬럼이 결과에 두 번 이상 있으면 어느 셀이 기준인지 모호하다.
  const originCount = new Map<string, number>();
  for (const origin of origins) {
    if (origin) {
      originCount.set(origin, (originCount.get(origin) ?? 0) + 1);
    }
  }

  // 기본 키는 전부 결과에 있어야 하고, 그 셀이 모호하지 않아야 한다.
  const keyColumns: EditSource['keyColumns'] = [];
  for (const pk of primaryKey) {
    const index = origins.indexOf(foldIdentifier(pk.name));
    if (index === -1) {
      // SELECT 목록에 기본 키가 빠져 있다 — WHERE 를 만들 수 없다.
      return { editable: false, reason: 'primary-key-not-selected' };
    }
    if (duplicated.has(foldIdentifier(columns[index]!.name))) {
      return { editable: false, reason: 'ambiguous-columns' };
    }
    keyColumns.push({ name: pk.name, index });
  }

  // 편집 가능한 컬럼: 가공되지 않은 원본 컬럼이면서, 기본 키가 아니고,
  // 결과 안에서 이름과 출처가 모두 유일한 것.
  const columnsByName = new Map(
    tableColumns.map((column) => [foldIdentifier(column.name), column] as const),
  );
  const editableColumns: EditSource['editableColumns'] = [];
  columns.forEach((column, index) => {
    if (duplicated.has(foldIdentifier(column.name))) {
      return;
    }
    const origin = origins[index];
    if (!origin || (originCount.get(origin) ?? 0) > 1) {
      return;
    }
    const source = columnsByName.get(origin);
    if (!source || source.isPrimaryKey) {
      return;
    }
    // 별칭이 붙었어도 UPDATE 에는 실제 컬럼 이름을 쓴다.
    editableColumns.push({ name: source.name, index });
  });

  if (editableColumns.length === 0) {
    return { editable: false, reason: 'no-editable-columns' };
  }

  return {
    editable: true,
    source: {
      schema: relation.schema,
      table: relation.name,
      keyColumns,
      editableColumns,
    },
  };
}

/**
 * 결과 컬럼별 원본 테이블 컬럼 이름(소문자). 가공된 값이면 undefined.
 *
 * SELECT 목록을 위치로 맞출 수 있으면 그렇게 한다 — 별칭이 붙어도
 * 원본을 알 수 있어 가장 정확하다. 별표가 있어 위치를 셀 수 없으면
 * 이름으로 맞추되, 표현식에 붙은 별칭과 같은 이름은 제외한다.
 */
function resolveOrigins(
  sql: string,
  dialect: DialectId,
  columns: ColumnMeta[],
): (string | undefined)[] {
  const items = parseSelectList(sql, dialect);

  if (items && items.length === columns.length && !items.some((i) => i.kind === 'star')) {
    return items.map((item) =>
      item.kind === 'ref' && item.column ? foldIdentifier(item.column) : undefined,
    );
  }

  const shadowed = new Set<string>();
  for (const item of items ?? []) {
    if (item.kind === 'expr' && item.output) {
      shadowed.add(foldIdentifier(item.output));
    }
  }
  return columns.map((column) => {
    const key = foldIdentifier(column.name);
    return shadowed.has(key) ? undefined : key;
  });
}

interface SelectItem {
  kind: 'ref' | 'expr' | 'star';
  /** 원본 컬럼 이름 (kind 가 'ref' 일 때만). */
  column?: string;
  /** 결과에 나타날 이름 — 별칭이 있으면 별칭. */
  output?: string;
}

/** SELECT 와 최상위 FROM 사이를 최상위 쉼표로 끊어 항목별로 분류한다. */
function parseSelectList(sql: string, dialect: DialectId): SelectItem[] | undefined {
  const tokens = significant(tokenize(sql, dialect));
  if (tokens.length === 0 || tokens[0]!.text.toUpperCase() !== 'SELECT') {
    return undefined;
  }

  let depth = 0;
  let end = -1;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (token.kind === 'semicolon') {
      break;
    }
    if (depth === 0 && token.kind === 'word' && token.text.toUpperCase() === 'FROM') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return undefined; // FROM 이 없으면 위치로 맞출 근거가 없다.
  }

  const items: Token[][] = [];
  let current: Token[] = [];
  depth = 0;
  for (let i = 1; i < end; i++) {
    const token = tokens[i]!;
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth++;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
      } else if (token.text === ',' && depth === 0) {
        items.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  items.push(current);

  return items.map(classifySelectItem);
}

function classifySelectItem(tokens: Token[]): SelectItem {
  if (tokens.length === 0) {
    return { kind: 'expr' };
  }
  if (tokens.length === 1 && tokens[0]!.text === '*') {
    return { kind: 'star' };
  }
  if (!isIdentifierToken(tokens[0]!)) {
    return { kind: 'expr', output: aliasOf(tokens) };
  }

  // schema.table.column 형태의 한정 이름을 따라간다.
  let i = 0;
  let last = tokens[i++]!;
  while (tokens[i]?.text === '.') {
    const next = tokens[i + 1];
    if (!next) {
      return { kind: 'expr', output: aliasOf(tokens) };
    }
    if (next.text === '*') {
      // t.* — 뒤에 아무것도 없어야 별표로 인정한다.
      return i + 2 === tokens.length
        ? { kind: 'star' }
        : { kind: 'expr', output: aliasOf(tokens) };
    }
    if (!isIdentifierToken(next)) {
      return { kind: 'expr', output: aliasOf(tokens) };
    }
    last = next;
    i += 2;
  }

  const column = unquoteIdentifier(last.text);
  const rest = tokens.slice(i);
  if (rest.length === 0) {
    return { kind: 'ref', column, output: column };
  }
  // 별칭이 붙은 순수 참조: col AS x / col x
  if (rest.length === 1 && isIdentifierToken(rest[0]!)) {
    return { kind: 'ref', column, output: unquoteIdentifier(rest[0]!.text) };
  }
  if (
    rest.length === 2 &&
    rest[0]!.text.toUpperCase() === 'AS' &&
    isIdentifierToken(rest[1]!)
  ) {
    return { kind: 'ref', column, output: unquoteIdentifier(rest[1]!.text) };
  }
  // 연산자나 함수 호출이 붙었으면 가공된 값이다.
  return { kind: 'expr', output: aliasOf(tokens) };
}

/** 표현식 항목의 결과 이름 — 별칭이 있을 때만 알 수 있다. */
function aliasOf(tokens: Token[]): string | undefined {
  const last = tokens[tokens.length - 1];
  const previous = tokens[tokens.length - 2];
  if (!last || !previous || !isIdentifierToken(last)) {
    return undefined;
  }
  if (previous.text.toUpperCase() === 'AS') {
    return unquoteIdentifier(last.text);
  }
  // AS 를 생략한 별칭: UPPER(name) nm
  if (previous.kind === 'punct' && previous.text === ')') {
    return unquoteIdentifier(last.text);
  }
  return undefined;
}

function isIdentifierToken(token: Token): boolean {
  return token.kind === 'word' || token.kind === 'quoted-identifier';
}

/** SELECT 목록이나 FROM 절 안에 괄호로 감싼 하위 SELECT 가 있는지. */
function containsSubquery(tokens: ReturnType<typeof significant>): boolean {
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
    if (depth > 0 && token.kind === 'word' && token.text.toUpperCase() === 'SELECT') {
      return true;
    }
  }
  return false;
}

/** 편집 불가 사유를 사용자에게 보여줄 문장으로. */
export function describeIneligible(reason: IneligibleReason): string {
  switch (reason) {
    case 'read-only-connection':
      return '읽기 전용 연결입니다.';
    case 'not-a-simple-select':
      return '단일 테이블 조회가 아닙니다. 조인·집계·서브쿼리가 있으면 편집할 수 없습니다.';
    case 'no-metadata':
      return '테이블 메타데이터를 아직 읽지 못했습니다.';
    case 'unknown-table':
      return '대상 테이블을 카탈로그에서 찾지 못했습니다.';
    case 'not-a-table':
      return '뷰는 편집할 수 없습니다.';
    case 'no-primary-key':
      return '테이블에 기본 키가 없어 수정할 행을 특정할 수 없습니다.';
    case 'primary-key-not-selected':
      return '기본 키 컬럼이 조회 결과에 포함되어야 합니다.';
    case 'ambiguous-columns':
      return '이름이 중복된 컬럼이 있어 대상을 특정할 수 없습니다.';
    case 'no-editable-columns':
      return '수정할 수 있는 컬럼이 없습니다 (기본 키는 수정 대상이 아닙니다).';
  }
}
