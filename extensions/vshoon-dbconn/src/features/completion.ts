import * as vscode from 'vscode';
import type {
  CatalogSnapshot,
  ColumnInfo,
  ConnectionProfile,
  DbObject,
  DialectId,
  ObjectKind,
  TableInfo,
} from '../types';
import type { ConnectionManager } from '../db/connectionManager';
import type { CatalogCache } from '../metadata/catalog';
import { findTables, tableKey } from '../metadata/catalog';
import { analyzeContext, type CompletionContext, type TableRef } from '../sql/context';
import { foldIdentifier, quoteIfNeeded } from '../sql/identifier';
import { statementAt } from '../sql/statements';
import { availableCategories, CompletionCycle, type Category } from './completionCycle';
import { applyCase, functionsFor, keywordsFor } from './keywords';
import { log } from '../util/logger';

/**
 * SQL 자동 완성 (Ctrl+Space).
 *
 * 두 가지 모드가 있다:
 *
 *  - **문맥 추천** (첫 Ctrl+Space): 커서 위치에서 가장 가능성 높은 것을 섞어서 보여준다.
 *    FROM 뒤면 테이블, `별칭.` 뒤면 그 테이블의 컬럼, 그 외엔 컬럼 + 키워드.
 *
 *  - **분류 순환** (같은 자리에서 Ctrl+Space 반복): 테이블 → 뷰 → 시퀀스 →
 *    함수 → … 한 분류씩만 보여준다. 이름이 기억나지 않는 시퀀스를 찾을 때처럼
 *    "종류는 아는데 이름을 모르는" 상황에 쓴다.
 *
 * 정렬은 sortText 접두사로 명시한다 (VS Code 는 사전순으로 정렬한다):
 *   0_ 컬럼   1_ 테이블/별칭   2_ 스키마·기타 객체   3_ 함수   4_ 키워드
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private readonly cycle = new CompletionCycle();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly catalog: CatalogCache,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    triggerContext: vscode.CompletionContext,
  ): Promise<vscode.CompletionList | undefined> {
    const config = vscode.workspace.getConfiguration('dbconn');
    if (!config.get<boolean>('completion.enabled', true)) {
      return undefined;
    }

    // 이 문서에 지정된 연결을 먼저 본다 — 편집기마다 다른 DB 를 보고 있을 때
    // 활성 연결의 스키마를 제안하면 있지도 않은 테이블 이름이 뜬다.
    const editorKey = document.uri.toString();
    const session = this.connections.sessionForEditor(editorKey);
    // 세션이 없어도 프로필은 알 수 있다 (아직 접속 전이거나 끊긴 경우).
    const profile = session?.profile ?? this.connections.profileForEditor(editorKey);
    const dialect = profile?.dialect ?? 'postgres';

    const text = document.getText();
    const offset = document.offsetAt(position);
    const statement = statementAt(text, offset, dialect);

    const statementText = statement?.text ?? text;
    const statementStart = statement?.start ?? 0;
    const context = analyzeContext(statementText, offset - statementStart, dialect, statementStart);

    // 문자열 리터럴이나 주석 안이면 제안하지 않는다.
    if (context.suppressed) {
      return undefined;
    }

    /**
     * 스키마는 **연결이 열려 있지 않아도** 쓸 수 있다.
     *
     * 세션이 있으면 필요할 때 새로 읽고, 없으면 마지막으로 읽어 둔 스냅샷을 쓴다.
     * 편집기에 연결을 지정해 두면 그 연결이 닫혀 있는 시간이 생기는데(창을 다시
     * 켠 직후가 대표적이다), 그때마다 자동 완성이 통째로 죽으면 지정해 둔 것이
     * 오히려 손해가 된다.
     */
    const snapshot = session
      ? await this.catalog.get(session)
      : profile
        ? this.catalog.peek(profile.id)
        : undefined;
    if (token.isCancellationRequested) {
      return undefined;
    }
    if (!snapshot) {
      // "테이블이 안 뜬다"는 신고는 대부분 여기서 갈린다. 이유를 남겨 둔다.
      log.debug(
        `자동 완성: 스키마 없음 — ${
          profile
            ? `연결 "${profile.name}" ${session ? '(세션 있음, 캐시 비어 있음)' : '(접속 전)'}`
            : '지정·활성 연결 없음'
        }`,
      );
    }

    const keywordCase = config.get<'upper' | 'lower' | 'preserve'>(
      'completion.keywordCase',
      'upper',
    );
    const range = new vscode.Range(document.positionAt(context.replaceStart), position);

    // `별칭.` 뒤에서는 순환하지 않는다 — 그 자리에서 원하는 건 컬럼뿐이다.
    if (context.qualifiers.length > 0) {
      const items: vscode.CompletionItem[] = [];
      if (snapshot) {
        addQualifiedItems(items, context, snapshot, dialect, range);
      } else if (!session) {
        // 점 뒤에서 빈 목록만 뜨면 고장으로 보인다 — 여기서도 이유를 보여준다.
        items.push(connectHint(profile, context.prefix, range));
      }
      return new vscode.CompletionList(items, false);
    }

    const categories = availableCategories(snapshot);
    const picked = this.cycle.advance(
      document,
      offset,
      context.prefix,
      triggerContext.triggerKind,
      categories,
    );

    const items = this.buildItems(
      picked.category,
      context,
      snapshot,
      dialect,
      keywordCase,
      range,
    );

    // 어느 분류를 보고 있는지 각 항목에 표시한다. VS Code 는 목록에 머리글을
    // 달 수 없어서, 항목마다 붙이는 게 유일하게 확실한 방법이다.
    if (picked.category.id !== 'smart' && items.length > 0) {
      const badge = `${picked.category.label} ${picked.index + 1}/${picked.total}`;
      for (const item of items) {
        item.label = typeof item.label === 'string'
          ? { label: item.label, description: badge }
          : { ...item.label, description: badge };
      }
    }

    // 연결이 열려 있지 않고 캐시된 스키마도 없으면, 키워드만 조용히 내놓는 대신
    // 왜 테이블이 없는지 알려 주고 그 자리에서 연결할 수 있게 한다.
    if (!session && !snapshot) {
      items.unshift(connectHint(profile, context.prefix, range));
    }

    return new vscode.CompletionList(items, false);
  }

  private buildItems(
    category: Category,
    context: CompletionContext,
    snapshot: CatalogSnapshot | undefined,
    dialect: DialectId,
    keywordCase: 'upper' | 'lower' | 'preserve',
    range: vscode.Range,
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    if (category.id === 'smart') {
      if (snapshot) {
        addSmartItems(items, context, snapshot, dialect, range);
      }
      addKeywordItems(items, context, dialect, keywordCase, range);
      return items;
    }

    if (category.id === 'keyword') {
      addKeywordItems(items, context, dialect, keywordCase, range);
      return items;
    }

    if (!snapshot) {
      return items;
    }

    if (category.id === 'column') {
      const columns = collectContextColumns(snapshot, context.tables);
      // 문장이 테이블을 참조하지 않으면 스키마 전체 컬럼은 너무 많다.
      addColumnItems(items, columns, dialect, range, '0', context.tables);
      return items;
    }

    // 관계형 객체 (테이블 / 뷰 / 구체화 뷰)
    if (category.id === 'table' || category.id === 'view' || category.id === 'materialized-view') {
      const relations = snapshot.tables.filter((t) => t.kind === category.id);
      addTableItems(items, relations, dialect, range, '1', true, snapshot);
      return items;
    }

    // 그 외 객체 (시퀀스 / 루틴 / 동의어 …)
    const objects = snapshot.objects.filter((o) => o.kind === category.id);
    addObjectItems(items, objects, dialect, range, snapshot);
    return items;
  }
}

