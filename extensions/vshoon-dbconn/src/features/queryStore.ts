import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { queryFileName, uniqueFileName } from './queryFiles';
import { log } from '../util/logger';

/**
 * 저장되는 쿼리 파일의 보관소.
 *
 * 새 SQL 편집기는 이름 없는 문서가 아니라 **파일**로 만든다. 이름 없는 문서는
 * 창을 닫는 순간 사라지고, 그걸 되살리는 일을 초안 캐시가 떠안고 있었다.
 * 애초에 파일로 두면 그 문제가 없다 — 다시 열 수 있고, 검색되고, 원하면
 * 워크스페이스로 옮겨 형상 관리에 넣을 수도 있다.
 *
 * 기본 위치는 홈 디렉터리의 **`.vscode/dbconn/queries`** 다. 워크스페이스 안에
 * 두면 남의 저장소에 잡동사니를 만들게 되고, 워크스페이스 없이 연 창에서는 둘
 * 곳이 없어진다. `dbconn.scripts.folder` 로 옮길 수 있다.
 *
 * 확장의 전역 저장소(globalStorageUri)를 쓰지 않는 이유가 있다. 그 폴더는
 * `vscode-userdata` 스킴으로 열리는데, 스킴을 `file` 로 가정한 코드(자동 완성
 * 등록·최근 목록 등)가 그 문서만 조용히 건너뛴다. 평범한 파일 경로에 두면
 * 그런 함정이 아예 없고, 사용자가 탐색기로 찾아가기도 쉽다.
 *
 * 여기에는 사용자가 쓴 SQL 이 그대로 남는다. 초안 캐시와 같은 성질이므로
 * 같은 경고가 적용된다 — 쿼리에 자격 증명을 적는 습관이 있다면 이 파일에도
 * 남는다.
 */

/** 홈 디렉터리 기준 기본 보관 경로. */
const DEFAULT_FOLDER = ['.vscode', 'dbconn', 'queries'];
/** 예전 기본 위치(전역 저장소). 남아 있는 파일을 새 폴더로 한 번 옮겨 준다. */
const LEGACY_FOLDER = 'queries';
/** 자동 저장 지연 — 타자마다 디스크에 쓰지 않도록. */
const AUTOSAVE_MS = 1_200;

export interface SavedQuery {
  uri: vscode.Uri;
  /** 파일 이름 (확장자 포함). */
  name: string;
  /** 마지막 수정 시각(ms). 목록은 최신순으로 정렬한다. */
  modifiedAt: number;
  size: number;
}

