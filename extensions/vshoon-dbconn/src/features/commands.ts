import * as vscode from 'vscode';
import {
  folderDepth,
  folderName,
  isWithinFolder,
  joinFolder,
  MAX_FOLDER_DEPTH,
  parentFolder,
  validateFolderName,
} from '../config/folders';
import { formatConnectionUrl, parseConnectionUrl } from '../config/connectionUrl';
import { isProduction } from '../config/environment';
import { duplicateName } from '../config/profileNames';
import type { ProfileStore } from '../config/profileStore';
import type { ConnectionManager } from '../db/connectionManager';
import { testConnection } from '../db/connectionTest';
import { getDriver } from '../db/registry';
import type { CatalogCache } from '../metadata/catalog';
import {
  DIALECT_LABELS,
  type ConnectionProfile,
  type ConnectionProfileDraft,
  type ObjectRef,
} from '../types';
import { log } from '../util/logger';
import type { ConnectionTreeProvider, TreeNode } from '../views/connectionTree';
import { openConnectionForm } from '../views/connectionForm';
import { profileIcon } from '../views/dialectIcon';
import type { ObjectDetailsPanel } from '../views/objectDetailsPanel';
import type { ResultsPanel } from '../views/resultsPanel';
import type { QueryExecutor } from './execute';
import type { QueryHistory } from './queryHistory';
import { describeRun, historyLabel, type QueryHistoryEntry } from './historyIndex';
import { historyEntryOf, type QueryHistoryTreeProvider } from '../views/historyTree';
import type { RecentScripts } from './recentScripts';
import type { RecentScriptEntry } from './recentIndex';
import type { QueryStore, SavedQuery } from './queryStore';
import { queryDisplayName } from './queryFiles';
import type { ScriptCache } from './scriptCache';
import type { ScriptCacheEntry } from './scriptIndex';

