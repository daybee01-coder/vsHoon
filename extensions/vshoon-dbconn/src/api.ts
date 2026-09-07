import { formatConnectionUrl } from './config/connectionUrl';
import type { ConnectionEnvironment, ConnectionProfile, DialectId } from './types';

/**
 * 다른 확장에 공개하는 읽기 전용 API.
 *
 * `activate()` 가 이 객체를 돌려주므로 소비자는 이렇게 접근한다:
 *
 * ```ts
 * const ext = vscode.extensions.getExtension<DbconnApi>('vshoon.vshoon-dbconn');
 * const api = await ext?.activate();
 * ```
 *
 * 두 가지를 의도적으로 뺐다:
 *  - **비밀번호.** SecretStorage 밖으로 나가지 않는다. 다른 확장이 조용히
 *    자격 증명을 긁어 가는 경로를 만들지 않는다. 실제로 접속이 필요하면
 *    사용자 동의를 받는 별도 API 로 열어야 한다.
 *  - **쓰기.** 프로필 추가/수정/삭제는 사용자가 이 확장의 UI 에서 한다.
 *    남의 확장이 트리를 바꿔 놓으면 사용자가 원인을 찾을 수 없다.
 *
 * 필드를 지우거나 의미를 바꿀 때는 `version` 을 올린다 — 소비자가 자기
 * 코드를 고칠 기회를 갖게 하는 유일한 신호다.
 */
export interface DbconnApi {
  /** API 모양의 버전. 호환되지 않는 변경마다 1 씩 올라간다. */
  readonly version: 1;
  /** 저장된 모든 연결 프로필. 이름순. */
  getProfiles(): DbconnProfileInfo[];
  getProfile(id: string): DbconnProfileInfo | undefined;
  /**
   * 표시·전달용 연결 URL (예: `postgresql://app@db:5432/shop?sslmode=verify-full`).
   * 비밀번호는 담기지 않는다. 없는 id 면 undefined.
   */
  getConnectionUrl(id: string): string | undefined;
  /** 프로필 목록이나 연결 상태가 바뀔 때 발생. */
  readonly onDidChangeProfiles: ApiEvent<void>;
}

/**
 * `vscode.Event` 와 구조적으로 호환되는 최소 이벤트 타입.
 *
 * 이 모듈이 `vscode` 를 임포트하지 않기 위한 것이다 — 덕분에 API 모양을
 * 순수 단위 테스트로 검증할 수 있다.
 */
export type ApiEvent<T> = (listener: (e: T) => void) => { dispose(): void };

/**
 * 외부에 보이는 연결 프로필.
 *
 * 내부 `ConnectionProfile` 을 그대로 주지 않는 이유: 풀 옵션이나 인증서
 * 경로처럼 내부 사정에 따라 바뀌는 필드가 남의 확장의 컴파일을 깨뜨리면
 * 안 된다. 여기 있는 필드만 계약이다.
 */
export interface DbconnProfileInfo {
  readonly id: string;
  readonly name: string;
  readonly dialect: DialectId;
  readonly host: string;
  readonly port: number;
  /** MySQL/MariaDB/PostgreSQL: database, Oracle: service name 또는 SID. */
  readonly database: string;
  readonly user: string;
  readonly environment: ConnectionEnvironment;
  /** 이 연결로는 데이터 변경 구문이 차단된다. */
  readonly readOnly: boolean;
  readonly tlsEnabled: boolean;
  /** 트리에서 이 연결이 놓인 폴더 경로(예: `운영/서울`). 최상위면 undefined. */
  readonly folder: string | undefined;
  /** 지금 세션이 열려 있는지. */
  readonly connected: boolean;
}

/** API 가 내부 상태를 읽어 가는 창구. */
export interface DbconnApiHost {
  listProfiles(): ConnectionProfile[];
  isConnected(profileId: string): boolean;
  onDidChange: ApiEvent<void>;
}

export function createDbconnApi(host: DbconnApiHost): DbconnApi {
  const find = (id: string): ConnectionProfile | undefined =>
    host.listProfiles().find((profile) => profile.id === id);

  return {
    version: 1,
    getProfiles: () =>
      host.listProfiles().map((profile) => toProfileInfo(profile, host.isConnected(profile.id))),
    getProfile: (id) => {
      const profile = find(id);
      return profile ? toProfileInfo(profile, host.isConnected(profile.id)) : undefined;
    },
    getConnectionUrl: (id) => {
      const profile = find(id);
      if (!profile) {
        return undefined;
      }
      return formatConnectionUrl({
        dialect: profile.dialect,
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        tlsEnabled: profile.tls.enabled,
        tlsVerify: profile.tls.rejectUnauthorized,
        oracleConnectType: profile.oracle?.connectType,
      });
    },
    onDidChangeProfiles: host.onDidChange,
  };
}

function toProfileInfo(profile: ConnectionProfile, connected: boolean): DbconnProfileInfo {
  return {
    id: profile.id,
    name: profile.name,
    dialect: profile.dialect,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    environment: profile.environment,
    readOnly: profile.readOnly,
    tlsEnabled: profile.tls.enabled,
    folder: profile.folder,
    connected,
  };
}
