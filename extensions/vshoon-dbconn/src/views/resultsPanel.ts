import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { CellValue, ConnectionEnvironment, EditSource, QueryResult } from '../types';
import { environmentBadge } from '../config/environment';
import { toCsvField } from '../db/serialize';
import type { RowEditService } from '../features/rowEditService';
import { log } from '../util/logger';

/**
 * 하단 패널의 쿼리 결과 뷰.
 *
 * 보안 관점에서 웹뷰는 확장에서 가장 위험한 표면이다. DB 에서 읽어온 값이
 * 그대로 DOM 에 들어가므로, 셀에 `<img onerror=…>` 같은 값이 있으면
 * 곧바로 웹뷰 컨텍스트에서 스크립트가 실행된다. 그래서:
 *
 *  - CSP 로 인라인 스크립트를 nonce 로만 허용하고 외부 로딩을 전부 막는다.
 *  - 데이터는 HTML 로 조립하지 않고 postMessage 로 보낸 뒤
 *    클라이언트에서 textContent 로만 넣는다 (innerHTML 을 쓰지 않는다).
 *  - 웹뷰에서 오는 메시지는 전부 검증한다.
 *
 * 탭 관리 규칙:
 *  한 편집기(문서)는 결과 탭 묶음 하나를 갖는다. 같은 문서에서 다시 실행하면
 *  이전 결과를 대체한다 — 같은 쿼리를 반복 실행할 때 탭이 무한정 쌓이지 않게.
 *  남겨 두고 비교하고 싶은 결과는 압정(📌)으로 고정하면 대체되지 않는다.
 */

/**
 * 페이징 상태.
 *
 * 첫 실행은 사용자가 쓴 SQL 을 그대로 돌린 결과다. 다음 쪽부터는 원본을
 * 파생 테이블로 감싸 OFFSET 을 건다(sql/paging.ts). 그래서 여기에 원본 SQL 을
 * 들고 있어야 한다 — 감싼 쿼리를 다시 감싸면 안 되기 때문이다.
 */
export interface ResultPage {
  /** 페이징의 기준이 되는 원본 SELECT. */
  sql: string;
  offset: number;
  pageSize: number;
  /** 다음 쪽이 있는지 (한 행 더 요청해서 확인한다). */
  hasMore: boolean;
  /** 서버 측 정렬 상태. 없으면 원래 순서. */
  sort?: { index: number; dir: 'asc' | 'desc' };
  /**
   * 스크롤로 이어 붙이기를 멈춘 상태인지.
   *
   * 한도에 닿았거나 이어 붙이다 실패했을 때 켜진다. 켜져 있으면 그리드가
   * 바닥에 닿아도 자동으로 더 부르지 않는다 — 실패한 요청을 스크롤할 때마다
   * 다시 던지면 오류 알림만 쌓인다. 사용자가 직접 누르면 다시 시도한다.
   */
  autoPaused?: boolean;
}

/**
 * 페이지 재조회를 실제로 수행하는 쪽 (QueryExecutor).
 * 결과 패널은 화면일 뿐이라 직접 쿼리를 돌리지 않는다.
 */
export interface ResultPager {
  runPage(
    tab: ResultTab,
    request: {
      offset: number;
      sort?: { index: number; dir: 'asc' | 'desc' };
      /** 결과를 갈아 끼우지 않고 지금 행 뒤에 이어 붙인다 (무한 스크롤). */
      append?: boolean;
    },
  ): Promise<void>;
}

export interface ResultTab {
  id: string;
  title: string;
  sql: string;
  connectionName: string;
  profileId: string;
  /** 연결 환경 — 결과 패널에서도 운영임을 알 수 있어야 한다. */
  environment: ConnectionEnvironment;
  /** 이 결과를 만든 편집기 문서. 같은 값이면 다음 실행 때 대체된다. */
  sourceKey: string;
  /** 고정된 탭은 대체·자동 정리 대상에서 빠진다. */
  pinned: boolean;
  result?: QueryResult;
  /** 실행 계획 탭이면 계획 텍스트. 결과 그리드 대신 이걸 보여준다. */
  plan?: { text: string; note?: string; durationMs: number };
  /** 페이징이 가능한 SELECT 결과면 현재 쪽 정보. */
  page?: ResultPage;
  /** 스크롤로 다음 묶음을 가져오는 중인지. 그리드는 그대로 두고 표시만 바뀐다. */
  loadingMore?: boolean;
  error?: string;
  startedAt: number;
  state: 'running' | 'done' | 'error';
}

