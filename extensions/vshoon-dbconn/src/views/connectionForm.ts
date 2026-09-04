import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  formatConnectionUrl,
  parseConnectionUrl,
  type ParsedConnectionUrl,
} from '../config/connectionUrl';
import {
  ENVIRONMENTS,
  environmentDescription,
  environmentLabel,
} from '../config/environment';
import { poolOptionsFromSettings } from '../config/profileStore';
import { testConnection } from '../db/connectionTest';
import {
  DEFAULT_PORTS,
  DIALECT_LABELS,
  type ConnectionEnvironment,
  type ConnectionProfile,
  type ConnectionProfileDraft,
  type DialectId,
} from '../types';
import { log } from '../util/logger';

/**
 * 연결 추가/편집 화면.
 *
 * 예전에는 QuickPick/InputBox 를 여덟 단계로 이어 붙였다. 자격 증명을 다루는
 * 표면이 좁다는 장점이 있었지만, 포트 하나를 고치려고 처음부터 여덟 번을
 * 눌러야 했고 앞 단계로 돌아갈 방법도 없었다. 그래서 한 화면에 모은다.
 *
 * 비밀번호를 웹뷰에서 받게 됐으므로 그만큼 규칙을 분명히 한다:
 *  - 비밀번호는 저장/테스트 요청에 실려 **확장으로 갈 때만** 오간다.
 *  - 웹뷰가 setState 로 남기는 값에는 절대 넣지 않는다 (아예 setState 를 쓰지 않는다).
 *  - 편집할 때 기존 비밀번호를 웹뷰로 내려보내지 않는다. 빈 칸은 "그대로 두기"다.
 *  - 저장은 이 함수의 반환값으로만 전달되고, SecretStorage 기록은 ProfileStore 가 한다.
 */

export interface ConnectionFormResult {
  draft: ConnectionProfileDraft;
  /** 새로 입력받은 비밀번호. undefined 면 기존 값을 유지한다. */
  password: string | undefined;
}

export interface ConnectionFormOptions {
  /**
   * 편집 중 비밀번호를 비워 뒀을 때 기존 비밀번호를 가져오는 함수.
   * 연결 테스트에만 쓰인다 — 이 화면은 비밀번호를 저장소에서 직접 읽지 않는다.
   */
  resolvePassword?: () => Promise<string | undefined>;
  /**
   * 저장하는 순간의 프로필을 다시 읽어 오는 함수.
   *
   * 폼이 창으로 떠 있는 동안에도 트리는 살아 있다 — 그 연결을 폴더로 끌어다
   * 놓을 수 있다. 열 때 찍어 둔 사본으로 저장하면 폼이 묻지도 않은 값(폴더·풀
   * 설정 등)이 그때 것으로 되돌아간다. 없으면 열 때의 사본을 쓴다.
   */
  resolveExisting?: () => ConnectionProfile | undefined;
  /**
   * 폼을 이 URL 에서 시작한다 ("URL 로 커넥션 추가").
   * 파싱에 실패하면 조용히 무시하고 빈 폼으로 연다 — 부르는 쪽에서 이미 확인했다.
   */
  initialUrl?: string;
}

/** 웹뷰와 주고받는 폼 값. 전부 문자열/불리언 — 입력 중인 상태를 그대로 담는다. */
interface FormValues {
  name: string;
  dialect: DialectId;
  environment: ConnectionEnvironment;
  /**
   * 접속 정보를 어떤 방식으로 입력했는지.
   *
   * `url` 이면 **URL 칸이 진실**이다. 화면이 URL 을 실시간으로 파싱해 아래 칸을
   * 채워 두지만, 저장·테스트 직전에 확장이 URL 을 한 번 더 읽어 덮어쓴다 —
   * 마지막 타자와 저장 사이의 짧은 틈에 낡은 값이 저장되면 안 되기 때문이다.
   */
  mode: 'fields' | 'url';
  url: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  savePassword: boolean;
  readOnly: boolean;
  tlsEnabled: boolean;
  tlsVerify: 'system' | 'ca' | 'insecure';
  caPath: string;
  oracleConnectType: 'service' | 'sid';
}

