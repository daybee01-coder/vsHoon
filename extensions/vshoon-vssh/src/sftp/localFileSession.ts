import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncSemaphore, LOCAL_SCAN_CONCURRENCY } from './asyncSemaphore';
import { FileSession, FileStat, RemoteEntry } from './fileSession';

/** `readdir`가 목록에 쓰는 항목. `fs.Dirent`가 그대로 만족한다. */
type ScanDirent = Pick<fs.Dirent, 'name' | 'isDirectory' | 'isSymbolicLink'>;

/** `readdir`가 항목 메타데이터로 쓰는 값. `fs.Stats`가 그대로 만족한다. */
type ScanStats = Pick<fs.Stats, 'isDirectory' | 'isFile' | 'size' | 'mtimeMs' | 'mode'>;

/** 목록 조회가 쓰는 파일 시스템 부분. 테스트에서 대체할 수 있게 좁게 정의한다. */
export interface DirectoryScanner {
  readdir(dirPath: string, options: { withFileTypes: true }): Promise<ScanDirent[]>;
  stat(entryPath: string): Promise<ScanStats>;
}

/**
 * 파일질라식 왼쪽(로컬) 패널의 백엔드. Node fs를 FileSession 인터페이스에 맞춘다.
 * 실제 원격 전송(upload/download)은 항상 원격 세션 쪽 구현이 담당하므로 여기서는 막아둔다.
 */
export class LocalFileSession implements FileSession {
  readonly id = crypto.randomUUID();
  readonly label = '로컬';
  private readonly scanSemaphore: AsyncSemaphore;

  /**
   * 항목 메타데이터 조회를 동시에 여는 수를 제한한다. 목록 순서와 각 항목의 값은 그대로다.
   *
   * @param scanner 목록 조회가 쓰는 파일 시스템. 기본값은 Node의 `fs.promises`다.
   * @param scanConcurrency 동시에 실행할 `stat` 수.
   */
  constructor(
    private readonly scanner: DirectoryScanner = fs.promises,
    scanConcurrency: number = LOCAL_SCAN_CONCURRENCY
  ) {
    this.scanSemaphore = new AsyncSemaphore(scanConcurrency);
  }

  async readdir(dirPath: string): Promise<RemoteEntry[]> {
    const dirents = await this.scanner.readdir(dirPath, { withFileTypes: true });
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
          const st = await this.scanSemaphore.run(() => this.scanner.stat(full));
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