type OutboundMessage = {
  type: 'tabs';
  tabs: SerializedTab[];
  activeId: string | undefined;
  /** 지금 적용 중인 행 제한 — 툴바의 선택 상자가 이 값을 보여준다. */
  rowLimit: number;
  /** 바닥까지 스크롤하면 자동으로 이어 조회할지. */
  autoLoadMore: boolean;
};

interface SerializedEdit {
  /** 값을 고칠 수 있는 결과 컬럼 인덱스. */
  columns: number[];
  /** 기본 키 컬럼 인덱스 — 그리드에서 자물쇠 표시에 쓴다. */
  keyColumns: number[];
  table: string;
}

interface SerializedTab {
  id: string;
  title: string;
  sql: string;
  connectionName: string;
  /** 운영/스테이징이면 꼬리표 문자열, 개발이면 없음. */
  environmentBadge?: string;
  pinned: boolean;
  state: ResultTab['state'];
  error?: string;
  columns?: { name: string; typeName: string }[];
  rows?: CellValue[][];
  rowCount?: number;
  affectedRows?: number;
  truncated?: boolean;
  durationMs?: number;
  messages?: string[];
  edit?: SerializedEdit;
  plan?: { text: string; note?: string };
  page?: {
    offset: number;
    pageSize: number;
    hasMore: boolean;
    sort?: ResultPage['sort'];
    /** 지금 화면에 쌓여 있는 행 수 (이어 조회로 늘어난다). */
    loaded: number;
    loadingMore: boolean;
    autoPaused: boolean;
  };
}

