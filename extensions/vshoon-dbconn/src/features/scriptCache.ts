import * as vscode from 'vscode';
import {
  cacheKey,
  normalizeEntries,
  pruneEntries,
  summarize,
  type ScriptCacheEntry,
} from './scriptIndex';
import { log } from '../util/logger';

/**
 * 저장하지 않은 SQL 초안 캐시.
 *
 * 새 SQL 편집기에 쓴 쿼리는 파일이 아니어서, 창을 닫거나 VS Code 가 죽으면
 * 그대로 사라진다. 여기서는 편집 중인 SQL 문서를 짧은 간격으로 확장의 전역
 * 저장소에 복사해 두고, 나중에 다시 열 수 있게 한다.
 *
 * 규칙:
 *  - 대상은 SQL 문서 중 **untitled 이거나 저장되지 않은 변경이 있는 것**뿐이다.
 *    이미 파일로 저장된 내용을 또 복사하면 사용자가 지운 데이터가
 *    엉뚱한 곳에 남는다.
 *  - 저장되는 순간 캐시에서 지운다 — 원본 파일이 진실이 된다.
 *  - 내용은 파일로, 목록은 globalState 로. 큰 스크립트가 상태 저장소를 부풀리지 않게.
 *
 * 캐시된 스크립트에는 사용자가 쓴 SQL 이 그대로 들어간다. 자격 증명을 쿼리에
 * 적어 두는 습관이 있다면 이 캐시에도 남으므로, 설정으로 끌 수 있게 했다.
 */

const INDEX_KEY = 'dbconn.scripts.v1';
/** 마지막으로 복구 알림을 띄운 시각. 같은 초안으로 매번 알리지 않기 위해. */
const PROMPTED_KEY = 'dbconn.scripts.promptedAt';
const FOLDER = 'scripts';
/** 저장 지연 — 타자마다 디스크에 쓰지 않도록. */
const DEBOUNCE_MS = 1_000;
/** 이보다 큰 문서는 캐시하지 않는다. 초안 복구용이지 백업이 아니다. */
const MAX_CHARS = 1_000_000;

