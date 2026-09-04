import * as vscode from 'vscode';
import { SessionStorage } from './sessionStorage';
import {
  SessionFolderTreeItem,
  SessionTreeItem,
  SessionsTreeItemUnion,
  SessionsTreeProvider,
  WslTreeItem,
} from './sessionsTreeProvider';

const TREE_MIME_TYPE = 'application/vnd.code.tree.vsshsessions';

/** 세션/폴더/WSL 항목을 다른 폴더로 끌어다 놓아 옮긴다. */
export class SessionsDragAndDropController implements vscode.TreeDragAndDropController<SessionsTreeItemUnion> {
  readonly dropMimeTypes = [TREE_MIME_TYPE];
  readonly dragMimeTypes = [TREE_MIME_TYPE];

  constructor(
    private readonly provider: SessionsTreeProvider,
    private readonly storage: SessionStorage
  ) {}

  handleDrag(source: readonly SessionsTreeItemUnion[], dataTransfer: vscode.DataTransfer): void {
    if (source.length > 0) {
      dataTransfer.set(TREE_MIME_TYPE, new vscode.DataTransferItem([...source]));
    }
  }

  handleDrop(target: SessionsTreeItemUnion | undefined, dataTransfer: vscode.DataTransfer): void {
    // 세션/WSL 항목 위로의 드롭은 지원하지 않는다 (폴더가 아니라 담을 곳이 없다).
    if (target instanceof SessionTreeItem || target instanceof WslTreeItem) return;

    const targetFolderId = target instanceof SessionFolderTreeItem ? target.folder.id : null;
    const item = dataTransfer.get(TREE_MIME_TYPE);
    if (!item) return;
    const nodes = item.value as SessionsTreeItemUnion[];

    for (const node of nodes) {
      if (node instanceof WslTreeItem) {
        this.storage.setWslParentId(node.distro, targetFolderId);
      } else if (node instanceof SessionFolderTreeItem) {
        if (node.folder.id === targetFolderId) continue;
        if (this.storage.isDescendantOfOrSelf(node.folder.id, targetFolderId)) {
          vscode.window.showErrorMessage(`VSsh: "${node.folder.name}" 폴더는 자기 자신의 하위로 이동할 수 없습니다.`);
          continue;
        }
        this.storage.moveNode(node.folder.id, targetFolderId);
      } else {
        this.storage.moveNode(node.profile.id, targetFolderId);
      }
    }
    this.provider.refresh();
  }
}
