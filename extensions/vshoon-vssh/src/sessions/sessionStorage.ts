import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SessionFolder, SessionProfile, StoreNode } from './types';

interface StoreFile {
  version: 1;
  nodes: StoreNode[];
  /**
   * WSL 배포판은 우리가 만드는 게 아니라 wsl.exe가 알려주는 목록이라 세션처럼 노드로 저장할
   * 수 없다(설치/삭제되면 목록이 바뀐다). 대신 "어느 폴더에 놓였는지"만 배포판 이름으로
   * 기억해서, 다음에 목록을 다시 읽어도 사용자가 옮겨둔 자리에 그대로 나타나게 한다.
   */
  wslPlacements?: Record<string, string>;
}

type FolderStoreNode = StoreNode & { type: 'folder' };
type SessionStoreNode = StoreNode & { type: 'session' };

function isFolder(n: StoreNode): n is FolderStoreNode {
  return n.type === 'folder';
}

function isSession(n: StoreNode): n is SessionStoreNode {
  return n.type === 'session';
}

function toProfile(n: SessionStoreNode): SessionProfile {
  const { type: _type, parentId: _parentId, ...profile } = n;
  return profile;
}

/**
 * PuTTY 레지스트리 대신 확장 자체 storage(JSON 파일)에 세션을 저장한다.
 * 트리는 parentId를 통한 평면 목록으로 표현한다 - 파일시스템 inode 테이블과 같은 구조라
 * 이동/삭제/이름변경이 하위 트리를 재귀적으로 손보지 않고 필드 하나만 바꾸면 끝난다.
 */