/**
 * 화면은 하나만 띄운다. 두 개가 열려 있으면 어느 쪽을 저장하는지 알 수 없고,
 * 같은 프로필을 양쪽에서 고치면 늦게 저장한 쪽이 조용히 이긴다.
 */
let current: ConnectionFormPanel | undefined;

export function openConnectionForm(
  extensionUri: vscode.Uri,
  existing?: ConnectionProfile,
  options: ConnectionFormOptions = {},
): Promise<ConnectionFormResult | undefined> {
  current?.close();
  const panel = new ConnectionFormPanel(extensionUri, existing, options);
  current = panel;
  return panel.result;
}

class ConnectionFormPanel {
  readonly result: Promise<ConnectionFormResult | undefined>;

  private readonly panel: vscode.WebviewPanel;
  private settle!: (result: ConnectionFormResult | undefined) => void;
  private settled = false;
  /** 저장/테스트가 도는 동안 같은 요청이 겹치지 않게 한다. */
  private busy = false;
  /** 닫힌 뒤에는 웹뷰로 아무것도 보내지 않는다 (post 참고). */
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly existing: ConnectionProfile | undefined,
    private readonly options: ConnectionFormOptions,
  ) {
    this.result = new Promise((resolve) => {
      this.settle = resolve;
    });

    this.panel = vscode.window.createWebviewPanel(
      'dbconn.connectionForm',
      existing ? `연결 편집 — ${existing.name}` : '연결 추가',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // 탭을 잠깐 벗어났다고 입력하던 값이 날아가면 안 된다.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'database.svg');
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (current === this) {
        current = undefined;
      }
      // 저장 없이 닫혔으면 취소다.
      this.finish(undefined);
    });
  }

  /** 다른 화면에 자리를 내준다 — 저장하지 않은 값은 취소로 처리된다. */
  close(): void {
    this.panel.dispose();
  }

  private finish(result: ConnectionFormResult | undefined): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.settle(result);
  }

  // ── 웹뷰 → 확장 ───────────────────────────────────────────────────────────

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    const { type } = message as { type?: unknown };
    switch (type) {
      case 'ready': {
        const values = this.initialValues();
        this.post({
          type: 'init',
          isEdit: this.existing !== undefined,
          values,
          // URL 로 시작한 폼은 URL 방식으로 연다.
          mode: values.mode,
          // 편집이면 지금 설정을 URL 로도 보여 준다 — 그대로 복사해 공유할 수 있게.
          url: this.options.initialUrl ?? (this.existing ? urlFromValues(values) : ''),
          dialects: (['mysql', 'mariadb', 'postgres', 'oracle'] as const).map((id) => ({
            id,
            label: DIALECT_LABELS[id],
            defaultPort: DEFAULT_PORTS[id],
            defaultUser: defaultUser(id),
          })),
          environments: ENVIRONMENTS.map((id) => ({
            id,
            label: environmentLabel(id),
            description: environmentDescription(id),
          })),
        });
        return;
      }

      case 'save':
        await this.save((message as { values?: unknown }).values);
        return;

      case 'test':
        await this.test((message as { values?: unknown }).values);
        return;

      case 'applyUrl':
        this.applyUrl((message as { url?: unknown }).url);
        return;

      case 'copyUrl':
        await this.copyUrl((message as { values?: unknown }).values);
        return;

      case 'buildUrl':
        this.buildUrl((message as { values?: unknown }).values);
        return;

      case 'browseCa':
        await this.browseCa();
        return;

      case 'cancel':
        this.panel.dispose();
        return;

      default:
        log.debug(`알 수 없는 연결 폼 메시지: ${String(type)}`);
    }
  }

  private async save(raw: unknown): Promise<void> {
    if (this.busy) {
      return;
    }
    const resolved = resolve(sanitize(raw));
    if (!resolved) {
      return;
    }
    const { values, problem } = resolved;
    if (problem) {
      this.post({ type: 'status', level: 'error', message: problem });
      return;
    }

    // 검증을 끄는 선택은 화면 안 경고만으로 넘기지 않는다 — 모달로 한 번 더 묻는다.
    if (values.tlsEnabled && values.tlsVerify === 'insecure') {
      const confirm = await vscode.window.showWarningMessage(
        '인증서 검증을 끄면 네트워크 상의 공격자가 연결을 가로채도 알 수 없습니다.',
        { modal: true, detail: '사설 CA 를 쓴다면 검증을 끄는 대신 CA 파일을 지정하세요.' },
        '검증 없이 저장',
      );
      if (confirm !== '검증 없이 저장') {
        this.post({ type: 'status', level: 'info', message: '저장을 취소했습니다.' });
        return;
      }
    }

    const draft = toDraft(values, this.currentExisting());
    // 편집 중 비워 뒀으면 기존 비밀번호를 유지한다는 뜻.
    const password =
      this.existing !== undefined && values.password === '' ? undefined : values.password;

    this.finish({ draft, password });
    this.panel.dispose();
  }

  private async test(raw: unknown): Promise<void> {
    if (this.busy) {
      return;
    }
    const resolved = resolve(sanitize(raw));
    if (!resolved) {
      return;
    }
    const { values, problem } = resolved;
    if (problem) {
      this.post({ type: 'status', level: 'error', message: problem });
      return;
    }

    const draft = toDraft(values, this.currentExisting());
    const password =
      values.password !== ''
        ? values.password
        : this.existing !== undefined
          ? await this.options.resolvePassword?.()
          : '';

    this.busy = true;
    this.post({ type: 'status', level: 'busy', message: '연결하는 중…' });
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${draft.name} 연결 테스트 중…` },
        () => testConnection(draft, password, draft.connectTimeoutMs),
      );
      this.post({
        type: 'status',
        level: result.ok ? 'success' : 'error',
        message: result.message,
      });
    } finally {
      this.busy = false;
      this.post({ type: 'idle' });
    }
  }

  /**
   * 붙여 넣은 URL 을 칸으로 흩뿌린다.
   *
   * 파싱은 확장에서 한다 — 웹뷰에도 같은 규칙을 두면 두 벌이 어긋나고,
   * 무엇보다 이 규칙은 테스트가 붙어 있는 쪽에 있어야 한다.
   *
   * URL 에 비밀번호가 들어 있으면 그 값도 돌려보낸다. 새로 흘리는 것이 아니라
   * **웹뷰가 방금 보낸 문자열 안에 있던 값**이라 경계를 새로 넘지 않는다.
   */
  private applyUrl(raw: unknown): void {
    if (typeof raw !== 'string') {
      return;
    }
    const result = parseConnectionUrl(raw);
    if (!result.ok) {
      // 실패해도 이미 채워 둔 칸은 건드리지 않는다 — 타이핑 도중에 값이
      // 지워지면 무엇을 고치는 중이었는지 알 수 없게 된다.
      this.post({ type: 'urlApplied', problem: result.error });
      return;
    }

    const value = result.value;
    const summary = [
      DIALECT_LABELS[value.dialect],
      `${value.host}:${value.port}`,
      value.database || '(기본 스키마)',
    ];
    if (value.user) {
      summary.push(`사용자 ${value.user}`);
    }
    if (value.password) {
      summary.push('비밀번호 포함');
    }
    if (value.tlsEnabled) {
      summary.push(value.tlsVerify === false ? 'TLS (검증 없음)' : 'TLS');
    }
    if (value.ignoredParams.length > 0) {
      summary.push(`반영하지 않음: ${value.ignoredParams.join(', ')}`);
    }

    this.post({ type: 'urlApplied', patch: patchFromUrl(value), summary: summary.join(' · ') });
  }

  /** 지금 칸 값으로 URL 문자열을 만들어 돌려준다 (방식을 URL 로 바꿀 때). */
  private buildUrl(raw: unknown): void {
    const values = sanitize(raw);
    if (!values) {
      return;
    }
    this.post({ type: 'urlText', url: urlFromValues(values) });
  }

  /** 지금 칸에 있는 값을 URL 한 줄로 만들어 클립보드에 넣는다 (비밀번호 제외). */
  private async copyUrl(raw: unknown): Promise<void> {
    const values = sanitize(raw);
    if (!values) {
      return;
    }
    await vscode.env.clipboard.writeText(urlFromValues(values));
    this.post({
      type: 'status',
      level: 'success',
      message: '연결 URL 을 복사했습니다 (비밀번호는 빠집니다).',
    });
  }

  private async browseCa(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      title: 'CA 인증서 (PEM)',
      canSelectMany: false,
      filters: { 인증서: ['pem', 'crt', 'cer'], '모든 파일': ['*'] },
    });
    if (!files || files.length === 0) {
      return;
    }
    this.post({ type: 'caPath', path: files[0]!.fsPath });
  }

  /**
   * 웹뷰로 한 마디.
   *
   * 닫힌 패널의 webview 에 손대면 VS Code 가 예외를 던진다. 연결 테스트는
   * 최대 15초가 걸리는데 그동안 탭을 닫아 버리면 끝나고 나서 결과를 보내다가
   * 터진다 — 이 호출들은 `void` 로 띄워 둔 자리라 아무도 잡아 주지 않는다.
   */
  /** 폼이 묻지 않는 값을 가져올 기준 프로필 — 열 때가 아니라 지금 것. */
  private currentExisting(): ConnectionProfile | undefined {
    if (!this.existing) {
      return undefined;
    }
    return this.options.resolveExisting?.() ?? this.existing;
  }

  private post(message: unknown): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  // ── 초기값 ────────────────────────────────────────────────────────────────

  private initialValues(): FormValues {
    const existing = this.existing;
    if (!existing) {
      const blank: FormValues = {
        name: '',
        dialect: 'mysql',
        environment: 'development',
        mode: 'fields',
        url: '',
        host: 'localhost',
        port: String(DEFAULT_PORTS.mysql),
        database: '',
        user: defaultUser('mysql'),
        password: '',
        savePassword: true,
        readOnly: false,
        tlsEnabled: false,
        tlsVerify: 'system',
        caPath: '',
        oracleConnectType: 'service',
      };
      // "URL 로 커넥션 추가"로 열렸으면 URL 방식으로, 그 값에서 시작한다.
      const url = this.options.initialUrl;
      const parsed = url ? parseConnectionUrl(url) : undefined;
      return parsed?.ok
        ? { ...blank, ...patchFromUrl(parsed.value), mode: 'url', url: url ?? '' }
        : blank;
    }
    return {
      name: existing.name,
      dialect: existing.dialect,
      environment: existing.environment,
      // 이미 저장된 연결은 칸으로 연다 — 고치려고 여는 것이 대부분이다.
      mode: 'fields',
      url: '',
      host: existing.host,
      port: String(existing.port),
      database: existing.database,
      user: existing.user,
      // 저장된 비밀번호는 화면으로 내려보내지 않는다. 빈 칸이 "그대로 두기"다.
      password: '',
      savePassword: existing.savePassword,
      readOnly: existing.readOnly,
      tlsEnabled: existing.tls.enabled,
      tlsVerify: !existing.tls.rejectUnauthorized
        ? 'insecure'
        : existing.tls.caPath
          ? 'ca'
          : 'system',
      caPath: existing.tls.caPath ?? '',
      oracleConnectType: existing.oracle?.connectType ?? 'service',
    };
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'connection.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'connection.css'),
    );
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
  <title>연결</title>
</head>
<body>
  <form id="form" autocomplete="off">
    <main id="content">
      <section class="group">
        <h2>기본</h2>
        <div class="row">
          <label for="name">이름</label>
          <div class="field">
            <input id="name" type="text" placeholder="트리에 표시될 이름" spellcheck="false">
            <p class="hint" id="name-hint">비워 두면 <span id="name-suggestion"></span> 으로 저장됩니다.</p>
          </div>
        </div>
        <div class="row" id="row-dialect">
          <label for="dialect">종류</label>
          <div class="field">
            <select id="dialect"></select>
          </div>
        </div>
        <div class="row">
          <label for="environment">환경</label>
          <div class="field">
            <select id="environment"></select>
            <p class="hint" id="environment-hint"></p>
          </div>
        </div>
      </section>

      <section class="group">
        <h2>접속</h2>
        <div class="row">
          <span class="label">입력 방식</span>
          <div class="field">
            <div class="radios" role="radiogroup" aria-label="접속 정보 입력 방식">
              <label class="radio">
                <input id="mode-fields" type="radio" name="connect-mode" value="fields">
                <span>호스트 직접 입력</span>
              </label>
              <label class="radio">
                <input id="mode-url" type="radio" name="connect-mode" value="url">
                <span>URL</span>
              </label>
            </div>
          </div>
        </div>
        <div class="row" id="row-url" hidden>
          <label for="url">URL</label>
          <div class="field">
            <div class="split">
              <input id="url" type="text" spellcheck="false" autocapitalize="off"
                placeholder="postgresql://user@host:5432/db">
              <button id="btn-copy-url" type="button" class="secondary">복사</button>
            </div>
            <p class="hint" id="url-summary"></p>
            <p class="hint">
              <code>mysql://</code> · <code>mariadb://</code> · <code>postgresql://</code> ·
              <code>oracle://</code> 과 <code>jdbc:</code> 형태를 읽습니다.
              종류 · 호스트 · 포트 · 데이터베이스는 이 URL 에서 나옵니다.
            </p>
          </div>
        </div>
        <div class="row" id="row-host">
          <label for="host">호스트</label>
          <div class="field split">
            <input id="host" type="text" spellcheck="false" autocapitalize="off">
            <label for="port" class="inline">포트</label>
            <input id="port" type="text" inputmode="numeric" class="port" spellcheck="false">
          </div>
        </div>
        <div class="row" id="row-oracle-type" hidden>
          <label for="oracleConnectType">접속 식별</label>
          <div class="field">
            <select id="oracleConnectType">
              <option value="service">서비스 이름</option>
              <option value="sid">SID</option>
            </select>
            <p class="hint">대부분의 최신 구성은 서비스 이름을 씁니다.</p>
          </div>
        </div>
        <div class="row" id="row-database">
          <label for="database" id="database-label">데이터베이스</label>
          <div class="field">
            <input id="database" type="text" spellcheck="false" autocapitalize="off">
            <p class="hint" id="database-hint"></p>
          </div>
        </div>
        <div class="row">
          <label for="user">사용자</label>
          <div class="field">
            <input id="user" type="text" spellcheck="false" autocapitalize="off">
          </div>
        </div>
        <div class="row">
          <label for="password">비밀번호</label>
          <div class="field">
            <input id="password" type="password" autocomplete="new-password">
            <p class="hint" id="password-hint"></p>
            <label class="check">
              <input id="savePassword" type="checkbox">
              <span>비밀번호 저장 <em>OS 자격 증명 저장소 사용. 끄면 연결할 때마다 물어봅니다.</em></span>
            </label>
          </div>
        </div>
      </section>

      <section class="group">
        <h2>옵션</h2>
        <div class="row">
          <span class="label">안전장치</span>
          <div class="field">
            <label class="check">
              <input id="readOnly" type="checkbox">
              <span>읽기 전용 <em>INSERT/UPDATE/DELETE/DDL 을 차단합니다. 운영 DB 에 권장.</em></span>
            </label>
          </div>
        </div>
        <div class="row">
          <span class="label">TLS</span>
          <div class="field">
            <label class="check">
              <input id="tlsEnabled" type="checkbox">
              <span>암호화 연결 사용 <em>원격 서버에는 반드시 켜세요.</em></span>
            </label>
            <select id="tlsVerify" disabled>
              <option value="system">시스템 신뢰 저장소로 검증 (기본)</option>
              <option value="ca">CA 인증서 파일로 검증</option>
              <option value="insecure">검증하지 않음</option>
            </select>
            <div class="split" id="row-ca" hidden>
              <input id="caPath" type="text" placeholder="CA 인증서 (PEM) 경로" spellcheck="false">
              <button id="btn-browse" type="button" class="secondary">찾아보기…</button>
            </div>
            <p class="hint warn" id="tls-warning" hidden>
              검증을 끄면 중간자 공격을 탐지할 수 없습니다. 사설 CA 를 쓴다면 CA 파일을 지정하세요.
            </p>
          </div>
        </div>
      </section>
    </main>

    <footer id="foot">
      <p id="status" role="status"></p>
      <div class="actions">
        <button id="btn-test" type="button" class="secondary">연결 테스트</button>
        <button id="btn-cancel" type="button" class="secondary">취소</button>
        <button id="btn-save" type="submit">저장</button>
      </div>
    </footer>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ── 폼 값 → 도메인 ──────────────────────────────────────────────────────────

/** 웹뷰가 보낸 값을 신뢰하지 않고 폼 값 모양으로 맞춘다. */
function sanitize(raw: unknown): FormValues | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const dialect = r.dialect;
  if (dialect !== 'mysql' && dialect !== 'mariadb' && dialect !== 'postgres' && dialect !== 'oracle') {
    return undefined;
  }
  const environment = r.environment;
  const tlsVerify = r.tlsVerify;
  return {
    name: text(r.name),
    dialect,
    environment:
      environment === 'production' || environment === 'staging' ? environment : 'development',
    mode: r.mode === 'url' ? 'url' : 'fields',
    url: text(r.url),
    host: text(r.host),
    port: text(r.port),
    database: text(r.database),
    user: text(r.user),
    password: typeof r.password === 'string' ? r.password : '',
    savePassword: r.savePassword !== false,
    readOnly: r.readOnly === true,
    tlsEnabled: r.tlsEnabled === true,
    tlsVerify: tlsVerify === 'ca' || tlsVerify === 'insecure' ? tlsVerify : 'system',
    caPath: text(r.caPath),
    oracleConnectType: r.oracleConnectType === 'sid' ? 'sid' : 'service',
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 저장·테스트에 쓸 최종 값을 만든다.
 *
 * URL 방식이면 **여기서 URL 을 다시 읽는다.** 화면도 입력할 때마다 파싱해 칸을
 * 채우지만, 마지막 타자와 저장 사이의 짧은 틈에 낡은 값이 저장되는 길을 남기지
 * 않으려면 확정 직전에 한 번 더 읽어야 한다.
 *
 * 사용자·비밀번호는 칸에 적힌 값이 이긴다. URL 에 자격 증명이 들어 있어도
 * 화면에서 고쳐 적었다면 그쪽이 사용자의 마지막 의사다.
 */
function resolve(
  values: FormValues | undefined,
): { values: FormValues; problem?: string } | undefined {
  if (!values) {
    return undefined;
  }
  if (values.mode !== 'url') {
    return { values, problem: validate(values) };
  }

  const parsed = parseConnectionUrl(values.url);
  if (!parsed.ok) {
    return { values, problem: parsed.error };
  }
  const patch = patchFromUrl(parsed.value);
  const merged: FormValues = {
    ...values,
    ...patch,
    user: values.user.trim() || patch.user || '',
    password: values.password || patch.password || '',
  };
  return { values: merged, problem: validate(merged) };
}

/** 폼 값을 URL 한 줄로. 비밀번호는 절대 담기지 않는다. */
function urlFromValues(values: FormValues): string {
  return formatConnectionUrl({
    dialect: values.dialect,
    host: values.host.trim(),
    port: Number(values.port) || DEFAULT_PORTS[values.dialect],
    database: values.database.trim(),
    user: values.user.trim(),
    tlsEnabled: values.tlsEnabled,
    tlsVerify: values.tlsVerify !== 'insecure',
    oracleConnectType: values.oracleConnectType,
  });
}

/**
 * 파싱한 URL 을 폼 값 조각으로 옮긴다.
 *
 * URL 이 말하지 않은 것은 키를 만들지 않는다 — 없는 값을 기본값으로 채우면
 * 붙여넣기 한 번에 화면에 맞춰 둔 설정이 되돌아간다.
 */
function patchFromUrl(value: ParsedConnectionUrl): Partial<FormValues> {
  const patch: Partial<FormValues> = {
    dialect: value.dialect,
    host: value.host,
    port: String(value.port),
    database: value.database,
  };
  if (value.user) {
    patch.user = value.user;
  }
  if (value.password) {
    patch.password = value.password;
  }
  if (value.oracleConnectType) {
    patch.oracleConnectType = value.oracleConnectType;
  }
  if (value.tlsEnabled !== undefined) {
    patch.tlsEnabled = value.tlsEnabled;
    if (value.tlsEnabled) {
      // URL 은 CA 파일 경로까지 말해 주지 않는다 — 검증은 시스템 저장소로.
      patch.tlsVerify = value.tlsVerify === false ? 'insecure' : 'system';
    }
  }
  return patch;
}

/**
 * 저장할 수 있는 값인지 확인한다.
 *
 * 웹뷰에도 같은 규칙이 있지만(`media/connection.js`), 그쪽은 입력 중에 알려 주기
 * 위한 것이고 판정은 여기서 한다 — 메시지는 어디서 오든 검증해야 한다.
 */
function validate(values: FormValues): string | undefined {
  if (!values.host.trim()) {
    return '호스트를 입력하세요.';
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '포트는 1–65535 사이의 정수여야 합니다.';
  }
  if (requiresDatabase(values.dialect) && !values.database.trim()) {
    return `${databaseLabel(values.dialect, values.oracleConnectType)}을(를) 입력하세요.`;
  }
  if (!values.user.trim()) {
    return '사용자를 입력하세요.';
  }
  if (values.tlsEnabled && values.tlsVerify === 'ca' && !values.caPath.trim()) {
    return 'CA 인증서 파일을 지정하세요.';
  }
  return undefined;
}

/**
 * 폼이 묻지 않은 값(풀 설정·클라이언트 인증서·폴더 등)은 기존 프로필에서 그대로
 * 가져온다. 여기서 빠뜨리면 이름만 고쳤는데 풀 설정이 초기화되는 사고가 난다.
 */
function toDraft(values: FormValues, existing: ConnectionProfile | undefined): ConnectionProfileDraft {
  const tlsEnabled = values.tlsEnabled;
  return {
    name: values.name.trim() || suggestedName(values),
    dialect: values.dialect,
    host: values.host.trim(),
    port: Number(values.port),
    database: values.database.trim(),
    user: values.user.trim(),
    savePassword: values.savePassword,
    readOnly: values.readOnly,
    tls: {
      enabled: tlsEnabled,
      rejectUnauthorized: !tlsEnabled || values.tlsVerify !== 'insecure',
      caPath: tlsEnabled && values.tlsVerify === 'ca' ? values.caPath.trim() : undefined,
      certPath: existing?.tls.certPath,
      keyPath: existing?.tls.keyPath,
      servername: existing?.tls.servername,
    },
    pool: existing?.pool ?? poolOptionsFromSettings(),
    connectTimeoutMs: existing?.connectTimeoutMs ?? 15_000,
    oracle:
      values.dialect === 'oracle'
        ? {
            connectType: values.oracleConnectType,
            connectString: existing?.oracle?.connectString,
          }
        : undefined,
    color: existing?.color,
    // 폴더는 폼에서 묻지 않는다 — 트리에서 끌어다 놓거나 메뉴로 옮긴다.
    folder: existing?.folder,
    environment: values.environment,
  };
}

/** 이름을 비워 뒀을 때 대신 쓸 이름. 화면에도 같은 문구를 미리 보여 준다. */
function suggestedName(values: FormValues): string {
  const host = values.host.trim() || 'localhost';
  return `${DIALECT_LABELS[values.dialect]} · ${host}`;
}

function requiresDatabase(dialect: DialectId): boolean {
  return dialect === 'postgres' || dialect === 'oracle';
}

function databaseLabel(dialect: DialectId, connectType: 'service' | 'sid'): string {
  if (dialect !== 'oracle') {
    return '데이터베이스';
  }
  return connectType === 'sid' ? 'SID' : '서비스 이름';
}

function defaultUser(dialect: DialectId): string {
  switch (dialect) {
    case 'postgres':
      return 'postgres';
    case 'oracle':
      return 'system';
    default:
      return 'root';
  }
}