export class ResultsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'dbconn.results';

  private view: vscode.WebviewView | undefined;
  private pager: ResultPager | undefined;
  private readonly tabs: ResultTab[] = [];
  private activeTabId: string | undefined;
  /** 고정되지 않은 탭의 상한 — 오래된 것부터 버려 메모리를 지킨다. */
  private readonly maxUnpinnedTabs = 12;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly editService: RowEditService,
  ) {}

  /** 페이지 재조회 담당자를 연결한다 (조립 순서상 생성자에서 받을 수 없다). */
  setPager(pager: ResultPager): void {
    this.pager = pager;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // 확장의 media 폴더 외에는 어떤 로컬 자원도 읽지 못하게 한다.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });

    this.postTabs();
  }

  /**
   * 실행 묶음을 시작한다. 같은 문서의 고정되지 않은 이전 결과를 비운다.
   * 문서 하나가 결과 탭 묶음 하나를 갖게 하는 핵심 지점.
   */
  beginRun(sourceKey: string): void {
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      const tab = this.tabs[i]!;
      if (tab.sourceKey === sourceKey && !tab.pinned) {
        this.tabs.splice(i, 1);
      }
    }
  }

  /** 구문 하나의 실행을 시작하며 탭을 만든다. */
  beginQuery(
    sql: string,
    connectionName: string,
    profileId: string,
    sourceKey: string,
    /** 탭 제목 앞에 붙일 표시 (예: 실행 계획). */
    titlePrefix?: string,
    environment: ConnectionEnvironment = 'development',
  ): string {
    const id = randomBytes(8).toString('hex');
    const tab: ResultTab = {
      id,
      title: titlePrefix ? `${titlePrefix} ${makeTitle(sql)}` : makeTitle(sql),
      sql,
      connectionName,
      profileId,
      environment,
      sourceKey,
      pinned: false,
      startedAt: Date.now(),
      state: 'running',
    };
    // 같은 실행 묶음 안에서는 구문 순서대로 왼쪽부터 놓이도록 뒤에 붙인다.
    const insertAt = this.tabs.findIndex((t) => t.sourceKey !== sourceKey);
    if (insertAt === -1) {
      this.tabs.push(tab);
    } else {
      this.tabs.splice(insertAt, 0, tab);
    }

    this.trimUnpinned();
    this.activeTabId = id;
    void this.reveal();
    this.postTabs();
    return id;
  }

  completeQuery(id: string, result: QueryResult, page?: ResultPage): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    tab.result = result;
    tab.state = 'done';
    if (page) {
      tab.page = page;
    }
    this.postTabs();
  }

  /**
   * 다음 묶음을 이어 붙이기 시작한다.
   *
   * beginReload 와 달리 탭 상태를 running 으로 바꾸지 않는다 — 그러면 그리드가
   * "실행 중…" 자리표시자로 바뀌면서 보고 있던 위치와 선택이 통째로 사라진다.
   */
  beginAppend(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    tab.loadingMore = true;
    this.postTabs();
  }

  /**
   * 가져온 묶음을 지금 결과 뒤에 붙인다.
   *
   * 행만 늘어나므로 컬럼·편집 판정은 그대로 둔다. 같은 쿼리의 이어진 부분이라
   * 다시 판정할 이유가 없고, 다시 하면 편집 가능하던 그리드가 도중에 읽기 전용으로
   * 바뀔 수도 있다.
   */
  appendRows(
    id: string,
    rows: CellValue[][],
    hasMore: boolean,
    /** 요청을 보낼 때의 쪽 상태. 그사이 화면이 달라졌으면 이 묶음은 버린다. */
    expected: { offset: number; loaded: number },
  ): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    tab.loadingMore = false;
    if (!tab.result || !tab.page) {
      return;
    }
    // 이어 붙이는 동안 다른 쪽으로 옮겨 갔거나 결과가 갈아 끼워졌을 수 있다.
    // 그때 그대로 붙이면 화면에 다른 구간의 행이 섞인다.
    if (tab.page.offset !== expected.offset || tab.result.rows.length !== expected.loaded) {
      this.postTabs();
      return;
    }
    tab.result.rows.push(...rows);
    tab.result.rowCount = tab.result.rows.length;
    tab.page.hasMore = hasMore;
    this.postTabs();
  }

  /**
   * 이어 붙이기가 실패했을 때. 이미 보고 있는 행은 그대로 두고 자동 조회만 멈춘다 —
   * 스크롤할 때마다 같은 오류를 다시 내면 알림만 쌓인다.
   */
  failAppend(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    tab.loadingMore = false;
    if (tab.page) {
      tab.page.autoPaused = true;
    }
    this.postTabs();
  }

  /** 같은 탭을 다시 채우는 동안(페이지 이동·정렬) 진행 중임을 보여준다. */
  beginReload(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    tab.state = 'running';
    this.postTabs();
  }

  /** 실행 계획을 탭에 채운다. */
  completePlan(id: string, plan: { text: string; note?: string; durationMs: number }): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    tab.plan = plan;
    tab.state = 'done';
    this.postTabs();
  }

  /**
   * 나중에 알아낸 편집 가능 정보를 탭에 붙인다.
   * (결과를 먼저 보여 주고 카탈로그가 도착한 뒤 판정하는 경로)
   */
  setEditSource(id: string, source: EditSource): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab?.result || tab.result.editSource) {
      return;
    }
    tab.result.editSource = source;
    this.postTabs();
  }

  failQuery(id: string, error: unknown): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    tab.error = error instanceof Error ? error.message : String(error);
    tab.state = 'error';
    this.postTabs();
  }

  /** 고정되지 않은 탭이 너무 많이 쌓이지 않게 오래된 것부터 버린다. */
  private trimUnpinned(): void {
    let unpinned = this.tabs.filter((t) => !t.pinned).length;
    for (let i = this.tabs.length - 1; i >= 0 && unpinned > this.maxUnpinnedTabs; i--) {
      if (!this.tabs[i]!.pinned) {
        this.tabs.splice(i, 1);
        unpinned--;
      }
    }
  }

  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(/* preserveFocus */ true);
      return;
    }
    // 패널이 아직 만들어지지 않았으면 VS Code 에 열어 달라고 한다.
    await vscode.commands.executeCommand('dbconn.results.focus');
  }

  private postTabs(): void {
    const config = vscode.workspace.getConfiguration('dbconn');
    const message: OutboundMessage = {
      type: 'tabs',
      tabs: this.tabs.map((tab) => serializeTab(tab)),
      activeId: this.activeTabId,
      rowLimit: config.get<number>('execution.maxRows', 1000),
      autoLoadMore: config.get<boolean>('execution.autoLoadMore', true),
    };
    void this.view?.webview.postMessage(message);
  }

  /** 설정이 밖에서 바뀌었을 때 툴바 표시를 맞춘다. */
  refreshSettings(): void {
    this.postTabs();
  }

  /** 지금 보고 있는 탭. 행 제한 변경처럼 "활성 결과"를 대상으로 하는 명령이 쓴다. */
  activeTab(): ResultTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId);
  }

  // ── 웹뷰 → 확장 ───────────────────────────────────────────────────────────

  private async handleMessage(message: unknown): Promise<void> {
    // 웹뷰가 보내는 것은 신뢰하지 않는다 — 모양을 먼저 확인한다.
    if (!message || typeof message !== 'object') {
      return;
    }
    const { type } = message as { type?: unknown };
    if (typeof type !== 'string') {
      return;
    }
    const id = (message as { id?: unknown }).id;
    const tab = typeof id === 'string' ? this.tabs.find((t) => t.id === id) : undefined;

    switch (type) {
      case 'selectTab': {
        if (tab) {
          this.activeTabId = tab.id;
        }
        return;
      }

      case 'closeTab': {
        if (!tab) {
          return;
        }
        const index = this.tabs.indexOf(tab);
        this.tabs.splice(index, 1);
        if (this.activeTabId === tab.id) {
          this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id;
        }
        this.postTabs();
        return;
      }

      case 'togglePin': {
        if (!tab) {
          return;
        }
        tab.pinned = !tab.pinned;
        this.postTabs();
        return;
      }

      case 'copy': {
        const text = (message as { text?: unknown }).text;
        if (typeof text === 'string' && text.length <= 10_000_000) {
          await vscode.env.clipboard.writeText(text);
          void vscode.window.setStatusBarMessage('$(check) 클립보드에 복사했습니다.', 2000);
        }
        return;
      }

      case 'exportCsv':
        await this.exportCsv(tab);
        return;

      case 'exportJson':
        await this.exportJson(tab);
        return;

      case 'openSql': {
        if (!tab) {
          return;
        }
        const doc = await vscode.workspace.openTextDocument({
          language: 'sql',
          content: tab.sql,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }

      case 'page': {
        await this.handlePage(tab, message);
        return;
      }

      case 'sortServer': {
        await this.handleServerSort(tab, message);
        return;
      }

      case 'setRowLimit': {
        await this.handleSetRowLimit(message);
        return;
      }

      case 'promptRowLimit': {
        await this.promptRowLimit();
        return;
      }

      case 'updateCell':
        await this.handleUpdateCell(tab, message);
        return;

      case 'deleteRow':
        await this.handleDeleteRow(tab, message);
        return;

      case 'insertRow':
        await this.handleInsertRow(tab, message);
        return;

      default:
        log.debug(`알 수 없는 웹뷰 메시지: ${type}`);
    }
  }

  // ── 페이징 · 서버 정렬 ────────────────────────────────────────────────────

  private async handlePage(tab: ResultTab | undefined, message: unknown): Promise<void> {
    const page = tab?.page;
    if (!tab || !page || !this.pager) {
      return;
    }
    const direction = (message as { direction?: unknown }).direction;
    // 이어 조회로 쌓인 만큼을 세야 "다음 쪽"이 건너뛰거나 겹치지 않는다.
    const loaded = tab.result?.rows.length ?? 0;
    let offset = page.offset;

    if (direction === 'more') {
      await this.handleLoadMore(tab, page, (message as { auto?: unknown }).auto === true);
      return;
    }
    if (direction === 'next') {
      if (!page.hasMore) {
        return;
      }
      offset = page.offset + Math.max(loaded, page.pageSize);
    } else if (direction === 'prev') {
      offset = Math.max(0, page.offset - page.pageSize);
    } else if (direction === 'first') {
      offset = 0;
    } else if (direction !== 'reload') {
      return;
    }
    await this.pager.runPage(tab, { offset, sort: page.sort });
  }

  /**
   * 바닥에 닿았을 때 다음 묶음을 이어 붙인다.
   *
   * 자동 요청에는 상한을 둔다. 수십만 행을 스크롤만으로 웹뷰에 쌓으면 확장
   * 호스트가 아니라 편집기 창이 먼저 죽는다. 직접 누른 요청(auto=false)은
   * 본인이 감수하겠다는 뜻이므로 상한에 걸리지 않는다.
   */
  private async handleLoadMore(tab: ResultTab, page: ResultPage, auto: boolean): Promise<void> {
    if (!this.pager || !page.hasMore || tab.loadingMore || tab.state === 'running') {
      return;
    }
    const loaded = tab.result?.rows.length ?? 0;
    if (auto) {
      if (page.autoPaused) {
        return;
      }
      const limit = vscode.workspace
        .getConfiguration('dbconn')
        .get<number>('execution.maxLoadedRows', 50_000);
      if (limit > 0 && loaded >= limit) {
        page.autoPaused = true;
        this.postTabs();
        return;
      }
    } else {
      // 직접 눌렀으면 멈춰 있던 자동 조회도 다시 살린다.
      page.autoPaused = false;
    }
    await this.pager.runPage(tab, { offset: page.offset + loaded, sort: page.sort, append: true });
  }

  /**
   * 툴바에서 행 제한을 바꿨다.
   *
   * 설정에 저장해 다음 실행부터 적용되게 하고, 지금 보고 있는 결과도 새 크기로
   * 다시 읽는다 — 숫자만 바뀌고 화면은 그대로면 바꾼 것 같지 않다.
   */
  private async handleSetRowLimit(message: unknown): Promise<void> {
    const raw = (message as { value?: unknown }).value;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return;
    }
    await this.setRowLimit(Math.min(1_000_000, Math.max(1, Math.floor(raw))));
  }

  /**
   * 목록에 없는 값을 직접 받는다. 웹뷰에는 prompt 가 없어서 확장이 대신 묻는다.
   */
  async promptRowLimit(): Promise<void> {
    const current = vscode.workspace
      .getConfiguration('dbconn')
      .get<number>('execution.maxRows', 1000);
    const typed = await vscode.window.showInputBox({
      title: '결과 행 제한',
      prompt: '한 번에 가져올 최대 행 수 (1 – 1,000,000)',
      value: String(current),
      ignoreFocusOut: true,
      validateInput: (input) => {
        const value = Number(input);
        return Number.isInteger(value) && value >= 1 && value <= 1_000_000
          ? undefined
          : '1 이상 1,000,000 이하의 정수를 입력하세요.';
      },
    });
    if (typed === undefined) {
      return;
    }
    await this.setRowLimit(Number(typed));
  }

  /**
   * 행 제한을 바꾸고 열려 있는 결과에 반영한다.
   * 활성 탭은 보고 있던 쪽을 새 크기로 다시 읽고, 나머지는 다음 이동부터 적용된다.
   */
  async setRowLimit(value: number): Promise<void> {
    await vscode.workspace
      .getConfiguration('dbconn')
      .update('execution.maxRows', value, vscode.ConfigurationTarget.Global);

    for (const tab of this.tabs) {
      if (tab.page) {
        tab.page.pageSize = value;
        tab.page.autoPaused = false;
      }
    }
    const active = this.activeTab();
    if (active?.page && this.pager) {
      await this.pager.runPage(active, { offset: active.page.offset, sort: active.page.sort });
      return;
    }
    this.postTabs();
  }

  private async handleServerSort(tab: ResultTab | undefined, message: unknown): Promise<void> {
    const page = tab?.page;
    if (!tab || !page || !this.pager) {
      return;
    }
    const { column, dir } = message as { column?: unknown; dir?: unknown };
    const columnCount = tab.result?.columns.length ?? 0;

    // 정렬 해제.
    if (column === null || column === undefined) {
      await this.pager.runPage(tab, { offset: 0 });
      return;
    }
    if (!isIndex(column) || column >= columnCount) {
      return;
    }
    const direction = dir === 'desc' ? 'desc' : 'asc';
    // 정렬이 바뀌면 몇 쪽에 있든 첫 쪽부터 다시 본다 — 순서가 통째로 달라진다.
    await this.pager.runPage(tab, { offset: 0, sort: { index: column, dir: direction } });
  }

  // ── 그리드 편집 ───────────────────────────────────────────────────────────

  private async handleUpdateCell(tab: ResultTab | undefined, message: unknown): Promise<void> {
    const editSource = tab?.result?.editSource;
    if (!tab || !editSource || !tab.result) {
      return;
    }

    const { rowIndex, columnIndex, value } = message as {
      rowIndex?: unknown;
      columnIndex?: unknown;
      value?: unknown;
    };
    if (!isIndex(rowIndex) || !isIndex(columnIndex)) {
      return;
    }
    // 웹뷰가 보낸 값은 문자열이거나 명시적 null 만 허용한다.
    if (value !== null && typeof value !== 'string') {
      return;
    }

    const row = tab.result.rows[rowIndex];
    if (!row) {
      return;
    }
    // 편집 허용 컬럼인지 서버 쪽에서 다시 확인한다.
    // 웹뷰의 판단을 그대로 믿고 UPDATE 를 만들지 않는다.
    if (!editSource.editableColumns.some((c) => c.index === columnIndex)) {
      void vscode.window.showWarningMessage('이 컬럼은 수정할 수 없습니다.');
      return;
    }
    if (row[columnIndex] === value) {
      return; // 바뀐 게 없다.
    }

    const outcome = await this.editService.updateCell({
      profileId: tab.profileId,
      editSource,
      row: [...row],
      columnIndex,
      newValue: value,
    });

    if (outcome.ok) {
      row[columnIndex] = value;
      this.postTabs();
      void vscode.window.setStatusBarMessage(`$(check) ${outcome.message}`, 3000);
    } else {
      // 실패했으면 원래 값으로 되돌아가야 하므로 다시 그린다.
      this.postTabs();
      void vscode.window.showErrorMessage(outcome.message);
    }
  }

  private async handleInsertRow(tab: ResultTab | undefined, message: unknown): Promise<void> {
    const editSource = tab?.result?.editSource;
    if (!tab || !editSource) {
      return;
    }
    const cells = (message as { cells?: unknown }).cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      return;
    }

    // 웹뷰가 보낸 것은 그대로 믿지 않는다 — 편집 대상 컬럼만, 문자열/NULL 만 받는다.
    const allowed = new Set(
      [...editSource.keyColumns, ...editSource.editableColumns].map((column) => column.index),
    );
    const validated: { index: number; value: string | null }[] = [];
    for (const cell of cells) {
      const index = (cell as { columnIndex?: unknown }).columnIndex;
      const value = (cell as { value?: unknown }).value;
      if (!isIndex(index) || !allowed.has(index)) {
        void vscode.window.showWarningMessage('이 컬럼에는 값을 넣을 수 없습니다.');
        return;
      }
      if (value !== null && typeof value !== 'string') {
        return;
      }
      validated.push({ index, value });
    }

    const outcome = await this.editService.insertRow({
      profileId: tab.profileId,
      editSource,
      cells: validated,
    });

    if (!outcome.ok) {
      void vscode.window.showErrorMessage(outcome.message);
      return;
    }

    void vscode.window.setStatusBarMessage(`$(check) ${outcome.message}`, 3000);
    // 서버가 채운 기본값·시퀀스 값을 보려면 다시 읽어야 한다.
    if (tab.page && this.pager) {
      await this.pager.runPage(tab, { offset: tab.page.offset, sort: tab.page.sort });
    } else {
      void vscode.window.setStatusBarMessage(
        '$(info) 다시 조회하면 추가된 행이 보입니다.',
        3000,
      );
    }
  }

  private async handleDeleteRow(tab: ResultTab | undefined, message: unknown): Promise<void> {
    const editSource = tab?.result?.editSource;
    if (!tab || !editSource || !tab.result) {
      return;
    }
    const { rowIndex } = message as { rowIndex?: unknown };
    if (!isIndex(rowIndex)) {
      return;
    }
    const row = tab.result.rows[rowIndex];
    if (!row) {
      return;
    }

    const outcome = await this.editService.deleteRow({
      profileId: tab.profileId,
      editSource,
      row: [...row],
    });

    if (outcome.ok) {
      tab.result.rows.splice(rowIndex, 1);
      tab.result.rowCount = tab.result.rows.length;
      this.postTabs();
      void vscode.window.setStatusBarMessage(`$(check) 행을 삭제했습니다.`, 3000);
    } else {
      void vscode.window.showErrorMessage(outcome.message);
    }
  }

  // ── 내보내기 ──────────────────────────────────────────────────────────────

  private async exportCsv(tab: ResultTab | undefined): Promise<void> {
    if (!tab?.result || tab.result.kind !== 'rows') {
      return;
    }
    const { columns, rows } = tab.result;
    const lines = [columns.map((c) => toCsvField(c.name)).join(',')];
    for (const row of rows) {
      lines.push(row.map(toCsvField).join(','));
    }
    // BOM 을 붙여야 Excel 이 UTF-8 로 인식한다.
    // eslint-disable-next-line no-irregular-whitespace -- BOM 은 의도된 문자다
    await this.saveFile(`${tab.title}.csv`, `﻿${lines.join('\r\n')}`, { CSV: ['csv'] });
  }

  private async exportJson(tab: ResultTab | undefined): Promise<void> {
    if (!tab?.result || tab.result.kind !== 'rows') {
      return;
    }
    const { columns, rows } = tab.result;
    const objects = rows.map((row) => {
      const object: Record<string, CellValue> = {};
      columns.forEach((column, index) => {
        // 동일 이름 컬럼은 뒤엣것에 인덱스를 붙여 구분한다.
        const key = object[column.name] === undefined ? column.name : `${column.name}_${index}`;
        object[key] = row[index] ?? null;
      });
      return object;
    });
    await this.saveFile(`${tab.title}.json`, JSON.stringify(objects, null, 2), { JSON: ['json'] });
  }

  private async saveFile(
    suggestedName: string,
    content: string,
    filters: Record<string, string[]>,
  ): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(sanitizeFileName(suggestedName)),
      filters,
    });
    if (!uri) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    void vscode.window.showInformationMessage(`저장했습니다: ${uri.fsPath}`);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'results.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'results.css'),
    );

    // default-src 'none' 으로 시작해 필요한 것만 연다.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>쿼리 결과</title>