/**
 * "연결이 없어서 테이블을 제안하지 못한다"고 알리는 항목.
 *
 * 목록을 그냥 비워 두면 자동 완성이 고장 난 것처럼 보인다. 이유를 한 줄로
 * 보여 주고, 고르면 그 자리에서 연결까지 한다.
 *
 * 글자는 하나도 바꾸지 않는다: 입력한 접두사를 그대로 다시 넣고(insertText),
 * 무엇을 치고 있든 걸러지지 않도록 filterText 도 접두사에 맞춘다.
 */
function connectHint(
  profile: ConnectionProfile | undefined,
  prefix: string,
  range: vscode.Range,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    {
      label: profile ? `${profile.name} 에 연결` : '연결 선택',
      description: '연결하면 테이블 · 컬럼을 제안합니다',
    },
    vscode.CompletionItemKind.Event,
  );
  item.detail = profile ? '연결 안 됨' : '활성 연결 없음';
  item.sortText = '00';
  item.insertText = prefix;
  item.filterText = prefix;
  item.range = range;
  item.command = profile
    ? { command: 'dbconn.connect', title: '연결', arguments: [{ profileId: profile.id }] }
    : { command: 'dbconn.setActiveConnection', title: '연결 선택' };
  return item;
}

// ─── 문맥 추천 ──────────────────────────────────────────────────────────────

