import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { passwordSecretKey } from './passwordSecrets';
import { AuthMethod, PasswordAction, SessionProfile } from './types';

interface SubmittedProfile {
  sessionName: string;
  hostName: string;
  portNumber: number;
  userName: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
}

type ToExtensionMessage =
  | { type: 'ready' }
  | { type: 'pickKeyFile' }
  | { type: 'submit'; profile: SubmittedProfile; passwordAction: PasswordAction }
  | { type: 'cancel' };

type ToWebviewMessage =
  | { type: 'init'; mode: 'add' | 'edit'; profile: SessionProfile | null; hasSavedPassword: boolean }
  | { type: 'keyFilePicked'; path: string }
  | { type: 'error'; message: string };

export interface SessionFormResult {
  profile: Omit<SessionProfile, 'id'>;
  passwordAction: PasswordAction;
}

/** SSH 세션 정보를 순차 QuickPick 대신 한 화면짜리 웹뷰 폼으로 입력받는다. */
export function openSessionFormPanel(
  extensionUri: vscode.Uri,
  secrets: vscode.SecretStorage,
  existing?: SessionProfile
): Promise<SessionFormResult | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'vsshSessionForm',
      existing ? `세션 편집: ${existing.sessionName}` : 'VSsh: 새 세션',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    // 이 폼은 VShoon 이 모달 편집기로 열어 준다 (package.json 의 vshoon.ui.modalWebviews).
    // 확장은 평범한 웹뷰 패널을 만들 뿐이고, 창을 옮기거나 크롬을 접는 일은 하지 않는다.
    // 폼을 좁은 카드로 묶어 가운데 두는 CSS 는 그대로 둔다 - 모달이 넓어도 모양이 유지된다.

    let settled = false;
    const finish = (result: SessionFormResult | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      panel.dispose();
    };

    const post = (message: ToWebviewMessage): void => {
      void panel.webview.postMessage(message);
    };

    panel.webview.html = buildHtml(panel.webview, extensionUri, existing);
    panel.onDidDispose(() => finish(undefined));

    panel.webview.onDidReceiveMessage(async (message: ToExtensionMessage) => {
      switch (message.type) {
        case 'ready': {
          const hasSavedPassword = existing ? (await secrets.get(passwordSecretKey(existing.id))) !== undefined : false;
          post({ type: 'init', mode: existing ? 'edit' : 'add', profile: existing ?? null, hasSavedPassword });
          break;
        }
        case 'pickKeyFile': {
          const picked = await vscode.window.showOpenDialog({
            title: '개인키 파일 선택',
            canSelectMany: false,
            defaultUri: existing?.privateKeyPath ? vscode.Uri.file(existing.privateKeyPath) : undefined,
          });
          if (picked && picked[0]) {
            post({ type: 'keyFilePicked', path: picked[0].fsPath });
          }
          break;
        }
        case 'submit': {
          const { profile, passwordAction } = message;
          if (!profile || typeof profile !== 'object') {
            post({ type: 'error', message: '세션 정보 형식이 올바르지 않습니다.' });
            return;
          }
          if (!isAuthMethod(profile.authMethod) || !isPasswordAction(passwordAction)) {
            post({ type: 'error', message: '인증 정보 형식이 올바르지 않습니다.' });
            return;
          }
          if (
            typeof profile.sessionName !== 'string' ||
            typeof profile.hostName !== 'string' ||
            typeof profile.userName !== 'string' ||
            typeof profile.portNumber !== 'number' ||
            (profile.privateKeyPath !== undefined && typeof profile.privateKeyPath !== 'string')
          ) {
            post({ type: 'error', message: '세션 입력값 형식이 올바르지 않습니다.' });
            return;
          }
          if (!profile.sessionName.trim() || !profile.hostName.trim()) {
            post({ type: 'error', message: '세션 이름과 호스트는 필수입니다.' });
            return;
          }
          if ([profile.sessionName, profile.hostName, profile.userName].some((value) => hasControlCharacters(value))) {
            post({ type: 'error', message: '세션 정보에 제어 문자를 사용할 수 없습니다.' });
            return;
          }
          if (!Number.isInteger(profile.portNumber) || profile.portNumber < 1 || profile.portNumber > 65535) {
            post({ type: 'error', message: '포트는 1~65535 사이의 정수여야 합니다.' });
            return;
          }
          if (profile.authMethod !== 'password' && !profile.privateKeyPath) {
            post({ type: 'error', message: '개인키 파일을 선택하세요.' });
            return;
          }
          finish({
            profile: {
              sessionName: profile.sessionName.trim(),
              hostName: profile.hostName.trim(),
              portNumber: profile.portNumber,
              userName: profile.userName,
              authMethod: profile.authMethod,
              privateKeyPath: profile.authMethod === 'password' ? undefined : profile.privateKeyPath,
              encoding: existing?.encoding,
              fontFamily: existing?.fontFamily,
              fontSize: existing?.fontSize,
            },
            passwordAction,
          });
          break;
        }
        case 'cancel':
          finish(undefined);
          break;
      }
    });
  });
}

