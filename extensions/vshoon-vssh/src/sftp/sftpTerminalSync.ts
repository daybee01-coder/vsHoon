import * as vscode from 'vscode';
import { shellQuote } from '../common/shellQuote';
import { getSshPseudoterminal } from '../terminal/sshPseudoterminal';
import { WslFileSession } from '../wsl/wslFileSession';
import { getWslTerminalDirectory } from '../wsl/wslTerminal';
import { ActiveSessionManager } from './activeSessionManager';

/** SFTP 원격 패널의 현재 경로로 활성 터미널의 셸을 cd 시킨다 (SSH·WSL 터미널 모두 sendText). */
export function cdTerminalToPath(activeSessionManager: ActiveSessionManager, targetPath: string): void {
  const terminal = activeSessionManager.getActiveTerminal();
  if (!terminal) {
    vscode.window.showWarningMessage('VSsh: 이동할 터미널이 없습니다. 먼저 세션에 연결하세요.');
    return;
  }
  terminal.sendText(`cd ${shellQuote(targetPath)}`, true);
  terminal.show();
}

/** 반대로, 활성 터미널(SSH·WSL 모두)이 지금 있는 디렉터리로 SFTP 원격 패널을 옮긴다. */
export async function followTerminalDirectory(
  activeSessionManager: ActiveSessionManager,
  goToPath: (path: string) => Promise<void> | void
): Promise<void> {
  const terminal = activeSessionManager.getActiveTerminal();
  const pty = getSshPseudoterminal(terminal);
  const session = activeSessionManager.getActive();
  const wslSession = session instanceof WslFileSession ? session : undefined;
  if (!terminal || (!pty && !wslSession)) {
    vscode.window.showWarningMessage('VSsh: 활성 SSH/WSL 터미널이 없습니다. 먼저 세션에 연결하세요.');
    return;
  }

  try {
    const dir = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'VSsh: 터미널 위치 확인 중...' },
      () => (pty ? pty.getCurrentDirectory() : getWslTerminalDirectory(terminal, wslSession!.distro))
    );
    await goToPath(dir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VSsh: 터미널 위치를 확인하지 못했습니다 - ${message}`);
  }
}