function addSmartItems(
  items: vscode.CompletionItem[],
  context: CompletionContext,
  snapshot: CatalogSnapshot,
  dialect: DialectId,
  range: vscode.Range,
): void {
  const wantsTables =
    context.clause === 'from' ||
    context.clause === 'join' ||
    context.clause === 'insert-into' ||
    context.leadingKeyword === 'UPDATE';

  if (wantsTables) {
    addTableItems(items, snapshot.tables, dialect, range, '1', true, snapshot);
    addSchemaItems(items, snapshot, dialect, range);
    return;
  }

  const contextColumns = collectContextColumns(snapshot, context.tables);
  if (contextColumns.length > 0) {
    addColumnItems(items, contextColumns, dialect, range, '0', context.tables);
  }
  addAliasItems(items, context.tables, range);

  // 값이 오는 자리에서는 시퀀스가 자주 쓰인다 (nextval / .NEXTVAL).
  if (context.clause === 'values' || context.clause === 'set' || context.clause === 'select') {
    const sequences = snapshot.objects.filter((o) => o.kind === 'sequence');
    addObjectItems(items, sequences, dialect, range, snapshot);
  }

  addTableItems(items, snapshot.tables, dialect, range, '2', true, snapshot);
}

/** `별칭.` / `스키마.` / `테이블.` 뒤. */
function addQualifiedItems(
  items: vscode.CompletionItem[],
  context: CompletionContext,
  snapshot: CatalogSnapshot,
  dialect: DialectId,
  range: vscode.Range,
): void {
  const qualifiers = context.qualifiers;
  const last = qualifiers[qualifiers.length - 1]!;

  // 1) 별칭 → 그 테이블의 컬럼
  const aliased = resolveAlias(context.tables, last);
  if (aliased) {
    const columns = lookupColumns(snapshot, aliased);
    if (columns.length > 0) {
      addColumnItems(items, columns, dialect, range, '0');
      return;
    }
  }

  // 2) 테이블 이름 → 그 컬럼
  const matched = findTables(snapshot, last);
  const schemaHint = qualifiers.length > 1 ? qualifiers[qualifiers.length - 2] : undefined;
  const table = schemaHint
    ? matched.find((t) => foldIdentifier(t.schema) === foldIdentifier(schemaHint))
    : matched[0];
  if (table) {
    const columns = snapshot.columnsByTable.get(tableKey(table.schema, table.name)) ?? [];
    if (columns.length > 0) {
      addColumnItems(items, columns, dialect, range, '0');
      return;
    }
  }

  // 3) 시퀀스 이름 → Oracle 의 NEXTVAL / CURRVAL
  const sequence = snapshot.objects.find(
    (o) => o.kind === 'sequence' && foldIdentifier(o.name) === foldIdentifier(last),
  );
  if (sequence && dialect === 'oracle') {
    for (const pseudo of ['NEXTVAL', 'CURRVAL']) {
      const item = new vscode.CompletionItem(pseudo, vscode.CompletionItemKind.Property);
      item.range = range;
      item.detail = '시퀀스 의사 컬럼';
      item.sortText = `0_${pseudo}`;
      items.push(item);
    }
    return;
  }

  // 4) 스키마 이름 → 그 안의 테이블과 객체
  const folded = foldIdentifier(last);
  const schemaTables = snapshot.tables.filter((t) => foldIdentifier(t.schema) === folded);
  const schemaObjects = snapshot.objects.filter((o) => foldIdentifier(o.schema) === folded);
  if (schemaTables.length > 0 || schemaObjects.length > 0) {
    addTableItems(items, schemaTables, dialect, range, '0', /* qualify */ false);
    addObjectItems(items, schemaObjects, dialect, range, snapshot, /* qualify */ false);
  }
}

