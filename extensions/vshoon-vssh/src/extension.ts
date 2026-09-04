import * as vscode from 'vscode';
import { registerFontSync } from './config/fontSync';
import { passwordSecretKey } from './sessions/passwordSecrets';
import { openSessionFormPanel } from './sessions/sessionFormPanel';
import { SessionStorage } from './sessions/sessionStorage';
import { SessionsClipboard } from './sessions/sessionsClipboard';
import { copySessionsCommand, cutSessionsCommand, pasteSessionsCommand } from './sessions/sessionsClipboardCommands';
import { SessionsDragAndDropController } from './sessions/sessionsDragAndDrop';
import {
  addSessionFolderCommand,
  deleteSessionFolderCommand,
  renameSessionFolderCommand,
} from './sessions/sessionsFolderCommands';
import { importFromPuttyCommand } from './sessions/sessionsImportCommand';
import {
  SessionFolderTreeItem,
  SessionsTreeItemUnion,
  SessionsTreeProvider,
  SessionTreeItem,
} from './sessions/sessionsTreeProvider';
import { PasswordAction, SessionProfile } from './sessions/types';
import { ActiveSessionManager } from './sftp/activeSessionManager';
import { SftpFileSystemProvider } from './sftp/sftpFileSystemProvider';
import { SftpPanelView } from './sftp/sftpPanelView';
import { followTerminalDirectory } from './sftp/sftpTerminalSync';
import { connect } from './ssh/connection';
import { HostKeyStore } from './ssh/hostKeyStore';
import { BroadcastManager } from './terminal/broadcastManager';
import { TerminalManager } from './terminal/terminalManager';
import { execWsl, listWslDistros, openWslTerminal } from './wsl/wslTerminal';
import { WslFileSession } from './wsl/wslFileSession';