</head>
<body>
  <div id="tabbar" role="tablist"></div>
  <div id="toolbar">
    <span id="summary"></span>
    <span class="spacer"></span>
    <span id="selection" title="선택한 블록 크기"></span>
    <button id="btn-prev" type="button" title="이전 쪽">◀</button>
    <span id="pageinfo"></span>
    <button id="btn-next" type="button" title="다음 쪽">▶</button>
    <button id="btn-more" type="button" title="다음 묶음을 지금 결과 뒤에 이어서 조회">더 불러오기</button>
    <label id="rowlimit-label" for="rowlimit">행 제한</label>
    <select id="rowlimit" title="한 번에 가져올 최대 행 수 (dbconn.execution.maxRows)"></select>
    <button id="btn-insert" type="button" title="새 행 추가">행 추가</button>
    <button id="btn-delete" type="button" title="선택한 행 삭제">행 삭제</button>
    <button id="btn-sql" type="button" title="실행한 SQL 열기">SQL</button>
    <button id="btn-csv" type="button" title="CSV 로 내보내기">CSV</button>
    <button id="btn-json" type="button" title="JSON 으로 내보내기">JSON</button>
  </div>
  <div id="content">
    <div id="empty" class="placeholder">쿼리를 실행하면 결과가 여기 표시됩니다. (Ctrl+Enter)</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.tabs.length = 0;
    this.view = undefined;
  }
}

