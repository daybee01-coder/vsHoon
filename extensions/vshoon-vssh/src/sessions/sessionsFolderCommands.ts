import * as vscode from 'vscode';
import { passwordSecretKey } from './passwordSecrets';
import { SessionStorage } from './sessionStorage';
import { SessionFolderTreeItem, SessionsTreeProvider } from './sessionsTreeProvider';

export async function addSessionFolderCommand(
  provider: SessionsTreeProvider,
  storage: SessionStorage,
  node?: SessionFolderTreeItem
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: '새 폴더 이름',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : '폴더 이름을 입력하세요.'),
  });
  if (!name) return;
  storage.addFolder(node?.folder.id ?? null, name);
  provider.refresh();
}

export async function renameSessionFolderCommand(
  provider: SessionsTreeProvider,
  storage: SessionStorage,
  node?: SessionFolderTreeItem
): Promise<void> {
  if (!node) return;
  const newName = await vscode.window.showInputBox({
    title: '폴더 이름 변경',
    value: node.folder.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : '폴더 이름을 입력하세요.'),
  });
  if (!newName || newName === node.folder.name) return;
  storage.renameFolder(node.folder.id, newName);
  provider.refresh();
}

export async function deleteSessionFolderCommand(
  provider: SessionsTreeProvider,
  storage: SessionStorage,
  secrets: vscode.SecretStorage,
  node?: SessionFolderTreeItem
): Promise<void> {
  if (!node) return;
  const affected = storage.getSessionsUnderFolder(node.folder.id);

  const choice = await vscode.window.showWarningMessage(
    `"${node.folder.name}" 폴더${affected.length > 0 ? `와 그 안의 세션 ${affected.length}개를` : '를'} 모두 삭제하시겠습니까?`,
    { modal: true },
    '모두 삭제'
  );
  if (choice !== '모두 삭제') return;

  const deletedIds = storage.deleteFolder(node.folder.id);
  for (const id of deletedIds) {
    await secrets.delete(passwordSecretKey(id));
  }
  provider.refresh();
}
