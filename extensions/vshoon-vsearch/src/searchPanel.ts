import * as vscode from 'vscode';
import { getConfig, runSearch } from './searchEngine';
import { loadPreview, recomputeMatches, replaceAll, replaceOne, savePreview } from './documentService';
import { SearchQuery, ToExtensionMessage, ToWebviewMessage } from './types';

const VIEW_TYPE = 'vsearch.panel';
const STATE_KEY = 'vsearch.uiState';

export interface OpenOptions {
  focus?: 'search' | 'replace';
  scopePath?: string;
  query?: string;
}

export class SearchPanel {
  private static current: SearchPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private searchTokenSource: vscode.CancellationTokenSource | undefined;
  private replaceTokenSource: vscode.CancellationTokenSource | undefined;
  private webviewReady = false;
  private pendingOptions: OpenOptions | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: ToExtensionMessage) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables
    );
  }

  static createOrShow(context: vscode.ExtensionContext, options: OpenOptions = {}): void {
    if (SearchPanel.current) {
      // 인자 없이 reveal 해야 지금 있는 자리(모달)에서 앞으로 나온다.
      // 컬럼을 지정하면 모달에 있던 패널이 일반 편집기 그룹으로 끌려온다.
      SearchPanel.current.panel.reveal();
      SearchPanel.current.applyOptions(options);
      return;
    }
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'VSearch', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    SearchPanel.current = new SearchPanel(panel, context);
    SearchPanel.current.pendingOptions = options;
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
    SearchPanel.current = new SearchPanel(panel, context);
  }

  private applyOptions(options: OpenOptions): void {
    if (!this.webviewReady) {
      this.pendingOptions = options;
      return;
    }
    if (options.scopePath) {
      this.post({ type: 'presetScope', scopePath: options.scopePath });
    }
    if (options.query) {
      this.post({ type: 'presetQuery', query: options.query });
    }
    if (options.focus) {
      this.post({ type: 'focus', target: options.focus });
    }
  }

  private post(message: ToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: ToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.webviewReady = true;
          this.post({
            type: 'init',
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({
              name: f.name,
              path: f.uri.fsPath
            })),
            state: this.context.workspaceState.get(STATE_KEY) ?? null,
            config: {
              autoSearch: vscode.workspace.getConfiguration('vsearch').get<boolean>('autoSearch', true)
            }
          });
          if (this.pendingOptions) {
            this.applyOptions(this.pendingOptions);
            this.pendingOptions = undefined;
          }
          break;

        case 'search':
          await this.doSearch(message.query);
          break;

        case 'cancel':
          this.searchTokenSource?.cancel();
          break;

        case 'pickFolder': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '이 폴더에서 검색',
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
          });
          if (picked && picked[0]) {
            this.post({ type: 'folderPicked', path: picked[0].fsPath });
          }
          break;
        }

        case 'requestPreview': {
          const uri = vscode.Uri.parse(message.uri);
          const payload = await loadPreview(uri, message.query, getConfig());
          this.post({ type: 'preview', uri: message.uri, ...payload });
          break;
        }

        case 'savePreview': {
          const uri = vscode.Uri.parse(message.uri);
          await savePreview(uri, message.content, message.baseText);
          this.post({
            type: 'previewSaved',
            uri: message.uri,
            matches: recomputeMatches(message.content, message.query, getConfig())
          });
          this.post({ type: 'info', message: '저장했습니다.' });
          break;
        }

        case 'openInEditor': {
          const items = message.items ?? [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const uri = vscode.Uri.parse(item.uri);
            const doc = await vscode.workspace.openTextDocument(uri);
            const start = new vscode.Position(item.line, item.column);
            const end = new vscode.Position(item.line, item.column + item.length);
            const range = new vscode.Range(start, end);

            // 검색 패널은 모달이라 편집기 그룹을 차지하지 않는다. 파일은 첫 번째 그룹에 연다.
            // 여러 개를 열 때 preview 탭이면 서로 덮어쓰므로 항상 고정 탭으로 연다.
            const editor = await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.One,
              preserveFocus: false,
              preview: false
            });
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          }
          break;
        }

        case 'replaceOne': {
          const uri = vscode.Uri.parse(message.uri);
          const result = await replaceOne(
            uri,
            message.query,
            message.replacement,
            { line: message.line, column: message.column },
            getConfig()
          );
          // 여기서 직접 다시 검색하면 웹뷰가 목록을 비우지 않아 결과가 중복된다.
          // replaceDone 을 받은 웹뷰가 스스로 새 검색을 시작하게 둔다.
          this.post({ type: 'replaceDone', fileCount: result.fileCount, matchCount: result.matchCount });
          break;
        }

        case 'replaceAll': {
          const answer = await vscode.window.showWarningMessage(
            `현재 검색 조건의 모든 일치 항목을 "${message.replacement}" (으)로 바꿉니다. 계속할까요?`,
            { modal: true },
            '모두 바꾸기'
          );
          if (answer !== '모두 바꾸기') {
            break;
          }
          this.replaceTokenSource?.cancel();
          this.replaceTokenSource = new vscode.CancellationTokenSource();
          const result = await replaceAll(
            message.query,
            message.replacement,
            getConfig(),
            this.replaceTokenSource.token
          );
          this.post({ type: 'replaceDone', fileCount: result.fileCount, matchCount: result.matchCount });
          vscode.window.showInformationMessage(
            `${result.fileCount}개 파일에서 ${result.matchCount}건을 바꿨습니다.`
          );
          break;
        }

        case 'persist':
          await this.context.workspaceState.update(STATE_KEY, message.state);
          break;

        case 'close':
          this.panel.dispose();
          break;

        case 'log':
          console.log('[VSearch webview]', message.message);
          break;

        default:
          break;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', message: text });
    }
  }

  private async doSearch(query: SearchQuery): Promise<void> {
    this.searchTokenSource?.cancel();
    this.searchTokenSource?.dispose();
    const source = new vscode.CancellationTokenSource();
    this.searchTokenSource = source;

    this.post({ type: 'searchStarted', id: query.id });
    const started = Date.now();
    try {
      const stats = await runSearch(query, getConfig(), source.token, (files) => {
        if (!source.token.isCancellationRequested) {
          this.post({ type: 'results', id: query.id, files });
        }
      });
      this.post({
        type: 'searchDone',
        id: query.id,
        fileCount: stats.fileCount,
        matchCount: stats.matchCount,
        elapsedMs: Date.now() - started,
        cancelled: source.token.isCancellationRequested,
        truncated: stats.truncated
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'searchError', id: query.id, message: text });
    } finally {
      if (this.searchTokenSource === source) {
        source.dispose();
        this.searchTokenSource = undefined;
      }
    }
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));
    const monacoBase = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'monaco', 'vs'));
    const nonce = createNonce();
    // Monaco 는 스타일을 동적으로 삽입하고(style-src unsafe-inline),
    // AMD 로더가 스크립트를 추가로 불러오며(script-src cspSource),
    // 언어 서비스용 워커를 data URL 로 만든다(worker-src data:).
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      // Monaco 는 아이콘 폰트(codicon)를 CSS 안에 data URI 로 넣어 둔다. data: 를 빼면 아이콘이 □ 로 깨진다.
      `font-src ${webview.cspSource} data:`,
      `img-src ${webview.cspSource} data:`,
      `worker-src data: blob:`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp};" />
