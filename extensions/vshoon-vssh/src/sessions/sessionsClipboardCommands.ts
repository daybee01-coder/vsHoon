import * as vscode from 'vscode';
import { pickAvailableName } from '../common/naming';
import { passwordSecretKey } from './passwordSecrets';
import { SessionsClipboard } from './sessionsClipboard';
import { SessionStorage } from './sessionStorage';
import {
  SessionFolderTreeItem,
  SessionTreeItem,
  SessionsTreeItemUnion,
  SessionsTreeProvider,
} from './sessionsTreeProvider';

function selectedSessions(treeView: vscode.TreeView<SessionsTreeItemUnion>): SessionTreeItem[] {
  return treeView.selection.filter((n): n is SessionTreeItem => n instanceof SessionTreeItem);
}

export function copySessionsCommand(treeView: vscode.TreeView<SessionsTreeItemUnion>, clipboard: SessionsClipboard): void {
  const selected = selectedSessions(treeView);
  if (selected.length === 0) return;
  clipboard.set(
    'copy',
    selected.map((s) => ({ id: s.profile.id }))
  );
  void vscode.commands.executeCommand('setContext', 'vssh.sessions.hasClipboard', true);
  vscode.window.setStatusBarMessage(`VSsh: 세션 ${selected.length}개 복사됨`, 3000);
}

export function cutSessionsCommand(treeView: vscode.TreeView<SessionsTreeItemUnion>, clipboard: SessionsClipboard): void {
  const selected = selectedSessions(treeView);
  if (selected.length === 0) return;
  clipboard.set(
    'cut',
    selected.map((s) => ({ id: s.profile.id }))
  );
  void vscode.commands.executeCommand('setContext', 'vssh.sessions.hasClipboard', true);
  vscode.window.setStatusBarMessage(`VSsh: 세션 ${selected.length}개 잘라내기됨`, 3000);
}

/**
 * 붙여넣기 대상 폴더는 우클릭한 폴더가 아니면 항상 루트로 정한다. SFTP 붙여넣기에서 겪은
 * 것과 같은 이유로, 트리 선택 상태에 의존하면 방금 자른/복사한 세션이 계속 선택된 채로
 * 남아있을 때 엉뚱한 곳에 붙여넣힐 수 있다.
 */
function resolveTargetFolderId(node?: SessionsTreeItemUnion): string | null {
  return node instanceof SessionFolderTreeItem ? node.folder.id : null;
}

export async function pasteSessionsCommand(
  provider: SessionsTreeProvider,
  storage: SessionStorage,
  clipboard: SessionsClipboard,
  secrets: vscode.SecretStorage,
  node?: SessionsTreeItemUnion
): Promise<void> {
  const clip = clipboard.get();
  if (!clip) return;
  const targetFolderId = resolveTargetFolderId(node);

  const siblingNames = new Set(
    storage
      .getChildren(targetFolderId)
      .filter((n) => n.type === 'session')
      .map((n) => n.sessionName)
  );

  let pastedCount = 0;
  for (const entry of clip.entries) {
    const source = storage.getSession(entry.id);
    if (!source) continue;

    try {
      if (clip.mode === 'cut') {
        storage.moveNode(entry.id, targetFolderId);
      } else {
        const newName = pickAvailableName(source.sessionName, siblingNames);
        siblingNames.add(newName);
        const { id: _drop, ...rest } = source;
        const created = storage.addSession(targetFolderId, { ...rest, sessionName: newName });
        const savedPassword = await secrets.get(passwordSecretKey(entry.id));
        if (savedPassword !== undefined) {
          await secrets.store(passwordSecretKey(created.id), savedPassword);
        }
      }
      pastedCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`VSsh: "${source.sessionName}" 붙여넣기 실패 - ${message}`);
    }
  }

  if (clip.mode === 'cut') {
    clipboard.clear();
    void vscode.commands.executeCommand('setContext', 'vssh.sessions.hasClipboard', false);
  }
  if (pastedCount > 0) {
    provider.refresh();
    vscode.window.setStatusBarMessage(`VSsh: 세션 ${pastedCount}개 붙여넣음`, 3000);
  }
}
