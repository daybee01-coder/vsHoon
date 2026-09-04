import * as vscode from 'vscode';
import { SshFileSession } from '../ssh/sshFileSession';
import { joinRemotePath } from './fileSession';

/**
 * `vssh-sftp://<sessionId>/<path>` 스킴을 파일시스템으로 노출한다.
 * 이걸 통해 원격 파일을 진짜 에디터로 열고, 저장하면 곧바로 SFTP로 업로드된다.
 * SSH 세션에만 연결된다 (WSL/로컬은 다른 경로로 처리).
 */
export class SftpFileSystemProvider implements vscode.FileSystemProvider {
  static readonly scheme = 'vssh-sftp';

  private readonly sessions = new Map<string, SshFileSession>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  register(session: SshFileSession): void {
    this.sessions.set(session.id, session);
  }

  unregister(id: string): void {
    this.sessions.delete(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  static uri(sessionId: string, remotePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SftpFileSystemProvider.scheme,
      authority: sessionId,
      path: remotePath.startsWith('/') ? remotePath : `/${remotePath}`,
    });
  }

  private session(uri: vscode.Uri): SshFileSession {
    const s = this.sessions.get(uri.authority);
    if (!s) {
      throw vscode.FileSystemError.Unavailable('VSsh: SSH 세션이 닫혔습니다. 다시 연결하세요.');
    }
    return s;
  }

  watch(): vscode.Disposable {
    // 원격 변경 감시는 지원하지 않는다 (편집/저장은 writeFile 이벤트로 반영).
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const st = await this.session(uri).stat(uri.path);
    return {
      type: st.isDirectory
        ? vscode.FileType.Directory
        : st.isSymbolicLink
          ? vscode.FileType.SymbolicLink
          : vscode.FileType.File,
      ctime: st.mtime,
      mtime: st.mtime,
      size: st.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await this.session(uri).readdir(uri.path);
    return entries.map((e) => [
      e.name,
      e.isDirectory ? vscode.FileType.Directory : e.isSymbolicLink ? vscode.FileType.SymbolicLink : vscode.FileType.File,
    ]);
  }

  createDirectory(uri: vscode.Uri): Thenable<void> {
    return Promise.resolve(this.session(uri).mkdir(uri.path));
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const s = this.session(uri);
    if (!s.readFile) throw vscode.FileSystemError.Unavailable('읽기를 지원하지 않는 세션입니다.');
    return s.readFile(uri.path);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const s = this.session(uri);
    if (!s.writeFile) throw vscode.FileSystemError.Unavailable('쓰기를 지원하지 않는 세션입니다.');
    await s.writeFile(uri.path, content);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const s = this.session(uri);
    const st = await s.stat(uri.path);
    if (st.isDirectory) {
      await this.deleteDir(s, uri.path);
    } else {
      await s.unlink(uri.path);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  private async deleteDir(s: SshFileSession, dir: string): Promise<void> {
    for (const e of await s.readdir(dir)) {
      const child = joinRemotePath(dir, e.name);
      if (e.isDirectory) await this.deleteDir(s, child);
      else await s.unlink(child);
    }
    await s.rmdir(dir);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    if (oldUri.authority !== newUri.authority) {
      throw vscode.FileSystemError.Unavailable('다른 세션 간 이동은 지원하지 않습니다.');
    }
    await this.session(oldUri).rename(oldUri.path, newUri.path);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }
}
