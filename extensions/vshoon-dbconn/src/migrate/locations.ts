/**
 * 정품 VS Code(와 그 파생 배포)가 확장 데이터를 두는 위치.
 *
 * 여기서 vscode API 를 쓰지 않는다 — 경로 규칙만 다루므로 테스트에서
 * 환경 변수와 플랫폼을 넣어 그대로 부를 수 있어야 한다.
 */

import * as path from 'node:path';

/**
 * 연결 프로필이 저장돼 있을 수 있는 확장 ID.
 *
 * `dbconn.dbconn` 은 publisher 를 `vshoon` 으로 바꾸기 전의 ID 다. globalState 와
 * SecretStorage 는 둘 다 확장 ID 로 격리되므로, ID 가 바뀌면 같은 앱에서 돌려도
 * 이전 데이터가 보이지 않는다 — 그래서 옛 ID 를 목록으로 들고 다닌다.
 */
export const SOURCE_EXTENSION_IDS = ['dbconn.dbconn', 'vshoon.vshoon-dbconn'] as const;

export interface StorageLocation {
  /** 사용자에게 보여 줄 앱 이름. */
  label: string;
  /** 앱 데이터 폴더. */
  dataDir: string;
  /** `User/globalStorage/state.vscdb` — 프로필과 암호화된 비밀 값이 함께 있다. */
  statePath: string;
  /** `Local State` — safeStorage 가 쓰는 암호화 키가 담겨 있다. */
  localStatePath: string;
}

const APPS: { label: string; dir: string }[] = [
  { label: 'Visual Studio Code', dir: 'Code' },
  { label: 'Visual Studio Code - Insiders', dir: 'Code - Insiders' },
  { label: 'VSCodium', dir: 'VSCodium' },
];

/**
 * 살펴볼 후보 위치. 실제로 존재하는지는 확인하지 않는다 —
 * 파일 시스템 접근은 호출부가 하고, 이 함수는 규칙만 만든다.
 */
export function storageLocations(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): StorageLocation[] {
  const root = appDataRoot(env, platform);
  if (!root) {
    return [];
  }
  return APPS.map((app) => {
    const dataDir = path.join(root, app.dir);
    return {
      label: app.label,
      dataDir,
      statePath: path.join(dataDir, 'User', 'globalStorage', 'state.vscdb'),
      localStatePath: path.join(dataDir, 'Local State'),
    };
  });
}

/** 플랫폼별 앱 데이터 루트. 필요한 환경 변수가 없으면 undefined. */
function appDataRoot(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === 'win32') {
    return env.APPDATA || undefined;
  }
  const home = env.HOME;
  if (!home) {
    return undefined;
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}