// ─── 항목 생성 ──────────────────────────────────────────────────────────────

function addColumnItems(
  items: vscode.CompletionItem[],
  columns: ColumnInfo[],
  dialect: DialectId,
  range: vscode.Range,
  sortPrefix: string,
  tables?: TableRef[],
): void {
  for (const column of columns) {
    const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
    item.insertText = quoteIfNeeded(column.name, dialect);
    item.range = range;
    item.detail = column.typeName + (column.nullable ? '' : ' NOT NULL');
    item.sortText = `${sortPrefix}_${String(column.ordinal).padStart(4, '0')}_${column.name}`;
    item.filterText = column.name;

    const lines: string[] = [`**${column.table}.${column.name}**`, '', `타입: \`${column.typeName}\``];
    if (column.isPrimaryKey) {
      lines.push('기본 키');
    }
    if (column.defaultValue) {
      lines.push(`기본값: \`${column.defaultValue}\``);
    }
    if (column.comment) {
      lines.push('', column.comment);
    }
    item.documentation = new vscode.MarkdownString(lines.join('\n'));

    if (column.isPrimaryKey) {
      item.kind = vscode.CompletionItemKind.Property;
    }
    if (tables && tables.length > 1) {
      item.detail = `${column.table} · ${item.detail}`;
    }
    items.push(item);
  }
}

function addTableItems(
  items: vscode.CompletionItem[],
  tables: TableInfo[],
  dialect: DialectId,
  range: vscode.Range,
  sortPrefix: string,
  qualify: boolean,
  snapshot?: CatalogSnapshot,
): void {
  for (const table of tables) {
    const isDefaultSchema =
      snapshot !== undefined &&
      foldIdentifier(table.schema) === foldIdentifier(snapshot.defaultSchema);

    const item = new vscode.CompletionItem(
      table.name,
      table.kind === 'table'
        ? vscode.CompletionItemKind.Struct
        : vscode.CompletionItemKind.Interface,
    );
    item.insertText =
      qualify && !isDefaultSchema
        ? `${quoteIfNeeded(table.schema, dialect)}.${quoteIfNeeded(table.name, dialect)}`
        : quoteIfNeeded(table.name, dialect);
    item.range = range;
    item.detail = isDefaultSchema
      ? kindLabel(table.kind)
      : `${table.schema} · ${kindLabel(table.kind)}`;
    item.sortText = `${sortPrefix}_${isDefaultSchema ? '0' : '1'}_${table.name}`;
    item.filterText = table.name;

    const lines = [`**${table.schema}.${table.name}**`, '', kindLabel(table.kind)];
    if (table.estimatedRows !== undefined) {
      lines.push(`예상 행 수: ${table.estimatedRows.toLocaleString()}`);
    }
    if (table.comment) {
      lines.push('', table.comment);
    }
    item.documentation = new vscode.MarkdownString(lines.join('\n'));
    items.push(item);
  }
}

