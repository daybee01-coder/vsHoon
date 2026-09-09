import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Client } from 'ssh2';
import { SessionProfile } from '../sessions/types';
import { connect } from '../ssh/connection';
import { HostKeyStore } from '../ssh/hostKeyStore';
import { SshFileSession } from '../ssh/sshFileSession';
import { ActiveSessionManager } from './activeSessionManager';
import { AsyncSemaphore } from './asyncSemaphore';
import { FileSession, joinRemotePath } from './fileSession';
import { LocalFileSession } from './localFileSession';
import { SftpFileSystemProvider } from './sftpFileSystemProvider';
import { cdTerminalToPath } from './sftpTerminalSync';
import { TransferItem, TransferQueue } from './transferQueue';

type Pane = 'local' | 'remote';

interface InboundMessage {
  type: string;
  pane?: Pane;
  from?: Pane;
  name?: string;
  names?: string[];
  path?: string;
  intoDir?: string;
  sync?: boolean;
  id?: string;
  paths?: string[];
}

const LOCAL_PATH_KEY = 'vssh.sftp.localPath';
const QUEUE_UI_INTERVAL_MS = 250;

/**
 * 하단 패널의 SFTP 탭을 파일질라식 2-패널(왼쪽 로컬 / 오른쪽 원격) 웹뷰로 제공한다.
 * 원격 쪽은 activeSessionManager가 가리키는 현재 SSH/WSL 세션을 따라간다.
 */
export class SftpPanelView implements vscode.WebviewViewProvider {
  static readonly viewId = 'vssh.sftp';