export class SessionStorage {
  private readonly filePath: string;
  private readonly backupPath: string;
  private nodes: StoreNode[] = [];
  private wslPlacements: Record<string, string> = {};
  private loaded = false;
  private lastMtimeMs = 0;
  private loadError: Error | undefined;
  private loadedFromBackup = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'sessions.json');
    this.backupPath = `${this.filePath}.bak`;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loadError = undefined;
    this.loadedFromBackup = false;
    try {
      this.loadFile(this.filePath);
      return;
    } catch (mainError) {
      if (!fs.existsSync(this.filePath) && !fs.existsSync(this.backupPath)) {
        this.nodes = [];
        this.wslPlacements = {};
        this.lastMtimeMs = 0;
        return;
      }
      try {
        this.loadFile(this.backupPath);
        this.loadedFromBackup = true;
        return;
      } catch {
        this.loadError = new Error(
          `세션 저장소를 읽을 수 없습니다. 손상된 파일을 보존했습니다: ${this.filePath} (${String(mainError)})`
        );
      }
      this.nodes = [];
      this.wslPlacements = {};
    }
  }

  private loadFile(filePath: string): void {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StoreFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) {
      throw new Error('지원하지 않거나 손상된 세션 저장소 형식입니다.');
    }
    this.nodes = parsed.nodes;
    this.wslPlacements = parsed.wslPlacements ?? {};
    this.lastMtimeMs = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).mtimeMs : 0;
  }

  /** 다른 VS Code 창에서 저장소가 바뀌었으면 변경을 적용하기 직전에 다시 읽는다. */
  private prepareMutation(): void {
    this.ensureLoaded();
    if (this.loadError) throw this.loadError;
    const currentMtime = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).mtimeMs : 0;
    if (currentMtime !== this.lastMtimeMs) {
      this.loaded = false;
      this.ensureLoaded();
      if (this.loadError) throw this.loadError;
    }
  }

  private persist(): void {
    if (this.loadError) throw this.loadError;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data: StoreFile = { version: 1, nodes: this.nodes, wslPlacements: this.wslPlacements };
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      if (!this.loadedFromBackup && fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, this.backupPath);
      fs.renameSync(tempPath, this.filePath);
      this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs;
      this.loadedFromBackup = false;
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* rename이 성공했거나 임시 파일 정리가 불가능하면 무시 */
      }
    }
  }

  private static newId(): string {
    return crypto.randomUUID();
  }

  getChildren(parentId: string | null): StoreNode[] {
    this.ensureLoaded();
    return this.nodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        const nameA = isFolder(a) ? a.name : a.sessionName;
        const nameB = isFolder(b) ? b.name : b.sessionName;
        return nameA.localeCompare(nameB, 'ko');
      });
  }

  getAllSessions(): SessionProfile[] {
    this.ensureLoaded();
    return this.nodes.filter(isSession).map(toProfile);
  }

  getFolder(id: string): SessionFolder | undefined {
    this.ensureLoaded();
    const node = this.nodes.find((n): n is FolderStoreNode => isFolder(n) && n.id === id);
    return node ? { id: node.id, name: node.name } : undefined;
  }

  getSession(id: string): SessionProfile | undefined {
    this.ensureLoaded();
    const node = this.nodes.find((n): n is SessionStoreNode => isSession(n) && n.id === id);
    return node ? toProfile(node) : undefined;
  }

  /** 지정한 폴더 자신 + 모든 하위 폴더의 id 집합. */
  private collectDescendantFolderIds(rootFolderId: string): Set<string> {
    const ids = new Set([rootFolderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of this.nodes) {
        if (isFolder(n) && n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
          ids.add(n.id);
          changed = true;
        }
      }
    }
    return ids;
  }

  /** folderId를 candidateParentId 아래로 옮기면 자기 자신이나 자기 하위로 들어가는 순환이 생기는지 확인한다. */
  isDescendantOfOrSelf(folderId: string, candidateParentId: string | null): boolean {
    if (candidateParentId === null) return false;
    if (candidateParentId === folderId) return true;
    this.ensureLoaded();
    return this.collectDescendantFolderIds(folderId).has(candidateParentId);
  }

  /** 지정한 폴더(및 하위 폴더 전체)에 속한 세션을 전부 반환한다. */
  getSessionsUnderFolder(folderId: string): SessionProfile[] {
    this.ensureLoaded();
    const folderIds = this.collectDescendantFolderIds(folderId);
    return this.nodes
      .filter((n): n is SessionStoreNode => isSession(n) && n.parentId !== null && folderIds.has(n.parentId))
      .map(toProfile);
  }

  addFolder(parentId: string | null, name: string): SessionFolder {
    this.prepareMutation();
    const id = SessionStorage.newId();
    this.nodes.push({ type: 'folder', id, parentId, name });
    this.persist();
    return { id, name };
  }

  renameFolder(id: string, name: string): void {
    this.prepareMutation();
    const node = this.nodes.find((n): n is FolderStoreNode => isFolder(n) && n.id === id);
    if (!node) throw new Error('폴더를 찾을 수 없습니다.');
    node.name = name;
    this.persist();
  }

  /** 폴더와 그 안의 모든 하위 폴더/세션을 통째로 지운다. 지워진 세션 id 목록을 돌려준다(비밀번호 정리용). */
  deleteFolder(id: string): string[] {
    this.prepareMutation();
    const folderIds = this.collectDescendantFolderIds(id);
    const deletedSessionIds = this.nodes
      .filter((n) => isSession(n) && n.parentId !== null && folderIds.has(n.parentId))
      .map((n) => n.id);
    this.nodes = this.nodes.filter(
      (n) => !(folderIds.has(n.id) || (n.parentId !== null && folderIds.has(n.parentId)))
    );
    this.persist();
    return deletedSessionIds;
  }

  addSession(parentId: string | null, profile: Omit<SessionProfile, 'id'>): SessionProfile {
    this.prepareMutation();
    const id = SessionStorage.newId();
    const node: SessionStoreNode = { type: 'session', id, parentId, ...profile };
    this.nodes.push(node);
    this.persist();
    return toProfile(node);
  }

  updateSession(id: string, profile: Omit<SessionProfile, 'id'>): void {
    this.prepareMutation();
    const index = this.nodes.findIndex((n) => isSession(n) && n.id === id);
    if (index === -1) throw new Error('세션을 찾을 수 없습니다.');
    const existing = this.nodes[index] as SessionStoreNode;
    this.nodes[index] = { type: 'session', id, parentId: existing.parentId, ...profile };
    this.persist();
  }

  deleteSession(id: string): void {
    this.prepareMutation();
    this.nodes = this.nodes.filter((n) => n.id !== id);
    this.persist();
  }

  /** WSL 배포판이 놓인 폴더 id. 그 폴더가 지워졌으면 루트로 되돌린다(항목이 사라져 보이지 않게). */
  getWslParentId(distro: string): string | null {
    this.ensureLoaded();
    const parentId = this.wslPlacements[distro];
    if (!parentId) return null;
    return this.nodes.some((n) => isFolder(n) && n.id === parentId) ? parentId : null;
  }

  setWslParentId(distro: string, parentId: string | null): void {
    this.prepareMutation();
    if (parentId === null) {
      delete this.wslPlacements[distro];
    } else {
      this.wslPlacements[distro] = parentId;
    }
    this.persist();
  }

  moveNode(id: string, newParentId: string | null): void {
    this.prepareMutation();
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error('항목을 찾을 수 없습니다.');
    node.parentId = newParentId;
    this.persist();
  }

  duplicateSession(id: string, newParentId: string | null): SessionProfile {
    const source = this.getSession(id);
    if (!source) throw new Error('세션을 찾을 수 없습니다.');
    const { id: _drop, ...rest } = source;
    return this.addSession(newParentId, rest);
  }
}