/** 시퀀스 / 루틴 / 동의어 등. */
function addObjectItems(
  items: vscode.CompletionItem[],
  objects: DbObject[],
  dialect: DialectId,
  range: vscode.Range,
  snapshot: CatalogSnapshot,
  qualify = true,
): void {
  for (const object of objects) {
    const isDefaultSchema =
      foldIdentifier(object.schema) === foldIdentifier(snapshot.defaultSchema);

    const item = new vscode.CompletionItem(object.name, completionKind(object.kind));
    const qualified =
      qualify && !isDefaultSchema
        ? `${quoteIfNeeded(object.schema, dialect)}.${quoteIfNeeded(object.name, dialect)}`
        : quoteIfNeeded(object.name, dialect);

    // 루틴은 괄호까지 넣고 커서를 안쪽에 둔다.
    if (object.kind === 'function' || object.kind === 'procedure') {
      item.insertText = new vscode.SnippetString(`${qualified}($0)`);
    } else if (object.kind === 'sequence') {
      item.insertText = sequenceInsertText(qualified, dialect);
    } else {
      item.insertText = qualified;
    }

    item.range = range;
    item.detail = isDefaultSchema
      ? kindLabel(object.kind)
      : `${object.schema} · ${kindLabel(object.kind)}`;
    item.sortText = `2_${isDefaultSchema ? '0' : '1'}_${object.name}`;
    item.filterText = object.name;

    const lines = [`**${object.schema}.${object.name}**`, '', kindLabel(object.kind)];
    if (object.detail) {
      lines.push(`\`${object.detail}\``);
    }
    if (object.comment) {
      lines.push('', object.comment);
    }
    item.documentation = new vscode.MarkdownString(lines.join('\n'));
    items.push(item);
  }
}

/**
 * 시퀀스는 이름만 넣어도 쓸 수 없다 — 방언마다 값을 꺼내는 문법이 다르다.
 * 바로 쓸 수 있는 형태로 넣어 준다.
 */
function sequenceInsertText(qualified: string, dialect: DialectId): vscode.SnippetString | string {
  switch (dialect) {
    case 'postgres':
      return new vscode.SnippetString(`nextval('${qualified}')`);
    case 'oracle':
      return new vscode.SnippetString(`${qualified}.NEXTVAL`);
    case 'mariadb':
      return new vscode.SnippetString(`NEXTVAL(${qualified})`);
    default:
      return qualified;
  }
}

function addSchemaItems(
  items: vscode.CompletionItem[],
  snapshot: CatalogSnapshot,
  dialect: DialectId,
  range: vscode.Range,
): void {
  for (const schema of snapshot.schemas) {
    const item = new vscode.CompletionItem(schema.name, vscode.CompletionItemKind.Module);
    item.insertText = quoteIfNeeded(schema.name, dialect);
    item.range = range;
    item.detail = schema.isDefault ? '스키마 (기본)' : '스키마';
    item.sortText = `2_${schema.isDefault ? '0' : '1'}_${schema.name}`;
    items.push(item);
  }
}

function addAliasItems(
  items: vscode.CompletionItem[],
  tables: TableRef[],
  range: vscode.Range,
): void {
  for (const table of tables) {
    if (!table.alias) {
      continue;
    }
    const item = new vscode.CompletionItem(table.alias, vscode.CompletionItemKind.Variable);
    item.insertText = table.alias;
    item.range = range;
    item.detail = `별칭 → ${table.schema ? `${table.schema}.` : ''}${table.name}`;
    item.sortText = `0_alias_${table.alias}`;
    items.push(item);
  }
}

