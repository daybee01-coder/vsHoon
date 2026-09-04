import * as vscode from 'vscode';
import type { ProfileStore } from '../config/profileStore';
import type { ConnectionProfile, SessionStatus } from '../types';
import { describeTlsRisk } from './tls';
import { log } from '../util/logger';
import { Session } from './session';

/** 편집기별 연결 지정을 워크스페이스에 남기는 자리. */
const BINDINGS_KEY = 'dbconn.editorConnections.v1';

/**
 * 활성 세션들의 소유자.
 *
 * 확장 어디에서도 Session 을 직접 만들지 않는다 — 반드시 여기를 거친다.
 * 그래야 dispose 시 단 한 곳에서 모든 풀을 확실히 닫을 수 있다.
 *
 * "활성 연결"은 두 겹이다:
 *  - **편집기별 지정** — 문서 하나에 연결 하나를 붙여 둔 것. 창을 오가며
 *    개발/운영 쿼리를 나란히 두고 작업할 때, 활성 연결 하나만 있으면
 *    편집기를 옮길 때마다 연결을 바꿔야 하고 결국 엉뚱한 DB 로 실행된다.
 *  - **전역 기본** — 지정이 없는 편집기와 트리 명령이 쓰는 값.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private activeProfileId: string | undefined;
  private readonly sessionSubscriptions = new Map<string, vscode.Disposable>();
  private readonly subscriptions: vscode.Disposable[] = [];

  /** 문서 URI → 프로필 id. 살아 있는 세션이 아니라 프로필을 가리킨다. */
  private readonly bindings = new Map<string, string>();
  /**
   * 마지막으로 활성이던 텍스트 편집기.
   *
   * 결과 패널이나 트리에 초점이 가면 `activeTextEditor` 가 비는데, 그때도
   * "지금 작업 중인 편집기의 연결"을 알아야 상태바와 실행 대상이 흔들리지 않는다.
   */
  private lastEditorKey: string | undefined;
  /** 그 직전에 보던 편집기. 이름 없는 문서를 저장할 때 지정을 옮기는 데 쓴다. */
  private previousEditorKey: string | undefined;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** 세션 목록/상태/활성 연결이 바뀔 때 발생. 트리와 상태바가 구독한다. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly profiles: ProfileStore,
    /** 편집기별 지정을 남길 저장소(workspaceState). 없으면 메모리에만 둔다. */
    private readonly storage?: vscode.Memento,
  ) {
    this.restoreBindings();
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.previousEditorKey = this.lastEditorKey;
          this.lastEditorKey = editor.document.uri.toString();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.carryBindingToSavedFile(document);
      }),
      // 연결이 삭제되면 그 연결을 가리키던 지정도 의미가 없다.
      profiles.onDidChange(() => this.pruneBindings()),
    );
    this.lastEditorKey = vscode.window.activeTextEditor?.document.uri.toString();
  }

  get(profileId: string): Session | undefined {
    return this.sessions.get(profileId);
  }

  isConnected(profileId: string): boolean {
    return this.sessions.has(profileId);
  }

  /**
   * 지금 실행에 쓸 세션.
   * 편집기에 지정된 연결이 있으면 그것, 없으면 전역 기본.
   */
  activeSession(): Session | undefined {
    return this.sessionForEditor(this.currentEditorKey());
  }

  /**
   * 이 편집기에서 쓸 세션.
   *
   * 지정된 연결이 아직 접속 전이면 전역 기본으로 조용히 넘어가지 않는다 —
   * 다른 DB 로 실행되거나 다른 DB 의 스키마를 자동 완성해 주는 것보다,
   * "연결이 없다"고 말하는 편이 낫다.
   */
  sessionForEditor(editorKey: string | undefined): Session | undefined {
    const bound = this.boundProfileId(editorKey);
    if (bound) {
      return this.sessions.get(bound);
    }
    return this.activeProfileId ? this.sessions.get(this.activeProfileId) : undefined;
  }

  /**
   * 이 편집기가 바라보는 연결 프로필. **접속 여부와 무관하다.**
   *
   * 세션이 없다고 아무것도 모르는 것은 아니다 — 스키마 캐시는 연결이 끊겨도
   * 남아 있어서, 자동 완성은 그것만으로도 테이블·컬럼을 제안할 수 있다.
   * 실행처럼 실제로 서버가 필요한 일과, 메타데이터만 있으면 되는 일을
   * 구분하기 위해 세션과 프로필을 따로 물어보게 둔다.
   */
  profileForEditor(editorKey: string | undefined): ConnectionProfile | undefined {
    const bound = this.boundProfileId(editorKey);
    if (bound) {
      return this.profiles.get(bound);
    }
    return this.activeProfileId ? this.profiles.get(this.activeProfileId) : undefined;
  }

  setActive(profileId: string | undefined): void {
    this.activeProfileId = profileId;
    this.onDidChangeEmitter.fire();
  }

  // ── 편집기별 연결 ─────────────────────────────────────────────────────────

  /** 지금(또는 마지막으로) 보고 있던 편집기의 키. */
  currentEditorKey(): string | undefined {
    return vscode.window.activeTextEditor?.document.uri.toString() ?? this.lastEditorKey;
  }

  /** 이 편집기에 지정된 프로필. 프로필이 지워졌으면 undefined. */
  boundProfileId(editorKey: string | undefined): string | undefined {
    if (!editorKey) {
      return undefined;
    }
    const profileId = this.bindings.get(editorKey);
    return profileId && this.profiles.get(profileId) ? profileId : undefined;
  }

  /** 이 편집기를 이 연결로 고정한다. profileId 가 없으면 고정을 푼다. */
  bindEditor(editorKey: string, profileId: string | undefined): void {
    if (profileId) {
      this.bindings.set(editorKey, profileId);
    } else {
      this.bindings.delete(editorKey);
    }
    void this.persistBindings();
    this.onDidChangeEmitter.fire();
  }

  /**
   * 프로필 id 로 연결한다 (편집기에 지정된 연결을 실행 직전에 여는 경로).
   * 실패하면 사용자에게 알리고 undefined 를 돌려준다 — 실행은 거기서 멈춘다.
   */
  async connectById(profileId: string): Promise<Session | undefined> {
    const existing = this.sessions.get(profileId);
    if (existing) {
      return existing;
    }
    const profile = this.profiles.get(profileId);
    if (!profile) {
      return undefined;
    }
    try {
      return await this.connect(profile);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `"${profile.name}" 연결에 실패했습니다: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /**
   * 이름 없는 문서를 파일로 저장하면 URI 가 통째로 바뀐다.
   *
   * 그대로 두면 지정이 사라지고 전역 기본 연결로 조용히 되돌아간다 — 개발 DB
   * 에서 쓰던 쿼리를 저장했더니 운영으로 나가는, 이 기능이 막으려던 바로 그
   * 사고다. 그래서 방금까지 보던 이름 없는 문서의 지정을 새 파일로 옮긴다.
   *
   * 옮길 후보는 "직전까지 활성이었고, 지금은 열려 있지 않은 untitled 문서"
   * 하나뿐이다. 조건에 맞는 것이 없으면 아무 일도 하지 않는다 — 짐작으로
   * 엉뚱한 연결을 붙이느니 지정이 없는 편이 낫다.
   */
  private carryBindingToSavedFile(document: vscode.TextDocument): void {
    const savedKey = document.uri.toString();
    // 저장된 문서는 더 이상 untitled 가 아니다. 스킴을 `file` 로 못 박으면
    // 전역 저장소(`vscode-userdata`)에 저장한 경우를 놓친다.
    if (document.uri.scheme === 'untitled' || this.bindings.has(savedKey)) {
      return;
    }
    const open = new Set(vscode.workspace.textDocuments.map((doc) => doc.uri.toString()));
    const candidates = [this.lastEditorKey, this.previousEditorKey].filter(
      (key): key is string =>
        key !== undefined &&
        key.startsWith('untitled:') &&
        !open.has(key) &&
        this.bindings.has(key),
    );
    const source = candidates[0];
    if (!source || candidates.some((key) => key !== source)) {
      return;
    }

    const profileId = this.bindings.get(source);
    this.bindings.delete(source);
    if (profileId && this.profiles.get(profileId)) {
      this.bindings.set(savedKey, profileId);
    }
    void this.persistBindings();
    this.onDidChangeEmitter.fire();
  }

  private restoreBindings(): void {
    const raw = this.storage?.get<unknown>(BINDINGS_KEY);
    if (!raw || typeof raw !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && this.profiles.get(value)) {
        this.bindings.set(key, value);
      }
    }
  }

  /** 지워진 연결을 가리키는 지정을 걷어낸다. */
  private pruneBindings(): void {
    let changed = false;
    for (const [key, profileId] of [...this.bindings]) {
      if (!this.profiles.get(profileId)) {
        this.bindings.delete(key);
        changed = true;
      }
    }
    if (changed) {
      void this.persistBindings();
      this.onDidChangeEmitter.fire();
    }
  }

  private async persistBindings(): Promise<void> {
    if (!this.storage) {
      return;
    }
    try {
      await this.storage.update(BINDINGS_KEY, Object.fromEntries(this.bindings));
    } catch (error) {
      log.debug('편집기별 연결 지정을 저장하지 못했습니다.', error);
    }
  }

  /**
   * 연결된 채로 이름이 바뀐 경우. 세션은 건드리지 않고 표시만 갱신한다 —
   * 이름 때문에 커넥션을 끊으면 열린 트랜잭션이 함께 사라진다.
   */
  rename(profileId: string, name: string): void {
    const session = this.sessions.get(profileId);
    if (!session) {
      return;
    }
    session.rename(name);
    this.onDidChangeEmitter.fire();
  }

  statuses(): SessionStatus[] {
    return [...this.sessions.values()].map((s) => s.status());
  }

  /**
   * 연결한다. 이미 연결돼 있으면 기존 세션을 돌려준다.
   * 비밀번호가 저장돼 있지 않으면 물어보고, 사용자가 취소하면 undefined.
   */
  async connect(profile: ConnectionProfile): Promise<Session | undefined> {
    const existing = this.sessions.get(profile.id);
    if (existing) {
      this.setActive(profile.id);
      return existing;
    }

    const password = await this.resolvePassword(profile);
    if (password === undefined && profile.savePassword) {
      return undefined; // 사용자가 입력을 취소했다.
    }

    const risk = describeTlsRisk(profile.tls);
    if (risk && !isLoopback(profile.host)) {
      // 원격 호스트에 평문/미검증으로 붙는 것은 알려 줘야 한다.
      log.warn(`[${profile.name}] ${risk}`);
      void vscode.window.showWarningMessage(`${profile.name}: ${risk}`);
    }

    const autoCommit = vscode.workspace
      .getConfiguration('dbconn')
      .get<boolean>('execution.autoCommit', true);

    const session = new Session(profile, password, autoCommit, (info) => {
      void vscode.window.showWarningMessage(
        `[${profile.name}] 반환되지 않은 커넥션을 회수했습니다 (${describeReclaim(info.reason)}, ` +
          `${Math.round(info.ageMs / 1000)}초 경과). 자세한 내용은 DBConn 로그를 확인하세요.`,
      );
    });

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${profile.name} 에 연결 중…` },
        () => session.testConnection(),
      );
    } catch (error) {
      await session.dispose();
      throw error;
    }

    this.sessions.set(profile.id, session);
    this.sessionSubscriptions.set(
      profile.id,
      session.onDidChange(() => this.onDidChangeEmitter.fire()),
    );
    this.setActive(profile.id);
    log.info(`[${profile.name}] 연결됨 (${profile.dialect} ${profile.host}:${profile.port})`);
    return session;
  }

  async disconnect(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId);
    if (!session) {
      return;
    }
    this.sessions.delete(profileId);
    this.sessionSubscriptions.get(profileId)?.dispose();
    this.sessionSubscriptions.delete(profileId);
    if (this.activeProfileId === profileId) {
      // 남아 있는 다른 연결로 활성 대상을 옮긴다.
      this.activeProfileId = this.sessions.keys().next().value;
    }
    await session.dispose();
    log.info(`[${session.profile.name}] 연결 해제됨`);
    this.onDidChangeEmitter.fire();
  }

  /**
   * 저장된 비밀번호를 꺼내거나 사용자에게 묻는다.
   * savePassword 가 꺼진 프로필은 매번 묻고 저장하지 않는다.
   */
  private async resolvePassword(profile: ConnectionProfile): Promise<string | undefined> {
    if (profile.savePassword) {
      const stored = await this.profiles.getPassword(profile.id);
      if (stored !== undefined) {
        return stored;
      }
    }

    const entered = await vscode.window.showInputBox({
      title: `${profile.name} 비밀번호`,
      prompt: `${profile.user}@${profile.host}:${profile.port}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (entered === undefined) {
      return undefined;
    }
    if (profile.savePassword) {
      await this.profiles.setPassword(profile.id, entered);
    }
    return entered;
  }

  /** 모든 세션을 닫는다. 확장 종료 경로에서 반드시 완료를 기다려야 한다. */
  async dispose(): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    const tasks = [...this.sessions.values()].map((s) => s.dispose());
    this.sessions.clear();
    for (const sub of this.sessionSubscriptions.values()) {
      sub.dispose();
    }
    this.sessionSubscriptions.clear();
    await Promise.allSettled(tasks);
    this.onDidChangeEmitter.dispose();
  }
}

function describeReclaim(reason: string): string {
  switch (reason) {
    case 'lease-timeout':
      return '대여 시간 초과';
    case 'transaction-idle-timeout':
      return '트랜잭션 유휴 시간 초과로 자동 롤백';
    case 'pool-closing':
      return '풀 종료';
    default:
      return reason;
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
