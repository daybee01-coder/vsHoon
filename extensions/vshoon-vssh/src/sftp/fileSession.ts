export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  /** 심볼릭 링크 여부 (대상이 디렉터리여도 isDirectory는 false로 둔다). */
  isSymbolicLink?: boolean;
  /** 파일 크기(바이트). 디렉터리이거나 알 수 없으면 생략. */
  size?: number;
  /** 수정 시각 (epoch 밀리초). 알 수 없으면 생략. */
  mtime?: number;
  /** 유닉스 퍼미션 비트만 (예: 0o644). 로컬 Windows 등에서는 생략될 수 있음. */
  mode?: number;
}

export interface FileStat {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /** 바이트 */
  size: number;
  /** 수정 시각 (epoch 밀리초) */
  mtime: number;
  /** 유닉스 퍼미션 비트 (예: 0o644) */
  mode?: number;
}

export type ProgressCallback = (transferred: number, total: number) => void;

/**
 * SFTP 탐색기/명령이 실제로 의존하는 최소 인터페이스.
 * SSH(SshFileSession), 로컬 WSL(WslFileSession), 로컬 파일시스템(LocalFileSession)이
 * 모두 이 인터페이스를 만족하므로 패널/전송 코드는 어떤 백엔드인지 알 필요가 없다.
 */
export interface FileSession {
  /** 세션마다 고유. vssh-sftp:// URI의 authority로 쓰인다. */
  readonly id: string;
  readonly label: string;
  readdir(remotePath: string): Promise<RemoteEntry[]>;
  realpath(remotePath: string): Promise<string>;
  stat(remotePath: string): Promise<FileStat>;
  mkdir(remotePath: string): Promise<void>;
  rmdir(remotePath: string): Promise<void>;
  unlink(remotePath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 같은 세션 안에서 서버 쪽 재귀 복사(cp -r 상당). 파일/폴더 모두 지원. */
  copy(oldPath: string, newPath: string): Promise<void>;
  download(remotePath: string, localPath: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<void>;
  upload(localPath: string, remotePath: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<void>;
  /** 원격 파일 편집(FileSystemProvider)용. SSH 세션만 구현. */
  readFile?(remotePath: string): Promise<Uint8Array>;
  writeFile?(remotePath: string, content: Uint8Array): Promise<void>;
  /** 전송 시 권한/수정시각 보존용. 지원하는 세션만 구현. */
  chmod?(remotePath: string, mode: number): Promise<void>;
  utimes?(remotePath: string, mtimeMs: number): Promise<void>;
}

export function joinRemotePath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}