function addKeywordItems(
  items: vscode.CompletionItem[],
  context: CompletionContext,
  dialect: DialectId,
  keywordCase: 'upper' | 'lower' | 'preserve',
  range: vscode.Range,
): void {
  for (const keyword of keywordsFor(dialect)) {
    const text = applyCase(keyword, keywordCase);
    const item = new vscode.CompletionItem(text, vscode.CompletionItemKind.Keyword);
    item.insertText = text;
    item.range = range;
    item.sortText = `4_${text}`;
    item.filterText = keyword;
    items.push(item);
  }

  for (const fn of functionsFor(dialect)) {
    const text = applyCase(fn, keywordCase);
    const item = new vscode.CompletionItem(text, vscode.CompletionItemKind.Function);
    item.insertText = new vscode.SnippetString(`${text}($0)`);
    item.range = range;
    item.detail = '내장 함수';
    item.sortText = `3_${text}`;
    item.filterText = fn;
    items.push(item);
  }

  if (context.leadingKeyword === '' || context.clause === 'unknown') {
    addSnippet(items, range, 'SELECT … FROM …', 'select-from',
      'SELECT ${1:*}\n  FROM ${2:table}\n WHERE ${3:condition};');
    addSnippet(items, range, 'INSERT INTO …', 'insert-into',
      'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});');
    addSnippet(items, range, 'UPDATE … SET …', 'update-set',
      'UPDATE ${1:table}\n   SET ${2:column} = ${3:value}\n WHERE ${4:condition};');
  }
}

function addSnippet(
  items: vscode.CompletionItem[],
  range: vscode.Range,
  label: string,
  filter: string,
  body: string,
): void {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
  item.insertText = new vscode.SnippetString(body);
  item.range = range;
  item.filterText = filter;
  item.sortText = `3_snippet_${filter}`;
  item.detail = '스니펫';
  items.push(item);
}

// ─── 조회 헬퍼 ──────────────────────────────────────────────────────────────

function resolveAlias(tables: TableRef[], name: string): TableRef | undefined {
  const folded = foldIdentifier(name);
  return (
    tables.find((t) => t.alias && foldIdentifier(t.alias) === folded) ??
    tables.find((t) => !t.alias && foldIdentifier(t.name) === folded)
  );
}

function lookupColumns(snapshot: CatalogSnapshot, ref: TableRef): ColumnInfo[] {
  if (!ref.name) {
    return [];
  }
  if (ref.schema) {
    return snapshot.columnsByTable.get(tableKey(ref.schema, ref.name)) ?? [];
  }
  for (const table of findTables(snapshot, ref.name)) {
    const columns = snapshot.columnsByTable.get(tableKey(table.schema, table.name));
    if (columns && columns.length > 0) {
      return columns;
    }
  }
  return [];
}

function collectContextColumns(snapshot: CatalogSnapshot, tables: TableRef[]): ColumnInfo[] {
  const out: ColumnInfo[] = [];
  const seen = new Set<string>();
  for (const ref of tables) {
    for (const column of lookupColumns(snapshot, ref)) {
      const key = `${column.table}.${column.name}`.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(column);
    }
  }
  return out;
}

function completionKind(kind: ObjectKind): vscode.CompletionItemKind {
  switch (kind) {
    case 'sequence':
      return vscode.CompletionItemKind.Value;
    case 'function':
      return vscode.CompletionItemKind.Function;
    case 'procedure':
      return vscode.CompletionItemKind.Method;
    case 'package':
      return vscode.CompletionItemKind.Module;
    case 'synonym':
      return vscode.CompletionItemKind.Reference;
    case 'type':
      return vscode.CompletionItemKind.Class;
    case 'view':
    case 'materialized-view':
      return vscode.CompletionItemKind.Interface;
    default:
      return vscode.CompletionItemKind.Struct;
  }
}

function kindLabel(kind: ObjectKind): string {
  switch (kind) {
    case 'view':
      return '뷰';
    case 'materialized-view':
      return '구체화 뷰';
    case 'sequence':
      return '시퀀스';
    case 'function':
      return '함수';
    case 'procedure':
      return '프로시저';
    case 'package':
      return '패키지';
    case 'synonym':
      return '동의어';
    case 'type':
      return '타입';
    default:
      return '테이블';
  }
}