function serializeTab(tab: ResultTab): SerializedTab {
  const base: SerializedTab = {
    id: tab.id,
    title: tab.title,
    sql: tab.sql,
    connectionName: tab.connectionName,
    environmentBadge: environmentBadge(tab.environment),
    pinned: tab.pinned,
    state: tab.state,
  };
  if (tab.error) {
    base.error = tab.error;
  }
  if (tab.plan) {
    base.plan = { text: tab.plan.text, note: tab.plan.note };
    base.durationMs = tab.plan.durationMs;
  }
  if (tab.page) {
    base.page = {
      offset: tab.page.offset,
      pageSize: tab.page.pageSize,
      hasMore: tab.page.hasMore,
      sort: tab.page.sort,
      loaded: tab.result?.rows.length ?? 0,
      loadingMore: tab.loadingMore === true,
      autoPaused: tab.page.autoPaused === true,
    };
  }
  const result = tab.result;
  if (result) {
    base.columns = result.columns.map((c) => ({ name: c.name, typeName: c.typeName }));
    base.rows = result.rows;
    base.rowCount = result.rowCount;
    base.affectedRows = result.affectedRows;
    base.truncated = result.truncated;
    base.durationMs = result.durationMs;
    base.messages = result.messages;
    if (result.editSource) {
      base.edit = serializeEdit(result.editSource);
    }
  }
  return base;
}

function serializeEdit(source: EditSource): SerializedEdit {
  return {
    columns: source.editableColumns.map((c) => c.index),
    keyColumns: source.keyColumns.map((c) => c.index),
    table: `${source.schema}.${source.table}`,
  };
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 탭 제목 — SQL 의 첫 부분을 짧게. */
function makeTitle(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine || '쿼리';
}

/** 저장 대화상자 기본 이름 — 경로 구분자/제어 문자를 제거한다. */
function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- 제어 문자를 지우는 것이 목적이다
  return name.replace(/[/\\:*?"<>|\u0000-\u001F]/g, '_').trim().slice(0, 120) || 'result';
}