export class QueryStore implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  activate(): void {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.scheduleSave(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        // 닫히는 문서의 예약은 의미가 없다 (닫기 전 VS Code 가 저장 여부를 묻는다).
        this.cancel(document.uri.toString());
      }),
    );
    void this.migrateLegacy();
  }

  /**
   * 예전 기본 위치(전역 저장소)에 만든 쿼리를 새 폴더로 옮긴다.
   *
   * 복사만 하고 원본은 지우지 않는다 — 옮기다 실패해도 잃는 것이 없어야 한다.
   * 같은 이름이 이미 있으면 건너뛰므로 여러 번 실행해도 결과가 같다.
   */
  private async migrateLegacy(): Promise<void> {
    if (vscode.workspace.getConfiguration('dbconn').get<string>('scripts.folder', '').trim()) {
      return; // 사용자가 위치를 정했으면 건드리지 않는다.
    }
    const legacy = vscode.Uri.joinPath(this.context.globalStorageUri, LEGACY_FOLDER);
    const target = this.folderUri();
    if (legacy.toString() === target.toString()) {
      return;
    }

    let names: string[];
    try {
      names = (await vscode.workspace.fs.readDirectory(legacy))
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name)
        .filter((name) => name.toLowerCase().endsWith('.sql'));
    } catch {
      return; // 예전 폴더가 없다 — 옮길 것도 없다.
    }
    if (names.length === 0) {
      return;
    }

    let moved = 0;
    try {
      await vscode.workspace.fs.createDirectory(target);
      const existing = new Set(await this.fileNames(target));
      for (const name of names) {
        if (existing.has(name)) {
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(legacy, name));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, name), bytes);
        moved++;
      }
    } catch (error) {
      log.warn('예전 위치의 쿼리를 옮기지 못했습니다.', error);
      return;
    }

    if (moved > 0) {
      log.info(`쿼리 ${moved}개를 ${target.fsPath} 로 옮겼습니다 (원본은 그대로 둡니다).`);
    }
  }

  /**
   * 쿼리를 보관하는 폴더.
   *
   * 설정이 있으면 그 경로, 없으면 전역 저장소 아래.
   * `~` 는 홈으로, 상대 경로는 워크스페이스 기준으로 푼다.
   */
  folderUri(): vscode.Uri {
    const configured = vscode.workspace
      .getConfiguration('dbconn')
      .get<string>('scripts.folder', '')
      .trim();
    if (configured === '') {
      return vscode.Uri.file(join(homedir(), ...DEFAULT_FOLDER));
    }
    if (configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')) {
      return vscode.Uri.file(`${homedir()}${configured.slice(1)}`);
    }
    // 상대 경로는 워크스페이스 기준으로 본다. 그대로 두면 드라이브 최상위처럼
    // 아무도 의도하지 않은 곳을 가리킨다.
    if (!isAbsolute(configured)) {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      return workspace
        ? vscode.Uri.joinPath(workspace.uri, configured)
        : vscode.Uri.file(join(homedir(), configured));
    }
    return vscode.Uri.file(configured);
  }

  /**
   * 이 문서가 쿼리 보관 폴더 안의 파일인지 — 자동 저장 대상 판정.
   *
   * 스킴을 `file` 로 못 박지 않는다. 확장의 전역 저장소는 `vscode-userdata`
   * 스킴으로 열려서, 못 박아 두면 정작 우리가 만든 파일이 자동 저장에서 빠진다.
   * 폴더와 같은 스킴인지만 보고 경로로 비교한다.
   */
  isStoredQuery(document: vscode.TextDocument): boolean {
    const folder = this.folderUri();
    if (document.uri.scheme !== folder.scheme) {
      return false;
    }
    const base = normalizePath(folder.path);
    return normalizePath(document.uri.path).startsWith(base.endsWith('/') ? base : `${base}/`);
  }

  /**
   * 새 쿼리 파일을 만든다.
   *
   * 파일을 먼저 만들어 두는 것이 핵심이다 — 편집기를 열기만 하고 저장을
   * 사용자에게 맡기면, 저장을 잊은 창 하나가 그대로 사라지는 예전 문제로
   * 돌아간다.
   */
  async create(label: string | undefined, content: string): Promise<vscode.Uri> {
    const folder = this.folderUri();
    await vscode.workspace.fs.createDirectory(folder);

    const taken = await this.fileNames(folder);
    const name = uniqueFileName(queryFileName(new Date(), label), taken);
    const uri = vscode.Uri.joinPath(folder, name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    log.debug(`새 쿼리 파일: ${uri.fsPath}`);
    return uri;
  }

  /** 보관된 쿼리 목록. 최신 수정순. 폴더가 없으면 빈 목록. */
  async list(): Promise<SavedQuery[]> {
    const folder = this.folderUri();
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      return []; // 아직 아무것도 만들지 않았다.
    }

    const files: SavedQuery[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.sql')) {
        continue;
      }
      const uri = vscode.Uri.joinPath(folder, name);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        files.push({ uri, name, modifiedAt: stat.mtime, size: stat.size });
      } catch {
        // 방금 지워졌을 수 있다 — 목록에서 빠지면 그만이다.
      }
    }
    return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
  }

  private async fileNames(folder: vscode.Uri): Promise<string[]> {
    try {
      return (await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name);
    } catch {
      return [];
    }
  }

  // ── 자동 저장 ─────────────────────────────────────────────────────────────

  /**
   * 보관 폴더 안의 SQL 파일은 잠시 뒤 자동으로 저장한다.
   *
   * 대상을 이 폴더로 좁힌 것이 중요하다. 사용자의 다른 파일까지 저장하면
   * 빌드·감시 도구가 돌고, 무엇보다 사용자가 정한 저장 시점을 확장이 빼앗는
   * 셈이 된다. 여기 파일들은 확장이 만든 것이고 저장돼 있는 것이 기본값이다.
   */
  private scheduleSave(document: vscode.TextDocument): void {
    if (document.languageId !== 'sql' || !document.isDirty || document.isClosed) {
      return;
    }
    if (!this.enabled() || !this.isStoredQuery(document)) {
      return;
    }

    const key = document.uri.toString();
    this.cancel(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (document.isClosed || !document.isDirty) {
          return;
        }
        void document.save().then(undefined, (error: unknown) => {
          log.debug('쿼리 자동 저장 실패', error);
        });
      }, AUTOSAVE_MS),
    );
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('dbconn').get<boolean>('scripts.autoSave', true);
  }

  private cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

/** 경로 비교용 정규화 — 윈도는 구분자가 둘이고 대소문자를 구분하지 않는다. */
function normalizePath(value: string): string {
  const slashed = value.split('\\').join('/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}
