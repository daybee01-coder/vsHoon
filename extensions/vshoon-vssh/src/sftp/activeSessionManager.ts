import * as vscode from 'vscode';
import { FileSession } from './fileSession';

/**
 * 터미널 탭 <-> FileSession 매핑을 들고 있다가, 활성 터미널이 바뀔 때마다
 * SFTP 탐색기가 그 탭에 해당하는 세션으로 같이 전환되게 한다.
 * 세션이 없는(우리가 관리하지 않는) 터미널로 전환하면 SFTP 뷰는 비운다.
 */
export class ActiveSessionManager {
  private readonly terminalSessions = new Map<vscode.Terminal, FileSession>();
  private active: FileSession | undefined;
  private activeTerminal: vscode.Terminal | undefined;
  private readonly emitter = new vscode.EventEmitter<FileSession | undefined>();
  readonly onDidChangeActive = this.emitter.event;

  constructor() {
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return; // 포커스가 터미널 밖으로 나간 경우는 마지막 상태를 유지
      this.setActive(this.terminalSessions.get(terminal), terminal);
    });

    vscode.window.onDidCloseTerminal((terminal) => {
      const session = this.terminalSessions.get(terminal);
      this.terminalSessions.delete(terminal);
      if (session && session === this.active) {
        this.setActive(undefined, undefined);
      }
    });
  }

  /** 새로 연 터미널을 해당 FileSession과 연결한다. session이 undefined면 매핑을 해제한다. */
  register(terminal: vscode.Terminal, session: FileSession | undefined): void {
    if (session) {
      this.terminalSessions.set(terminal, session);
    } else {
      this.terminalSessions.delete(terminal);
    }
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
}
