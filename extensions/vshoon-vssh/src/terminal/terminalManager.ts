import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { ActiveSessionManager } from '../sftp/activeSessionManager';
import { connect } from '../ssh/connection';
import { HostKeyStore } from '../ssh/hostKeyStore';
import { SshFileSession } from '../ssh/sshFileSession';
import { SftpFileSystemProvider } from '../sftp/sftpFileSystemProvider';
import { SessionProfile } from '../sessions/types';
import { BroadcastManager } from './broadcastManager';
import { SshPseudoterminal } from './sshPseudoterminal';

export class TerminalManager {
  /** 세션 id -> 그 세션으로 열려 있는 터미널들. 같은 세션을 여러 번 연결할 수 있어 Set이다. */
  private readonly terminalsBySession = new Map<string, Set<vscode.Terminal>>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** 연결/해제로 "지금 연결된 세션" 목록이 바뀔 때마다 발생 (트리뷰 갱신용). */
  readonly onDidChangeConnections = this.changeEmitter.event;

  constructor(
    private readonly hostKeyStore: HostKeyStore,
    private readonly activeSessionManager: ActiveSessionManager,
    private readonly broadcastManager: BroadcastManager,
    private readonly secrets: vscode.SecretStorage,
    private readonly sftpFsProvider: SftpFileSystemProvider
  ) {
    // 탭을 직접 닫거나 원격 셸이 exit한 경우도 연결 해제로 친다.
    vscode.window.onDidCloseTerminal((terminal) => this.forget(terminal));
  }

  private forget(terminal: vscode.Terminal): void {
    for (const [sessionId, terminals] of this.terminalsBySession) {
      if (!terminals.delete(terminal)) continue;
      if (terminals.size === 0) this.terminalsBySession.delete(sessionId);
      this.changeEmitter.fire();
      return;
    }
  }

  isConnected(sessionId: string): boolean {
    return this.terminalsBySession.has(sessionId);
  }

  getConnectedSessionIds(): ReadonlySet<string> {
    return new Set(this.terminalsBySession.keys());
  }

  /** 이 세션으로 열린 터미널을 모두 닫는다. 닫은 개수를 돌려준다 (0이면 연결이 없었다는 뜻). */
  disconnect(sessionId: string): number {
    const terminals = this.terminalsBySession.get(sessionId);
    if (!terminals) return 0;
    const count = terminals.size;
    // dispose -> Pseudoterminal.close() -> 셸 스트림 종료 + SSH 클라이언트 종료 순으로 정리된다.
    for (const terminal of terminals) terminal.dispose();
    this.terminalsBySession.delete(sessionId);
    this.changeEmitter.fire();
    return count;
  }

  async openTerminal(profile: SessionProfile): Promise<void> {
    try {
      const connection = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `VSsh: ${profile.sessionName}에 연결 중...`,
        },
        () => connect(profile, this.hostKeyStore, this.secrets)
      );

      const pty = new SshPseudoterminal({
        client: connection.client,
        encoding: profile.encoding ?? getSettings().terminalEncoding,
        broadcastManager: this.broadcastManager,
      });
      const terminal = vscode.window.createTerminal({
        name: profile.sessionName,
        pty,
        location: vscode.TerminalLocation.Editor,
      });

      const existing = this.terminalsBySession.get(profile.id);
      if (existing) {
        existing.add(terminal);
      } else {
        this.terminalsBySession.set(profile.id, new Set([terminal]));
      }
      this.changeEmitter.fire();

      const fileSession = new SshFileSession(connection.client, profile.sessionName, {
        host: profile.hostName,
        port: profile.portNumber || 22,
        username: profile.userName,
      });
      this.sftpFsProvider.register(fileSession);
      this.activeSessionManager.register(terminal, fileSession);
      this.activeSessionManager.setActive(fileSession, terminal);

      terminal.show();
      // 터미널이 메인 에디터 영역을 넓게 쓰도록 연결 직후 왼쪽 사이드바를 접는다.
      void vscode.commands.executeCommand('workbench.action.closeSidebar');
      // 연결된 원격 파일 세션을 바로 확인할 수 있도록 하단 패널의 SFTP 뷰를 연다.
      await vscode.commands.executeCommand('vssh.sftp.focus');

      connection.client.on('close', () => {
        this.forget(terminal);
        this.sftpFsProvider.unregister(fileSession.id);
        this.activeSessionManager.register(terminal, undefined);
        if (this.activeSessionManager.getActive() === fileSession) {
          this.activeSessionManager.setActive(undefined);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`VSsh: ${profile.sessionName} 연결 실패 - ${message}`);
    }
  }
}