<!-- Monaco 스타일을 먼저 걸어두면 아이콘 폰트(codicon)를 툴바에서도 바로 쓸 수 있다.
     AMD 로더가 나중에 같은 CSS 를 또 넣지만 중복일 뿐 문제는 없다. -->
<link href="${monacoBase}/editor/editor.main.css" rel="stylesheet" />
<link href="${styleUri}" rel="stylesheet" />
<title>VSearch</title>
</head>
<body>
<div id="app">
  <header class="toolbar">
    <div class="field-row">
      <button id="btnHistory" class="opt with-caret" title="최근 검색어">
        <span class="vs-icon icon-search"></span><span class="vs-icon icon-chevron-down caret"></span>
      </button>
      <input id="query" class="field-input" type="text" placeholder="검색어" spellcheck="false" autocomplete="off" />
      <button id="btnClear" class="opt" title="검색어 지우기" hidden><span class="vs-icon icon-close"></span></button>
      <button id="optReplace" class="opt" title="바꾸기 (Alt+R)"><span class="vs-icon icon-replace"></span></button>
      <span class="opt-sep"></span>
      <button id="optCase" class="opt" title="대소문자 구분 (Alt+C)"><span class="vs-icon icon-case-sensitive"></span></button>
      <button id="optWord" class="opt" title="단어 단위 (Alt+W)"><span class="vs-icon icon-whole-word"></span></button>
      <button id="optRegex" class="opt" title="정규식 (Alt+E)"><span class="vs-icon icon-regex"></span></button>
      <span class="opt-sep"></span>
      <span class="mask-wrap">
        <input id="fileMask" class="file-mask" type="text" placeholder="*.ts" title="파일 마스크 (예: *.ts, *.java)" spellcheck="false" autocomplete="off" />
        <button id="btnMaskHistory" class="opt caret-only" title="최근 파일 마스크"><span class="vs-icon icon-chevron-down"></span></button>
      </span>
    </div>

    <div class="field-row collapsible" id="replaceRow">
      <button id="btnReplaceHistory" class="opt with-caret" title="최근 바꿀 내용">
        <span class="vs-icon icon-replace"></span><span class="vs-icon icon-chevron-down caret"></span>
      </button>
      <input id="replacement" class="field-input" type="text" placeholder="바꿀 내용 ($1, $&amp; 사용 가능)" spellcheck="false" autocomplete="off" />
      <button id="btnReplaceOne" class="ghost small" disabled title="선택한 항목만 바꾸기">바꾸기</button>
      <button id="btnReplaceAll" class="ghost small" disabled title="모두 바꾸기">모두 바꾸기</button>
    </div>

    <div class="scope-row">
      <button id="optDirectory" class="opt" title="디렉터리 지정해서 검색 (Alt+D)">
        <span class="vs-icon icon-folder"></span>
      </button>
      <span class="dir-group" id="dirGroup" hidden>
        <input id="scopePath" type="text" placeholder="디렉터리 경로" spellcheck="false" autocomplete="off" />
        <button id="btnPickFolder" class="ghost small" title="폴더 선택">…</button>
        <label class="check"><input type="checkbox" id="recursive" checked /> 하위 포함</label>
      </span>
    </div>
  </header>

  <div id="historyPopup" class="history-popup" hidden></div>

  <main class="content" id="content">
    <section id="results" class="results" tabindex="0" aria-label="검색 결과"></section>
    <div id="splitter" class="splitter" title="드래그하여 크기 조절"></div>
    <section class="preview">
      <div class="preview-header">
        <span id="previewPath" class="preview-path">파일을 선택하세요</span>
        <span id="previewDirty" class="dirty-dot" hidden>●</span>
        <span class="spacer"></span>
        <button id="btnFind" class="opt" title="이 파일에서 찾기 (Ctrl+F)">
          <span class="vs-icon icon-search"></span>
        </button>
      </div>

      <div id="editorWrap" class="editor-wrap"></div>
      <div id="previewMessage" class="preview-message" hidden></div>
    </section>
  </main>

  <div class="status-bar">
    <span id="status" class="status">검색어를 입력하세요.</span>
    <span class="spacer"></span>
    <button id="btnOpenEditor" class="ghost wide" title="열기 (Ctrl+Enter)" disabled>열기</button>
  </div>
</div>
<script nonce="${nonce}">
  // Monaco 로더가 쓸 기준 경로. 워커는 쓰지 않으므로(미리보기에 언어 서비스가 필요 없다)
  // 아무 일도 하지 않는 워커를 돌려줘서 로드 실패 오류만 막는다.
  window.__vsearchMonacoBase = "${monacoBase}";
  window.MonacoEnvironment = {
    getWorkerUrl: function () {
      return 'data:text/javascript;charset=utf-8,' + encodeURIComponent('self.onmessage=function(){};');
    }
  };
</script>
<script nonce="${nonce}" src="${monacoBase}/loader.js"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    SearchPanel.current = undefined;
    this.searchTokenSource?.cancel();
    this.searchTokenSource?.dispose();
    this.replaceTokenSource?.cancel();
    this.replaceTokenSource?.dispose();
    this.panel.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export const SEARCH_PANEL_VIEW_TYPE = VIEW_TYPE;
