/**
 * 다른 VS Code 설치본의 `globalStorage/state.vscdb` 를 읽는다.
 *
 * 확장 하나의 globalState 는 이 SQLite 파일의 `ItemTable` 에서 확장 ID 를 키로
 * 갖는 JSON 한 덩어리이고, SecretStorage 값은 같은 표의 `secret://…` 키에
 * 암호화된 채로 들어 있다. 즉 프로필과 비밀번호가 한 파일에 함께 있다.
 *
 * 이 파일은 vscode API 를 쓰지 않는다 — 키 이름은 호출부가 넘겨 주고,
 * `node:sqlite` 는 실제로 읽을 때 처음 불러온다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { secretValueToBytes } from './secrets';

/** 읽어 올 globalState/SecretStorage 키 이름. */
export interface StoredKeys {
  profiles: string;
  folders: string;
  secretPrefix: string;
}

export interface SourceData {
  /** 프로필 원본 JSON. 검증은 저장소의 정규화 규칙에 맡긴다. */
  profiles: unknown[];
  folders: string[];
  /** 프로필 id → 아직 암호화된 상태의 비밀 값. */
  secrets: Map<string, Buffer>;
}

const SECRET_KEY_PREFIX = 'secret://';

/**
 * 지정한 확장 ID 의 저장 내용을 읽는다. 파일이나 표가 없으면 undefined.
 */
export async function readSourceData(
  statePath: string,
  extensionId: string,
  keys: StoredKeys,
): Promise<SourceData | undefined> {
  if (!fs.existsSync(statePath)) {
    return undefined;
  }
  const rows = await readItemTable(statePath);
  if (!rows) {
    return undefined;
  }

  const state = parseExtensionState(rows.get(extensionId), keys);
  const secrets = new Map<string, Buffer>();
  for (const [key, value] of rows) {
    if (!key.startsWith(SECRET_KEY_PREFIX)) {
      continue;
    }
    const id = parsePasswordSecretKey(key, extensionId, keys.secretPrefix);
    if (!id) {
      continue;
    }
    const bytes = secretValueToBytes(value);
    if (bytes) {
      secrets.set(id, bytes);
    }
  }
  if (state.profiles.length === 0 && secrets.size === 0) {
    return undefined;
  }
  return { ...state, secrets };
}

/** 확장 ID 키에 담긴 JSON 에서 프로필과 폴더 목록을 뽑는다. */
export function parseExtensionState(
  value: unknown,
  keys: StoredKeys,
): { profiles: unknown[]; folders: string[] } {
  const empty = { profiles: [], folders: [] };
  if (typeof value !== 'string' || !value.trim()) {
    return empty;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') {
    return empty;
  }
  const profiles = parsed[keys.profiles];
  const folders = parsed[keys.folders];
  return {
    profiles: Array.isArray(profiles) ? profiles : [],
    folders: Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string') : [],
  };
}

/**
 * `secret://{"extensionId":"…","key":"dbconn.password.<id>"}` 에서 프로필 id 를 뽑는다.
 * 다른 확장이나 다른 용도의 비밀 값이면 undefined.
 */
export function parsePasswordSecretKey(
  key: string,
  extensionId: string,
  secretPrefix: string,
): string | undefined {
  if (!key.startsWith(SECRET_KEY_PREFIX)) {
    return undefined;
  }
  let parsed: { extensionId?: unknown; key?: unknown };
  try {
    parsed = JSON.parse(key.slice(SECRET_KEY_PREFIX.length)) as {
      extensionId?: unknown;
      key?: unknown;
    };
  } catch {
    return undefined;
  }
  if (parsed.extensionId !== extensionId || typeof parsed.key !== 'string') {
    return undefined;
  }
  if (!parsed.key.startsWith(secretPrefix)) {
    return undefined;
  }
  const id = parsed.key.slice(secretPrefix.length);
  return id || undefined;
}

/**
 * `ItemTable` 전체를 키/값 맵으로 읽는다.
 *
 * 원본을 열지 않고 임시 폴더로 복사해서 읽는다. 정품 VS Code 가 실행 중이면
 * 같은 파일을 붙잡고 있고, 최근 변경은 아직 `-wal` 쪽에 있을 수 있다. 복사본은
 * 우리 것이므로 쓰기 권한이 있고, 그래야 SQLite 가 WAL 을 반영해 최신 상태를
 * 보여 준다 — 읽기 전용으로 열면 WAL 을 읽지 못해 며칠 지난 값을 볼 수 있다.
 */
async function readItemTable(statePath: string): Promise<Map<string, unknown> | undefined> {
  const { DatabaseSync } = await import('node:sqlite');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbconn-import-'));
  const copyPath = path.join(workDir, 'state.vscdb');
  try {
    fs.copyFileSync(statePath, copyPath);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(statePath + suffix)) {
        fs.copyFileSync(statePath + suffix, copyPath + suffix);
      }
    }
    const db = new DatabaseSync(copyPath);
    try {
      const rows = db.prepare('select key, value from ItemTable').all();
      const map = new Map<string, unknown>();
      for (const row of rows) {
        const key = row['key'];
        if (typeof key === 'string') {
          map.set(key, row['value']);
        }
      }
      return map;
    } catch {
      // 표가 없다 — 우리가 찾는 저장소가 아니다. 파일 접근 오류는
      // 여기서 삼키지 않고 그대로 올려 보낸다.
      return undefined;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
