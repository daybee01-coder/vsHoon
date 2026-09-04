import * as vscode from 'vscode';
import { environmentBadge, environmentLabel, isProduction } from '../config/environment';
import { profileIcon } from './dialectIcon';
import {
  compareNames,
  folderDepth,
  folderName,
  isWithinFolder,
  joinFolder,
  MAX_FOLDER_DEPTH,
} from '../config/folders';
import type { ProfileStore } from '../config/profileStore';
import type { ConnectionManager } from '../db/connectionManager';
import { getDriver } from '../db/registry';
import type { CatalogCache } from '../metadata/catalog';
import { tableKey } from '../metadata/catalog';
import {
  DIALECT_LABELS,
  type ColumnInfo,
  type ConnectionProfile,
  type DbObject,
  type ObjectKind,
  type TableInfo,
} from '../types';
import { log } from '../util/logger';

/**
 * 사이드바 연결 트리.
 *
 * 계층: (연결 폴더) → 연결 → 스키마 → (테이블 | 뷰) 폴더 → 테이블 → 컬럼
 *
 * 맨 위의 연결 폴더는 사용자가 만드는 그룹이다. 폴더는 별도 엔티티가 아니라
 * 프로필의 `folder` 경로에서 유도되므로(config/folders.ts), 트리와 저장소가
 * 어긋날 수 없다.
 *
 * 자식은 펼칠 때 조회한다. 테이블이 수천 개인 DB 에서 연결하자마자
 * 전부 읽으면 UI 가 멈추기 때문이다.
 */

/** 트리 안에서 연결·폴더를 끌어다 놓을 때 쓰는 형식. */
const DND_MIME = 'application/vnd.code.tree.dbconn.connections';

/** 드래그 페이로드 — 같은 확장 안에서만 오가므로 최소한의 식별자만 담는다. */
type DragPayload =
  | { kind: 'connection'; profileId: string }
  | { kind: 'group'; path: string };

/** 스키마 아래에 놓이는 폴더 종류. */
export type FolderKind = 'tables' | 'views' | 'sequences' | 'routines' | 'others';

export type TreeNode =
  /** 사용자가 만든 연결 그룹. `path` 는 "운영/서울" 같은 전체 경로. */
  | { kind: 'group'; path: string }
  | { kind: 'connection'; profile: ConnectionProfile }
  | { kind: 'schema'; profileId: string; schema: string; isDefault: boolean }
  | { kind: 'folder'; profileId: string; schema: string; folder: FolderKind }
  | { kind: 'table'; profileId: string; table: TableInfo }
  | { kind: 'object'; profileId: string; object: DbObject }
  | { kind: 'column'; profileId: string; column: ColumnInfo }
  | { kind: 'message'; text: string };

const FOLDER_LABELS: Record<FolderKind, string> = {
  tables: '테이블',
  views: '뷰',
  sequences: '시퀀스',
  routines: '함수 · 프로시저',
  others: '기타 객체',
};

/** 각 폴더가 담는 객체 종류. */
const FOLDER_KINDS: Record<FolderKind, Set<string>> = {
  tables: new Set(['table']),
  views: new Set(['view', 'materialized-view']),
  sequences: new Set(['sequence']),
  routines: new Set(['function', 'procedure', 'package']),
  others: new Set(['synonym', 'type']),
};

