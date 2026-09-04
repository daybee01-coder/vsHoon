import { Client } from 'ssh2';
import { SshConnectionInfo, SshFileSession } from '../ssh/sshFileSession';

/** WSL 터미널과 연결된 localhost SSH/SFTP 파일 세션. */
export class WslFileSession extends SshFileSession {
  constructor(client: Client, readonly distro: string, connection?: SshConnectionInfo) {
    super(client, `WSL: ${distro}`, connection);
  }

  override async realpath(remotePath: string): Promise<string> {
    return remotePath === '.' || remotePath === '' ? '/' : super.realpath(remotePath);
  }

  dispose(): void {
    // SSH Client의 수명은 extension.ts에서 터미널과 함께 관리한다.
  }
}