function isAuthMethod(value: unknown): value is AuthMethod {
  return value === 'password' || value === 'openssh-key' || value === 'ppk';
}

function isPasswordAction(value: unknown): value is PasswordAction {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const action = value as { type?: unknown; password?: unknown };
  if (action.type === 'keep' || action.type === 'forget') return true;
  return action.type === 'save' && typeof action.password === 'string';
}

function hasControlCharacters(value: unknown): boolean {
  return typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value);
}

function nonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, existing: SessionProfile | undefined): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sessionForm.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sessionForm.css'));
  const n = nonce();
  const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${n}'`].join('; ');
  const heading = existing ? `세션 편집: ${escapeHtml(existing.sessionName)}` : '새 세션';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>${heading}</title>
</head>
<body>
  <div class="card">
  <h1>${heading}</h1>
  <form id="form">
    <div class="field">
      <label for="sessionName">세션 이름</label>
      <input id="sessionName" type="text" required autocomplete="off">
    </div>
    <div class="field">
      <label for="hostName">호스트</label>
      <input id="hostName" type="text" required autocomplete="off" placeholder="example.com 또는 IP 주소">
    </div>
    <div class="row">
      <div class="field port">
        <label for="portNumber">포트</label>
        <input id="portNumber" type="number" value="22" min="1" max="65535">
      </div>
      <div class="field grow">
        <label for="userName">사용자 이름</label>
        <input id="userName" type="text" autocomplete="off">
      </div>
    </div>

    <fieldset class="field">
      <legend>인증 방식</legend>
      <label class="radio"><input type="radio" name="authMethod" value="password" checked> 비밀번호</label>
      <label class="radio"><input type="radio" name="authMethod" value="openssh-key"> OpenSSH 개인키</label>
      <label class="radio"><input type="radio" name="authMethod" value="ppk"> PuTTY .ppk 키</label>
    </fieldset>

    <div class="field" id="passwordSection">
      <label for="passwordAction">비밀번호 저장</label>
      <select id="passwordAction">
        <option value="keep-none">저장 안 함 (매번 입력)</option>
        <option value="save">지금 입력하고 저장</option>
        <option value="keep-saved">저장된 비밀번호 유지</option>
        <option value="forget">저장된 비밀번호 삭제 (매번 입력으로 전환)</option>
      </select>
      <input id="passwordInput" type="password" placeholder="비밀번호" autocomplete="new-password" style="display:none">
    </div>

    <div class="field" id="keySection" style="display:none">
      <label for="privateKeyPath">개인키 파일</label>
      <div class="row">
        <input id="privateKeyPath" type="text" readonly placeholder="선택된 파일 없음" class="grow">
        <button type="button" id="browseKeyBtn" class="secondary">찾아보기</button>
      </div>
    </div>

    <div id="errorBox" class="error" role="alert"></div>

    <div class="actions">
      <button type="button" id="cancelBtn" class="secondary">취소</button>
      <button type="submit" id="saveBtn">저장</button>
    </div>
  </form>
  </div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
