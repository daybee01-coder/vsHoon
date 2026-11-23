import { Client } from 'ssh2';
import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { ActiveSessionManager } from '../sftp/activeSessionManager';
import { connect, Connection } from '../ssh/connection';
import { HostKeyStore } from '../ssh/hostKeyStore';
import { SshFileSession } from '../ssh/sshFileSession';
import { SftpFileSystemProvider } from '../sftp/sftpFileSystemProvider';
import { SessionProfile } from '../sessions/types';
import { BroadcastManager } from './broadcastManager';
import { getSshPseudoterminal, SshPseudoterminal } from './sshPseudoterminal';

export class TerminalManager {
  /** 세션 id -> 그 세션으로 열려 있는 터미널들. 같은 세션을 여러 번 연결할 수 있어 Set이다. */
  private readonly terminalsBySession = new Map<string, Set<vscode.Terminal>>();
  /** 터미널 -> 지금 쓰는 SSH 연결. 재접속하면 바뀌고, 이전 연결의 close는 무시한다. */
  private readonly connections = new Map<vscode.Terminal, { client: Client; fileSession: SshFileSession }>();
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
    this.connections.delete(terminal);
    for (const [sessionId, terminals] of this.terminalsBySession) {
      if (!terminals.delete(terminal)) continue;
      if (terminals.size === 0) this.terminalsBySession.delete(sessionId);
      this.changeEmitter.fire();
      return;
    }
  }

  /** VSsh가 연 SSH 터미널이면 그 세션 id를 돌려준다. */
  getSessionId(terminal: vscode.Terminal): string | undefined {
    for (const [sessionId, terminals] of this.terminalsBySession) {
      if (terminals.has(terminal)) return sessionId;
    }
    return undefined;
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
      const connection = await this.connectWithProgress(profile);
      const settings = getSettings();

      const pty = new SshPseudoterminal({
        client: connection.client,
        encoding: profile.encoding ?? settings.terminalEncoding,
        broadcastManager: this.broadcastManager,
        mouseReporting: settings.terminalMouseReporting,
      });
      const terminal = vscode.window.createTerminal({
        name: profile.sessionName,
        pty,
        location: vscode.TerminalLocation.Editor,
        isTransient: true,
      });

      const existing = this.terminalsBySession.get(profile.id);
      if (existing) {
        existing.add(terminal);
      } else {
        this.terminalsBySession.set(profile.id, new Set([terminal]));
      }
      this.changeEmitter.fire();

      this.attach(terminal, profile, connection.client);

      terminal.show();
      if (settings.closeSidebarOnConnect) {
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
      }
      // 연결된 원격 파일 세션을 바로 확인할 수 있도록 하단 패널의 SFTP 뷰를 연다.
      await vscode.commands.executeCommand('vssh.sftp.focus');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`VSsh: ${profile.sessionName} 연결 실패 - ${message}`);
    }
  }

  /**
   * 열려 있는 SSH 터미널 탭을 그대로 두고 새 연결로 셸을 다시 연다. 응답 없는 연결을 살릴 때 쓴다.
   * 새 연결이 실패하면 이전 연결은 건드리지 않는다.
   */
  async reconnect(terminal: vscode.Terminal, profile: SessionProfile): Promise<void> {
    const pty = getSshPseudoterminal(terminal);
    const previous = this.connections.get(terminal);
    if (!pty || !previous) return;

    let client: Client;
    try {
      client = (await this.connectWithProgress(profile)).client;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`VSsh: ${profile.sessionName} 재접속 실패 - ${message}`);
      return;
    }
    // 탭이 연결을 기다리는 사이에 닫혔다면 새 연결을 버린다.
    if (!this.connections.has(terminal)) {
      client.end();
      return;
    }

    this.sftpFsProvider.unregister(previous.fileSession.id);
    this.attach(terminal, profile, client);
    // 이전 연결은 pty가 끊는다. attach가 연결을 먼저 바꿔 두었으므로 그 close는 무시된다.
    pty.reconnect(client);
    terminal.show();
  }

  private connectWithProgress(profile: SessionProfile): Thenable<Connection> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VSsh: ${profile.sessionName}에 연결 중...`,
      },
      () => connect(profile, this.hostKeyStore, this.secrets)
    );
  }

  /** 연결을 터미널에 붙이고 SFTP 패널이 이 세션을 쓰게 한다. */
  private attach(terminal: vscode.Terminal, profile: SessionProfile, client: Client): void {
    const fileSession = new SshFileSession(client, profile.sessionName, {
      host: profile.hostName,
      port: profile.portNumber || 22,
      username: profile.userName,
    });
    this.connections.set(terminal, { client, fileSession });
    this.sftpFsProvider.register(fileSession);
    this.activeSessionManager.register(terminal, fileSession);
    this.activeSessionManager.setActive(fileSession, terminal);

    client.on('close', () => {
      this.sftpFsProvider.unregister(fileSession.id);
      if (this.connections.get(terminal)?.client !== client) {
        return; // 재접속으로 교체된 연결
      }
      this.forget(terminal);
      this.activeSessionManager.release(terminal);
    });
  }
}
