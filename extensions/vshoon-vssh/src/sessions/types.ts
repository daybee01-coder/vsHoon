export type AuthMethod = 'password' | 'openssh-key' | 'ppk';

export type PasswordAction = { type: 'save'; password: string } | { type: 'forget' } | { type: 'keep' };

/**
 * 세션 프로필. v1(레지스트리 공유)과 달리 이제 PuTTY와 무관한 확장 자체 저장소에 저장되므로
 * "우리가 모르는 필드를 보존"할 필요가 없어져 raw 맵이 사라졌다. id는 폴더 이동/이름변경과
 * 무관하게 세션을 식별하는 안정적인 키 (비밀번호 저장 등에 사용).
 */
export interface SessionProfile {
  id: string;
  sessionName: string;
  hostName: string;
  portNumber: number;
  userName: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  encoding?: string;
  fontFamily?: string;
  fontSize?: number;
}

export interface SessionFolder {
  id: string;
  name: string;
}

/** 저장소 파일에 그대로 직렬화되는 노드. 트리는 parentId로 표현하는 평면 목록이다. */
export type StoreNode =
  | ({ type: 'folder'; parentId: string | null } & SessionFolder)
  | ({ type: 'session'; parentId: string | null } & SessionProfile);
