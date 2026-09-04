import * as vscode from 'vscode';
import { listWslDistros } from '../wsl/wslTerminal';
import { SessionStorage } from './sessionStorage';
import { SessionFolder, SessionProfile } from './types';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly profile: SessionProfile, connected = false) {
    super(profile.sessionName, vscode.TreeItemCollapsibleState.None);
    // 우클릭 메뉴에서 연결/연결 해제를 상태에 맞게 하나만 보여주려면 contextValue로 구분해야 한다
    // (view/item/context의 when절은 항목별 상태를 viewItem으로밖에 못 본다).
    this.contextValue = connected ? 'sessionConnected' : 'session';
    const target = `${profile.userName ? profile.userName + '@' : ''}${profile.hostName}:${profile.portNumber}`;
    this.description = connected ? `${target} (연결됨)` : target;
    this.tooltip = `${profile.sessionName}\n${target}\n인증: ${profile.authMethod}${connected ? '\n연결됨' : ''}`;
    this.iconPath = new vscode.ThemeIcon(
      'remote-explorer',
      connected ? new vscode.ThemeColor('charts.green') : undefined
    );
    // 한 번 클릭은 선택만 한다 (복사/잘라내기/드래그 대상 지정을 위해). 예전엔 클릭에 연결 명령을
    // 바로 물렸는데, 그러면 세션을 "선택"하려는 클릭마다 즉시 연결이 시작되고(연결 시 사이드바까지
    // 접혀서) 복사/잘라내기가 아예 안 됐다. 더블클릭 판정은 vssh.session.click 쪽에서 한다.
    this.command = {
      command: 'vssh.session.click',
      title: '',
      arguments: [profile.id],
    };
  }
}

export class SessionFolderTreeItem extends vscode.TreeItem {
  constructor(public readonly folder: SessionFolder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'sessionFolder';
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

/** SSH가 아니라 wsl.exe를 직접 실행하는 로컬 WSL 배포판 항목. */
export class WslTreeItem extends vscode.TreeItem {
  constructor(public readonly distro: string) {
    super(distro, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'wsl';
    this.description = '로컬 WSL';
    this.tooltip = `로컬 WSL 배포판 "${distro}"에 바로 터미널을 엽니다 (SSH를 거치지 않음).`;
    this.iconPath = new vscode.ThemeIcon('terminal-linux');
    this.command = {
      command: 'vssh.wsl.click',
      title: 'WSL 터미널 열기',
      arguments: [distro],
    };
  }
}

export type SessionsTreeItemUnion = SessionTreeItem | WslTreeItem | SessionFolderTreeItem;

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionsTreeItemUnion> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private connectedIds: ReadonlySet<string> = new Set();
  private distros: string[] | undefined;
  private distrosPending: Promise<string[]> | undefined;

  constructor(private readonly storage: SessionStorage) {}

  /**
   * rediscoverWsl은 wsl.exe를 다시 실행해 배포판 목록을 새로 읽는다. 트리는 연결 상태 변화 등으로
   * 자주 다시 그려지는데 그때마다 프로세스를 띄우면 낭비라, 평소엔 캐시를 쓰고 사용자가 명시적으로
   * 새로고침했을 때만 다시 읽는다.
   */
  refresh(rediscoverWsl = false): void {
    if (rediscoverWsl) this.distros = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  private async getDistros(): Promise<string[]> {
    if (this.distros) return this.distros;
    if (!this.distrosPending) {
      // 트리를 그리는 것만으로 WSL이 시작되지 않도록 레지스트리만 조회한다.
      this.distrosPending = listWslDistros(false).then((list) => {
        this.distros = list;
        this.distrosPending = undefined;
        return list;
      });
    }
    return this.distrosPending;
  }

  /** 지금 터미널이 열려 있는 세션 id들. 바뀔 때마다 트리를 다시 그려 연결 표시를 갱신한다. */
  setConnectedIds(ids: ReadonlySet<string>): void {
    this.connectedIds = ids;
    this.refresh();
  }

  getTreeItem(element: SessionsTreeItemUnion): vscode.TreeItem {
    return element;
  }

  /**
   * WSL 항목도 세션과 같은 자격으로 폴더 안팎에 놓이고 이름순으로 섞여 정렬된다.
   * (예전엔 항상 루트 맨 위에 고정이라 폴더로 옮길 수 없었다.)
   */
  private async childrenOf(parentId: string | null): Promise<SessionsTreeItemUnion[]> {
    const entries: { isFolder: boolean; sortKey: string; item: SessionsTreeItemUnion }[] = this.storage
      .getChildren(parentId)
      .map((node) =>
        node.type === 'folder'
          ? {
              isFolder: true,
              sortKey: node.name,
              item: new SessionFolderTreeItem({ id: node.id, name: node.name }),
            }
          : {
              isFolder: false,
              sortKey: node.sessionName,
              item: new SessionTreeItem(node, this.connectedIds.has(node.id)),
            }
      );

    for (const distro of await this.getDistros()) {
      if (this.storage.getWslParentId(distro) !== parentId) continue;
      entries.push({ isFolder: false, sortKey: distro, item: new WslTreeItem(distro) });
    }

    entries.sort((a, b) =>
      a.isFolder !== b.isFolder ? (a.isFolder ? -1 : 1) : a.sortKey.localeCompare(b.sortKey, 'ko')
    );
    return entries.map((e) => e.item);
  }

  async getChildren(element?: SessionsTreeItemUnion): Promise<SessionsTreeItemUnion[]> {
    if (element instanceof SessionFolderTreeItem) {
      return this.childrenOf(element.folder.id);
    }
    if (element) return [];
    return this.childrenOf(null);
  }

  /** 트리 구조와 무관하게 저장된 세션 전체 목록 (QuickPick 등 폴더 무시하고 골라야 할 때 사용). */
  getAllProfiles(): SessionProfile[] {
    return this.storage.getAllSessions();
  }
}
