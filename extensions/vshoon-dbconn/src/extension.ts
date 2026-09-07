import * as vscode from 'vscode';
import { createDbconnApi, type DbconnApi } from './api';
import { ProfileStore } from './config/profileStore';
import { ConnectionManager } from './db/connectionManager';
import { registerCommands } from './features/commands';
import { SqlCompletionProvider } from './features/completion';
import { QueryExecutor } from './features/execute';
import { QueryHistory } from './features/queryHistory';
import { RowEditService } from './features/rowEditService';
import { RecentScripts } from './features/recentScripts';
import { QueryStore } from './features/queryStore';
import { ScriptCache } from './features/scriptCache';
import { CatalogCache } from './metadata/catalog';
import { log } from './util/logger';
import { ConnectionTreeProvider, type TreeNode } from './views/connectionTree';
import { QueryHistoryTreeProvider, type HistoryNode } from './views/historyTree';
import { ObjectDetailsPanel } from './views/objectDetailsPanel';
import { ResultsPanel } from './views/resultsPanel';
import { StatusBar } from './views/statusBar';

/**
 * 확장 진입점.
 *
 * 여기서 중요한 건 조립 순서보다 **해체 순서**다. deactivate 에서
 * 커넥션 매니저의 종료를 반드시 기다려야, 열린 트랜잭션이 롤백되고
 * 서버 쪽 세션이 남지 않는다. VS Code 는 deactivate 가 돌려주는
 * Promise 를 기다려 주므로 그 계약을 그대로 쓴다.
 */

let connections: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): DbconnApi {
  log.init();
  log.info('DBConn 활성화');

  const profiles = new ProfileStore(context);
  // 편집기별 연결 지정은 워크스페이스에 남긴다 — 창을 닫았다 열어도 같은 파일이
  // 같은 DB 를 가리켜야 하고, 다른 워크스페이스로 새어 나가면 안 된다.
  const manager = new ConnectionManager(profiles, context.workspaceState);
  connections = manager;

  const catalog = new CatalogCache();
  const history = new QueryHistory(context);
  const rowEditService = new RowEditService(manager, history);
  const results = new ResultsPanel(context.extensionUri, rowEditService);
  const executor = new QueryExecutor(manager, results, catalog, history);
  // 페이지 이동·서버 정렬은 실행기가 처리한다 (결과 패널은 화면만 담당).
  results.setPager(executor);

  const tree = new ConnectionTreeProvider(context.extensionUri, profiles, manager, catalog);
  const treeView = vscode.window.createTreeView<TreeNode>('dbconn.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
    // 연결을 폴더로 끌어다 놓아 정리할 수 있게 한다.
    dragAndDropController: tree,
    canSelectMany: true,
  });
  const historyTree = new QueryHistoryTreeProvider(history);
  const historyView = vscode.window.createTreeView<HistoryNode>('dbconn.history', {
    treeDataProvider: historyTree,
    showCollapseAll: true,
  });
  const details = new ObjectDetailsPanel(context.extensionUri, manager, catalog);
  const scripts = new ScriptCache(context);
  scripts.activate();
  // 새 SQL 편집기를 파일로 만들고, 그 폴더의 파일을 자동 저장한다.
  const queries = new QueryStore(context);
  queries.activate();
  const recents = new RecentScripts(context);
  recents.activate();
  const statusBar = new StatusBar(manager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewType, results, {
      // 패널을 숨겼다 다시 열어도 결과가 남아 있게 한다.
      webviewOptions: { retainContextWhenHidden: true },
    }),

    treeView,
    historyView,

    // Ctrl+Space 는 등록만 하면 동작한다. 트리거 문자는 `.` 만 추가한다 —
    // 공백을 트리거로 넣으면 타이핑 중 팝업이 계속 튀어나와 방해가 된다.
    //
    // 스킴으로 거르지 않는다. 예전에는 `file` 과 `untitled` 만 받았는데, 확장의
    // 전역 저장소에 만든 쿼리 파일은 `vscode-userdata` 스킴으로 열린다 — 그래서
    // 그 파일에서만 자동 완성이 통째로 조용히 죽었다. SQL 문서면 어디 있든 돕는다.
    vscode.languages.registerCompletionItemProvider(
      { language: 'sql' },
      new SqlCompletionProvider(manager, catalog),
      '.',
    ),

    ...registerCommands({
      extensionUri: context.extensionUri,
      profiles,
      connections: manager,
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
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dbconn.log.level')) {
        log.applyConfig();
      }
      if (event.affectsConfiguration('dbconn.metadata.cacheTtlMs')) {
        catalog.clear();
      }
      // 설정에서 행 제한을 바꿔도 결과 툴바가 같은 값을 보여야 한다.
      if (
        event.affectsConfiguration('dbconn.execution.maxRows') ||
        event.affectsConfiguration('dbconn.execution.autoLoadMore')
      ) {
        results.refreshSettings();
      }
      if (event.affectsConfiguration('dbconn.history')) {
        historyTree.refresh();
      }
    }),

    // 해체 순서: 위쪽(UI)부터, 커넥션은 deactivate 에서 마지막에.
    statusBar,
    tree,
    historyTree,
    history,
    results,
    details,
    scripts,
    queries,
    recents,
    catalog,
    executor,
    profiles,
    log,
  );

  // 이전 세션에서 남은 초안 알림은 명령 등록이 끝난 뒤에 — 사용자가
  // "목록 보기"를 누르면 곧바로 명령이 실행되기 때문이다.
  void scripts.promptRestore();

  // 다른 확장이 연결 목록을 읽을 수 있게 한다. 프로필 변경과 접속 상태
  // 변경은 서로 다른 곳에서 나므로 하나의 이벤트로 합쳐 내보낸다 —
  // 소비자가 두 군데를 구독할 이유가 없다.
  const apiChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    apiChange,
    profiles.onDidChange(() => apiChange.fire()),
    manager.onDidChange(() => apiChange.fire()),
  );

  return createDbconnApi({
    listProfiles: () => profiles.list(),
    isConnected: (profileId) => manager.isConnected(profileId),
    onDidChange: apiChange.event,
  });
}

/**
 * VS Code 는 이 Promise 를 기다린다.
 * 여기서 풀을 닫아야 서버에 좀비 세션이 남지 않는다.
 */
export async function deactivate(): Promise<void> {
  log.info('DBConn 비활성화 — 커넥션 정리 중');
  const manager = connections;
  connections = undefined;
  await manager?.dispose();
  log.info('DBConn 정리 완료');
}
