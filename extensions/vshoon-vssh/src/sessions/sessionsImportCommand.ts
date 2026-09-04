import * as vscode from 'vscode';
import { pickAvailableName } from '../common/naming';
import { listPuttySessionsForImport } from './puttyImport';
import { SessionStorage } from './sessionStorage';
import { SessionsTreeProvider } from './sessionsTreeProvider';

const IMPORT_FOLDER_NAME = 'PuTTY 가져오기';

/** 실제 PuTTY 레지스트리의 세션을 확장 자체 저장소로 1회성 가져오기한다 (더 이상 동기화되지 않음). */
export async function importFromPuttyCommand(provider: SessionsTreeProvider, storage: SessionStorage): Promise<void> {
  const sessions = await listPuttySessionsForImport();
  if (sessions.length === 0) {
    vscode.window.showInformationMessage('VSsh: 가져올 PuTTY 세션이 없습니다.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({ label: s.name, picked: true, session: s })),
    { title: `VSsh: 가져올 PuTTY 세션 선택 (${sessions.length}개 발견)`, canPickMany: true, ignoreFocusOut: true }
  );
  if (!picked || picked.length === 0) return;

  const existingFolder = storage.getChildren(null).find((n) => n.type === 'folder' && n.name === IMPORT_FOLDER_NAME);
  const folderId =
    existingFolder && existingFolder.type === 'folder' ? existingFolder.id : storage.addFolder(null, IMPORT_FOLDER_NAME).id;

  const existingNames = new Set(
    storage
      .getChildren(folderId)
      .filter((n) => n.type === 'session')
      .map((n) => n.sessionName)
  );

  for (const item of picked) {
    const name = pickAvailableName(item.session.name, existingNames);
    existingNames.add(name);
    storage.addSession(folderId, { ...item.session.profile, sessionName: name });
  }

  provider.refresh();
  vscode.window.showInformationMessage(`VSsh: 세션 ${picked.length}개를 "${IMPORT_FOLDER_NAME}" 폴더로 가져왔습니다.`);
}