export class ScriptCache implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 문서가 닫힌 뒤에도 마지막 내용을 쓸 수 있게 들고 있는다. */
  private readonly lastText = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  activate(): void {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        // 저장됐으면 초안이 아니다.
        void this.forget(document.uri.toString());
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        void this.flush(document);
      }),
    );

    // 창을 다시 열었을 때 이미 떠 있는 초안도 한 번 담아 둔다.
    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document);
    }
  }

  // ── 캐시 쓰기 ─────────────────────────────────────────────────────────────

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('dbconn').get<boolean>('scripts.cache', true);
  }

  private shouldCache(document: vscode.TextDocument): boolean {
    if (!this.enabled() || document.languageId !== 'sql') {
      return false;
    }
    if (document.uri.scheme !== 'untitled' && !document.isDirty) {
      return false;
    }
    const length = document.getText().length;
    return length > 0 && length <= MAX_CHARS;
  }

  private schedule(document: vscode.TextDocument): void {
    if (!this.shouldCache(document)) {
      return;
    }
    const uri = document.uri.toString();
    this.lastText.set(uri, document.getText());

    const existing = this.timers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      uri,
      setTimeout(() => {
        this.timers.delete(uri);
        void this.write(uri, document.uri.scheme === 'untitled');
      }, DEBOUNCE_MS),
    );
  }

  /** 문서가 닫힐 때는 기다리지 않고 바로 쓴다. */
  private async flush(document: vscode.TextDocument): Promise<void> {
    const uri = document.uri.toString();
    const timer = this.timers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(uri);
    }
    if (!this.lastText.has(uri)) {
      return;
    }
    await this.write(uri, document.uri.scheme === 'untitled');
  }

  private async write(uri: string, untitled: boolean): Promise<void> {
    const text = this.lastText.get(uri);
    if (!text || !this.enabled()) {
      return;
    }
    try {
      const key = cacheKey(uri);
      await vscode.workspace.fs.createDirectory(this.folderUri());
      await vscode.workspace.fs.writeFile(this.fileUri(key), Buffer.from(text, 'utf8'));

      const entry: ScriptCacheEntry = {
        key,
        uri,
        untitled,
        label: summarize(text),
        savedAt: Date.now(),
        length: text.length,
      };
      const others = this.list().filter((e) => e.key !== key);
      await this.persist([entry, ...others]);
    } catch (error) {
      // 캐시는 부가 기능이다. 실패해도 편집을 방해하지 않는다.
      log.debug('스크립트 캐시 저장 실패', error);
    }
  }

  /** 저장된 문서를 캐시에서 지운다. */
  private async forget(uri: string): Promise<void> {
    this.lastText.delete(uri);
    const timer = this.timers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(uri);
    }
    const key = cacheKey(uri);
    if (!this.list().some((entry) => entry.key === key)) {
      return;
    }
    await this.remove(key);
  }

  // ── 목록 ──────────────────────────────────────────────────────────────────

  list(): ScriptCacheEntry[] {
    return normalizeEntries(this.context.globalState.get<unknown>(INDEX_KEY, []));
  }

  async read(key: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri(key));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  async remove(key: string): Promise<void> {
    await this.persist(this.list().filter((entry) => entry.key !== key));
    await this.deleteFile(key);
  }

  async clear(): Promise<void> {
    const entries = this.list();
    await this.context.globalState.update(INDEX_KEY, []);
    for (const entry of entries) {
      await this.deleteFile(entry.key);
    }
  }

  /** 색인을 저장하며 보관 정책을 적용한다. */
  private async persist(entries: ScriptCacheEntry[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('dbconn');
    const { keep, drop } = pruneEntries(entries, {
      maxEntries: config.get<number>('scripts.maxEntries', 50),
      retentionDays: config.get<number>('scripts.retentionDays', 14),
      now: Date.now(),
    });
    await this.context.globalState.update(INDEX_KEY, keep);
    for (const entry of drop) {
      await this.deleteFile(entry.key);
    }
  }

  private async deleteFile(key: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.fileUri(key));
    } catch {
      /* 이미 없음 */
    }
  }

  private folderUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, FOLDER);
  }

  private fileUri(key: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folderUri(), `${key}.sql`);
  }

  // ── 복구 ──────────────────────────────────────────────────────────────────

  /** 캐시된 스크립트를 새 편집기로 연다. */
  async open(entry: ScriptCacheEntry): Promise<void> {
    const content = await this.read(entry.key);
    if (content === undefined) {
      void vscode.window.showWarningMessage('캐시 파일을 읽지 못했습니다. 목록에서 제거합니다.');
      await this.remove(entry.key);
      return;
    }
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /**
   * 이전 세션에서 남은 초안이 있으면 알린다.
   *
   * VS Code 의 핫 엑싯이 이미 복원한 초안은 제외한다 — 같은 내용이 두 번
   * 열리면 어느 쪽을 고쳐야 할지 알 수 없다.
   */
  async promptRestore(): Promise<void> {
    const mode = vscode.workspace
      .getConfiguration('dbconn')
      .get<string>('scripts.restore', 'prompt');
    if (mode === 'off' || !this.enabled()) {
      return;
    }

    const openTexts = new Set(
      vscode.workspace.textDocuments
        .filter((document) => document.languageId === 'sql')
        .map((document) => document.getText()),
    );

    // 이미 한 번 알린 초안으로 창을 열 때마다 다시 알리지는 않는다.
    const promptedAt = this.context.globalState.get<number>(PROMPTED_KEY, 0);

    const pending: ScriptCacheEntry[] = [];
    for (const entry of this.list().filter((e) => e.untitled && e.savedAt > promptedAt)) {
      const text = await this.read(entry.key);
      if (text !== undefined && !openTexts.has(text)) {
        pending.push(entry);
      }
    }
    if (pending.length === 0) {
      return;
    }

    // 알림/자동 복구는 한 번이면 충분하다. 이 시점 이후에 바뀐 초안만
    // 다음 창에서 다시 대상이 된다 — 그러지 않으면 같은 초안이 창을 열 때마다
    // 다시 열리고, 열린 초안이 또 캐시되어 사본이 불어난다.
    await this.context.globalState.update(PROMPTED_KEY, Date.now());

    if (mode === 'auto') {
      // 한꺼번에 수십 개를 열면 편집기가 뒤덮이므로 최근 것만.
      for (const entry of pending.slice(0, 5)) {
        await this.open(entry);
      }
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `저장하지 않은 SQL 초안 ${pending.length}개가 캐시에 있습니다.`,
      '열기',
      '목록 보기',
    );
    if (choice === '열기') {
      for (const entry of pending.slice(0, 5)) {
        await this.open(entry);
      }
    } else if (choice === '목록 보기') {
      await vscode.commands.executeCommand('dbconn.openCachedScript');
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
    this.subscriptions.length = 0;
  }
}
