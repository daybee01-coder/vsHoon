import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSession, FileStat, RemoteEntry } from './fileSession';

/**
 * 파일질라식 왼쪽(로컬) 패널의 백엔드. Node fs를 FileSession 인터페이스에 맞춘다.
 * 실제 원격 전송(upload/download)은 항상 원격 세션 쪽 구현이 담당하므로 여기서는 막아둔다.
 */
export class LocalFileSession implements FileSession {
  readonly id = crypto.randomUUID();
  readonly label = '로컬';

  async readdir(dirPath: string): Promise<RemoteEntry[]> {
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return Promise.all(
      dirents.map(async (d) => {
        const full = path.join(dirPath, d.name);
        let isDirectory = d.isDirectory();
        const isSymbolicLink = d.isSymbolicLink();
        let size: number | undefined;
        let mtime: number | undefined;
        let mode: number | undefined;
        try {
          // 심링크는 대상 기준으로 표시한다 (깨진 링크면 catch로 넘어가 lstat 정보 유지).
          const st = await fs.promises.stat(full);
          isDirectory = st.isDirectory();
          size = st.isFile() ? st.size : undefined;
          mtime = st.mtimeMs;
          mode = st.mode & 0o777;
        } catch {
          /* 접근 불가/깨진 링크 - 메타데이터 없이 이름만 표시 */
        }
        return { name: d.name, isDirectory, isSymbolicLink, size, mtime, mode };
      })
    );
  }

  async realpath(p: string): Promise<string> {
    if (!p || p === '.') return os.homedir();
    try {
      return await fs.promises.realpath(p);
    } catch {
      return path.resolve(p);
    }
  }

  async stat(p: string): Promise<FileStat> {
    const st = await fs.promises.stat(p);
    return {
      isDirectory: st.isDirectory(),
      isSymbolicLink: st.isSymbolicLink(),
      size: st.size,
      mtime: st.mtimeMs,
      mode: st.mode & 0o777,
    };
  }

  async mkdir(p: string): Promise<void> {
    await fs.promises.mkdir(p);
  }

  async rmdir(p: string): Promise<void> {
    await fs.promises.rm(p, { recursive: true, force: true });
  }

  async unlink(p: string): Promise<void> {
    await fs.promises.unlink(p);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.promises.rename(oldPath, newPath);
  }

  async copy(oldPath: string, newPath: string): Promise<void> {
    await fs.promises.cp(oldPath, newPath, { recursive: true });
  }

  readFile(p: string): Promise<Uint8Array> {
    return fs.promises.readFile(p);
  }

  async writeFile(p: string, content: Uint8Array): Promise<void> {
    await fs.promises.writeFile(p, content);
  }

  async download(): Promise<void> {
    throw new Error('로컬 세션은 다운로드를 지원하지 않습니다.');
  }

  async upload(): Promise<void> {
    throw new Error('로컬 세션은 업로드를 지원하지 않습니다.');
  }
}
