/**
 * 정품 VS Code 에서 쓰던 연결 프로필을 가져온다.
 *
 * 왜 자동으로 넘어오지 않는가: 앱 데이터 폴더가 다르고(`Code` vs 우리 제품),
 * 확장 ID 도 바뀌었다. globalState 와 SecretStorage 는 둘 다 확장 ID 로
 * 격리되므로 같은 기계·같은 계정이라도 서로의 저장소를 볼 수 없다.
 *
 * 이 명령은 원본을 읽기만 한다 — 옛 설치본의 프로필도, 비밀번호도 지우지 않는다.
 * 되돌리고 싶으면 가져온 연결을 지우면 된다.
 */

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  FOLDERS_KEY,
  PASSWORD_SECRET_PREFIX,
  PROFILES_KEY,
  normalizeStoredProfile,
  type ProfileStore,
} from '../config/profileStore';
import {
  DIALECT_LABELS,
  type ConnectionProfile,
  type ConnectionProfileDraft,
} from '../types';
import { log } from '../util/logger';
import { SOURCE_EXTENSION_IDS, storageLocations, type StorageLocation } from './locations';
import { planImport, type ImportItem } from './plan';
import {
  decryptSafeStorage,
  isSafeStorageEncrypted,
  protectedKeyFromLocalState,
  unprotectDpapi,
} from './secrets';
import { readSourceData, type SourceData } from './state';

const STORED_KEYS = {
  profiles: PROFILES_KEY,
  folders: FOLDERS_KEY,
  secretPrefix: PASSWORD_SECRET_PREFIX,
};

/** 찾아낸 가져오기 원본 하나 — 앱 한 곳 + 확장 ID 하나. */
interface ImportSource {
  location: StorageLocation;
  extensionId: string;
  data: SourceData;
  /** 정규화를 통과한 프로필. 원본 id 를 그대로 들고 있다 — 비밀 값을 찾는 열쇠다. */
  profiles: ConnectionProfile[];
}

/** 암호화된 비밀 값을 원래 비밀번호로 되돌리는 함수. */
type PasswordReader = (encrypted: Buffer) => Promise<string>;

/**
 * 명령 본문. 원본 선택 → 가져올 연결 선택 → 저장 순서로 진행한다.
 */
export async function importConnectionsFromVSCode(profiles: ProfileStore): Promise<void> {
  const sources = await findSources();
  if (sources.length === 0) {
    void vscode.window.showInformationMessage(
      '가져올 연결 정보를 찾지 못했습니다. 이 계정의 VS Code 설치본에 저장된 DBConn 연결이 없습니다.',
    );
    return;
  }

  const source = await pickSource(sources);
  if (!source) {
    return;
  }

  const plan = planImport(profiles.list(), source.profiles);
  const selected = await pickItems(plan);
  if (!selected || selected.length === 0) {
    return;
  }

  const readPassword = await passwordReader(source.location);
  if (!readPassword && selected.some((item) => item.source.savePassword)) {
    const proceed = await vscode.window.showWarningMessage(
      '저장된 비밀번호를 복호화할 수 없습니다. 연결 정보만 가져오고, 비밀번호는 처음 접속할 때 다시 입력해야 합니다.',
      { modal: true },
      '계속',
    );
    if (proceed !== '계속') {
      return;
    }
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '연결 정보를 가져오는 중' },
    async (progress) => {
      let imported = 0;
      let withPassword = 0;
      let failed = 0;

      for (const [index, item] of selected.entries()) {
        progress.report({
          message: item.name,
          increment: index === 0 ? 0 : 100 / selected.length,
        });
        try {
          const password = await recoverPassword(source, item.source, readPassword);
          await profiles.add(draftOf(item.source, item.name), password);
          imported++;
          if (password !== undefined) {
            withPassword++;
          }
        } catch (error) {
          failed++;
          log.error(`연결 "${item.name}" 가져오기 실패`, error);
        }
      }

      // 비어 있던 폴더까지 살려 두면 옛 설치본의 트리 모양이 그대로 남는다.
      for (const folder of source.data.folders) {
        await profiles.createFolder(folder);
      }
      return { imported, withPassword, failed };
    },
  );

  const skipped = plan.filter((item) => item.status === 'existing').length;
  const parts = [`연결 ${result.imported}개를 가져왔습니다.`];
  if (result.withPassword > 0) {
    parts.push(`비밀번호 ${result.withPassword}개 복원.`);
  }
  if (skipped > 0) {
    parts.push(`이미 있는 ${skipped}개는 건너뛰었습니다.`);
  }
  if (result.failed > 0) {
    parts.push(`${result.failed}개는 실패했습니다 — 출력 창을 확인하세요.`);
  }
  const message = parts.join(' ');
  if (result.failed > 0) {
    const action = await vscode.window.showWarningMessage(message, '로그 보기');
    if (action === '로그 보기') {
      log.show();
    }
    return;
  }
  void vscode.window.showInformationMessage(message);
}

