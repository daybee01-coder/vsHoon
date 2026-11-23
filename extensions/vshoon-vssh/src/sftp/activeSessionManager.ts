import * as vscode from 'vscode';
import { getSshPseudoterminal } from '../terminal/sshPseudoterminal';
import { FileSession } from './fileSession';

export interface TerminalDirectoryChangeEvent {
  readonly terminal: vscode.Terminal;
  readonly session: FileSession;
  readonly path: string;
}

/**
 * 터미널 탭 <-> FileSession 매핑을 들고 있다가, 활성 터미널이 바뀔 때마다
 * SFTP 탐색기가 그 탭에 해당하는 세션으로 같이 전환되게 한다.
 * 세션이 없는(우리가 관리하지 않는) 터미널로 전환하면 마지막 세션을 그대로 둔다. 비우면
 * `vssh.connected`가 꺼져 하단 패널의 SFTP 뷰가 통째로 사라진다.
 * 활성 세션이 끊기면 아직 열려 있는 다른 세션으로 넘어가고, 하나도 없을 때만 비운다.
 */
export class ActiveSessionManager implements vscode.Disposable {
  private readonly terminalSessions = new Map<vscode.Terminal, FileSession>();
  private readonly directoryListeners = new Map<vscode.Terminal, vscode.Disposable>();
  private active: FileSession | undefined;
  private activeTerminal: vscode.Terminal | undefined;
  private readonly emitter = new vscode.EventEmitter<FileSession | undefined>();
  private readonly directoryEmitter = new vscode.EventEmitter<TerminalDirectoryChangeEvent>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly onDidChangeActive = this.emitter.event;
  readonly onDidChangeTerminalDirectory = this.directoryEmitter.event;

  constructor() {
    void vscode.commands.executeCommand('setContext', 'vssh.connected', false);
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        const session = terminal && this.terminalSessions.get(terminal);
        // 포커스가 터미널 밖이나 VSsh가 관리하지 않는 터미널로 간 경우는 마지막 상태를 유지
        if (session && (session !== this.active || terminal !== this.activeTerminal)) {
          this.setActive(session, terminal);
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => this.release(terminal))
    );
  }

  /** 새로 연 터미널을 해당 FileSession과 연결한다. session이 undefined면 매핑을 해제한다. */
  register(terminal: vscode.Terminal, session: FileSession | undefined): void {
    this.directoryListeners.get(terminal)?.dispose();
    this.directoryListeners.delete(terminal);
    if (session) {
      this.terminalSessions.set(terminal, session);
      const pty = getSshPseudoterminal(terminal);
      if (pty) {
        this.directoryListeners.set(
          terminal,
          pty.onDidChangeDirectory((path) => this.reportTerminalDirectory(terminal, path))
        );
      }
    } else {
      this.terminalSessions.delete(terminal);
    }
  }

  /**
   * 터미널의 연결이 끊겼거나 탭이 닫혔을 때 부른다. 매핑을 해제하고, 그 세션이 활성이었다면
   * 남아 있는 다른 세션(가장 나중에 연결한 것)으로 넘긴다.
   */
  release(terminal: vscode.Terminal): void {
    const session = this.terminalSessions.get(terminal);
    this.removeTerminal(terminal);
    if (!session || session !== this.active) {
      return;
    }
    const remaining = [...this.terminalSessions].pop();
    this.setActive(remaining?.[1], remaining?.[0]);
  }

  setActive(session: FileSession | undefined, terminal?: vscode.Terminal): void {
    this.active = session;
    this.activeTerminal = session ? terminal : undefined;
    void vscode.commands.executeCommand('setContext', 'vssh.connected', !!session);
    this.emitter.fire(session);
  }

  getActive(): FileSession | undefined {
    return this.active;
  }

  /** 현재 활성 세션에 연결된 vscode.Terminal (sendText 등으로 터미널에 직접 입력을 보낼 때 사용). */
  getActiveTerminal(): vscode.Terminal | undefined {
    return this.activeTerminal;
  }

  getSession(terminal: vscode.Terminal): FileSession | undefined {
    return this.terminalSessions.get(terminal);
  }

  reportTerminalDirectory(terminal: vscode.Terminal, path: string): void {
    const session = this.terminalSessions.get(terminal);
    if (session) {
      this.directoryEmitter.fire({ terminal, session, path });
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    for (const listener of this.directoryListeners.values()) {
      listener.dispose();
    }
    this.directoryListeners.clear();
    this.terminalSessions.clear();
    this.emitter.dispose();
    this.directoryEmitter.dispose();
  }

  private removeTerminal(terminal: vscode.Terminal): void {
    this.terminalSessions.delete(terminal);
    this.directoryListeners.get(terminal)?.dispose();
    this.directoryListeners.delete(terminal);
  }
}
