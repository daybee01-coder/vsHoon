import * as vscode from 'vscode';
import { log } from '../util/logger';
import {
  needsTouch,
  normalizeRecents,
  removeRecent,
  touchRecent,
  type RecentScriptEntry,
} from './recentIndex';

/**
 * 최근 연 SQL 편집기 목록.
 *
 * VS Code 의 "최근 항목 열기"는 워크스페이스와 온갖 파일이 뒤섞여 있어서,
 * 어제 쓰던 쿼리 파일 하나를 찾는 데 쓰기 어렵다. 여기서는 **SQL 파일만** 따로
 * 기억한다.
 *
 * 내용은 복사하지 않는다 — 경로와 마지막으로 본 시각만 남긴다. 초안 캐시와
 * 달리 원본 파일이 진실이므로, 사본을 두면 어느 쪽이 최신인지 알 수 없어진다.
 * 그래서 이 목록은 사용자가 지운 SQL 을 되살리지 못한다(그건 초안 캐시의 일이다).
 */

const KEY = 'dbconn.recentScripts.v1';

export class RecentScripts implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  activate(): void {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          void this.touch(editor.document);
        }
      }),
      // 저장은 "지금 이걸 쓰고 있다"는 가장 분명한 신호다.
      vscode.workspace.onDidSaveTextDocument((document) => void this.touch(document)),
    );

    // 창을 다시 열었을 때 이미 떠 있는 편집기도 담는다.
    const active = vscode.window.activeTextEditor?.document;
    if (active) {
      void this.touch(active);
    }
  }

  list(): RecentScriptEntry[] {
    return normalizeRecents(this.context.globalState.get<unknown>(KEY, []));
  }

  /**
   * 목록에서 하나를 연다.
   *
   * 파일이 사라졌으면 목록에서 지운다 — 지워진 파일이 목록에 남아 있으면
   * 누를 때마다 같은 오류를 본다.
   */
  async open(entry: RecentScriptEntry): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      log.debug('최근 SQL 파일을 열지 못했습니다.', error);
      void vscode.window.showWarningMessage(
        `파일을 열지 못했습니다. 목록에서 제거합니다: ${entry.folder ? `${entry.folder}/` : ''}${entry.label}`,
      );
      await this.remove(entry.uri);
    }
  }

  async remove(uri: string): Promise<void> {
    await this.context.globalState.update(KEY, removeRecent(this.list(), uri));
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(KEY, []);
  }

  /**
   * 대상은 **파일로 저장된 SQL** 뿐이다.
   *
   * untitled 초안은 여기 담지 않는다. uri 가 창을 닫는 순간 의미를 잃어서
   * 다시 열 수 없기 때문이다 — 그쪽은 내용을 통째로 보관하는 초안 캐시가 맡는다.
   */
  private async touch(document: vscode.TextDocument): Promise<void> {
    // untitled 만 걸러 낸다. 확장이 만든 쿼리 파일은 `vscode-userdata` 스킴이라
    // `file` 로 못 박으면 정작 이 도구로 만든 쿼리가 최근 목록에 안 들어온다.
    if (document.languageId !== 'sql' || !isReopenable(document.uri)) {
      return;
    }
    const uri = document.uri.toString();
    const entries = this.list();
    const now = Date.now();
    if (!needsTouch(entries, uri, now)) {
      return;
    }
    const entry: RecentScriptEntry = {
      uri,
      label: basename(document.uri),
      folder: displayFolder(document.uri),
      usedAt: now,
    };
    try {
      await this.context.globalState.update(KEY, touchRecent(entries, entry));
    } catch (error) {
      // 목록은 부가 기능이다. 실패해도 편집을 방해하지 않는다.
      log.debug('최근 SQL 목록 저장 실패', error);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }
}

/**
 * 다시 열 수 있는 문서인가.
 *
 * 목록에는 경로만 남기므로, 나중에 그 uri 로 다시 열 수 있어야 의미가 있다.
 * `untitled` 는 창을 닫는 순간 사라지고(그쪽은 초안 캐시가 맡는다), 진단·차이
 * 보기 같은 읽기 전용 가상 문서도 목록에 남길 것이 못 된다.
 */
function isReopenable(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-userdata' || uri.scheme === 'vscode-remote';
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? uri.path;
}

/**
 * 목록에 보여줄 위치.
 *
 * 워크스페이스 안이면 상대 경로가 훨씬 읽기 쉽다 —
 * 전체 경로는 앞부분이 다 같아서 정작 다른 부분이 화면 밖으로 밀린다.
 */
function displayFolder(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  // 워크스페이스 밖의 파일이면 asRelativePath 가 OS 경로를 그대로 돌려준다 —
  // 윈도우에서는 역슬래시라, `/` 로만 자르면 위치가 통째로 사라진다.
  const full = vscode.workspace
    .asRelativePath(uri, /* includeWorkspaceFolder */ folder !== undefined)
    .replace(/\\/g, '/');
  const cut = full.lastIndexOf('/');
  return cut > 0 ? full.slice(0, cut) : '';
}