  private view: vscode.WebviewView | undefined;
  private readonly localSession = new LocalFileSession();
  /** 실제 파일 작업에 쓰는 원격 세션. 평소엔 터미널 세션과 같고, 수동 사용자 변경 시 오버라이드 세션이 된다. */
  private remoteSession: FileSession | undefined;
  /** 활성 터미널을 따라가는 원격 세션. 오버라이드가 걸려 있어도 "복귀"할 대상으로 계속 추적한다. */
  private terminalSession: FileSession | undefined;
  /** SFTP 패널에서 다른 사용자로 직접 연 세션. 이 연결의 수명은 패널이 소유한다(client.end 책임). */
  private userOverride: { session: SshFileSession; client: Client } | undefined;
  private remoteInitialization: { session: FileSession; promise: Promise<void> } | undefined;
  private localPath: string;
  private remotePath = '/';
  private readonly queue: TransferQueue;
  private readonly transferStatusBar: vscode.StatusBarItem;
  private readonly progressItemIds = new Set<string>();
  private statusHideTimer: ReturnType<typeof setTimeout> | undefined;
  private queueUiTimer: ReturnType<typeof setTimeout> | undefined;
  private lastQueueUiUpdate = 0;
  private queueWasIdle = true;
  private readonly scanSemaphore = new AsyncSemaphore(8);
  private readonly createdRemoteDirs = new WeakMap<FileSession, Set<string>>();
  private seq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly activeSessionManager: ActiveSessionManager,
    private readonly fsProvider: SftpFileSystemProvider,
    private readonly hostKeyStore: HostKeyStore
  ) {
    this.localPath =
      this.context.globalState.get<string>(LOCAL_PATH_KEY) ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      os.homedir();

    this.transferStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.transferStatusBar.name = 'VSsh 전체 전송 진행률';
    this.transferStatusBar.command = 'vssh.sftp.toggleQueue';
    context.subscriptions.push(this.transferStatusBar);

    this.queue = new TransferQueue(
      (item, onProgress, signal) => this.runTransfer(item, onProgress, signal),
      this.config<number>('maxConcurrentTransfers', 5)
    );
    context.subscriptions.push(this.queue.onDidUpdate(() => {
      const idle = this.queue.isIdle();
      if (idle) this.flushQueueUiUpdate();
      else this.scheduleQueueUiUpdate();
      if (idle && !this.queueWasIdle) {
        void this.listPane('local');
        void this.listPane('remote');
      }
      this.queueWasIdle = idle;
    }));

    context.subscriptions.push(
      new vscode.Disposable(() => {
        if (this.queueUiTimer) clearTimeout(this.queueUiTimer);
        if (this.statusHideTimer) clearTimeout(this.statusHideTimer);
      })
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vssh.sftp.maxConcurrentTransfers')) {
          this.queue.setConcurrency(this.config<number>('maxConcurrentTransfers', 5));
        }
      })
    );

    this.terminalSession = activeSessionManager.getActive();
    this.remoteSession = this.terminalSession;
    if (this.remoteSession) void this.initRemote();
    context.subscriptions.push(
      activeSessionManager.onDidChangeActive((session) => {
        this.terminalSession = session;
        // 수동 사용자 변경(오버라이드)이 걸려 있으면 터미널 전환이 SFTP 패널을 덮어쓰지 않는다.
        if (this.userOverride) return;
        this.remoteSession = session;
        this.remotePath = '/';
        void this.initRemote();
      })
    );
    context.subscriptions.push(new vscode.Disposable(() => this.disposeUserOverride()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: InboundMessage) => void this.onMessage(msg));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  /** 타이틀 바 새로고침 명령용. */
  refreshBoth(): void {
    void this.listPane('local');
    void this.listPane('remote');
  }

  /** 타이틀 바 숨김 파일 표시 명령용. */
  toggleHiddenFiles(): void {
    this.post({ type: 'toggleHidden' });
  }

  /** 타이틀 바 전송 목록 표시 명령용. */
  toggleTransferQueue(): void {
    this.post({ type: 'toggleQueue' });
  }

  /** 타이틀 바 동기 탐색 명령용. */
  toggleSynchronizedNavigation(): void {
    this.post({ type: 'toggleSync' });
  }

  /** 터미널 위치 따라가기 명령용. */
  async navigateRemote(target: string): Promise<void> {
    await this.navigate('remote', target);
  }

  // ---- 사용자 변경 (오버라이드) ------------------------------------------------

  /**
   * SFTP 패널만 다른 사용자로 전환한다. 현재 원격 세션과 같은 호스트/포트로 새 SSH 연결을
   * 열어(별도 자격증명 입력) SFTP 세션을 교체하며, 터미널 세션은 그대로 둔다.
   *
   * 터미널에서 `su - other`를 해도 SFTP subsystem은 별개 채널이라 그 변경을 따라가지 못한다.
   * 그래서 "따라가기"가 아니라 사용자가 명시적으로 다른 계정으로 재접속하는 방식으로 제공한다.
   */
  async changeRemoteUser(): Promise<void> {
    // 이미 오버라이드 중이면 다시 바꿀지/원래 세션으로 복귀할지 먼저 고른다.
    if (this.userOverride) {
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(account) 다른 사용자로 다시 연결…', action: 'change' as const },
          {
            label: '$(discard) 원래(터미널) 세션으로 복귀',
            description: this.terminalSession?.label ?? '연결 없음',
            action: 'revert' as const,
          },
        ],
        { title: 'VSsh SFTP: 사용자 변경', ignoreFocusOut: true }
      );
      if (!action) return;
      if (action.action === 'revert') {
        this.revertRemoteUser();
        vscode.window.showInformationMessage('VSsh: SFTP를 원래 터미널 세션으로 되돌렸습니다.');
        return;
      }
    }

    const base = this.userOverride?.session ?? this.terminalSession;
    const conn = base instanceof SshFileSession ? base.connection : undefined;
    if (!conn) {
      vscode.window.showWarningMessage(
        'VSsh: 먼저 원격 SSH/WSL 세션에 연결하세요. 현재 호스트 정보를 알 수 없어 사용자를 변경할 수 없습니다.'
      );
      return;
    }

    const input = await vscode.window.showInputBox({
      title: `VSsh SFTP: ${conn.host}:${conn.port} 사용자 변경`,
      prompt: '연결할 사용자 이름',
      value: conn.username,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : '사용자 이름을 입력하세요.'),
    });
    if (input === undefined) return;
    const user = input.trim();

    const password = await vscode.window.showInputBox({
      title: `VSsh SFTP: ${user}@${conn.host} 비밀번호`,
      prompt: `${user}@${conn.host}:${conn.port}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return;

    // 저장된 비밀번호를 읽지 않도록 passwordOverride로 넘긴다. 호스트 키는 같은 host:port라
    // 기존 저장 지문으로 재검증되어 추가 프롬프트가 없다.
    const profile: SessionProfile = {
      id: `sftp-user-override:${conn.host}:${conn.port}:${user}`,
      sessionName: `${user}@${conn.host}`,
      hostName: conn.host,
      portNumber: conn.port,
      userName: user,
      authMethod: 'password',
    };

    let client: Client;
    try {
      const connection = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSsh: ${user}@${conn.host} SFTP 연결 중...` },
        () => connect(profile, this.hostKeyStore, this.context.secrets, password)
      );
      client = connection.client;
    } catch (err) {
      vscode.window.showErrorMessage(`VSsh: 사용자 변경 실패 - ${describe(err)}`);
      return;
    }

    const session = new SshFileSession(client, `${user}@${conn.host}`, {
      host: conn.host,
      port: conn.port,
      username: user,
    });
    this.fsProvider.register(session);

    // 이전 오버라이드 연결을 정리하고 새 것으로 교체한다.
    this.disposeUserOverride();
    this.userOverride = { session, client };

    client.on('close', () => {
      this.fsProvider.unregister(session.id);
      // 이 오버라이드가 아직 활성일 때만 원래 세션으로 되돌린다(교체로 이미 바뀌었으면 무시).
      if (this.userOverride?.client === client) {
        this.userOverride = undefined;
        this.remoteSession = this.terminalSession;
        this.remotePath = '/';
        void this.initRemote();
      }
    });

    this.remoteSession = session;
    this.remotePath = '/';
    await this.initRemote();
    vscode.window.showInformationMessage(`VSsh: SFTP를 ${user}@${conn.host} 사용자로 전환했습니다.`);
  }

  private revertRemoteUser(): void {
    if (!this.userOverride) return;
    this.disposeUserOverride();
    this.remoteSession = this.terminalSession;
    this.remotePath = '/';
    void this.initRemote();
  }

  private disposeUserOverride(): void {
    const override = this.userOverride;
    if (!override) return;
    this.userOverride = undefined;
    this.fsProvider.unregister(override.session.id);
    override.client.end();
  }

  // ---- 메시지 처리 -----------------------------------------------------------

  private async onMessage(msg: InboundMessage): Promise<void> {
    if (msg.pane !== undefined && msg.pane !== 'local' && msg.pane !== 'remote') return;
    if (msg.from !== undefined && msg.from !== 'local' && msg.from !== 'remote') return;
    if (msg.name !== undefined && this.leafNameError(msg.name)) return;
    if (
      msg.names !== undefined &&
      (!Array.isArray(msg.names) || msg.names.some((name) => typeof name !== 'string' || !!this.leafNameError(name)))
    ) {
      return;
    }
    if (msg.intoDir !== undefined && this.leafNameError(msg.intoDir)) return;
    if (
      msg.paths !== undefined &&
      (!Array.isArray(msg.paths) || msg.paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p)))
    ) {
      return;
    }

    switch (msg.type) {
      case 'ready':
        this.postState();
        await Promise.all([
          this.listPane('local'),
          this.remoteSession ? this.initRemote() : this.listPane('remote'),
        ]);
        this.postQueue();
        break;
      case 'refresh':
        if (msg.pane) await this.listPane(msg.pane);
        break;
      case 'up':
        if (msg.pane) await this.enter(msg.pane, '..', msg.sync);
        break;
      case 'enter':
        if (msg.pane && msg.name !== undefined) await this.enter(msg.pane, msg.name, msg.sync);
        break;
      case 'navigate':
        if (msg.pane && msg.path) await this.navigate(msg.pane, msg.path);
        break;
      case 'open':
        if (msg.pane && msg.name) await this.openEntry(msg.pane, msg.name);
        break;
      case 'openSymlink':
        if (msg.pane && msg.name) await this.openSymlink(msg.pane, msg.name);
        break;
      case 'transfer':
        if (msg.from && msg.names) await this.startTransfer(msg.from, msg.names, msg.intoDir);
        break;
      case 'osFileDrop':
        if (msg.pane && msg.paths?.length) await this.dropFromOs(msg.pane, msg.paths, msg.intoDir);
        break;
      case 'osDragStart':
        if (msg.pane && msg.names?.length) await this.startOsDrag(msg.pane, msg.names);
        break;
      case 'mkdirRequest':
        if (msg.pane) await this.mkdirInteractive(msg.pane);
        break;
      case 'renameRequest':
        if (msg.pane && msg.name) await this.renameInteractive(msg.pane, msg.name);
        break;
      case 'deleteRequest':
        if (msg.pane && msg.names) await this.deleteInteractive(msg.pane, msg.names);
        break;
      case 'openTerminalHere':
        cdTerminalToPath(this.activeSessionManager, this.remotePath);
        break;
      case 'pickLocalFolder':
        await this.pickLocalFolder();
        break;
      case 'queueCancel':
        this.queue.cancelAll();
        break;
      case 'queueCancelItem':
        if (msg.id) this.queue.cancelItem(msg.id);
        break;
      case 'queueClear':
        this.queue.clearFinished();
        break;
    }
  }

  // ---- 탐색 ---------------------------------------------------------------

  private async initRemote(): Promise<void> {
    const session = this.remoteSession;
    if (!session) {
      this.postState();
      await this.listPane('remote');
      return;
    }

    // 세션 활성화와 Webview의 ready 메시지가 거의 동시에 들어오면 초기화가 두 번
    // 실행될 수 있다. WSL은 호출마다 wsl.exe를 새로 띄우므로 같은 세션의 초기화는
    // 하나로 합쳐 불필요한 홈 경로 조회와 디렉터리 목록 요청을 막는다.
    if (this.remoteInitialization?.session === session) {
      await this.remoteInitialization.promise;
      return;
    }

    const promise = this.initializeRemoteSession(session);
    this.remoteInitialization = { session, promise };
    try {
      await promise;
    } finally {
      if (this.remoteInitialization?.promise === promise) {
        this.remoteInitialization = undefined;
      }
    }
  }

  private async initializeRemoteSession(session: FileSession): Promise<void> {
    try {
      this.remotePath = await session.realpath('.');
    } catch {
      this.remotePath = '/';
    }

    // 조회 중 활성 터미널이 바뀌었다면 이전 세션의 결과를 새 화면에 표시하지 않는다.
    if (this.remoteSession !== session) return;

    this.postState();
    await this.listPane('remote');
  }

  private async listPane(pane: Pane): Promise<void> {
    if (!this.view) return;
    const session = pane === 'local' ? this.localSession : this.remoteSession;
    const dir = pane === 'local' ? this.localPath : this.remotePath;
    if (!session) {
      this.post({
        type: 'list',
        pane,
        path: '',
        entries: [],
        error: '연결된 세션이 없습니다. Sessions 뷰에서 세션에 연결하세요.',
      });
      return;
    }
    try {
      const entries = await session.readdir(dir);
      this.post({ type: 'list', pane, path: dir, entries });
    } catch (err) {
      this.post({ type: 'list', pane, path: dir, entries: [], error: describe(err) });
    }
  }

  private async enter(pane: Pane, name: string, sync?: boolean): Promise<void> {
    await this.doEnter(pane, name);
    if (sync) {
      const other: Pane = pane === 'local' ? 'remote' : 'local';
      try {
        await this.doEnter(other, name, true);
      } catch {
        // 반대쪽에 같은 하위 폴더가 없으면 그쪽은 그대로 둔다.
      }
    }
  }

  private async doEnter(pane: Pane, name: string, verify?: boolean): Promise<void> {
    const nextPath =
      pane === 'local'
        ? name === '..'
          ? path.dirname(this.localPath)
          : path.join(this.localPath, name)
        : name === '..'
          ? path.posix.dirname(this.remotePath)
          : joinRemotePath(this.remotePath, name);

    if (verify) {
      const session = pane === 'local' ? this.localSession : this.remoteSession;
      if (!session) throw new Error('세션 없음');
      await session.readdir(nextPath); // 없으면 throw → 호출부에서 무시
    }

    if (pane === 'local') {
      this.localPath = nextPath;
      this.persistLocalPath();
    } else {
      this.remotePath = nextPath;
    }
    this.postState();
    await this.listPane(pane);
  }

  private async navigate(pane: Pane, target: string): Promise<void> {
    const session = pane === 'local' ? this.localSession : this.remoteSession;
    if (!session) return;
    try {
      await session.readdir(target);
    } catch (err) {
      vscode.window.showErrorMessage(`VSsh: "${target}" 로 이동할 수 없습니다 - ${describe(err)}`);
      this.postState();
      return;
    }
    if (pane === 'local') {
      this.localPath = target;
      this.persistLocalPath();
    } else {
      this.remotePath = target;
    }
    this.postState();
    await this.listPane(pane);
  }

  private async openEntry(pane: Pane, name: string): Promise<void> {
    if (pane === 'local') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(this.localPath, name)));
      return;
    }
    const session = this.remoteSession;
    if (session instanceof SshFileSession && this.fsProvider.has(session.id)) {
      // 원격 파일을 진짜 에디터로 연다 (저장하면 SFTP로 자동 업로드).
      const uri = SftpFileSystemProvider.uri(session.id, joinRemotePath(this.remotePath, name));
      await vscode.commands.executeCommand('vscode.open', uri);
    } else {
      // SSH가 아니면 (WSL 등) 로컬 패널 현재 위치로 다운로드
      await this.startTransfer('remote', [name]);
    }
  }

  /** 심링크: 디렉터리면 진입, 아니면 파일로 연다. */
  private async openSymlink(pane: Pane, name: string): Promise<void> {
    const session = pane === 'local' ? this.localSession : this.remoteSession;
    if (!session) return;
    const target = this.childPath(pane, name);
    try {
      await session.readdir(target);
      await this.doEnter(pane, name);
    } catch {
      await this.openEntry(pane, name);
    }
  }

  private async pickLocalFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: 'VSsh: 로컬 폴더 선택',
      defaultUri: vscode.Uri.file(this.localPath),
    });
    if (!picked || !picked[0]) return;
    this.localPath = picked[0].fsPath;
    this.persistLocalPath();
    this.postState();
    await this.listPane('local');
  }

  // ---- 파일 작업 --------------------------------------------------------------

  private async mkdirInteractive(pane: Pane): Promise<void> {
    const session = this.sessionFor(pane);
    if (!session) return;
    const name = await vscode.window.showInputBox({
      title: 'VSsh: 새 폴더 이름',
      ignoreFocusOut: true,
      validateInput: (v) => this.leafNameError(v),
    });
    if (!name) return;
    try {
      await session.mkdir(this.childPath(pane, name));
    } catch (err) {
      vscode.window.showErrorMessage(`VSsh: 폴더 생성 실패 - ${describe(err)}`);
      return;
    }
    await this.listPane(pane);
  }

  private async renameInteractive(pane: Pane, name: string): Promise<void> {
    const session = this.sessionFor(pane);
    if (!session) return;
    const newName = await vscode.window.showInputBox({
      title: 'VSsh: 이름 변경',
      value: name,
      ignoreFocusOut: true,
      validateInput: (v) => this.leafNameError(v),
    });
    if (!newName || newName === name) return;
    try {
      await session.rename(this.childPath(pane, name), this.childPath(pane, newName));
    } catch (err) {
      vscode.window.showErrorMessage(`VSsh: 이름 변경 실패 - ${describe(err)}`);
      return;
    }
    await this.listPane(pane);
  }

  private async deleteInteractive(pane: Pane, names: string[]): Promise<void> {
    const session = this.sessionFor(pane);
    if (!session || names.length === 0) return;
    const label = names.length === 1 ? `"${names[0]}"` : `${names.length}개 항목`;
    const choice = await vscode.window.showWarningMessage(
      `${label}을(를) 삭제하시겠습니까? (폴더는 하위 항목까지 모두 삭제됩니다)`,
      { modal: true },
      '삭제'
    );
    if (choice !== '삭제') return;

    const dir = pane === 'local' ? this.localPath : this.remotePath;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'VSsh: 삭제 중', cancellable: false },
      async (progress) => {
        let byName: Map<string, boolean>;
        try {
          byName = new Map((await session.readdir(dir)).map((e) => [e.name, e.isDirectory]));
        } catch {
          byName = new Map();
        }
        for (const name of names) {
          progress.report({ message: name });
          const full = this.childPath(pane, name);
          try {
            if (byName.get(name)) {
              await this.deleteRecursive(session, full, pane === 'local');
            } else {
              await session.unlink(full);
            }
          } catch (err) {
            vscode.window.showErrorMessage(`VSsh: "${name}" 삭제 실패 - ${describe(err)}`);
          }
        }
      }
    );
    await this.listPane(pane);
  }

  private async deleteRecursive(session: FileSession, dir: string, isLocal: boolean): Promise<void> {
    if (isLocal) {
      // LocalFileSession.rmdir 은 재귀 삭제로 구현되어 있다.
      await session.rmdir(dir);
      return;
    }
    for (const entry of await session.readdir(dir)) {
      const child = joinRemotePath(dir, entry.name);
      if (entry.isDirectory) {
        await this.deleteRecursive(session, child, false);
      } else {
        await session.unlink(child);
      }
    }
    await session.rmdir(dir);
  }

  // ---- 전송 -----------------------------------------------------------------

  private async startTransfer(from: Pane, names: string[], intoDir?: string): Promise<void> {
    const remoteSession = this.remoteSession;
    if (!remoteSession) {
      vscode.window.showWarningMessage('VSsh: 먼저 세션에 연결하세요.');
      return;
    }
    if (names.length === 0) return;

    const toRemote = from === 'local';
    const baseDest = toRemote ? this.remotePath : this.localPath;
    const destDir = intoDir
      ? toRemote
        ? joinRemotePath(baseDest, intoDir)
        : path.join(baseDest, intoDir)
      : baseDest;

    let items: TransferItem[];
    try {
      items = toRemote
        ? await this.buildUploadItems(remoteSession, names, destDir)
        : await this.buildDownloadItems(remoteSession, names, destDir);
    } catch (err) {
      vscode.window.showErrorMessage(`VSsh: 전송 목록을 만들지 못했습니다 - ${describe(err)}`);
      return;
    }
    await this.queueTransferItems(remoteSession, items, toRemote);
  }

  /**
   * 패널에서 시작한 드래그를 셸에 넘긴다.
   *
   * 웹뷰는 OS 드래그를 시작할 수 없다. 여기서 실제 경로를 확정해 웹뷰로 돌려주면, 웹뷰가 그것을
   * Workbench seam으로 전달하고 seam이 네이티브 드래그를 연다(VSH-0012/VSH-0013). 로컬 항목은
   * 이미 디스크에 있으므로 확인만 하면 된다.
   */
  private async startOsDrag(pane: Pane, names: string[]): Promise<void> {
    if (pane !== 'local') {
      return;
    }

    const paths: string[] = [];
    for (const name of names) {
      const candidate = path.join(this.localPath, name);
      try {
        await fs.promises.stat(candidate);
        paths.push(candidate);
      } catch {
        // 목록과 디스크가 어긋난 항목은 조용히 건너뛴다.
      }
    }
    if (paths.length === 0) return;

    this.post({ type: 'vshoon.osFileDragReady', paths });
  }

  /**
   * 윈도우 탐색기에서 끌어온 파일을 받는다.
   *
   * 웹뷰는 OS 드롭을 직접 받을 수 없어 Workbench가 경로를 풀어 넘겨준다(VSH-0012). 웹뷰는 포인터가
   * 어느 패널의 무엇 위에 있었는지만 알려주므로, 여기서는 실제로 남아 있는 항목만 골라 기존 전송
   * 경로에 그대로 태운다.
   */
  private async dropFromOs(pane: Pane, paths: string[], intoDir?: string): Promise<void> {
    const sources: string[] = [];
    for (const candidate of paths) {
      try {
        await fs.promises.stat(candidate);
        sources.push(candidate);
      } catch {
        // 드롭과 처리 사이에 사라진 항목은 조용히 건너뛴다.
      }
    }
    if (sources.length === 0) return;

    if (pane === 'local') {
      await this.copyIntoLocalPane(sources, intoDir);
      return;
    }

    const remoteSession = this.remoteSession;
    if (!remoteSession) {
      vscode.window.showWarningMessage('VSsh: 먼저 세션에 연결하세요.');
      return;
    }

    const destDir = intoDir ? joinRemotePath(this.remotePath, intoDir) : this.remotePath;
    let items: TransferItem[];
    try {
      // 한 번의 드롭에도 서로 다른 폴더의 항목이 섞여 올 수 있어 부모 폴더별로 묶는다.
      const byParent = new Map<string, string[]>();
      for (const source of sources) {
        const parent = path.dirname(source);
        const group = byParent.get(parent);
        if (group) group.push(path.basename(source));
        else byParent.set(parent, [path.basename(source)]);
      }

      const groups = await Promise.all(
        [...byParent].map(([parent, names]) => this.buildUploadItems(remoteSession, names, destDir, parent))
      );
      items = groups.flat();
    } catch (err) {
      vscode.window.showErrorMessage(`VSsh: 전송 목록을 만들지 못했습니다 - ${describe(err)}`);
      return;
    }

    await this.queueTransferItems(remoteSession, items, true);
  }

  /** 로컬 패널에 놓은 항목은 원격을 거치지 않고 지금 보고 있는 폴더로 복사한다. */
  private async copyIntoLocalPane(sources: string[], intoDir?: string): Promise<void> {
    const destDir = intoDir ? path.join(this.localPath, intoDir) : this.localPath;

    // 자기 자신이나 자기 하위 폴더로의 복사는 원본을 망가뜨린다.
    const copyable = sources.filter((source) => {
      const target = path.join(destDir, path.basename(source));
      const relative = path.relative(source, target);
      return relative !== '' && (path.isAbsolute(relative) || relative.startsWith('..'));
    });
    if (copyable.length === 0) return;

    const existing: string[] = [];
    for (const source of copyable) {
      try {
        await fs.promises.stat(path.join(destDir, path.basename(source)));
        existing.push(source);
      } catch {
        // 대상에 없으면 그대로 복사한다.
      }
    }

    let planned = copyable;
    if (existing.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `이미 있는 항목 ${existing.length}개를 덮어쓸까요?`,
        { modal: true },
        '덮어쓰기',
        '건너뛰기'
      );
      if (!answer) return;
      if (answer === '건너뛰기') planned = copyable.filter((source) => !existing.includes(source));
    }
    if (planned.length === 0) return;

    let copied = 0;
    for (const source of planned) {
      try {
        await fs.promises.cp(source, path.join(destDir, path.basename(source)), { recursive: true, force: true });
        copied++;
      } catch (err) {
        vscode.window.showErrorMessage(`VSsh: ${path.basename(source)} 복사에 실패했습니다 - ${describe(err)}`);
      }
    }

    if (copied > 0) await this.listPane('local');
  }

  /** 전송 목록을 만든 뒤의 공통 경로: 충돌 확인, 덮어쓰기 정책, 큐 투입. */
  private async queueTransferItems(
    remoteSession: FileSession,
    items: TransferItem[],
    toRemote: boolean
  ): Promise<void> {
    if (items.length === 0) {
      vscode.window.showInformationMessage('VSsh: 전송할 파일이 없습니다.');
      return;
    }

    // 대상에 이미 있는 파일을 하위 폴더 안까지 전부 찾아서 어떻게 처리할지 확인한다.
    const conflicts = await this.findConflicts(remoteSession, items, toRemote);
    if (conflicts.size > 0) {
      const policy = await this.askOverwritePolicy(conflicts.size, items.length);
      if (policy === 'cancel') return;
      if (policy === 'skip') {
        items = items.filter((i) => !conflicts.has(i.id));
      } else if (policy === 'each') {
        items = await this.resolvePerFile(items, conflicts);
      }
      for (const it of items) if (conflicts.has(it.id)) it.overwrite = true;
      if (items.length === 0) return;
    }

    this.beginTransferProgress(items);
    this.queue.add(items);
  }

  private beginTransferProgress(items: TransferItem[]): void {
    if (this.queue.isIdle()) this.progressItemIds.clear();
    if (this.statusHideTimer) {
      clearTimeout(this.statusHideTimer);
      this.statusHideTimer = undefined;
    }
    for (const item of items) this.progressItemIds.add(item.id);
  }

  /** 여러 파일에서 동시에 오는 진행 이벤트를 합쳐 웹뷰 전체 재렌더링 횟수를 제한한다. */
  private scheduleQueueUiUpdate(): void {
    const elapsed = Date.now() - this.lastQueueUiUpdate;
    if (elapsed >= QUEUE_UI_INTERVAL_MS) {
      this.flushQueueUiUpdate();
      return;
    }
    if (this.queueUiTimer) return;
    this.queueUiTimer = setTimeout(() => this.flushQueueUiUpdate(), QUEUE_UI_INTERVAL_MS - elapsed);
  }

  private flushQueueUiUpdate(): void {
    if (this.queueUiTimer) {
      clearTimeout(this.queueUiTimer);
      this.queueUiTimer = undefined;
    }
    this.lastQueueUiUpdate = Date.now();
    this.postQueue();
    this.updateTransferStatusBar();
  }

  private updateTransferStatusBar(): void {
    const items = this.queue.list().filter((item) => this.progressItemIds.has(item.id));
    if (items.length === 0) {
      this.transferStatusBar.hide();
      return;
    }

    const running = items.some((item) => item.status === 'queued' || item.status === 'active');
    const failed = items.filter((item) => item.status === 'error').length;
    const canceled = items.filter((item) => item.status === 'canceled').length;
    const uploads = items.filter((item) => item.direction === 'upload').length;
    const downloads = items.length - uploads;
    const totalBytes = items.reduce((sum, item) => sum + Math.max(0, item.size), 0);
    const movedBytes = items.reduce((sum, item) => {
      if (item.status === 'done' || item.status === 'error' || item.status === 'canceled') {
        return sum + Math.max(0, item.size);
      }
      return sum + Math.min(Math.max(0, item.transferred), Math.max(0, item.size));
    }, 0);
    const terminalCount = items.filter(
      (item) => item.status === 'done' || item.status === 'error' || item.status === 'canceled'
    ).length;
    const ratio = totalBytes > 0 ? movedBytes / totalBytes : terminalCount / items.length;
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    const filled = Math.round(percent / 10);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
    const icon = running ? '$(sync~spin)' : failed > 0 ? '$(warning)' : '$(check)';

    this.transferStatusBar.text = `${icon} ${bar} ${percent}%  ↑${uploads} ↓${downloads}`;
    this.transferStatusBar.tooltip = [
      `VSsh 전체 전송: ${percent}%`,
      `업로드 ${uploads}개 · 다운로드 ${downloads}개`,
      failed ? `실패 ${failed}개` : '',
      canceled ? `취소 ${canceled}개` : '',
      '클릭하면 전송 목록을 표시하거나 숨깁니다.',
    ]
      .filter(Boolean)
      .join('\n');
    this.transferStatusBar.show();

    if (!running && !this.statusHideTimer) {
      this.statusHideTimer = setTimeout(() => {
        this.transferStatusBar.hide();
        this.progressItemIds.clear();
        this.statusHideTimer = undefined;
      }, 4000);
    }
  }

  /** 펼쳐진 전송 항목들 중 대상 경로가 이미 존재하는 것들의 id 집합. 대상 디렉터리별로 한 번씩만 조회한다. */
  private async findConflicts(
    remoteSession: FileSession,
    items: TransferItem[],
    toRemote: boolean
  ): Promise<Set<string>> {
    const session = toRemote ? remoteSession : this.localSession;
    const dirnameOf = toRemote ? path.posix.dirname : path.dirname;
    const basenameOf = toRemote ? path.posix.basename : path.basename;

    const byDir = new Map<string, TransferItem[]>();
    for (const it of items) {
      const dest = toRemote ? it.remotePath : it.localPath;
      const key = dirnameOf(dest);
      const bucket = byDir.get(key);
      if (bucket) bucket.push(it);
      else byDir.set(key, [it]);
    }

    const conflicts = new Set<string>();
    await Promise.all(
      [...byDir].map(async ([dir, bucket]) => {
        let present: Set<string>;
        try {
          present = new Set((await this.scanSemaphore.run(() => session.readdir(dir))).map((e) => e.name));
        } catch {
          return; // 대상 디렉터리가 아직 없음 → 충돌 아님
        }
        for (const it of bucket) {
          const dest = toRemote ? it.remotePath : it.localPath;
          const name = basenameOf(dest);
          if (toRemote) {
            if (present.has(name)) conflicts.add(it.id);
          } else {
            // Windows 로컬 파일시스템에서는 대소문자만 달라도 같은 파일일 수 있다.
            const folded = name.toLocaleLowerCase();
            if ([...present].some((candidate) => candidate.toLocaleLowerCase() === folded)) {
              conflicts.add(it.id);
            }
          }
        }
      })
    );
    return conflicts;
  }

  private async askOverwritePolicy(
    conflictCount: number,
    totalCount: number
  ): Promise<'overwrite' | 'skip' | 'each' | 'cancel'> {
    const pick = await vscode.window.showWarningMessage(
      `대상에 이미 있는 파일이 ${conflictCount}개 있습니다 (전체 ${totalCount}개). 어떻게 할까요?`,
      { modal: true },
      '모두 덮어쓰기',
      '새 파일만 전송',
      '하나씩 확인'
    );
    if (pick === '모두 덮어쓰기') return 'overwrite';
    if (pick === '새 파일만 전송') return 'skip';
    if (pick === '하나씩 확인') return 'each';
    return 'cancel';
  }

  /** 충돌하는 항목을 파일별로 물어본다. "나머지 전부" 선택으로 반복을 중간에 끝낼 수 있다. */
  private async resolvePerFile(items: TransferItem[], conflicts: Set<string>): Promise<TransferItem[]> {
    const kept: TransferItem[] = [];
    let applyAll: 'overwrite' | 'skip' | undefined;
    for (const it of items) {
      if (!conflicts.has(it.id)) {
        kept.push(it);
        continue;
      }
      if (applyAll === 'overwrite') {
        kept.push(it);
        continue;
      }
      if (applyAll === 'skip') continue;

      const pick = await vscode.window.showWarningMessage(
        `"${it.label}" 이(가) 대상에 이미 있습니다. 덮어쓸까요?`,
        { modal: true },
        '덮어쓰기',
        '건너뛰기',
        '나머지 전부 덮어쓰기'
      );
      if (pick === undefined) return []; // 취소(X/Esc) = 전체 중단
      if (pick === '덮어쓰기') kept.push(it);
      else if (pick === '나머지 전부 덮어쓰기') {
        applyAll = 'overwrite';
        kept.push(it);
      }
      // '건너뛰기' → 이 파일은 건너뜀
    }
    return kept;
  }

  private async buildUploadItems(
    remoteSession: FileSession,
    names: string[],
    destDir: string,
    sourceDir: string = this.localPath
  ): Promise<TransferItem[]> {
    const items: TransferItem[] = [];
    await Promise.all(
      names.map(async (name) => {
        const localBase = path.join(sourceDir, name);
        const remoteBase = joinRemotePath(destDir, name);
        const st = await this.scanSemaphore.run(() => fs.promises.stat(localBase));
        if (st.isDirectory()) {
          await this.walkLocalDir(remoteSession, localBase, remoteBase, name, items);
        } else {
          items.push(
            this.newItem(remoteSession, 'upload', name, localBase, remoteBase, st.size, st.mode & 0o777, st.mtimeMs)
          );
        }
      })
    );
    return items;
  }

  private async walkLocalDir(
    remoteSession: FileSession,
    localDir: string,
    remoteDir: string,
    rel: string,
    items: TransferItem[]
  ): Promise<void> {
    const dirents = await this.scanSemaphore.run(() => fs.promises.readdir(localDir, { withFileTypes: true }));
    if (dirents.length === 0) {
      await this.ensureRemoteDir(remoteSession, remoteDir);
      return;
    }
    await Promise.all(
      dirents.map(async (d) => {
        const lp = path.join(localDir, d.name);
        const rp = joinRemotePath(remoteDir, d.name);
        const childRel = `${rel}/${d.name}`;
        if (d.isDirectory()) {
          await this.walkLocalDir(remoteSession, lp, rp, childRel, items);
        } else {
          try {
            const st = await this.scanSemaphore.run(() => fs.promises.stat(lp));
            items.push(
              this.newItem(remoteSession, 'upload', childRel, lp, rp, st.size, st.mode & 0o777, st.mtimeMs)
            );
          } catch {
            items.push(this.newItem(remoteSession, 'upload', childRel, lp, rp, 0));
          }
        }
      })
    );
  }

  private async buildDownloadItems(
    remote: FileSession,
    names: string[],
    destDir: string
  ): Promise<TransferItem[]> {
    const items: TransferItem[] = [];
    const byName = new Map(
      (await this.scanSemaphore.run(() => remote.readdir(this.remotePath))).map((e) => [e.name, e])
    );
    await Promise.all(
      names.map(async (name) => {
        const entry = byName.get(name);
        const remoteBase = joinRemotePath(this.remotePath, name);
        const localBase = path.join(destDir, name);
        if (entry?.isDirectory) {
          await this.walkRemoteDir(remote, remoteBase, localBase, name, items);
        } else {
          items.push(
            this.newItem(remote, 'download', name, localBase, remoteBase, entry?.size ?? 0, entry?.mode, entry?.mtime)
          );
        }
      })
    );
    return items;
  }

  private async walkRemoteDir(
    remote: FileSession,
    remoteDir: string,
    localDir: string,
    rel: string,
    items: TransferItem[]
  ): Promise<void> {
    const entries = await this.scanSemaphore.run(() => remote.readdir(remoteDir));
    if (entries.length === 0) {
      await fs.promises.mkdir(localDir, { recursive: true });
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        // 악성/침해된 원격 서버는 readdir 응답에 "..", 경로 구분자, 제어 문자가 든 파일
        // 이름을 넣어 다운로드 폴더 밖(예: 시작프로그램, ~/.ssh)에 파일을 쓰게 만들 수 있다.
        // 웹뷰가 보낸 최상위 이름은 leafNameError로 막지만 재귀 하위 이름은 서버값 그대로라
        // 여기서 반드시 다시 검증하고, 위험한 이름을 만나면 전체 다운로드를 중단한다.
        this.assertSafeRemoteChildName(e.name);
        const rp = joinRemotePath(remoteDir, e.name);
        const lp = path.join(localDir, e.name);
        const childRel = `${rel}/${e.name}`;
        if (e.isDirectory) {
          await this.walkRemoteDir(remote, rp, lp, childRel, items);
        } else {
          items.push(this.newItem(remote, 'download', childRel, lp, rp, e.size ?? 0, e.mode, e.mtime));
        }
      })
    );
  }

  /**
   * 원격 서버가 돌려준 디렉터리 항목 이름이 로컬 경로 탈출에 악용될 수 있으면 예외를 던진다.
   * leafNameError와 규칙은 같되(경로 구분자/상위 경로/제어 문자 차단) 공백만 있는 이름 같은
   * 정상 유닉스 파일명은 막지 않도록 트래버설과 직접 관련된 조건만 검사한다.
   */
  private assertSafeRemoteChildName(name: string): void {
    if (name === '.' || name === '..' || /[\\/]/.test(name) || /\0|[\x01-\x1f\x7f]/.test(name)) {
      throw new Error(
        `원격 서버가 안전하지 않은 파일 이름을 반환했습니다: ${JSON.stringify(name)}. ` +
          `경로 구분자·상위 경로(..)·제어 문자가 포함되어 다운로드를 중단했습니다.`
      );
    }
  }

  private newItem(
    remoteSession: FileSession,
    direction: TransferItem['direction'],
    label: string,
    localPath: string,
    remotePath: string,
    size: number,
    mode?: number,
    mtime?: number
  ): TransferItem {
    return {
      id: `t${++this.seq}`,
      direction,
      label,
      localPath,
      remotePath,
      remoteSession,
      size,
      transferred: 0,
      status: 'queued',
      mode,
      mtime,
    };
  }

  private async runTransfer(
    item: TransferItem,
    onProgress: (transferred: number, total: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    const remote = item.remoteSession;
    const preserve = this.config<boolean>('preserveTimestamps', true);

    if (item.direction === 'upload') {
      const tempPath = this.temporaryRemotePath(item.remotePath);
      try {
        await this.ensureRemoteDir(remote, path.posix.dirname(item.remotePath));
        await remote.upload(item.localPath, tempPath, onProgress, signal);
        if (preserve && !signal.aborted) {
          const metadataUpdates: Promise<unknown>[] = [];
          if (item.mode !== undefined && remote.chmod) {
            metadataUpdates.push(remote.chmod(tempPath, item.mode).catch(() => undefined));
          }
          if (item.mtime !== undefined && remote.utimes) {
            metadataUpdates.push(remote.utimes(tempPath, item.mtime).catch(() => undefined));
          }
          await Promise.all(metadataUpdates);
        }
        if (signal.aborted) throw new Error('전송이 취소되었습니다.');
        await this.commitRemoteFile(remote, tempPath, item.remotePath, !!item.overwrite);
      } catch (err) {
        await remote.unlink(tempPath).catch(() => undefined);
        throw err;
      }
    } else {
      const tempPath = this.temporaryLocalPath(item.localPath);
      try {
        await fs.promises.mkdir(path.dirname(item.localPath), { recursive: true });
        await remote.download(item.remotePath, tempPath, onProgress, signal);
        if (preserve && !signal.aborted) {
          const metadataUpdates: Promise<unknown>[] = [];
          if (item.mode !== undefined) {
            metadataUpdates.push(fs.promises.chmod(tempPath, item.mode).catch(() => undefined));
          }
          if (item.mtime !== undefined) {
            const t = new Date(item.mtime);
            metadataUpdates.push(fs.promises.utimes(tempPath, t, t).catch(() => undefined));
          }
          await Promise.all(metadataUpdates);
        }
        if (signal.aborted) throw new Error('전송이 취소되었습니다.');
        await this.commitLocalFile(tempPath, item.localPath, !!item.overwrite);
      } catch (err) {
        await fs.promises.unlink(tempPath).catch(() => undefined);
        throw err;
      }
    }
  }

  private temporaryRemotePath(destination: string): string {
    const dir = path.posix.dirname(destination);
    const name = path.posix.basename(destination);
    return path.posix.join(dir, `.vssh-${name}-${crypto.randomUUID()}.tmp`);
  }

  private temporaryLocalPath(destination: string): string {
    return path.join(path.dirname(destination), `.vssh-${path.basename(destination)}-${crypto.randomUUID()}.tmp`);
  }

  private async commitRemoteFile(
    remote: FileSession,
    tempPath: string,
    destination: string,
    overwrite: boolean
  ): Promise<void> {
    let existing: Awaited<ReturnType<FileSession['stat']>> | undefined;
    try {
      existing = await remote.stat(destination);
    } catch {
      existing = undefined;
    }
    if (!existing) {
      await remote.rename(tempPath, destination);
      return;
    }
    if (existing.isDirectory) throw new Error('대상 경로에 같은 이름의 폴더가 있습니다.');
    if (!overwrite) throw new Error('전송 중 대상 파일이 생성되어 덮어쓰기를 중단했습니다.');

    const backup = this.temporaryRemotePath(`${destination}.backup`);
    await remote.rename(destination, backup);
    try {
      await remote.rename(tempPath, destination);
    } catch (err) {
      await remote.rename(backup, destination).catch(() => undefined);
      throw err;
    }
    await remote.unlink(backup).catch(() => undefined);
  }

  private async commitLocalFile(tempPath: string, destination: string, overwrite: boolean): Promise<void> {
    let existing: fs.Stats | undefined;
    try {
      existing = await fs.promises.lstat(destination);
    } catch {
      existing = undefined;
    }
    if (!existing) {
      await fs.promises.rename(tempPath, destination);
      return;
    }
    if (existing.isDirectory()) throw new Error('대상 경로에 같은 이름의 폴더가 있습니다.');
    if (!overwrite) throw new Error('전송 중 대상 파일이 생성되어 덮어쓰기를 중단했습니다.');

    const backup = this.temporaryLocalPath(`${destination}.backup`);
    await fs.promises.rename(destination, backup);
    try {
      await fs.promises.rename(tempPath, destination);
    } catch (err) {
      await fs.promises.rename(backup, destination).catch(() => undefined);
      throw err;
    }
    await fs.promises.unlink(backup).catch(() => undefined);
  }

  private async ensureRemoteDir(remote: FileSession, dir: string): Promise<void> {
    let created = this.createdRemoteDirs.get(remote);
    if (!created) {
      created = new Set<string>();
      this.createdRemoteDirs.set(remote, created);
    }
    if (!dir || dir === '/' || dir === '.' || created.has(dir)) {
      return;
    }
    const parent = path.posix.dirname(dir);
    if (parent && parent !== dir) await this.ensureRemoteDir(remote, parent);
    try {
      await remote.mkdir(dir);
    } catch {
      /* 이미 존재 */
    }
    created.add(dir);
  }

  // ---- 유틸 / 메시지 송신 ----------------------------------------------------

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('vssh.sftp').get<T>(key, fallback);
  }

  private sessionFor(pane: Pane): FileSession | undefined {
    const session = pane === 'local' ? this.localSession : this.remoteSession;
    if (!session) vscode.window.showWarningMessage('VSsh: 먼저 세션에 연결하세요.');
    return session;
  }

  private childPath(pane: Pane, name: string): string {
    const error = this.leafNameError(name);
    if (error) throw new Error(error);
    return pane === 'local' ? path.join(this.localPath, name) : joinRemotePath(this.remotePath, name);
  }

  private leafNameError(value: string): string | undefined {
    if (!value.trim()) return '이름을 입력하세요.';
    if (value === '.' || value === '..') return '상대 경로 이름은 사용할 수 없습니다.';
    if (/[\\/]/.test(value)) return '이름에 경로 구분자를 사용할 수 없습니다.';
    if (/\0|[\x01-\x1f\x7f]/.test(value)) return '이름에 제어 문자를 사용할 수 없습니다.';
    return undefined;
  }

  private persistLocalPath(): void {
    void this.context.globalState.update(LOCAL_PATH_KEY, this.localPath);
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private postState(): void {
    this.post({
      type: 'state',
      connected: !!this.remoteSession,
      sessionLabel: this.remoteSession?.label ?? '',
      canEditRemote: this.remoteSession instanceof SshFileSession,
      localPath: this.localPath,
      remotePath: this.remotePath,
    });
  }

  private postQueue(): void {
    this.post({
      type: 'queue',
      items: this.queue.list().map((i) => ({
        id: i.id,
        label: i.label,
        direction: i.direction,
        transferred: i.transferred,
        size: i.size,
        status: i.status,
        error: i.error,
      })),
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sftpPanel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sftpPanel.css'));
    const nonce = crypto.randomBytes(16).toString('hex');
    // 전송 큐 진행률 막대 등에서 인라인 style 속성을 쓰므로 style-src에 unsafe-inline을 허용한다.
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>SFTP</title>
</head>
<body>
<div id="app">
  <div id="panes">
    <section class="pane" data-pane="local">
      <div class="pane-head">
        <span class="pane-title">로컬</span>
        <span class="pane-tools">
          <button id="toRemote" title="선택 항목을 원격으로 업로드">▶</button>
          <button data-act="refresh" title="새로고침">⟳</button>
          <button data-act="mkdir" title="새 폴더">＋</button>
          <button data-act="pick" title="폴더 선택">…</button>
        </span>
      </div>
      <input class="pane-path" spellcheck="false" autocomplete="off" />
      <div class="pane-cols">
        <span class="c-name" data-sort="name">이름</span>
        <span class="c-size" data-sort="size">크기</span>
        <span class="c-mtime" data-sort="mtime">수정일</span>
        <span class="c-mode" data-sort="mode">권한</span>
      </div>
      <div class="pane-list" tabindex="0"></div>
      <div class="pane-foot"></div>
    </section>

    <div id="paneSplitter" title="드래그해서 로컬/원격 패널 너비 조절"></div>

    <section class="pane" data-pane="remote">
      <div class="pane-head">
        <span class="pane-title">원격</span>
        <span class="pane-tools">
          <button id="toLocal" title="선택 항목을 로컬로 다운로드">◀</button>
          <button data-act="refresh" title="새로고침">⟳</button>
          <button data-act="mkdir" title="새 폴더">＋</button>
          <button data-act="terminal" title="여기로 터미널 이동">❯_</button>
        </span>
      </div>
      <input class="pane-path" spellcheck="false" autocomplete="off" />
      <div class="pane-cols">
        <span class="c-name" data-sort="name">이름</span>
        <span class="c-size" data-sort="size">크기</span>
        <span class="c-mtime" data-sort="mtime">수정일</span>
        <span class="c-mode" data-sort="mode">권한</span>
      </div>
      <div class="pane-list" tabindex="0"></div>
      <div class="pane-foot"></div>
    </section>
  </div>

  <div id="queue" class="hidden">
    <div id="queueHandle" title="드래그해서 전송 목록 높이 조절"></div>
    <div id="queueBar">
      <span id="queueSummary">전송 없음</span>
      <span class="spacer"></span>
      <button id="queueClear" title="완료·실패 항목 지우기">지우기</button>
      <button id="queueCancel" title="모든 전송 취소">전체 취소</button>
      <button id="queueToggle" title="전송 목록 숨기기">✕</button>
    </div>
    <div id="queueList"></div>
  </div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
