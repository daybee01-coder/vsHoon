import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  DEFAULT_PORTS,
  type ConnectionProfile,
  type ConnectionProfileDraft,
  type DialectId,
  type PoolOptions,
} from '../types';
import { log } from '../util/logger';
import { normalizeEnvironment } from './environment';
import {
  compareNames,
  folderChain,
  isWithinFolder,
  normalizeFolderPath,
  parentFolder,
  rerootFolder,
} from './folders';

/**
 * 연결 프로필 저장소.
 *
 * 저장 위치를 나눈 이유:
 *  - 프로필 메타데이터(호스트/포트/사용자)는 globalState 에 둔다.
 *    settings.json 에 두면 워크스페이스를 커밋할 때 내부 호스트명이
 *    실수로 저장소에 올라간다.
 *  - 비밀번호는 오직 SecretStorage 에만 둔다. OS 키체인/자격 증명 관리자가
 *    암호화를 맡고, 확장은 필요할 때만 꺼내 쓴다.
 *
 * 어떤 경로로도 비밀번호가 ConnectionProfile 객체에 실리지 않는다 —
 * 그래야 프로필을 로깅하거나 웹뷰로 보내도 사고가 나지 않는다.
 */

export const PROFILES_KEY = 'dbconn.profiles.v1';
/**
 * 폴더 경로 목록. 프로필이 하나도 없는 빈 폴더를 기억하기 위한 것이다 —
 * 폴더는 프로필의 folder 필드에서 유도되므로, 이 목록이 없으면
 * 방금 만든 빈 폴더가 새로고침과 함께 사라진다.
 */
export const FOLDERS_KEY = 'dbconn.folders.v1';
export const PASSWORD_SECRET_PREFIX = 'dbconn.password.';