/** 살펴볼 수 있는 모든 위치를 훑어 실제로 데이터가 있는 것만 남긴다. */
async function findSources(): Promise<ImportSource[]> {
  const found: ImportSource[] = [];
  for (const location of storageLocations(process.env, process.platform)) {
    for (const extensionId of SOURCE_EXTENSION_IDS) {
      try {
        const data = await readSourceData(location.statePath, extensionId, STORED_KEYS);
        if (!data) {
          continue;
        }
        const profiles = data.profiles
          .map((raw) => normalizeStoredProfile(raw))
          .filter((p): p is ConnectionProfile => p !== undefined);
        if (profiles.length === 0) {
          continue;
        }
        found.push({ location, extensionId, data, profiles });
      } catch (error) {
        log.warn(`${location.label} 의 저장소를 읽지 못했습니다.`, error);
      }
    }
  }
  return found;
}

async function pickSource(sources: ImportSource[]): Promise<ImportSource | undefined> {
  if (sources.length === 1) {
    return sources[0];
  }
  const picked = await vscode.window.showQuickPick(
    sources.map((source) => ({
      label: source.location.label,
      description: source.extensionId,
      detail: `연결 ${source.profiles.length}개 · 저장된 비밀번호 ${source.data.secrets.size}개`,
      source,
    })),
    { title: '어느 설치본에서 가져올까요?', ignoreFocusOut: true },
  );
  return picked?.source;
}

/**
 * 가져올 연결을 고른다.
 *
 * 접속 정보까지 같은 것이 이미 있으면 처음부터 선택을 풀어 둔다 — 목록을
 * 그대로 확인만 하고 넘어가도 같은 연결이 두 개로 늘어나지 않아야 한다.
 */
async function pickItems(
  plan: ImportItem<ConnectionProfile>[],
): Promise<ImportItem<ConnectionProfile>[] | undefined> {
  const items = plan.map((item) => ({
    label: item.status === 'renamed' ? `${item.source.name} → ${item.name}` : item.name,
    description: `${DIALECT_LABELS[item.source.dialect]} · ${item.source.host}:${item.source.port}/${item.source.database}`,
    detail: detailOf(item),
    picked: item.status !== 'existing',
    item,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: '가져올 연결 선택',
    placeHolder: '가져올 연결을 고르세요. 원본은 그대로 남습니다.',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  return picked?.map((entry) => entry.item);
}

function detailOf(item: ImportItem<ConnectionProfile>): string {
  const where = item.source.folder ? `$(folder) ${item.source.folder}` : '$(folder) (최상위)';
  switch (item.status) {
    case 'existing':
      return `${where} · 이미 있음`;
    case 'renamed':
      return `${where} · 이름이 겹쳐 새 이름으로 저장`;
    default:
      return where;
  }
}

/**
 * 옛 프로필의 비밀번호를 되돌린다. 저장돼 있지 않거나 풀 수 없으면 undefined —
 * 그 경우 연결 정보만 넘어가고 비밀번호는 처음 접속할 때 물어본다.
 */
async function recoverPassword(
  source: ImportSource,
  profile: ConnectionProfile,
  readPassword: PasswordReader | undefined,
): Promise<string | undefined> {
  if (!profile.savePassword || !readPassword) {
    return undefined;
  }
  const encrypted = source.data.secrets.get(profile.id);
  if (!encrypted) {
    return undefined;
  }
  try {
    const password = await readPassword(encrypted);
    return password || undefined;
  } catch (error) {
    // 비밀번호 하나를 못 풀었다고 프로필까지 버리지 않는다.
    log.warn(`"${profile.name}" 의 비밀번호를 복호화하지 못했습니다.`, error);
    return undefined;
  }
}

/**
 * 원본 설치본의 safeStorage 키를 열어 비밀번호를 읽는 함수를 만든다.
 *
 * Windows 에서만 가능하다 — macOS 는 키체인, Linux 는 시크릿 서비스가 키를
 * 쥐고 있고, 둘 다 앱 신원 확인을 거치므로 다른 앱이 꺼내 쓸 수 없다.
 */
async function passwordReader(location: StorageLocation): Promise<PasswordReader | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  try {
    const localState = fs.readFileSync(location.localStatePath, 'utf8');
    const protectedKey = protectedKeyFromLocalState(localState);
    if (!protectedKey) {
      log.warn(`${location.label} 의 암호화 키를 찾지 못했습니다.`);
      return undefined;
    }
    const key = await unprotectDpapi(protectedKey);
    return async (encrypted) =>
      isSafeStorageEncrypted(encrypted)
        ? decryptSafeStorage(encrypted, key)
        : (await unprotectDpapi(encrypted)).toString('utf8');
  } catch (error) {
    log.warn(`${location.label} 의 암호화 키를 열지 못했습니다.`, error);
    return undefined;
  }
}

/**
 * 저장할 초안. id 와 생성 시각은 새로 발급된다 — 옛 id 를 그대로 쓰면
 * 원본 설치본과 비밀 값 키가 얽혀, 한쪽을 지울 때 다른 쪽이 영향을 받는다.
 */
function draftOf(profile: ConnectionProfile, name: string): ConnectionProfileDraft {
  return {
    name,
    dialect: profile.dialect,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    savePassword: profile.savePassword,
    readOnly: profile.readOnly,
    tls: profile.tls,
    pool: profile.pool,
    connectTimeoutMs: profile.connectTimeoutMs,
    oracle: profile.oracle,
    color: profile.color,
    folder: profile.folder,
    environment: profile.environment,
  };
}
