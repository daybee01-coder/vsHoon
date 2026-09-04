import { Readable, Writable } from 'stream';
import { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';

/** OpenSSH SFTP 패킷 상한에 맞춘 스트림 버퍼. 기본 64 KiB보다 왕복 지연의 영향을 덜 받는다. */
export const SFTP_STREAM_BUFFER_SIZE = 256 * 1024;

/** ssh2 SFTPWrapper를 프로미스 기반으로 감싼다. */
export class SftpSession {
  private readonly ready: Promise<SFTPWrapper>;

  constructor(client: Client) {
    this.ready = new Promise((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
  }

  async readdir(remotePath: string): Promise<FileEntryWithStats[]> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)));
    });
  }

  async realpath(remotePath: string): Promise<string> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath, (err, abs) => (err ? reject(err) : resolve(abs)));
    });
  }

  async stat(remotePath: string): Promise<Stats> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => (err ? reject(err) : resolve(stats)));
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async rmdir(remotePath: string): Promise<void> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.rmdir(remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async unlink(remotePath: string): Promise<void> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async chmod(remotePath: string, mode: number): Promise<void> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.chmod(remotePath, mode, (err) => (err ? reject(err) : resolve()));
    });
  }

  async utimes(remotePath: string, atime: number, mtime: number): Promise<void> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.utimes(remotePath, atime, mtime, (err) => (err ? reject(err) : resolve()));
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }

  async writeFile(remotePath: string, data: Buffer): Promise<void> {
    const sftp = await this.ready;
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, data, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** 전송 중 취소(스트림 destroy)를 지원하려고 fastGet/fastPut 대신 스트림을 쓴다. */
  async createReadStream(remotePath: string): Promise<Readable> {
    const sftp = await this.ready;
    return sftp.createReadStream(remotePath, { highWaterMark: SFTP_STREAM_BUFFER_SIZE });
  }

  async createWriteStream(remotePath: string): Promise<Writable> {
    const sftp = await this.ready;
    return sftp.createWriteStream(remotePath, { highWaterMark: SFTP_STREAM_BUFFER_SIZE });
  }
}