export class ProfileStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    const raw = this.context.globalState.get<unknown>(PROFILES_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item) => normalizeStoredProfile(item))
      .filter((p): p is ConnectionProfile => p !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  async add(draft: ConnectionProfileDraft, password: string | undefined): Promise<ConnectionProfile> {
    const profile: ConnectionProfile = {
      ...draft,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    const profiles = this.list();
    profiles.push(profile);
    await this.persist(profiles);
    if (profile.savePassword && password) {
      await this.setPassword(profile.id, password);
    }
    log.info(`연결 프로필 추가: ${profile.name} (${profile.dialect})`);
    return profile;
  }

  async update(
    id: string,
    draft: ConnectionProfileDraft,
    password: string | undefined,
  ): Promise<ConnectionProfile> {
    const profiles = this.list();
    const index = profiles.findIndex((p) => p.id === id);
    if (index === -1) {
      throw new Error(`연결 프로필을 찾을 수 없습니다: ${id}`);
    }
    const updated: ConnectionProfile = {
      ...draft,
      id,
      createdAt: profiles[index]!.createdAt,
    };
    profiles[index] = updated;
    await this.persist(profiles);

    if (!updated.savePassword) {
      // 저장하지 않기로 바꿨으면 이미 저장된 비밀번호를 지운다.
      await this.deletePassword(id);
    } else if (password !== undefined) {
      await this.setPassword(id, password);
    }
    log.info(`연결 프로필 수정: ${updated.name}`);
    return updated;
  }

  /**
   * 이름만 바꾼다.
   *
   * update() 로도 되지만 그 길은 draft 전체를 요구하고, 호출부가 한 필드만
   * 바꾸려다 나머지를 실수로 되돌릴 수 있다. 이름은 접속에 아무 영향이 없으므로
   * 세션을 끊지 않고 바꿀 수 있다 — F2 로 고치는 대상이 바로 이것이다.
   */
  async rename(id: string, name: string): Promise<ConnectionProfile | undefined> {
    const trimmed = name.trim();
    if (!trimmed) {
      return undefined;
    }
    const profiles = this.list();
    const index = profiles.findIndex((p) => p.id === id);
    if (index === -1) {
      return undefined;
    }
    const before = profiles[index]!;
    if (before.name === trimmed) {
      return before;
    }
    const renamed: ConnectionProfile = { ...before, name: trimmed };
    profiles[index] = renamed;
    await this.persist(profiles);
    log.info(`연결 프로필 이름 변경: ${before.name} → ${trimmed}`);
    return renamed;
  }

  async remove(id: string): Promise<void> {
    const profiles = this.list().filter((p) => p.id !== id);
    await this.persist(profiles);
    await this.deletePassword(id);
    log.info(`연결 프로필 삭제: ${id}`);
  }

  // ── 폴더 ────────────────────────────────────────────────────────────────

  /**
   * 트리에 존재하는 모든 폴더 경로.
   * 프로필이 들어 있는 폴더와, 비어 있어도 사용자가 만든 폴더를 합친다.
   * 중간 경로("운영/서울" 의 "운영")도 빠짐없이 포함된다.
   */
  folders(): string[] {
    const all = new Set(this.storedFolders());
    for (const profile of this.list()) {
      if (profile.folder) {
        for (const ancestor of folderChain(profile.folder)) {
          all.add(ancestor);
        }
      }
    }
    return [...all].sort(compareNames);
  }

  /** 폴더를 만든다. 이미 있으면 아무 일도 하지 않는다. */
  async createFolder(path: string): Promise<string | undefined> {
    const normalized = normalizeFolderPath(path);
    if (!normalized) {
      return undefined;
    }
    const all = new Set(this.storedFolders());
    for (const ancestor of folderChain(normalized)) {
      all.add(ancestor);
    }
    await this.persistFolders([...all]);
    log.info(`연결 폴더 추가: ${normalized}`);
    return normalized;
  }

  /**
   * 폴더를 다른 이름/위치로 옮긴다. 하위 폴더와 그 안의 연결이 함께 따라간다.
   * 자기 자신의 하위로는 옮길 수 없다 — 트리가 끊어진 가지를 만든다.
   */
  async moveFolder(from: string, to: string | undefined): Promise<void> {
    const source = normalizeFolderPath(from);
    const target = normalizeFolderPath(to);
    if (!source || source === target) {
      return;
    }
    if (target && isWithinFolder(target, source)) {
      throw new Error('폴더를 자기 자신의 하위로 옮길 수 없습니다.');
    }

    const profiles = this.list().map((profile) =>
      profile.folder && isWithinFolder(profile.folder, source)
        ? { ...profile, folder: rerootFolder(profile.folder, source, target) }
        : profile,
    );
    const folders = this.storedFolders().map((path) =>
      isWithinFolder(path, source) ? rerootFolder(path, source, target) : path,
    );
    if (target) {
      folders.push(target);
    }

    await this.persist(profiles, folders.filter((f): f is string => f !== undefined));
    log.info(`연결 폴더 이동: ${source} → ${target ?? '(최상위)'}`);
  }

  /**
   * 폴더를 지운다. 안에 있던 연결과 하위 폴더는 상위 폴더로 올라간다 —
   * 연결 프로필을 폴더 삭제의 부수 효과로 지우는 일은 없어야 한다.
   */
  async deleteFolder(path: string): Promise<void> {
    const target = normalizeFolderPath(path);
    if (!target) {
      return;
    }
    const parent = parentFolder(target);

    const profiles = this.list().map((profile) =>
      profile.folder && isWithinFolder(profile.folder, target)
        ? { ...profile, folder: rerootFolder(profile.folder, target, parent) }
        : profile,
    );
    const folders: string[] = [];
    for (const stored of this.storedFolders()) {
      if (!isWithinFolder(stored, target)) {
        folders.push(stored);
        continue;
      }
      const lifted = rerootFolder(stored, target, parent);
      if (lifted) {
        folders.push(lifted);
      }
    }

    await this.persist(profiles, folders);
    log.info(`연결 폴더 삭제: ${target}`);
  }

  /** 연결 하나를 폴더로 옮긴다. undefined 면 최상위로. */
  async setProfileFolder(id: string, folder: string | undefined): Promise<void> {
    const normalized = normalizeFolderPath(folder);
    const profiles = this.list();
    const index = profiles.findIndex((p) => p.id === id);
    if (index === -1) {
      return;
    }
    if (profiles[index]!.folder === normalized) {
      return;
    }
    profiles[index] = { ...profiles[index]!, folder: normalized };

    // 목적지가 빈 폴더 목록에만 있던 경로여도 그대로 유지되게 함께 저장한다.
    const folders = new Set(this.storedFolders());
    if (normalized) {
      for (const ancestor of folderChain(normalized)) {
        folders.add(ancestor);
      }
    }
    await this.persist(profiles, [...folders]);
  }

  private storedFolders(): string[] {
    const raw = this.context.globalState.get<unknown>(FOLDERS_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    const all = new Set<string>();
    for (const item of raw) {
      const path = normalizeFolderPath(typeof item === 'string' ? item : undefined);
      if (!path) {
        continue;
      }
      for (const ancestor of folderChain(path)) {
        all.add(ancestor);
      }
    }
    return [...all];
  }

  private async persistFolders(folders: string[]): Promise<void> {
    await this.context.globalState.update(FOLDERS_KEY, dedupeFolders(folders));
    this.onDidChangeEmitter.fire();
  }

  // ── 비밀번호 (SecretStorage 전용) ─────────────────────────────────────────

  async getPassword(id: string): Promise<string | undefined> {
    try {
      return await this.context.secrets.get(PASSWORD_SECRET_PREFIX + id);
    } catch (error) {
      // 키체인이 잠겨 있거나 접근이 거부된 경우.
      log.warn('저장된 비밀번호를 읽지 못했습니다.', error);
      return undefined;
    }
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.context.secrets.store(PASSWORD_SECRET_PREFIX + id, password);
  }

  async deletePassword(id: string): Promise<void> {
    try {
      await this.context.secrets.delete(PASSWORD_SECRET_PREFIX + id);
    } catch (error) {
      log.debug('비밀번호 삭제 실패 (무시)', error);
    }
  }

  /**
   * 프로필(과 필요하면 폴더 목록)을 저장한다.
   * 변경 통지는 한 번만 낸다 — 두 번 내면 트리가 두 번 다시 그려진다.
   */
  private async persist(profiles: ConnectionProfile[], folders?: string[]): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, profiles);
    if (folders) {
      await this.context.globalState.update(FOLDERS_KEY, dedupeFolders(folders));
    }
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

/** 설정에서 읽은 풀 옵션 — 프로필에 저장된 값이 없으면 이걸 쓴다. */
export function poolOptionsFromSettings(): PoolOptions {
  const config = vscode.workspace.getConfiguration('dbconn');
  return {
    max: config.get<number>('pool.max', 5),
    min: config.get<number>('pool.min', 0),
    acquireTimeoutMs: config.get<number>('pool.acquireTimeoutMs', 15_000),
    idleTimeoutMs: config.get<number>('pool.idleTimeoutMs', 60_000),
    maxLifetimeMs: config.get<number>('pool.maxLifetimeMs', 1_800_000),
    leaseTimeoutMs: config.get<number>('pool.leaseTimeoutMs', 120_000),
    transactionIdleTimeoutMs: config.get<number>('pool.transactionIdleTimeoutMs', 300_000),
  };
}

/**
 * 저장된 JSON 을 신뢰하지 않고 검증한다.
 * globalState 는 다른 확장 버전이 쓴 값일 수 있고, 손상됐을 수도 있다.
 */
export function normalizeStoredProfile(raw: unknown): ConnectionProfile | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : undefined;
  const name = typeof r.name === 'string' ? r.name : undefined;
  const dialect = isDialect(r.dialect) ? r.dialect : undefined;
  if (!id || !name || !dialect) {
    log.warn('손상된 연결 프로필을 건너뜁니다.', JSON.stringify(r).slice(0, 200));
    return undefined;
  }

  const pool = (r.pool ?? {}) as Record<string, unknown>;
  const tls = (r.tls ?? {}) as Record<string, unknown>;
  const fallback = poolOptionsFromSettings();

  return {
    id,
    name,
    dialect,
    host: typeof r.host === 'string' ? r.host : 'localhost',
    port: typeof r.port === 'number' && r.port > 0 ? r.port : DEFAULT_PORTS[dialect],
    database: typeof r.database === 'string' ? r.database : '',
    user: typeof r.user === 'string' ? r.user : '',
    savePassword: r.savePassword !== false,
    readOnly: r.readOnly === true,
    tls: {
      enabled: tls.enabled === true,
      // 명시적으로 false 를 저장한 경우에만 검증을 끈다 — 기본은 검증 켬.
      rejectUnauthorized: tls.rejectUnauthorized !== false,
      caPath: typeof tls.caPath === 'string' ? tls.caPath : undefined,
      certPath: typeof tls.certPath === 'string' ? tls.certPath : undefined,
      keyPath: typeof tls.keyPath === 'string' ? tls.keyPath : undefined,
      servername: typeof tls.servername === 'string' ? tls.servername : undefined,
    },
    pool: {
      max: positiveInt(pool.max, fallback.max),
      min: positiveInt(pool.min, fallback.min, 0),
      acquireTimeoutMs: positiveInt(pool.acquireTimeoutMs, fallback.acquireTimeoutMs),
      idleTimeoutMs: positiveInt(pool.idleTimeoutMs, fallback.idleTimeoutMs),
      maxLifetimeMs: positiveInt(pool.maxLifetimeMs, fallback.maxLifetimeMs),
      leaseTimeoutMs: positiveInt(pool.leaseTimeoutMs, fallback.leaseTimeoutMs),
      transactionIdleTimeoutMs: positiveInt(
        pool.transactionIdleTimeoutMs,
        fallback.transactionIdleTimeoutMs,
      ),
    },
    connectTimeoutMs: positiveInt(r.connectTimeoutMs, 15_000),
    oracle:
      dialect === 'oracle'
        ? {
            connectType:
              (r.oracle as Record<string, unknown> | undefined)?.connectType === 'sid'
                ? 'sid'
                : 'service',
            connectString:
              typeof (r.oracle as Record<string, unknown> | undefined)?.connectString === 'string'
                ? ((r.oracle as Record<string, unknown>).connectString as string)
                : undefined,
          }
        : undefined,
    color: typeof r.color === 'string' ? r.color : undefined,
    folder: normalizeFolderPath(typeof r.folder === 'string' ? r.folder : undefined),
    // 이전 버전에서 저장된 프로필에는 환경이 없다 — 개발로 본다.
    environment: normalizeEnvironment(r.environment),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
  };
}

/** 저장 전 정리 — 중복 제거와 정렬. 목록이 무한정 자라지 않게. */
function dedupeFolders(folders: string[]): string[] {
  const all = new Set<string>();
  for (const folder of folders) {
    const normalized = normalizeFolderPath(folder);
    if (!normalized) {
      continue;
    }
    for (const ancestor of folderChain(normalized)) {
      all.add(ancestor);
    }
  }
  return [...all].sort(compareNames);
}

function isDialect(value: unknown): value is DialectId {
  return value === 'mysql' || value === 'mariadb' || value === 'postgres' || value === 'oracle';
}

function positiveInt(value: unknown, fallback: number, min = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    return fallback;
  }
  return Math.floor(value);
}
