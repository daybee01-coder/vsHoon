import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSettings } from '../config/settings';

interface KnownHostEntry {
  fingerprint: string;
  acceptedAt: string;
}

/**
 * PuTTY의 SshHostKeys 레지스트리 브랜치와는 별도의 저장소(확장 전용 storage의 JSON 파일)를 쓴다.
 * PuTTY 쪽 브랜치는 키 이름 인코딩 규칙이 세션과 달라 별도 검증이 필요해 v1 범위에서 제외했다.
 */
export class HostKeyStore {
  private entries: Record<string, KnownHostEntry> = {};
  private readonly filePath: string;
  private readonly backupPath: string;
  private loaded = false;
  private lastMtimeMs = 0;
  private loadError: Error | undefined;
  private loadedFromBackup = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'known_hosts.json');
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
        this.entries = {};
        this.lastMtimeMs = 0;
        return;
      }
      try {
        this.loadFile(this.backupPath);
        this.loadedFromBackup = true;
        return;
      } catch {
        this.entries = {};
        this.loadError = new Error(`호스트 키 저장소가 손상되었습니다: ${this.filePath} (${String(mainError)})`);
      }
    }
  }

  private loadFile(filePath: string): void {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('잘못된 저장소 형식');
    this.entries = parsed as Record<string, KnownHostEntry>;
    this.lastMtimeMs = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).mtimeMs : 0;
  }

  private refreshBeforeMutation(): void {
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
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.entries, null, 2), 'utf8');
      if (!this.loadedFromBackup && fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, this.backupPath);
      fs.renameSync(tempPath, this.filePath);
      this.lastMtimeMs = fs.statSync(this.filePath).mtimeMs;
      this.loadedFromBackup = false;
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* rename 성공 후에는 임시 파일이 없으므로 무시 */
      }
    }
  }

  static fingerprint(key: Buffer): string {
    const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    return `SHA256:${digest}`;
  }

  async verify(host: string, port: number, key: Buffer): Promise<boolean> {
    this.refreshBeforeMutation();
    const normalizedHost = host.trim().replace(/\.$/, '').toLocaleLowerCase('en-US');
    const id = `${normalizedHost}:${port}`;
    const fingerprint = HostKeyStore.fingerprint(key);
    const strict = getSettings().hostkeyStrictChecking;
    const existing = this.entries[id];

    if (!existing) {
      const choice = await vscode.window.showWarningMessage(
        `${host}:${port}의 호스트 키를 처음 확인합니다.\n지문: ${fingerprint}\n이 호스트를 신뢰하시겠습니까?`,
        { modal: true },
        '신뢰하고 연결'
      );
      if (choice === '신뢰하고 연결') {
        this.entries[id] = { fingerprint, acceptedAt: new Date().toISOString() };
        this.persist();
        return true;
      }
      return false;
    }

    if (existing.fingerprint === fingerprint) {
      return true;
    }

    if (strict) {
      await vscode.window.showErrorMessage(
        `경고: ${host}:${port}의 호스트 키가 이전에 저장된 값과 다릅니다! (저장됨: ${existing.fingerprint} / 현재: ${fingerprint})\n` +
          `중간자 공격(MITM) 가능성이 있어 연결을 차단했습니다. 계속하려면 vssh.hostkey.strictChecking 설정을 끄세요.`,
        { modal: true }
      );
      return false;
    }

    const choice = await vscode.window.showErrorMessage(
      `경고: ${host}:${port}의 호스트 키가 이전과 다릅니다!\n저장된 지문: ${existing.fingerprint}\n현재 지문: ${fingerprint}\n` +
        `중간자 공격(MITM) 가능성이 있습니다. 정말 계속하시겠습니까?`,
      { modal: true },
      '위험을 감수하고 계속'
    );
    if (choice === '위험을 감수하고 계속') {
      this.entries[id] = { fingerprint, acceptedAt: new Date().toISOString() };
      this.persist();
      return true;
    }
    return false;
  }

  async list(): Promise<Array<{ id: string } & KnownHostEntry>> {
    this.ensureLoaded();
    return Object.entries(this.entries).map(([id, entry]) => ({ id, ...entry }));
  }

  async remove(id: string): Promise<void> {
    this.refreshBeforeMutation();
    delete this.entries[id];
    this.persist();
  }
}