/** 명령 등록. 반환된 Disposable 들은 확장 컨텍스트에 등록된다. */
export function registerCommands(deps: {
  extensionUri: vscode.Uri;
  profiles: ProfileStore;
  connections: ConnectionManager;
  catalog: CatalogCache;
  tree: ConnectionTreeProvider;
  /** 키보드로 부른 명령이 대상 노드를 찾을 때 쓴다 (F2 등). */
  treeView: vscode.TreeView<TreeNode>;
  results: ResultsPanel;
  details: ObjectDetailsPanel;
  executor: QueryExecutor;
  scripts: ScriptCache;
  recents: RecentScripts;
  history: QueryHistory;
  historyTree: QueryHistoryTreeProvider;
  queries: QueryStore;
}): vscode.Disposable[] {
  const {
    extensionUri,
    profiles,
    connections,
    catalog,
    tree,
    treeView,
    results,
    details,
    executor,
    scripts,
    recents,
    history,
    historyTree,
    queries,
  } = deps;

  /**
   * 트리 노드에서 상세 대상 객체를 뽑는다.
   * 컬럼 노드는 그 컬럼이 속한 테이블을 가리킨다 — 컬럼 하나만 담은
   * 화면보다 테이블 상세로 가는 편이 실제로 하려는 일에 가깝다.
   */
  function objectTargetOf(arg: unknown): { profileId: string; ref: ObjectRef } | undefined {
    const node = arg as TreeNode | undefined;
    if (!node || typeof node !== 'object' || !('kind' in node)) {
      return undefined;
    }
    switch (node.kind) {
      case 'table':
        return {
          profileId: node.profileId,
          ref: { schema: node.table.schema, name: node.table.name, kind: node.table.kind },
        };
      case 'object':
        return {
          profileId: node.profileId,
          ref: { schema: node.object.schema, name: node.object.name, kind: node.object.kind },
        };
      case 'column':
        return {
          profileId: node.profileId,
          ref: { schema: node.column.schema, name: node.column.table, kind: 'table' },
        };
      default:
        return undefined;
    }
  }

  /** 같은 항목을 짧은 간격으로 두 번 눌렀는지 판단하기 위한 마지막 클릭. */
  let lastActivation: { key: string; at: number } | undefined;

  /**
   * 이번 클릭이 "두 번째"인가.
   *
   * 트리 항목에 붙인 명령은 한 번 클릭에도 불린다. 그대로 두면 훑어보려고
   * 누른 것만으로 접속이 일어나거나 조회가 나간다. 그래서 짧은 간격의 두 번째
   * 클릭에서만 참을 돌려주고, 첫 클릭은 기록만 남긴다.
   *
   * 사용자가 `workbench.list.openMode` 를 doubleClick 으로 두었다면 VS Code 가
   * 이미 두 번 눌렀을 때만 명령을 부르므로 곧바로 참이다.
   */
  function isSecondClick(key: string): boolean {
    const openMode = vscode.workspace
      .getConfiguration('workbench')
      .get<string>('list.openMode', 'singleClick');
    const now = Date.now();
    if (openMode === 'doubleClick' || (lastActivation?.key === key && now - lastActivation.at < 500)) {
      // 세 번째 클릭이 또 열지 않도록 기록을 지운다.
      lastActivation = undefined;
      return true;
    }
    lastActivation = { key, at: now };
    return false;
  }

  /** 트리 노드 인자에서 프로필을 뽑거나, 없으면 사용자에게 고르게 한다. */
  async function resolveProfile(arg: unknown): Promise<ConnectionProfile | undefined> {
    const node = arg as TreeNode | { profileId?: string } | undefined;
    if (node && typeof node === 'object') {
      if ('kind' in node && node.kind === 'connection') {
        return node.profile;
      }
      if ('profileId' in node && typeof node.profileId === 'string') {
        return profiles.get(node.profileId);
      }
    }
    return pickProfile('연결 선택');
  }

  /**
   * 연결 복사용 클립보드.
   *
   * 시스템 클립보드를 쓰지 않는다 — 프로필에는 내부 호스트명과 계정이 들어 있어서,
   * 복사한 뒤 다른 곳에 무심코 붙여 넣으면 그대로 새어 나간다. 붙여넣기는 트리
   * 안에서만 일어나므로 확장 안에 두는 편이 안전하고 충분하다.
   *
   * 스냅샷을 들고 있는 이유: 복사한 뒤 원본을 고치거나 지워도 붙여 넣을 수 있어야
   * 한다. (다만 원본을 지웠다면 저장된 비밀번호는 함께 사라진다.)
   */
  let clipboard: ConnectionProfile[] = [];

  /**
   * 명령이 대상으로 삼을 연결들.
   *
   * 트리 메뉴는 (누른 노드, 선택된 노드 전체) 두 인자를 준다 — 여러 개를 골라 두고
   * 우클릭하면 그 전부가 대상이다. 키보드로 부르면 인자가 없으므로 선택을 본다.
   */
  function connectionTargets(arg: unknown, many: unknown): ConnectionProfile[] {
    const nodes: readonly unknown[] =
      Array.isArray(many) && many.length > 0
        ? many
        : arg !== undefined && arg !== null
          ? [arg]
          : treeView.selection;
    const picked: ConnectionProfile[] = [];
    for (const node of nodes) {
      if (node && typeof node === 'object' && 'kind' in node && node.kind === 'connection') {
        picked.push((node as Extract<TreeNode, { kind: 'connection' }>).profile);
      }
    }
    return picked;
  }

  /** 붙여 넣을 자리 — 폴더 위면 그 폴더, 연결 위면 그 연결이 있는 폴더. */
  function pasteFolder(arg: unknown): string | undefined {
    const node = (arg ?? selectedNode()) as TreeNode | undefined;
    if (!node || typeof node !== 'object' || !('kind' in node)) {
      return undefined;
    }
    if (node.kind === 'group') {
      return node.path;
    }
    if (node.kind === 'connection') {
      return node.profile.folder;
    }
    return undefined;
  }

  /**
   * 프로필 하나를 복제한다.
   *
   * 비밀번호는 화면이나 클립보드를 거치지 않고 SecretStorage 안에서만 옮긴다 —
   * 복제본이 곧바로 접속되지 않으면 복사할 이유가 없고, 그렇다고 비밀번호를
   * 밖으로 꺼낼 이유도 없다.
   */
  async function duplicateProfile(
    source: ConnectionProfile,
    folder: string | undefined,
  ): Promise<ConnectionProfile> {
    const { id: _id, createdAt: _createdAt, ...rest } = source;
    const draft: ConnectionProfileDraft = {
      ...rest,
      // 중첩 객체는 새로 만든다 — 원본과 같은 객체를 가리키면 한쪽 수정이 양쪽에 번진다.
      tls: { ...source.tls },
      pool: { ...source.pool },
      oracle: source.oracle ? { ...source.oracle } : undefined,
      name: duplicateName(
        source.name,
        profiles.list().map((p) => p.name),
      ),
      folder,
    };
    const password = source.savePassword ? await profiles.getPassword(source.id) : undefined;
    return profiles.add(draft, password);
  }

  /**
   * 키보드로 부른 명령(F2 등)에는 트리 노드가 인자로 오지 않는다.
   * 그럴 때는 트리에서 지금 선택된 항목을 본다 — 눌렀을 때 반응해야 하는 대상은
   * 화면에서 선택돼 보이는 바로 그것이다.
   */
  function selectedNode(): TreeNode | undefined {
    return treeView.selection[0];
  }

  /** 트리에서 폴더 노드를 넘겨받았으면 그 경로. 아니면 undefined. */
  function folderPathOf(arg: unknown): string | undefined {
    const node = arg as TreeNode | undefined;
    return node && typeof node === 'object' && 'kind' in node && node.kind === 'group'
      ? node.path
      : undefined;
  }

  /** 폴더 이름 하나를 입력받는다 (경로 구분자 불가). */
  async function promptFolderName(
    title: string,
    value?: string,
  ): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      title,
      prompt: '연결을 묶을 폴더 이름',
      value,
      ignoreFocusOut: true,
      validateInput: (input) => validateFolderName(input),
    });
    return name?.trim() || undefined;
  }

  /** 연결을 옮길 폴더를 고르게 한다. 취소하면 undefined 를 돌려준다. */
  async function pickFolder(
    title: string,
    current: string | undefined,
  ): Promise<{ folder: string | undefined } | undefined> {
    interface FolderItem extends vscode.QuickPickItem {
      folder?: string;
      create?: boolean;
    }
    const items: FolderItem[] = [
      {
        label: '$(home) 최상위',
        description: current === undefined ? '현재 위치' : undefined,
      },
      ...profiles.folders().map(
        (path): FolderItem => ({
          label: `$(folder) ${path}`,
          folder: path,
          description: path === current ? '현재 위치' : undefined,
        }),
      ),
      { label: '$(new-folder) 새 폴더…', create: true },
    ];

    const picked = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true });
    if (!picked) {
      return undefined;
    }
    if (picked.create) {
      const name = await promptFolderName('새 폴더');
      if (!name) {
        return undefined;
      }
      const created = await profiles.createFolder(name);
      return { folder: created };
    }
    return { folder: picked.folder };
  }

  async function pickProfile(title: string): Promise<ConnectionProfile | undefined> {
    const all = profiles.list();
    if (all.length === 0) {
      void vscode.window.showInformationMessage('등록된 연결이 없습니다. 먼저 연결을 추가하세요.');
      return undefined;
    }
    if (all.length === 1) {
      return all[0];
    }
    const picked = await vscode.window.showQuickPick(
      all.map((profile) => ({
        label: profile.name,
        description: `${DIALECT_LABELS[profile.dialect]} · ${profile.host}:${profile.port}`,
        detail: connections.isConnected(profile.id) ? '$(check) 연결됨' : undefined,
        iconPath: profileIcon(extensionUri, profile, connections.isConnected(profile.id)),
        profile,
      })),
      { title, ignoreFocusOut: true },
    );
    return picked?.profile;
  }

  return [
    // ── 프로필 CRUD ─────────────────────────────────────────────────────────

    vscode.commands.registerCommand('dbconn.addConnection', async (arg: unknown) => {
      const result = await openConnectionForm(extensionUri);
      if (!result) {
        return;
      }
      // 폴더 노드에서 실행했으면 그 폴더 안에 만든다.
      const folder = folderPathOf(arg);
      const profile = await profiles.add(folder ? { ...result.draft, folder } : result.draft, result.password);
      const connect = await vscode.window.showInformationMessage(
        `"${profile.name}" 연결을 추가했습니다.`,
        '지금 연결',
      );
      if (connect === '지금 연결') {
        await connectProfile(profile);
      }
    }),

    /**
     * URL 한 줄로 연결 추가.
     *
     * 위키나 설정 파일에서 복사해 온 접속 문자열이 출발점일 때 칸을 하나씩
     * 채우게 하지 않는다. 파싱한 값으로 폼을 열어 주므로, 이름·환경처럼
     * URL 에 없는 것은 저장 전에 확인하고 고칠 수 있다.
     */
    vscode.commands.registerCommand('dbconn.addConnectionFromUrl', async (arg: unknown) => {
      const url = await vscode.window.showInputBox({
        title: 'URL 로 커넥션 추가',
        prompt: '연결 URL 을 붙여 넣으세요. 비밀번호가 들어 있으면 함께 저장됩니다.',
        placeHolder: 'postgresql://app@db.example.com:5432/orders',
        ignoreFocusOut: true,
        validateInput: (input) => {
          if (input.trim() === '') {
            return undefined; // 아직 입력 중.
          }
          const check = parseConnectionUrl(input);
          return check.ok ? undefined : check.error;
        },
      });
      if (!url) {
        return;
      }
      const parsed = parseConnectionUrl(url);
      if (!parsed.ok) {
        void vscode.window.showErrorMessage(parsed.error);
        return;
      }

      const result = await openConnectionForm(extensionUri, undefined, { initialUrl: url });
      if (!result) {
        return;
      }
      const folder = folderPathOf(arg);
      const profile = await profiles.add(
        folder ? { ...result.draft, folder } : result.draft,
        result.password,
      );
      const connect = await vscode.window.showInformationMessage(
        `"${profile.name}" 연결을 추가했습니다.`,
        '지금 연결',
      );
      if (connect === '지금 연결') {
        await connectProfile(profile);
      }
    }),

    /** 연결 정보를 URL 한 줄로 복사한다. 비밀번호는 절대 담기지 않는다. */
    vscode.commands.registerCommand('dbconn.copyConnectionUrl', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (!profile) {
        return;
      }
      const url = formatConnectionUrl({
        dialect: profile.dialect,
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        tlsEnabled: profile.tls.enabled,
        tlsVerify: profile.tls.rejectUnauthorized,
        oracleConnectType: profile.oracle?.connectType,
      });
      await vscode.env.clipboard.writeText(url);
      void vscode.window.setStatusBarMessage(
        '$(check) 연결 URL 을 복사했습니다 (비밀번호 제외).',
        3000,
      );
    }),

    vscode.commands.registerCommand('dbconn.editConnection', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (!profile) {
        return;
      }
      const result = await openConnectionForm(extensionUri, profile, {
        resolvePassword: () => profiles.getPassword(profile.id),
        // 폼이 떠 있는 동안 트리에서 폴더를 옮겼을 수 있다 — 저장은 지금 것 위에.
        resolveExisting: () => profiles.get(profile.id),
      });
      if (!result) {
        return;
      }
      // 폼은 창으로 떠 있으므로 그사이 이 연결이 지워졌을 수 있다.
      if (!profiles.get(profile.id)) {
        void vscode.window.showWarningMessage(
          `"${profile.name}" 연결이 삭제되어 변경 사항을 저장하지 않았습니다.`,
        );
        return;
      }
      // 설정이 바뀌면 기존 세션의 풀 설정과 어긋나므로 끊는다.
      const wasConnected = connections.isConnected(profile.id);
      if (wasConnected) {
        await connections.disconnect(profile.id);
      }
      catalog.invalidate(profile.id);
      const updated = await profiles.update(profile.id, result.draft, result.password);
      if (wasConnected) {
        await connectProfile(updated);
      }
    }),

    // eslint-disable-next-line @typescript-eslint/require-await -- 명령 시그니처를 맞춘다
    vscode.commands.registerCommand('dbconn.copyConnection', async (arg: unknown, many: unknown) => {
      const picked = connectionTargets(arg, many);
      if (picked.length === 0) {
        void vscode.window.showInformationMessage('복사할 연결을 트리에서 선택하세요.');
        return;
      }
      clipboard = picked;
      const what = picked.length === 1 ? `"${picked[0]!.name}"` : `연결 ${picked.length}개`;
      void vscode.window.setStatusBarMessage(`$(check) ${what} 복사 — Ctrl+V 로 붙여넣기`, 3000);
    }),

    vscode.commands.registerCommand('dbconn.pasteConnection', async (arg: unknown) => {
      if (clipboard.length === 0) {
        void vscode.window.showInformationMessage(
          '붙여 넣을 연결이 없습니다. 먼저 연결을 복사하세요 (Ctrl+C).',
        );
        return;
      }
      const folder = pasteFolder(arg);
      const created: ConnectionProfile[] = [];
      for (const source of clipboard) {
        // 순서대로 만든다 — 이름 중복 검사가 방금 만든 것까지 봐야 한다.
        created.push(await duplicateProfile(source, folder));
      }
      const where = folder ? ` → ${folder}` : '';
      const what =
        created.length === 1 ? `"${created[0]!.name}"` : `연결 ${created.length}개`;
      void vscode.window.setStatusBarMessage(`$(check) ${what} 붙여넣기${where}`, 3000);
    }),

    /**
     * Ctrl+C — 트리에서 고른 것을 복사한다.
     *
     * 연결이면 붙여넣기용으로 담고, 그 밖의 항목(테이블·컬럼…)이면 이름을 시스템
     * 클립보드로 보낸다. 같은 키가 항목에 따라 아무 일도 하지 않으면 고장으로 보인다.
     */
    vscode.commands.registerCommand('dbconn.copyTreeItem', async (arg: unknown, many: unknown) => {
      if (connectionTargets(arg, many).length > 0) {
        await vscode.commands.executeCommand('dbconn.copyConnection', arg, many);
        return;
      }
      await vscode.commands.executeCommand('dbconn.copyName', arg ?? selectedNode());
    }),

    /**
     * F2 — 트리에서 선택한 것의 이름을 바꾼다.
     *
     * 키 바인딩의 when 절에서 항목 종류(`viewItem`)로 연결과 폴더를 갈라 두면
     * 눌러도 아무 일이 없는 경우가 생긴다. 그래서 조건은 "연결 뷰에 초점이
     * 있는가" 하나로 두고, 무엇을 바꿀지는 선택된 노드를 보고 여기서 고른다.
     */
    vscode.commands.registerCommand('dbconn.renameTreeItem', async () => {
      const node = selectedNode();
      if (node?.kind === 'group') {
        await vscode.commands.executeCommand('dbconn.renameFolder', node);
        return;
      }
      if (node?.kind === 'connection') {
        await vscode.commands.executeCommand('dbconn.renameConnection', node);
        return;
      }
      void vscode.window.showInformationMessage(
        '이름을 바꿀 연결이나 폴더를 트리에서 선택하세요.',
      );
    }),

    vscode.commands.registerCommand('dbconn.renameConnection', async (arg: unknown) => {
      // 선택된 것이 연결일 때만 대신 쓴다. 테이블을 골라 둔 채 팔레트에서 부르면
      // 그 테이블이 속한 연결의 이름을 바꾸자고 나서는데, 그건 시킨 적 없는 일이다.
      const selected = selectedNode();
      const profile = await resolveProfile(
        arg ?? (selected?.kind === 'connection' ? selected : undefined),
      );
      if (!profile) {
        return;
      }
      const name = await vscode.window.showInputBox({
        title: '연결 이름 변경',
        prompt: '트리에 표시될 이름',
        value: profile.name,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : '이름을 입력하세요.'),
      });
      if (name === undefined || name.trim() === profile.name) {
        return;
      }
      await profiles.rename(profile.id, name);
      // 연결돼 있으면 상태바가 든 사본도 새 이름으로 바꾼다.
      connections.rename(profile.id, name.trim());
    }),

    vscode.commands.registerCommand('dbconn.deleteConnection', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (!profile) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `"${profile.name}" 연결을 삭제할까요?`,
        { modal: true, detail: '저장된 비밀번호도 함께 삭제됩니다.' },
        '삭제',
      );
      if (confirm !== '삭제') {
        return;
      }
      await connections.disconnect(profile.id);
      catalog.invalidate(profile.id);
      await profiles.remove(profile.id);
    }),

    // ── 폴더 ────────────────────────────────────────────────────────────────

    vscode.commands.registerCommand('dbconn.addFolder', async (arg: unknown) => {
      const parent = folderPathOf(arg);
      const name = await promptFolderName(parent ? `새 하위 폴더 — ${parent}` : '새 폴더');
      if (!name) {
        return;
      }
      const path = joinFolder(parent, name);
      if (!path) {
        return;
      }
      if (folderDepth(path) > MAX_FOLDER_DEPTH) {
        void vscode.window.showWarningMessage(
          `폴더는 ${MAX_FOLDER_DEPTH}단계까지만 만들 수 있습니다.`,
        );
        return;
      }
      await profiles.createFolder(path);
    }),

    vscode.commands.registerCommand('dbconn.renameFolder', async (arg: unknown) => {
      const path = folderPathOf(arg ?? selectedNode());
      if (!path) {
        return;
      }
      const name = await promptFolderName('폴더 이름 변경', folderName(path));
      if (!name || name === folderName(path)) {
        return;
      }
      const renamed = joinFolder(parentFolder(path), name);
      if (!renamed) {
        return;
      }
      try {
        await profiles.moveFolder(path, renamed);
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
      }
    }),

    vscode.commands.registerCommand('dbconn.deleteFolder', async (arg: unknown) => {
      const path = folderPathOf(arg);
      if (!path) {
        return;
      }
      const parent = parentFolder(path);
      const inside = profiles
        .list()
        .filter((profile) => profile.folder !== undefined && isWithinFolder(profile.folder, path));
      const confirm = await vscode.window.showWarningMessage(
        `"${folderName(path)}" 폴더를 삭제할까요?`,
        {
          modal: true,
          detail:
            inside.length > 0
              ? `연결 ${inside.length}개는 지워지지 않고 ${parent ? `"${folderName(parent)}"` : '최상위'} 로 이동합니다.`
              : '폴더만 사라집니다.',
        },
        '삭제',
      );
      if (confirm !== '삭제') {
        return;
      }
      await profiles.deleteFolder(path);
    }),

    vscode.commands.registerCommand('dbconn.moveToFolder', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (!profile) {
        return;
      }
      const picked = await pickFolder(`"${profile.name}" 을(를) 옮길 폴더`, profile.folder);
      if (!picked) {
        return;
      }
      await profiles.setProfileFolder(profile.id, picked.folder);
      void vscode.window.setStatusBarMessage(
        `$(check) ${profile.name} → ${picked.folder ?? '최상위'}`,
        2500,
      );
    }),

    vscode.commands.registerCommand('dbconn.testConnection', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (!profile) {
        return;
      }

      // 저장된 비밀번호가 없으면(저장 안 함 설정) 이번 테스트에만 쓸 값을 받는다.
      let password = await profiles.getPassword(profile.id);
      if (password === undefined) {
        password = await vscode.window.showInputBox({
          title: `${profile.name} — 비밀번호`,
          prompt: '연결 테스트에만 사용하고 저장하지 않습니다.',
          password: true,
          ignoreFocusOut: true,
        });
        if (password === undefined) {
          return;
        }
      }

      const { id: _id, createdAt: _createdAt, ...draft } = profile;
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${profile.name} 연결 테스트 중…`,
        },
        () => testConnection(draft, password, profile.connectTimeoutMs),
      );

      if (result.ok) {
        void vscode.window.showInformationMessage(`$(check) ${profile.name}: ${result.message}`);
      } else {
        const choice = await vscode.window.showErrorMessage(
          `${profile.name} 연결 테스트 실패: ${result.message}`,
          '연결 편집',
          '로그 보기',
        );
        if (choice === '연결 편집') {
          await vscode.commands.executeCommand('dbconn.editConnection', {
            kind: 'connection',
            profile,
          });
        } else if (choice === '로그 보기') {
          log.show();
        }
      }
    }),

    // ── 연결 / 해제 ─────────────────────────────────────────────────────────

    vscode.commands.registerCommand('dbconn.connect', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (profile) {
        await connectProfile(profile);
      }
    }),

    vscode.commands.registerCommand('dbconn.disconnect', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (!profile) {
        return;
      }
      const session = connections.get(profile.id);
      if (session && session.transactionState === 'active') {
        const choice = await vscode.window.showWarningMessage(
          `"${profile.name}" 에 커밋되지 않은 트랜잭션이 있습니다.`,
          { modal: true, detail: '연결을 끊으면 롤백됩니다.' },
          '커밋 후 해제',
          '롤백 후 해제',
        );
        if (choice === undefined) {
          return;
        }
        if (choice === '커밋 후 해제') {
          await session.commit();
        }
      }
      await connections.disconnect(profile.id);
      catalog.invalidate(profile.id);
    }),

    /**
     * 연결 선택 — 상태바를 누르거나 실행할 때 연결이 없으면 불린다.
     *
     * 편집기를 보고 있는 중이면 **그 편집기에 연결을 붙인다.** SQL 파일마다
     * 다른 DB 를 보는 것이 이 도구의 정상적인 사용 방식이라, 하나뿐인 활성
     * 연결을 바꾸는 것만으로는 창을 옮길 때마다 다시 골라야 한다.
     * 전역 기본값도 함께 옮겨 두어, 지정이 없는 편집기와 트리 명령이 따라온다.
     */
    vscode.commands.registerCommand('dbconn.setActiveConnection', async () => {
      const editorKey = connections.currentEditorKey();
      const bound = connections.boundProfileId(editorKey);

      const connected = profiles.list().filter((p) => connections.isConnected(p.id));
      if (connected.length === 0) {
        const profile = await pickProfile('연결할 대상 선택');
        if (profile && (await connectProfile(profile)) && editorKey) {
          connections.bindEditor(editorKey, profile.id);
        }
        return;
      }

      interface ConnectionItem extends vscode.QuickPickItem {
        profile?: ConnectionProfile;
        unbind?: boolean;
      }
      const items: ConnectionItem[] = connected.map((profile) => ({
        label: profile.name,
        description: `${DIALECT_LABELS[profile.dialect]} · ${profile.host}:${profile.port}`,
        detail: profile.id === bound ? '$(check) 이 편집기에 지정됨' : undefined,
        iconPath: profileIcon(extensionUri, profile, true),
        profile,
      }));
      if (bound) {
        items.push({
          label: '$(circle-slash) 이 편집기의 지정 해제',
          description: '전역 기본 연결을 따릅니다',
          unbind: true,
        });
      }

      const picked = await vscode.window.showQuickPick(items, {
        title: editorKey ? '이 편집기에서 사용할 연결' : '활성 연결 선택',
        ignoreFocusOut: true,
      });
      if (!picked) {
        return;
      }
      if (picked.unbind) {
        if (editorKey) {
          connections.bindEditor(editorKey, undefined);
        }
        return;
      }
      if (picked.profile) {
        connections.setActive(picked.profile.id);
        if (editorKey) {
          connections.bindEditor(editorKey, picked.profile.id);
        }
      }
    }),

    /**
     * 편집기 제목줄/문맥 메뉴에서 부르는 같은 기능.
     * 상태바를 거치지 않고 곧바로 이 파일의 연결을 정하고 싶을 때.
     */
    vscode.commands.registerCommand('dbconn.setEditorConnection', async () => {
      await vscode.commands.executeCommand('dbconn.setActiveConnection');
    }),

    vscode.commands.registerCommand('dbconn.refreshTree', async () => {
      const session = connections.activeSession();
      if (session) {
        await catalog.refresh(session).catch((error: unknown) => {
          log.warn('스키마 새로고침 실패', error);
        });
      }
      tree.refresh();
    }),

    // ── 쿼리 ────────────────────────────────────────────────────────────────

    /**
     * 새 SQL 편집기.
     *
     * 기본은 **파일로 만드는 것**이다. 이름 없는 문서는 창을 닫는 순간 사라져서
     * 초안 캐시가 그걸 되살리는 일을 떠맡고 있었는데, 애초에 파일로 두면 그
     * 문제가 없다. 파일은 확장의 보관 폴더에 만들어지고 잠시 뒤 자동 저장된다.
     * 예전처럼 이름 없는 문서로 열려면 `dbconn.scripts.newQueryLocation` 을
     * `untitled` 로 둔다.
     */
    vscode.commands.registerCommand('dbconn.newQuery', async (arg: unknown) => {
      const profile = await resolveProfile(arg);
      if (profile && !connections.isConnected(profile.id)) {
        await connectProfile(profile);
      } else if (profile) {
        connections.setActive(profile.id);
      }

      const document = await openNewQueryDocument(profile?.name);
      const editor = await vscode.window.showTextDocument(document);
      // 어느 연결에서 열었는지 이 편집기에 붙여 둔다. 나중에 다른 연결을
      // 활성으로 바꿔도 이 창의 쿼리는 여기서 열린 그 DB 로 나간다.
      //
      // 열지 못한 연결(비밀번호 입력 취소·접속 실패)에는 붙이지 않는다. 붙여 두면
      // 그 편집기는 아무 연결도 쓸 수 없는 상태로 남는다 — 실행도, 자동 완성도.
      if (profile && connections.isConnected(profile.id)) {
        connections.bindEditor(document.uri.toString(), profile.id);
      }
      // 커서를 본문 시작으로 옮긴다.
      const end = new vscode.Position(document.lineCount - 1, 0);
      editor.selection = new vscode.Selection(end, end);
    }),

    /**
     * 보관 폴더에 쌓인 쿼리 목록.
     *
     * "최근 SQL 편집기"는 최근에 **연** 파일을, 이쪽은 이 확장이 **만든** 파일
     * 전부를 보여준다. 한동안 열지 않았던 쿼리는 최근 목록에서 밀려나므로
     * 폴더를 그대로 훑을 길이 따로 있어야 한다.
     */
    vscode.commands.registerCommand('dbconn.openSavedQuery', async () => {
      const entries = await queries.list();
      if (entries.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          '보관된 쿼리가 없습니다. 새 SQL 편집기를 열면 여기에 쌓입니다.',
          '새 SQL 편집기',
        );
        if (choice === '새 SQL 편집기') {
          await vscode.commands.executeCommand('dbconn.newQuery');
        }
        return;
      }

      interface QueryItem extends vscode.QuickPickItem {
        entry: SavedQuery;
      }
      const toItems = (list: SavedQuery[]): QueryItem[] =>
        list.map((entry) => ({
          label: queryDisplayName(entry.name),
          description: `${formatWhen(entry.modifiedAt)} · ${formatSize(entry.size)}`,
          entry,
          buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: '삭제' }],
        }));

      const picker = vscode.window.createQuickPick<QueryItem>();
      picker.title = '보관된 쿼리';
      picker.placeholder = '열 쿼리를 고르세요 (삭제는 오른쪽 휴지통)';
      picker.matchOnDescription = true;
      picker.items = toItems(entries);

      picker.onDidTriggerItemButton(async (event) => {
        const confirm = await vscode.window.showWarningMessage(
          `"${queryDisplayName(event.item.entry.name)}" 을(를) 삭제할까요?`,
          { modal: true, detail: '휴지통으로 보냅니다.' },
          '삭제',
        );
        if (confirm !== '삭제') {
          return;
        }
        await queries.delete(event.item.entry.uri);
        const remaining = await queries.list();
        picker.items = toItems(remaining);
        if (remaining.length === 0) {
          picker.hide();
        }
      });
      picker.onDidAccept(async () => {
        const item = picker.selectedItems[0];
        picker.hide();
        if (item) {
          const document = await vscode.workspace.openTextDocument(item.entry.uri);
          await vscode.window.showTextDocument(document);
        }
      });
      picker.onDidHide(() => picker.dispose());
      picker.show();
    }),

    /** 보관 폴더를 파일 탐색기로 연다 — 백업하거나 통째로 옮길 때. */
    vscode.commands.registerCommand('dbconn.openQueryFolder', async () => {
      const folder = queries.folderUri();
      try {
        await vscode.workspace.fs.createDirectory(folder);
        await vscode.env.openExternal(folder);
      } catch (error) {
        log.warn('쿼리 폴더를 열지 못했습니다.', error);
        await vscode.env.clipboard.writeText(folder.fsPath);
        void vscode.window.showWarningMessage(
          `폴더를 열지 못했습니다. 경로를 클립보드에 복사했습니다: ${folder.fsPath}`,
        );
      }
    }),

    vscode.commands.registerCommand('dbconn.executeStatement', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await executor.executeAtCursor(editor);
    }),

    vscode.commands.registerCommand('dbconn.executeAll', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await executor.executeAll(editor);
    }),

    vscode.commands.registerCommand('dbconn.explainStatement', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await executor.explainAtCursor(editor, false);
    }),

    vscode.commands.registerCommand('dbconn.explainAnalyzeStatement', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      await executor.explainAtCursor(editor, true);
    }),

    /**
     * 결과 행 제한 바꾸기.
     *
     * 결과 툴바의 선택 상자와 같은 일을 하지만, 이쪽은 결과 패널을 열지 않고도
     * 부를 수 있다 — 큰 테이블을 건드리기 **전에** 제한부터 낮추는 것이
     * 이 설정을 만지는 가장 흔한 이유이기 때문이다.
     */
    vscode.commands.registerCommand('dbconn.setRowLimit', async () => {
      const current = vscode.workspace
        .getConfiguration('dbconn')
        .get<number>('execution.maxRows', 1000);

      interface LimitItem extends vscode.QuickPickItem {
        value?: number;
      }
      const items: LimitItem[] = [100, 200, 500, 1000, 5000, 10_000, 50_000].map((value) => ({
        label: value.toLocaleString(),
        description: value === current ? '현재 값' : undefined,
        value,
      }));
      items.push({ label: '$(edit) 직접 입력…' });

      const picked = await vscode.window.showQuickPick(items, {
        title: '한 번에 가져올 최대 행 수',
        ignoreFocusOut: true,
      });
      if (!picked) {
        return;
      }
      if (picked.value === undefined) {
        await results.promptRowLimit();
        return;
      }
      await results.setRowLimit(picked.value);
      void vscode.window.setStatusBarMessage(
        `$(check) 행 제한: ${picked.value.toLocaleString()}행`,
        2500,
      );
    }),

    vscode.commands.registerCommand('dbconn.cancelQuery', async () => {
      const session = connections.activeSession();
      if (!session) {
        return;
      }
      const cancelled = await session.cancelRunning();
      if (!cancelled) {
        void vscode.window.setStatusBarMessage('실행 중인 쿼리가 없습니다.', 2000);
      }
    }),

    vscode.commands.registerCommand('dbconn.selectTop', async (arg: unknown) => {
      const node = arg as TreeNode | undefined;
      if (!node || node.kind !== 'table') {
        return;
      }
      const session = connections.get(node.profileId);
      if (!session) {
        return;
      }
      connections.setActive(node.profileId);
      const driver = getDriver(session.profile.dialect);
      const sql = driver.buildPreviewQuery(node.table.schema, node.table.name, 200);

      // 트리에서 연 미리보기는 자체 묶음을 갖는다 — 편집기 결과를 밀어내지 않게.
      const sourceKey = 'dbconn:preview';
      results.beginRun(sourceKey);
      const tabId = results.beginQuery(
        sql,
        session.profile.name,
        session.profile.id,
        sourceKey,
        undefined,
        session.profile.environment,
      );
      const startedAt = Date.now();
      try {
        const config = vscode.workspace.getConfiguration('dbconn');
        const result = await session.execute(sql, {
          maxRows: Math.max(200, config.get<number>('execution.maxRows', 1000)),
          timeoutMs: config.get<number>('execution.queryTimeoutMs', 60_000),
        });
        await executor.attachEditSource(session, result, tabId);
        results.completeQuery(tabId, result);
        history.record({
          sql,
          profileId: session.profile.id,
          connectionName: session.profile.name,
          dialect: session.profile.dialect,
          origin: 'preview',
          startedAt,
          durationMs: result.durationMs,
          status: 'ok',
          rowCount: result.rowCount,
        });
      } catch (error) {
        results.failQuery(tabId, error);
        history.record({
          sql,
          profileId: session.profile.id,
          connectionName: session.profile.name,
          dialect: session.profile.dialect,
          origin: 'preview',
          startedAt,
          durationMs: Date.now() - startedAt,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
      }
    }),

    // ── 트랜잭션 ────────────────────────────────────────────────────────────

    vscode.commands.registerCommand('dbconn.toggleAutoCommit', async () => {
      const session = connections.activeSession();
      if (!session) {
        void vscode.window.showInformationMessage('활성 연결이 없습니다.');
        return;
      }
      const next = !session.autoCommit;

      if (next && session.transactionState === 'active') {
        const choice = await vscode.window.showWarningMessage(
          '자동 커밋으로 전환하기 전에 열린 트랜잭션을 정리해야 합니다.',
          { modal: true },
          '커밋',
          '롤백',
        );
        if (choice === undefined) {
          return;
        }
        await session.setAutoCommit(true, choice === '커밋' ? 'commit' : 'rollback');
      } else {
        await session.setAutoCommit(next);
      }
      void vscode.window.setStatusBarMessage(
        `커밋 모드: ${session.autoCommit ? '자동' : '수동'}`,
        2500,
      );
    }),

    vscode.commands.registerCommand('dbconn.commit', async () => {
      const session = connections.activeSession();
      if (!session) {
        return;
      }
      try {
        await session.commit();
        void vscode.window.setStatusBarMessage('$(check) 커밋했습니다.', 2500);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `커밋 실패: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),

    vscode.commands.registerCommand('dbconn.rollback', async () => {
      const session = connections.activeSession();
      if (!session) {
        return;
      }
      try {
        await session.rollback();
        void vscode.window.setStatusBarMessage('$(discard) 롤백했습니다.', 2500);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `롤백 실패: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),

    // ── 객체 상세 ───────────────────────────────────────────────────────────

    /**
     * 트리 항목 클릭. VS Code 에는 더블클릭 이벤트가 없어서, 같은 항목을
     * 짧은 간격으로 두 번 눌렀는지 여기서 직접 본다. 한 번 클릭은 펼치기만
     * 하고 아무 조회도 하지 않는다.
     *
     * 사용자가 목록 열기 방식을 이미 더블클릭으로 설정했다면(workbench.list.openMode)
     * VS Code 가 더블클릭에서만 이 명령을 보내므로 곧바로 연다.
     */
    vscode.commands.registerCommand('dbconn.treeItemActivate', async (arg: unknown) => {
      const node = arg as TreeNode | undefined;

      // 연결은 **더블클릭에서만** 접속한다. 한 번 클릭은 고르기일 뿐이다 —
      // 목록을 훑는 것만으로 운영 DB 에 세션이 열리면 안 된다.
      if (node && typeof node === 'object' && 'kind' in node && node.kind === 'connection') {
        if (connections.isConnected(node.profile.id)) {
          return;
        }
        if (!isSecondClick(`connection:${node.profile.id}`)) {
          return;
        }
        await connectProfile(node.profile);
        return;
      }

      const target = objectTargetOf(arg);
      if (!target) {
        return;
      }
      if (!isSecondClick(`${target.profileId}:${target.ref.schema}.${target.ref.name}`)) {
        return;
      }
      await details.show(target.profileId, target.ref);
    }),

    vscode.commands.registerCommand('dbconn.showObjectDetails', async (arg: unknown) => {
      const target = objectTargetOf(arg);
      if (!target) {
        void vscode.window.showInformationMessage(
          '상세 정보를 볼 테이블·뷰·시퀀스 등을 트리에서 선택하세요.',
        );
        return;
      }
      if (!connections.isConnected(target.profileId)) {
        const profile = profiles.get(target.profileId);
        if (profile) {
          await connectProfile(profile);
        }
      }
      await details.show(target.profileId, target.ref);
    }),

    // ── 실행 이력 ───────────────────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/require-await -- QuickPick 은 콜백으로 이어진다
    vscode.commands.registerCommand('dbconn.showQueryHistory', async () => {
      const entries = history.list();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('실행 이력이 없습니다.');
        return;
      }

      interface HistoryItem extends vscode.QuickPickItem {
        entry: QueryHistoryEntry;
      }
      const toItems = (list: QueryHistoryEntry[]): HistoryItem[] =>
        list.map((entry) => ({
          label: `${entry.status === 'error' ? '$(error) ' : ''}${historyLabel(entry.sql)}`,
          description: describeRun(entry),
          detail: entry.status === 'error' ? entry.error : entry.sql.split('\n')[0],
          entry,
          buttons: [
            { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'SQL 복사' },
            { iconPath: new vscode.ThemeIcon('trash'), tooltip: '이력에서 삭제' },
          ],
        }));

      const picker = vscode.window.createQuickPick<HistoryItem>();
      picker.title = '쿼리 실행 이력';
      picker.placeholder = '편집기에 넣을 쿼리를 고르세요 (복사 · 삭제는 오른쪽 아이콘)';
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.items = toItems(entries);

      picker.onDidTriggerItemButton(async (event) => {
        const isCopy = (event.button.tooltip ?? '').startsWith('SQL');
        if (isCopy) {
          await vscode.env.clipboard.writeText(event.item.entry.sql);
          void vscode.window.setStatusBarMessage('$(check) SQL 을 복사했습니다.', 2000);
          return;
        }
        await history.remove(event.item.entry.id);
        const remaining = history.list();
        picker.items = toItems(remaining);
        if (remaining.length === 0) {
          picker.hide();
        }
      });
      picker.onDidAccept(async () => {
        const item = picker.selectedItems[0];
        picker.hide();
        if (item) {
          await insertSql(item.entry.sql);
        }
      });
      picker.onDidHide(() => picker.dispose());
      picker.show();
    }),

    // eslint-disable-next-line @typescript-eslint/require-await -- 명령 시그니처를 맞춘다
    vscode.commands.registerCommand('dbconn.refreshHistory', async () => {
      historyTree.refresh();
    }),

    /** 이력 항목의 SQL 을 지금 편집기에 넣는다 (트리 클릭의 기본 동작). */
    vscode.commands.registerCommand('dbconn.history.insert', async (arg: unknown) => {
      const entry = historyEntryOf(arg);
      if (entry) {
        await insertSql(entry.sql);
      }
    }),

    /**
     * 이력 항목을 새 SQL 편집기로 연다.
     *
     * 그때 쓰던 연결을 그 편집기에 지정해 둔다 — 이력에서 꺼낸 쿼리를 엉뚱한
     * DB 에 대고 실행하는 것이 가장 조심할 지점이다.
     */
    vscode.commands.registerCommand('dbconn.history.openInEditor', async (arg: unknown) => {
      const entry = historyEntryOf(arg);
      if (!entry) {
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: entry.sql,
      });
      await vscode.window.showTextDocument(document);
      if (profiles.get(entry.profileId)) {
        connections.bindEditor(document.uri.toString(), entry.profileId);
      }
    }),

    vscode.commands.registerCommand('dbconn.history.copy', async (arg: unknown) => {
      const entry = historyEntryOf(arg);
      if (!entry) {
        return;
      }
      await vscode.env.clipboard.writeText(entry.sql);
      void vscode.window.setStatusBarMessage('$(check) SQL 을 복사했습니다.', 2000);
    }),

    vscode.commands.registerCommand('dbconn.history.remove', async (arg: unknown) => {
      const entry = historyEntryOf(arg);
      if (entry) {
        await history.remove(entry.id);
      }
    }),

    vscode.commands.registerCommand('dbconn.clearQueryHistory', async () => {
      const count = history.list().length;
      if (count === 0) {
        void vscode.window.showInformationMessage('실행 이력이 없습니다.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `실행 이력 ${count}건을 지울까요?`,
        { modal: true, detail: '되돌릴 수 없습니다.' },
        '지우기',
      );
      if (confirm !== '지우기') {
        return;
      }
      await history.clear();
      void vscode.window.setStatusBarMessage('$(check) 실행 이력을 지웠습니다.', 2500);
    }),

    // ── 스크립트 캐시 ───────────────────────────────────────────────────────

    /**
     * 최근 연 SQL 파일 목록.
     *
     * VS Code 의 "최근 항목 열기"와 겹쳐 보이지만 다르다 — 저기는 워크스페이스와
     * 온갖 파일이 섞여 있어서, 어제 쓰던 쿼리 하나를 찾는 데 쓰기 어렵다.
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- QuickPick 은 콜백으로 이어진다
    vscode.commands.registerCommand('dbconn.openRecentScript', async () => {
      const entries = recents.list();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage(
          '최근 연 SQL 파일이 없습니다. SQL 파일을 열면 여기에 쌓입니다.',
        );
        return;
      }

      interface RecentItem extends vscode.QuickPickItem {
        entry: RecentScriptEntry;
      }
      const toItems = (list: RecentScriptEntry[]): RecentItem[] =>
        list.map((entry) => ({
          label: entry.label,
          description: formatWhen(entry.usedAt),
          detail: entry.folder,
          entry,
          buttons: [{ iconPath: new vscode.ThemeIcon('close'), tooltip: '목록에서 제거' }],
        }));

      const picker = vscode.window.createQuickPick<RecentItem>();
      picker.title = '최근 연 SQL 편집기';
      picker.placeholder = '열 파일을 고르세요 (파일은 지워지지 않고 목록에서만 빠집니다)';
      picker.matchOnDetail = true;
      picker.items = toItems(entries);

      picker.onDidTriggerItemButton(async (event) => {
        await recents.remove(event.item.entry.uri);
        const remaining = recents.list();
        picker.items = toItems(remaining);
        if (remaining.length === 0) {
          picker.hide();
        }
      });
      picker.onDidAccept(async () => {
        const item = picker.selectedItems[0];
        picker.hide();
        if (item) {
          await recents.open(item.entry);
        }
      });
      picker.onDidHide(() => picker.dispose());
      picker.show();
    }),

    // eslint-disable-next-line @typescript-eslint/require-await -- QuickPick 은 콜백으로 이어진다
    vscode.commands.registerCommand('dbconn.openCachedScript', async () => {
      const entries = scripts.list();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('캐시된 SQL 초안이 없습니다.');
        return;
      }

      interface ScriptItem extends vscode.QuickPickItem {
        entry: ScriptCacheEntry;
      }
      const toItems = (list: ScriptCacheEntry[]): ScriptItem[] =>
        list.map((entry) => ({
          label: entry.label,
          description: `${formatWhen(entry.savedAt)} · ${entry.length.toLocaleString()}자`,
          detail: entry.untitled ? '저장한 적 없는 초안' : entry.uri,
          entry,
          buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: '캐시에서 삭제' }],
        }));

      const picker = vscode.window.createQuickPick<ScriptItem>();
      picker.title = '저장하지 않은 SQL 초안';
      picker.placeholder = '열 스크립트를 고르세요 (휴지통 아이콘으로 삭제)';
      picker.matchOnDetail = true;
      picker.items = toItems(entries);

      picker.onDidTriggerItemButton(async (event) => {
        await scripts.remove(event.item.entry.key);
        const remaining = scripts.list();
        picker.items = toItems(remaining);
        if (remaining.length === 0) {
          picker.hide();
        }
      });
      picker.onDidAccept(async () => {
        const item = picker.selectedItems[0];
        picker.hide();
        if (item) {
          await scripts.open(item.entry);
        }
      });
      picker.onDidHide(() => picker.dispose());
      picker.show();
    }),

    vscode.commands.registerCommand('dbconn.clearScriptCache', async () => {
      const count = scripts.list().length;
      if (count === 0) {
        void vscode.window.showInformationMessage('캐시된 SQL 초안이 없습니다.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `캐시된 SQL 초안 ${count}개를 지울까요?`,
        { modal: true, detail: '되돌릴 수 없습니다. 열려 있는 편집기는 그대로 남습니다.' },
        '지우기',
      );
      if (confirm !== '지우기') {
        return;
      }
      await scripts.clear();
      void vscode.window.setStatusBarMessage('$(check) SQL 초안 캐시를 비웠습니다.', 2500);
    }),

    // ── 진단 ────────────────────────────────────────────────────────────────

    vscode.commands.registerCommand('dbconn.copyName', async (arg: unknown) => {
      const node = arg as TreeNode | undefined;
      if (!node) {
        return;
      }
      const text =
        node.kind === 'group'
          ? node.path
          : node.kind === 'table'
            ? `${node.table.schema}.${node.table.name}`
            : node.kind === 'column'
              ? node.column.name
              : node.kind === 'schema'
                ? node.schema
                : node.kind === 'connection'
                  ? node.profile.name
                  : '';
      if (text) {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.setStatusBarMessage(`$(check) 복사: ${text}`, 2000);
      }
    }),

    // eslint-disable-next-line @typescript-eslint/require-await -- 명령 시그니처를 맞춘다
    vscode.commands.registerCommand('dbconn.showPoolStats', async () => {
      const all = profiles.list().filter((p) => connections.isConnected(p.id));
      if (all.length === 0) {
        void vscode.window.showInformationMessage('연결된 세션이 없습니다.');
        return;
      }
      const lines: string[] = ['커넥션 풀 상태', ''];
      for (const profile of all) {
        const session = connections.get(profile.id)!;
        const stats = session.stats();
        lines.push(
          `[${profile.name}]`,
          `  전체 ${stats.size} / 유휴 ${stats.idle} / 사용 중 ${stats.leased} / 대기 ${stats.pendingAcquires}`,
          `  누적 생성 ${stats.createdTotal}, 폐기 ${stats.destroyedTotal}`,
          `  좀비 회수 ${stats.zombiesReclaimed}, 획득 타임아웃 ${stats.acquireTimeouts}`,
          `  커밋 모드 ${session.autoCommit ? '자동' : '수동'}, 트랜잭션 ${session.transactionState}`,
          '',
        );
      }
      const report = lines.join('\n');
      log.info(report);
      log.show();
    }),

    vscode.commands.registerCommand('dbconn.showLog', () => {
      log.show();
    }),
  ];

  /** 이력 항목 한 줄 요약 — 시각 · 연결 · 소요 · 결과. */
  /**
   * 이력의 SQL 을 편집기로 가져온다.
   * SQL 편집기가 열려 있으면 커서 위치에 넣고, 없으면 새 편집기를 연다 —
   * 작업하던 문맥을 잃지 않는 쪽이 낫다.
   */
  async function insertSql(sql: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'sql') {
      await editor.edit((builder) => {
        builder.insert(editor.selection.active, sql.endsWith('\n') ? sql : `${sql}\n`);
      });
      return;
    }
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /** 목록에 보여줄 시각 — 오늘이면 시:분, 아니면 월-일 시:분. */
  function formatWhen(timestamp: number): string {
    const when = new Date(timestamp);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
    const today = new Date();
    const sameDay =
      when.getFullYear() === today.getFullYear() &&
      when.getMonth() === today.getMonth() &&
      when.getDate() === today.getDate();
    return sameDay ? time : `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
  }

  /**
   * 새 쿼리 문서를 만든다.
   *
   * 파일로 만들지 못하는 상황(권한·잠긴 폴더)에서도 편집기는 열려야 한다.
   * 그럴 때는 이름 없는 문서로 물러서고 이유를 알린다 — 쿼리를 쓰려던 사람을
   * 파일 시스템 오류 앞에 세워 두지 않는다.
   */
  async function openNewQueryDocument(
    connectionName: string | undefined,
  ): Promise<vscode.TextDocument> {
    const header =
      (connectionName ? `-- ${connectionName}\n` : '') +
      '-- Ctrl+Enter: 커서 위치의 쿼리 실행\n-- Ctrl+Shift+Enter: 전체 실행\n\n';

    const location = vscode.workspace
      .getConfiguration('dbconn')
      .get<string>('scripts.newQueryLocation', 'folder');

    if (location === 'folder') {
      try {
        const uri = await queries.create(connectionName, header);
        return await vscode.workspace.openTextDocument(uri);
      } catch (error) {
        log.warn('쿼리 파일을 만들지 못했습니다 — 이름 없는 문서로 엽니다.', error);
        void vscode.window.showWarningMessage(
          `쿼리 파일을 만들지 못해 이름 없는 문서로 엽니다: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return vscode.workspace.openTextDocument({ language: 'sql', content: header });
  }

  /** 파일 크기를 사람이 읽는 단위로. */
  function formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /** 연결하고 성공 여부를 돌려준다. 실패는 여기서 안내까지 마친다. */
  async function connectProfile(profile: ConnectionProfile): Promise<boolean> {
    try {
      const session = await connections.connect(profile);
      if (!session) {
        return false;
      }
      // 연결 직후 스키마를 미리 읽어 두면 첫 자동 완성이 즉시 뜬다.
      //
      // 단, **운영 연결에서는 하지 않는다.** 카탈로그 조회는 공짜가 아니다 —
      // MySQL/MariaDB 의 information_schema 는 스키마의 테이블을 전부 열어 보게
      // 만들고, 그동안 다른 세션이 밀린다. 붙자마자 그 부하를 주는 것은
      // 사용자가 시킨 적 없는 일이다. 자동 완성을 부르거나 트리를 펼치면
      // 그때 읽으므로 기능이 사라지지는 않는다.
      if (isProduction(profile.environment)) {
        log.info(`[${profile.name}] 운영 연결 — 스키마 미리 읽기를 건너뜁니다.`);
      } else {
        void catalog.refresh(session).catch((error: unknown) => {
          log.debug('초기 스키마 로딩 실패', error);
        });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[${profile.name}] 연결 실패: ${message}`);
      const choice = await vscode.window.showErrorMessage(
        `"${profile.name}" 연결 실패: ${message}`,
        '설정 편집',
        '로그 보기',
      );
      if (choice === '설정 편집') {
        await vscode.commands.executeCommand('dbconn.editConnection', {
          kind: 'connection',
          profile,
        });
      } else if (choice === '로그 보기') {
        log.show();
      }
      return false;
    }
  }
}