export class ConnectionTreeProvider
  implements
    vscode.TreeDataProvider<TreeNode>,
    vscode.TreeDragAndDropController<TreeNode>,
    vscode.Disposable
{
  readonly dragMimeTypes = [DND_MIME];
  readonly dropMimeTypes = [DND_MIME];

  private readonly onDidChangeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly profiles: ProfileStore,
    private readonly connections: ConnectionManager,
    private readonly catalog: CatalogCache,
  ) {
    this.subscriptions.push(
      profiles.onDidChange(() => this.refresh()),
      connections.onDidChange(() => this.refresh()),
    );
  }

  refresh(node?: TreeNode): void {
    this.onDidChangeEmitter.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'group':
        return this.groupItem(node.path);
      case 'connection':
        return this.connectionItem(node.profile);
      case 'schema': {
        const item = new vscode.TreeItem(
          node.schema,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        item.description = node.isDefault ? '기본' : undefined;
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(
          FOLDER_LABELS[node.folder],
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'folder';
        return item;
      }
      case 'object': {
        const object = node.object;
        const item = new vscode.TreeItem(object.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(objectIcon(object.kind));
        item.contextValue = object.kind;
        item.description = object.detail ?? objectKindLabel(object.kind);
        item.tooltip = buildObjectTooltip(object);
        item.command = activateCommand(node);
        return item;
      }
      case 'table': {
        const item = new vscode.TreeItem(
          node.table.name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon(
          node.table.kind === 'table' ? 'table' : 'eye',
        );
        item.contextValue = node.table.kind === 'table' ? 'table' : 'view';
        item.description =
          node.table.estimatedRows !== undefined
            ? `~${node.table.estimatedRows.toLocaleString()}행`
            : undefined;
        item.tooltip = buildTableTooltip(node.table);
        // 한 번 클릭은 펼치기다. 명령은 더블클릭에서만 실제 동작하도록
        // dbconn.treeItemActivate 안에서 걸러진다 — 펼칠 때마다 조회가
        // 나가면 트리를 훑는 것만으로 서버에 부담을 준다.
        item.command = activateCommand(node);
        return item;
      }
      case 'column': {
        const column = node.column;
        const item = new vscode.TreeItem(column.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(column.isPrimaryKey ? 'key' : 'symbol-field');
        item.description = `${column.typeName}${column.nullable ? '' : ' NOT NULL'}`;
        item.contextValue = 'column';
        item.tooltip = buildColumnTooltip(column);
        // 컬럼을 더블클릭하면 그 컬럼이 속한 테이블의 상세를 연다.
        item.command = activateCommand(node);
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  private groupItem(path: string): vscode.TreeItem {
    const item = new vscode.TreeItem(
      folderName(path),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    // id 를 고정해야 펼침 상태가 새로고침 후에도 유지된다.
    item.id = `folder:${path}`;
    item.iconPath = new vscode.ThemeIcon('folder');
    item.contextValue = 'group';

    const inside = this.profiles.list().filter((p) => p.folder && isWithinFolder(p.folder, path));
    const connected = inside.filter((p) => this.connections.isConnected(p.id)).length;
    if (inside.length > 0) {
      const parts = [`${inside.length}개`];
      if (connected > 0) {
        parts.push(`${connected} 연결됨`);
      }
      // 접혀 있어도 운영이 섞여 있다는 것은 보여야 한다.
      if (inside.some((p) => isProduction(p.environment))) {
        parts.push('운영 포함');
      }
      item.description = parts.join(' · ');
    } else {
      item.description = '비어 있음';
    }
    item.tooltip = path;
    return item;
  }

  private connectionItem(profile: ConnectionProfile): vscode.TreeItem {
    const session = this.connections.get(profile.id);
    const connected = session !== undefined;
    // 연결 여부와 상관없이 항상 펼칠 수 있게 둔다.
    //
    // 연결된 것만 펼침 상태로 두면, 하나가 연결되는 순간 그 줄에 화살표가 생기면서
    // 목록 전체가 오른쪽으로 밀린다 — 보고 있던 자리가 흔들린다. 화살표 자리를
    // 처음부터 비워 두면 연결하든 끊든 줄이 제자리에 있다.
    // (연결 전에 펼치면 안내 한 줄이 나온다 — getChildren 참고)
    const item = new vscode.TreeItem(profile.name, vscode.TreeItemCollapsibleState.Collapsed);
    // id 를 고정해야 펼침 상태가 새로고침·이름 변경 뒤에도 유지된다.
    item.id = `connection:${profile.id}`;

    // contextValue 로 메뉴 표시 조건이 갈린다 (package.json 의 when 절).
    item.contextValue = connected ? 'connection.connected' : 'connection.disconnected';

    // 아이콘 하나가 세 가지를 말한다: 어떤 DB 인가 · 연결됐나 · 어떤 환경인가.
    // (운영이면 오른쪽 아래에 빨간 점이 붙는다)
    item.iconPath = profileIcon(this.extensionUri, profile, connected);

    const badges: string[] = [];
    const environment = environmentBadge(profile.environment);
    if (environment) {
      badges.push(environment);
    }
    badges.push(DIALECT_LABELS[profile.dialect]);
    if (profile.readOnly) {
      badges.push('읽기 전용');
    }
    if (session && !session.autoCommit) {
      badges.push(session.transactionState === 'active' ? '트랜잭션 열림' : '수동 커밋');
    }
    if (this.connections.activeSession()?.profile.id === profile.id) {
      badges.push('활성');
    }
    item.description = badges.join(' · ');
    item.tooltip = buildConnectionTooltip(profile, connected);

    if (!connected) {
      // 한 번 클릭은 고르기다. 실제 접속은 dbconn.treeItemActivate 가
      // 더블클릭으로 판정했을 때만 일어난다 — 트리를 훑는 것만으로 세션이
      // 열리면 운영 DB 에서 특히 위험하다.
      item.command = activateCommand({ kind: 'connection', profile });
    }
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return this.folderChildren(undefined);
    }
    if (node.kind === 'group') {
      return this.folderChildren(node.path);
    }

    try {
      return await this.loadChildren(node);
    } catch (error) {
      log.warn('트리 자식 항목을 불러오지 못했습니다.', error);
      return [{ kind: 'message', text: describeError(error) }];
    }
  }

  /** 폴더 하나(또는 최상위)에 직접 속한 하위 폴더와 연결. */
  private folderChildren(folder: string | undefined): TreeNode[] {
    const depth = folder ? folderDepth(folder) + 1 : 1;
    const groups = this.profiles
      .folders()
      .filter((path) => folderDepth(path) === depth)
      .filter((path) => folder === undefined || isWithinFolder(path, folder))
      .sort(compareNames)
      .map((path): TreeNode => ({ kind: 'group', path }));

    const connections = this.profiles
      .list()
      .filter((profile) => (profile.folder ?? undefined) === folder)
      .sort((a, b) => compareNames(a.name, b.name))
      .map((profile): TreeNode => ({ kind: 'connection', profile }));

    // 폴더를 먼저, 그다음 연결 — 탐색기와 같은 배치.
    return [...groups, ...connections];
  }

  // ── 끌어다 놓기 ─────────────────────────────────────────────────────────

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const payload: DragPayload[] = [];
    for (const node of source) {
      if (node.kind === 'connection') {
        payload.push({ kind: 'connection', profileId: node.profile.id });
      } else if (node.kind === 'group') {
        payload.push({ kind: 'group', path: node.path });
      }
    }
    if (payload.length > 0) {
      dataTransfer.set(DND_MIME, new vscode.DataTransferItem(payload));
    }
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DND_MIME);
    if (!item) {
      return;
    }
    const payload = item.value as DragPayload[] | undefined;
    if (!Array.isArray(payload) || payload.length === 0) {
      return;
    }

    // 연결 위에 놓으면 그 연결과 같은 폴더로 간다 — 목록 사이에 떨어뜨렸을 때
    // 아무 일도 일어나지 않는 것보다 예측 가능하다.
    let destination: string | undefined;
    if (target !== undefined) {
      if (target.kind === 'group') {
        destination = target.path;
      } else if (target.kind === 'connection') {
        destination = target.profile.folder;
      } else {
        return; // 스키마·테이블 위로는 놓을 수 없다.
      }
    }

    try {
      for (const entry of payload) {
        if (entry.kind === 'connection') {
          await this.profiles.setProfileFolder(entry.profileId, destination);
          continue;
        }
        if (destination !== undefined && isWithinFolder(destination, entry.path)) {
          throw new Error('폴더를 자기 자신의 하위로 옮길 수 없습니다.');
        }
        const moved = joinFolder(destination, folderName(entry.path));
        if (moved && folderDepth(moved) > MAX_FOLDER_DEPTH) {
          throw new Error(`폴더는 ${MAX_FOLDER_DEPTH}단계까지만 만들 수 있습니다.`);
        }
        await this.profiles.moveFolder(entry.path, moved);
      }
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async loadChildren(node: TreeNode): Promise<TreeNode[]> {
    switch (node.kind) {
      case 'connection': {
        const session = this.connections.get(node.profile.id);
        if (!session) {
          // 빈 배열을 돌려주면 VS Code 가 화살표를 지워 버리고, 그 순간 줄이 다시
          // 왼쪽으로 밀린다. 안내 한 줄을 두면 자리도 지키고 무엇을 해야 하는지도 보인다.
          return [{ kind: 'message', text: '연결되어 있지 않습니다 — 더블클릭하면 연결합니다.' }];
        }
        const snapshot = await this.catalog.get(session);
        if (!snapshot) {
          return [{ kind: 'message', text: '스키마 정보를 불러올 수 없습니다.' }];
        }
        return snapshot.schemas.map((schema) => ({
          kind: 'schema',
          profileId: node.profile.id,
          schema: schema.name,
          isDefault: schema.isDefault,
        }));
      }

      case 'schema': {
        // 폴더는 항상 다 보여준다. 비어 있는지 확인하려고 스키마를 펼치는
        // 순간마다 5종류를 모두 조회하면 트리가 느려진다.
        const folders: FolderKind[] = ['tables', 'views', 'sequences', 'routines', 'others'];
        return folders.map((folder) => ({
          kind: 'folder' as const,
          profileId: node.profileId,
          schema: node.schema,
          folder,
        }));
      }

      case 'folder': {
        const kinds = FOLDER_KINDS[node.folder];

        if (node.folder === 'tables' || node.folder === 'views') {
          const tables = await this.loadTables(node.profileId, node.schema);
          const filtered = tables.filter((t) => kinds.has(t.kind));
          if (filtered.length === 0) {
            return [{ kind: 'message', text: '항목이 없습니다.' }];
          }
          return filtered.map((table) => ({
            kind: 'table' as const,
            profileId: node.profileId,
            table,
          }));
        }

        const objects = await this.loadObjects(node.profileId, node.schema);
        const filtered = objects.filter((o) => kinds.has(o.kind));
        if (filtered.length === 0) {
          return [{ kind: 'message', text: '항목이 없습니다.' }];
        }
        return filtered.map((object) => ({
          kind: 'object' as const,
          profileId: node.profileId,
          object,
        }));
      }

      case 'table': {
        const columns = await this.loadColumns(node.profileId, node.table);
        return columns.map((column) => ({ kind: 'column', profileId: node.profileId, column }));
      }

      default:
        return [];
    }
  }

  /** 캐시에 있으면 쓰고, 없으면 그 스키마만 직접 조회한다. */
  private async loadTables(profileId: string, schema: string): Promise<TableInfo[]> {
    const session = this.connections.get(profileId);
    if (!session) {
      return [];
    }
    const snapshot = this.catalog.peek(profileId);
    const cached = snapshot?.tables.filter(
      (t) => t.schema.toLowerCase() === schema.toLowerCase(),
    );
    if (cached && cached.length > 0) {
      return cached;
    }
    const driver = getDriver(session.profile.dialect);
    return session.pool.withConnection(`tree: tables ${schema}`, (conn) =>
      driver.catalog.listTables(conn, schema),
    );
  }

  /** 캐시에 있으면 쓰고, 없으면 그 스키마의 객체만 직접 조회한다. */
  private async loadObjects(profileId: string, schema: string): Promise<DbObject[]> {
    const session = this.connections.get(profileId);
    if (!session) {
      return [];
    }
    const snapshot = this.catalog.peek(profileId);
    const cached = snapshot?.objects.filter(
      (o) => o.schema.toLowerCase() === schema.toLowerCase(),
    );
    if (cached && cached.length > 0) {
      return cached;
    }
    const driver = getDriver(session.profile.dialect);
    return session.pool.withConnection(`tree: objects ${schema}`, (conn) =>
      driver.catalog.listOtherObjects(conn, schema),
    );
  }

  private async loadColumns(profileId: string, table: TableInfo): Promise<ColumnInfo[]> {
    const session = this.connections.get(profileId);
    if (!session) {
      return [];
    }
    const snapshot = this.catalog.peek(profileId);
    const cached = snapshot?.columnsByTable.get(tableKey(table.schema, table.name));
    if (cached && cached.length > 0) {
      return cached;
    }
    const driver = getDriver(session.profile.dialect);
    const all = await session.pool.withConnection(`tree: columns ${table.schema}`, (conn) =>
      driver.catalog.listColumns(conn, table.schema),
    );
    return all.filter((c) => c.table.toLowerCase() === table.name.toLowerCase());
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }
}

/** 더블클릭(또는 사용자의 openMode 설정)으로 상세 화면을 여는 명령. */
function activateCommand(node: TreeNode): vscode.Command {
  return { command: 'dbconn.treeItemActivate', title: '상세 정보', arguments: [node] };
}

function buildConnectionTooltip(profile: ConnectionProfile, connected: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${profile.name}**\n\n`);
  md.appendMarkdown(`- 환경: ${environmentLabel(profile.environment)}\n`);
  md.appendMarkdown(`- 종류: ${DIALECT_LABELS[profile.dialect]}\n`);
  md.appendMarkdown(`- 주소: \`${profile.host}:${profile.port}\`\n`);
  md.appendMarkdown(`- 데이터베이스: \`${profile.database || '(기본)'}\`\n`);
  md.appendMarkdown(`- 사용자: \`${profile.user}\`\n`);
  md.appendMarkdown(`- TLS: ${profile.tls.enabled ? (profile.tls.rejectUnauthorized ? '사용 (검증)' : '사용 (검증 안 함)') : '사용 안 함'}\n`);
  md.appendMarkdown(`- 상태: ${connected ? '연결됨' : '연결 안 됨'}\n`);
  if (isProduction(profile.environment)) {
    md.appendMarkdown('\n> $(warning) 운영 연결입니다. 변경 구문 실행 전에 확인을 한 번 더 받습니다.\n');
    md.supportThemeIcons = true;
  }
  if (profile.readOnly) {
    md.appendMarkdown('\n> 읽기 전용 연결입니다. 데이터 변경 구문이 차단됩니다.\n');
  }
  return md;
}

function buildTableTooltip(table: TableInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${table.schema}.${table.name}**\n\n`);
  if (table.comment) {
    md.appendMarkdown(`${table.comment}\n\n`);
  }
  if (table.estimatedRows !== undefined) {
    md.appendMarkdown(`예상 행 수: ${table.estimatedRows.toLocaleString()}\n`);
  }
  return md;
}

function objectIcon(kind: ObjectKind): string {
  switch (kind) {
    case 'sequence':
      return 'symbol-numeric';
    case 'function':
      return 'symbol-function';
    case 'procedure':
      return 'symbol-method';
    case 'package':
      return 'package';
    case 'synonym':
      return 'references';
    case 'type':
      return 'symbol-class';
    case 'view':
    case 'materialized-view':
      return 'eye';
    default:
      return 'table';
  }
}

function objectKindLabel(kind: ObjectKind): string {
  switch (kind) {
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
    case 'view':
      return '뷰';
    case 'materialized-view':
      return '구체화 뷰';
    default:
      return '테이블';
  }
}

function buildObjectTooltip(object: DbObject): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${object.schema}.${object.name}**\n\n`);
  md.appendMarkdown(`${objectKindLabel(object.kind)}\n\n`);
  if (object.detail) {
    md.appendMarkdown(`\`${object.detail}\`\n\n`);
  }
  if (object.comment) {
    md.appendMarkdown(object.comment);
  }
  return md;
}

function buildColumnTooltip(column: ColumnInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${column.name}** \`${column.typeName}\`\n\n`);
  if (column.isPrimaryKey) {
    md.appendMarkdown('기본 키\n\n');
  }
  md.appendMarkdown(`NULL 허용: ${column.nullable ? '예' : '아니오'}\n\n`);
  if (column.defaultValue) {
    md.appendMarkdown(`기본값: \`${column.defaultValue}\`\n\n`);
  }
  if (column.comment) {
    md.appendMarkdown(column.comment);
  }
  return md;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}