/** id는 이름변경/폴더이동과 무관하게 고정이라, 저장 여부에 따라 그냥 store/delete만 하면 된다. */
async function applyPasswordAction(
  secrets: vscode.SecretStorage,
  sessionId: string,
  action: PasswordAction
): Promise<void> {
  if (action.type === 'save') {
    await secrets.store(passwordSecretKey(sessionId), action.password);
  } else if (action.type === 'forget') {
    await secrets.delete(passwordSecretKey(sessionId));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  registerFontSync(context);

  const hostKeyStore = new HostKeyStore(context.globalStorageUri.fsPath);
  const sessionStorage = new SessionStorage(context.globalStorageUri.fsPath);
  const activeSessionManager = new ActiveSessionManager();
  const broadcastManager = new BroadcastManager();
  const sftpFsProvider = new SftpFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SftpFileSystemProvider.scheme, sftpFsProvider, { isCaseSensitive: true })
  );
  const terminalManager = new TerminalManager(
    hostKeyStore,
    activeSessionManager,
    broadcastManager,
    context.secrets,
    sftpFsProvider
  );

  const sessionsProvider = new SessionsTreeProvider(sessionStorage);
  const sessionsTreeView = vscode.window.createTreeView('vssh.sessions', {
    treeDataProvider: sessionsProvider,
    dragAndDropController: new SessionsDragAndDropController(sessionsProvider, sessionStorage),
    canSelectMany: true,
  });
  context.subscriptions.push(sessionsTreeView);
  const sessionsClipboard = new SessionsClipboard();

  const sftpPanel = new SftpPanelView(context, activeSessionManager, sftpFsProvider, hostKeyStore);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SftpPanelView.viewId, sftpPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // VSCode의 내장 "view == <id>" when절이 트리뷰 키바인딩에서는 신뢰할 수 없어서
  // (메뉴 표시엔 되는데 키바인딩 해석에선 안 먹는 게 확인된 VSCode 자체의 알려진 한계),
  // Sessions 트리뷰는 포커스 컨텍스트 키를 직접 관리해서 단축키가 그 트리에 포커스 있을 때만 동작하게 한다.
  const setSessionsFocused = (value: boolean): void => {
    void vscode.commands.executeCommand('setContext', 'vssh.sessions.focused', value);
  };
  setSessionsFocused(false);

  // 클릭은 선택만 하고 연결은 인라인 아이콘/우클릭으로 하도록 바꿨었는데(복사/잘라내기를 하려면
  // "그냥 선택"이 가능해야 했음), 더블클릭만큼은 예외로 바로 연결되게 한다. TreeView API엔
  // 더블클릭 이벤트가 없어서, 같은 항목에 클릭이 짧은 간격으로 두 번 오는지로 흉내낸다.
  // 이 판정은 반드시 SessionTreeItem.command(클릭마다 호출됨)로 받아야 한다 -
  // onDidChangeSelection으로는 불가능하다. 이미 선택된 항목을 다시 클릭하면 선택이 바뀌지
  // 않아 이벤트 자체가 오지 않으므로 두 번째 클릭을 영영 볼 수 없기 때문.
  let lastSessionClickId: string | undefined;
  let lastSessionClickTime = 0;
  const DOUBLE_CLICK_MS = 500;

  context.subscriptions.push(
    terminalManager.onDidChangeConnections(() =>
      sessionsProvider.setConnectedIds(terminalManager.getConnectedSessionIds())
    ),
    sessionsTreeView.onDidChangeSelection(() => setSessionsFocused(true)),
    sessionsTreeView.onDidChangeVisibility((e) => {
      if (!e.visible) setSessionsFocused(false);
    }),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal) setSessionsFocused(false);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) setSessionsFocused(false);
    })
  );

  const broadcastStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  broadcastStatusBarItem.command = 'vssh.terminal.toggleBroadcast';
  const updateBroadcastStatusBar = (enabled: boolean): void => {
    broadcastStatusBarItem.text = enabled ? '$(broadcast) 멀티세션 입력: 켜짐' : '$(broadcast) 멀티세션 입력: 꺼짐';
    broadcastStatusBarItem.backgroundColor = enabled
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    broadcastStatusBarItem.tooltip =
      '열려 있는 모든 vssh SSH 터미널에 입력을 동시에 전달합니다 (WSL 터미널은 제외). 클릭해서 켜기/끄기.';
  };
  updateBroadcastStatusBar(false);
  broadcastStatusBarItem.show();
  context.subscriptions.push(broadcastStatusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('vssh.sessions.refresh', () => sessionsProvider.refresh(true)),

    vscode.commands.registerCommand('vssh.session.add', async (folderNode?: SessionFolderTreeItem) => {
      const result = await openSessionFormPanel(context.extensionUri, context.secrets);
      if (!result) return;
      const created = sessionStorage.addSession(folderNode?.folder.id ?? null, result.profile);
      await applyPasswordAction(context.secrets, created.id, result.passwordAction);
      sessionsProvider.refresh();
      vscode.window.showInformationMessage(`세션 "${created.sessionName}"을(를) 저장했습니다.`);
    }),

    vscode.commands.registerCommand('vssh.session.edit', async (item?: SessionTreeItem) => {
      const current = item?.profile ?? (await pickSessionInteractively(sessionsProvider));
      if (!current) return;
      const result = await openSessionFormPanel(context.extensionUri, context.secrets, current);
      if (!result) return;
      sessionStorage.updateSession(current.id, result.profile);
      await applyPasswordAction(context.secrets, current.id, result.passwordAction);
      sessionsProvider.refresh();
      vscode.window.showInformationMessage(`세션 "${result.profile.sessionName}"을(를) 저장했습니다.`);
    }),

    vscode.commands.registerCommand('vssh.session.delete', async (item?: SessionTreeItem) => {
      const profile = item?.profile ?? (await pickSessionInteractively(sessionsProvider));
      if (!profile) return;
      const choice = await vscode.window.showWarningMessage(
        `세션 "${profile.sessionName}"을(를) 삭제하시겠습니까?`,
        { modal: true },
        '삭제'
      );
      if (choice !== '삭제') return;
      sessionStorage.deleteSession(profile.id);
      await context.secrets.delete(passwordSecretKey(profile.id));
      sessionsProvider.refresh();
    }),

    vscode.commands.registerCommand('vssh.session.connect', async (item?: SessionTreeItem) => {
      let profile = item?.profile;
      if (!profile) {
        const selected = sessionsTreeView.selection.find((n): n is SessionTreeItem => n instanceof SessionTreeItem);
        profile = selected?.profile;
      }
      if (!profile) {
        profile = await pickSessionInteractively(sessionsProvider);
      }
      if (!profile) return;
      // 트리뷰에 남아있는 값이 최신이 아닐 수 있으므로 연결 직전 저장소에서 다시 읽는다.
      const fresh = sessionStorage.getSession(profile.id);
      await terminalManager.openTerminal(fresh ?? profile);
    }),

    // 트리 항목 클릭마다 호출된다 (package.json에 넣지 않아 명령 팔레트에는 안 뜬다).
    // 한 번 클릭은 아무것도 하지 않고, 같은 세션을 DOUBLE_CLICK_MS 안에 다시 클릭하면 연결한다.
    vscode.commands.registerCommand('vssh.session.click', async (sessionId?: string) => {
      if (!sessionId) return;
      // ctrl/shift 클릭으로 여러 개를 고르는 중에 실수로 연결되지 않게 한다.
      if (sessionsTreeView.selection.length > 1) {
        lastSessionClickId = undefined;
        return;
      }
      const now = Date.now();
      const isDoubleClick = lastSessionClickId === sessionId && now - lastSessionClickTime < DOUBLE_CLICK_MS;
      lastSessionClickId = isDoubleClick ? undefined : sessionId;
      lastSessionClickTime = now;
      if (!isDoubleClick) return;
      // 트리뷰에 남아있는 값이 최신이 아닐 수 있으므로 연결 직전 저장소에서 다시 읽는다.
      const profile = sessionStorage.getSession(sessionId);
      if (!profile) return;
      await terminalManager.openTerminal(profile);
    }),

    vscode.commands.registerCommand('vssh.wsl.click', async (distro?: string) => {
      if (!distro) return;
      if (sessionsTreeView.selection.length > 1) {
        lastSessionClickId = undefined;
        return;
      }
      const clickId = `wsl:${distro}`;
      const now = Date.now();
      const isDoubleClick = lastSessionClickId === clickId && now - lastSessionClickTime < DOUBLE_CLICK_MS;
      lastSessionClickId = isDoubleClick ? undefined : clickId;
      lastSessionClickTime = now;
      if (!isDoubleClick) return;
      await vscode.commands.executeCommand('vssh.wsl.open', distro);
    }),

    vscode.commands.registerCommand('vssh.session.disconnect', async (item?: SessionTreeItem) => {
      let profile = item?.profile;
      if (!profile) {
        const selected = sessionsTreeView.selection.find((n): n is SessionTreeItem => n instanceof SessionTreeItem);
        profile = selected?.profile;
      }
      if (!profile) {
        const connected = sessionsProvider.getAllProfiles().filter((p) => terminalManager.isConnected(p.id));
        if (connected.length === 0) {
          vscode.window.showInformationMessage('VSsh: 연결된 세션이 없습니다.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          connected.map((p) => ({ label: p.sessionName, profile: p })),
          { title: 'VSsh: 연결을 해제할 세션 선택', ignoreFocusOut: true }
        );
        profile = picked?.profile;
      }
      if (!profile) return;
      const closed = terminalManager.disconnect(profile.id);
      if (closed === 0) {
        vscode.window.showInformationMessage(`VSsh: "${profile.sessionName}"에 연결된 터미널이 없습니다.`);
      }
    }),

    vscode.commands.registerCommand('vssh.session.folder.add', (node?: SessionFolderTreeItem) =>
      addSessionFolderCommand(sessionsProvider, sessionStorage, node)
    ),
    vscode.commands.registerCommand('vssh.session.folder.rename', (node?: SessionFolderTreeItem) =>
      renameSessionFolderCommand(sessionsProvider, sessionStorage, node)
    ),
    vscode.commands.registerCommand('vssh.session.folder.delete', (node?: SessionFolderTreeItem) =>
      deleteSessionFolderCommand(sessionsProvider, sessionStorage, context.secrets, node)
    ),

    vscode.commands.registerCommand('vssh.session.importFromPutty', () =>
      importFromPuttyCommand(sessionsProvider, sessionStorage)
    ),

    vscode.commands.registerCommand('vssh.session.copy', () => copySessionsCommand(sessionsTreeView, sessionsClipboard)),
    vscode.commands.registerCommand('vssh.session.cut', () => cutSessionsCommand(sessionsTreeView, sessionsClipboard)),
    vscode.commands.registerCommand('vssh.session.paste', (node?: SessionsTreeItemUnion) =>
      pasteSessionsCommand(sessionsProvider, sessionStorage, sessionsClipboard, context.secrets, node)
    ),

    vscode.commands.registerCommand('vssh.sftp.refresh', () => sftpPanel.refreshBoth()),
    vscode.commands.registerCommand('vssh.sftp.changeUser', () => sftpPanel.changeRemoteUser()),
    vscode.commands.registerCommand('vssh.sftp.toggleSync', () => sftpPanel.toggleSynchronizedNavigation()),
    vscode.commands.registerCommand('vssh.sftp.toggleHidden', () => sftpPanel.toggleHiddenFiles()),
    vscode.commands.registerCommand('vssh.sftp.toggleQueue', () => sftpPanel.toggleTransferQueue()),
    vscode.commands.registerCommand('vssh.sftp.followTerminal', () =>
      followTerminalDirectory(activeSessionManager, (path) => sftpPanel.navigateRemote(path))
    ),

    vscode.commands.registerCommand('vssh.terminal.toggleBroadcast', () => {
      const enabled = broadcastManager.toggle();
      updateBroadcastStatusBar(enabled);
      vscode.window.showInformationMessage(
        enabled
          ? '멀티세션 동시입력을 켰습니다. 열려 있는 모든 SSH 터미널에 입력이 동시에 전달됩니다.'
          : '멀티세션 동시입력을 껐습니다.'
      );
    }),

    vscode.commands.registerCommand('vssh.wsl.open', async (distro?: string) => {
      if (!distro) {
        const distros = await listWslDistros();
        if (distros.length === 0) {
          vscode.window.showErrorMessage('설치된 WSL 배포판을 찾을 수 없습니다.');
          return;
        }
        distro = distros.length === 1 ? distros[0] : undefined;
        if (!distro) {
          distro = await vscode.window.showQuickPick(distros, {
            title: 'VSsh: 열 WSL 배포판 선택',
            ignoreFocusOut: true,
          });
          if (!distro) return;
        }
      }
      // WSL을 처음 깨우면 배포판 부팅 때문에 몇 초 걸릴 수 있는데, 그 사이 아무 표시가 없으면
      // 멈춘 건지 진행 중인지 알 수 없다. 사용자 확인(id -un) 단계부터 진행 알림을 띄운다.
      let wslUser: string;
      try {
        wslUser = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `VSsh: ${distro} 연결 준비 중... (WSL 시작 확인)`,
          },
          async () => (await execWsl(distro!, ['--', 'id', '-un'])).trim()
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`VSsh: ${distro} 준비 실패 - ${message}`);
        return;
      }
      const sftpProfile: SessionProfile = {
        id: `wsl-sftp:${distro}:${wslUser}:2222`,
        sessionName: `WSL: ${distro}`,
        hostName: '127.0.0.1',
        portNumber: 2222,
        userName: wslUser,
        authMethod: 'password',
      };
      const secretKey = passwordSecretKey(sftpProfile.id);
      const savedPassword = await context.secrets.get(secretKey);
      const password =
        savedPassword ??
        (await vscode.window.showInputBox({
          title: `VSsh: ${distro} SFTP 비밀번호`,
          prompt: `${wslUser}@127.0.0.1:2222`,
          password: true,
          ignoreFocusOut: true,
        }));
      if (password === undefined) return;

      const connection = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `VSsh: ${distro} SFTP 연결 중...`,
        },
        () => connect(sftpProfile, hostKeyStore, context.secrets, password)
      );

      if (savedPassword === undefined) {
        const passwordChoice = await vscode.window.showInformationMessage(
          `${distro} SFTP 비밀번호를 안전하게 저장하시겠습니까?`,
          '저장',
          '이번만 사용'
        );
        if (passwordChoice === '저장') {
          await context.secrets.store(secretKey, password);
        }
      }

      const terminal = openWslTerminal(distro);
      const fileSession = new WslFileSession(connection.client, distro, {
        host: sftpProfile.hostName,
        port: sftpProfile.portNumber,
        username: wslUser,
      });
      activeSessionManager.register(terminal, fileSession);
      activeSessionManager.setActive(fileSession, terminal);
      const closeListener = vscode.window.onDidCloseTerminal((closed) => {
        if (closed !== terminal) return;
        connection.client.end();
        closeListener.dispose();
      });
      context.subscriptions.push(closeListener);

      connection.client.on('close', () => {
        activeSessionManager.register(terminal, undefined);
        if (activeSessionManager.getActive() === fileSession) {
          activeSessionManager.setActive(undefined);
        }
      });

      // SSH 연결과 동일하게 터미널을 에디터 영역에 남기고 SFTP 패널로 전환한다.
      void vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('vssh.sftp.focus');
    }),

    vscode.commands.registerCommand('vssh.hostkey.manage', async () => {
      const entries = await hostKeyStore.list();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('저장된 호스트 키가 없습니다.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((e) => ({
          label: e.id,
          description: e.fingerprint,
          detail: `신뢰한 시각: ${e.acceptedAt}`,
        })),
        { title: 'VSsh: 호스트 키 관리 (선택하면 삭제)', ignoreFocusOut: true }
      );
      if (!picked) return;
      await hostKeyStore.remove(picked.label);
      vscode.window.showInformationMessage(`"${picked.label}" 호스트 키를 삭제했습니다.`);
    })
  );
}

async function pickSessionInteractively(provider: SessionsTreeProvider): Promise<SessionProfile | undefined> {
  const profiles = provider.getAllProfiles();
  if (profiles.length === 0) {
    vscode.window.showInformationMessage('저장된 세션이 없습니다. 먼저 세션을 추가하세요.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.sessionName,
      description: `${p.userName ? p.userName + '@' : ''}${p.hostName}:${p.portNumber}`,
      profile: p,
    })),
    { title: 'VSsh: 세션 선택', ignoreFocusOut: true }
  );
  return picked?.profile;
}

export function deactivate(): void {
  // 열린 SSH 연결은 각 Pseudoterminal의 close()에서 정리된다.
}
