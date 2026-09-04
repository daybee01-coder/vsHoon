import * as crypto from 'crypto';
import * as fs from 'fs';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { Client } from 'ssh2';
import { shellQuote } from '../common/shellQuote';
import { FileSession, FileStat, ProgressCallback, RemoteEntry } from '../sftp/fileSession';
import { SFTP_STREAM_BUFFER_SIZE, SftpSession } from '../sftp/sftpClient';

function execRemote(client: Client, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stderr = '';
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });
      stream.on('exit', (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `명령이 종료 코드 ${code}로 실패했습니다.`));
        }
      });
      stream.on('error', reject);
    });
  });
}

/**
 * 스트림을 파이프하면서 진행률을 보고하고, AbortSignal로 중간 취소를 지원한다.
 * fs 스트림과 ssh2 SFTP 스트림은 end/finish/close 이벤트 타이밍이 제각각이라
 * (직접 'finish'만 기다리면 전송이 끝나도 Promise가 안 풀리는 경우가 있다)
 * stream.pipeline에 완료·오류·정리를 맡긴다.
 */
async function pipeWithProgress(
  rs: Readable,
  ws: Writable,
  total: number,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  let transferred = 0;
  const meter = new Transform({
    readableHighWaterMark: SFTP_STREAM_BUFFER_SIZE,
    writableHighWaterMark: SFTP_STREAM_BUFFER_SIZE,
    transform(chunk: Buffer, _enc, cb) {
      transferred += chunk.length;
      onProgress?.(transferred, total || transferred);
      cb(null, chunk);
    },
  });

  try {
    await (signal ? pipeline(rs, meter, ws, { signal }) : pipeline(rs, meter, ws));
  } catch (err) {
    const code = (err as { code?: string; name?: string }).code;
    const name = (err as { code?: string; name?: string }).name;
    if (signal?.aborted || code === 'ABORT_ERR' || name === 'AbortError') {
      throw new Error('전송이 취소되었습니다.');
    }
    throw err;
  }
}

/** 세션이 어떤 호스트/포트/사용자로 접속했는지. SFTP 패널의 "사용자 변경"이 같은 호스트로 재접속할 때 쓴다. */
export interface SshConnectionInfo {
  host: string;
  port: number;
  username: string;
}

/** ssh2 기반 SftpSession을 공통 FileSession 인터페이스에 맞게 어댑팅한다. */
export class SshFileSession implements FileSession {
  readonly id = crypto.randomUUID();
  readonly label: string;
  /** 접속에 사용한 호스트/포트/사용자. 알 수 없는 경로로 만들어진 세션은 생략될 수 있다. */
  readonly connection: SshConnectionInfo | undefined;
  private readonly sftp: SftpSession;

  constructor(private readonly client: Client, sessionName: string, connection?: SshConnectionInfo) {
    this.label = sessionName;
    this.connection = connection;
    this.sftp = new SftpSession(client);
  }

  async readdir(remotePath: string): Promise<RemoteEntry[]> {
    const entries = await this.sftp.readdir(remotePath);
    return entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => {
        const isDirectory = e.attrs.isDirectory();
        return {
          name: e.filename,
          isDirectory,
          isSymbolicLink: e.attrs.isSymbolicLink(),
          size: isDirectory ? undefined : e.attrs.size,
          mtime: e.attrs.mtime ? e.attrs.mtime * 1000 : undefined,
          mode: e.attrs.mode & 0o777,
        };
      });
  }

  realpath(remotePath: string): Promise<string> {
    return this.sftp.realpath(remotePath);
  }

  async stat(remotePath: string): Promise<FileStat> {
    const st = await this.sftp.stat(remotePath);
    return {
      isDirectory: st.isDirectory(),
      isSymbolicLink: st.isSymbolicLink(),
      size: st.size ?? 0,
      mtime: st.mtime ? st.mtime * 1000 : 0,
      mode: st.mode & 0o777,
    };
  }

  mkdir(remotePath: string): Promise<void> {
    return this.sftp.mkdir(remotePath);
  }

  rmdir(remotePath: string): Promise<void> {
    return this.sftp.rmdir(remotePath);
  }

  unlink(remotePath: string): Promise<void> {
    return this.sftp.unlink(remotePath);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.sftp.rename(oldPath, newPath);
  }

  /** SFTP 프로토콜엔 재귀 복사가 없어서, exec 채널로 원격 cp -r을 그대로 실행한다. */
  copy(oldPath: string, newPath: string): Promise<void> {
    return execRemote(this.client, `cp -r ${shellQuote(oldPath)} ${shellQuote(newPath)}`);
  }

  readFile(remotePath: string): Promise<Uint8Array> {
    return this.sftp.readFile(remotePath);
  }

  async writeFile(remotePath: string, content: Uint8Array): Promise<void> {
    await this.sftp.writeFile(remotePath, Buffer.from(content));
  }

  chmod(remotePath: string, mode: number): Promise<void> {
    return this.sftp.chmod(remotePath, mode);
  }

  utimes(remotePath: string, mtimeMs: number): Promise<void> {
    const t = Math.floor(mtimeMs / 1000);
    return this.sftp.utimes(remotePath, t, t);
  }

  async download(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<void> {
    let total = 0;
    try {
      total = (await this.sftp.stat(remotePath)).size ?? 0;
    } catch {
      /* 크기를 못 구하면 진행률 %는 못 보여줘도 전송은 진행 */
    }
    const rs = await this.sftp.createReadStream(remotePath);
    const ws = fs.createWriteStream(localPath, { highWaterMark: SFTP_STREAM_BUFFER_SIZE });
    await pipeWithProgress(rs, ws, total, onProgress, signal);
  }

  async upload(
    localPath: string,
    remotePath: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<void> {
    let total = 0;
    try {
      total = (await fs.promises.stat(localPath)).size;
    } catch {
      /* 무시 */
    }
    const rs = fs.createReadStream(localPath, { highWaterMark: SFTP_STREAM_BUFFER_SIZE });
    const ws = await this.sftp.createWriteStream(remotePath);
    await pipeWithProgress(rs, ws, total, onProgress, signal);
  }
}
