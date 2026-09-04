import { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import * as iconv from 'iconv-lite';
import { BroadcastManager, BroadcastTarget } from './broadcastManager';

export interface SshPseudoterminalOptions {
  client: Client;
  /** 'UTF-8' | 'EUC-KR' | 'CP949' 등 PuTTY의 LineCodePage와 매핑되는 값 */
  encoding: string;
  broadcastManager?: BroadcastManager;
}

function toIconvEncoding(encoding: string): string {
  switch (encoding.toUpperCase()) {
    case 'EUC-KR':
      return 'euc-kr';
    case 'CP949':
      return 'cp949';
    default:
      return 'utf8';
  }
}

/**
 * node-pty 없이 vscode.Pseudoterminal을 ssh2의 shell 채널에 직접 연결한다.
 * 실제 PTY는 원격 SSH 서버가 할당하므로 로컬에는 네이티브 의존성이 없다.
 */
export class SshPseudoterminal implements vscode.Pseudoterminal, BroadcastTarget {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private stream: ClientChannel | undefined;
  private readonly iconvEncoding: string;

  constructor(private readonly options: SshPseudoterminalOptions) {
    this.iconvEncoding = toIconvEncoding(options.encoding);
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    const cols = initialDimensions?.columns ?? 80;
    const rows = initialDimensions?.rows ?? 24;
    // PuTTY 기본값(xterm)과 맞춘다. xterm-256color였을 때 vi/vim이 TERM 기반으로 마우스
    // 프로토콜을 다르게 자동감지해서 휠 스크롤 업만 안 먹는 것으로 의심됨(실제 PuTTY/다른
    // 터미널로는 같은 서버에서 문제 없음을 확인함).
    this.options.client.shell({ term: 'xterm', cols, rows }, (err, stream) => {
      if (err) {
        this.writeEmitter.fire(`\r\n연결 실패: ${err.message}\r\n`);
        this.closeEmitter.fire(1);
        return;
      }
      this.stream = stream;
      this.options.broadcastManager?.register(this);
      stream.on('data', (data: Buffer) => this.writeEmitter.fire(this.decode(data)));
      stream.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(this.decode(data)));
      stream.on('close', () => {
        this.options.broadcastManager?.unregister(this);
        this.closeEmitter.fire(0);
      });
    });
  }

  close(): void {
    this.options.broadcastManager?.unregister(this);
    this.stream?.end();
    this.options.client.end();
  }

  handleInput(data: string): void {
    this.stream?.write(this.encode(data));
    this.options.broadcastManager?.broadcastFrom(this, data);
  }

  /** BroadcastManager가 다른 터미널에서 온 입력을 이 터미널에도 전달할 때 쓴다. */
  writeRaw(data: string): void {
    this.stream?.write(this.encode(data));
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.stream?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  /**
   * 지금 이 셸이 실제로 위치한 디렉터리를 알아낸다. 별도 exec 채널로 pwd를 돌리면 로그인 시점
   * 기본 디렉터리만 나오므로(사용자가 대화형으로 cd한 상태를 못 봄), 반드시 이 인터랙티브
   * 셸 스트림에 명령을 흘려보내고 그 응답을 가로채야 한다. 그래서 터미널 화면에 pwd 명령과
   * 결과가 잠깐 보인다 - 조용히 감추려면 훨씬 복잡해져서 v1에서는 그대로 뒀다.
   */
  getCurrentDirectory(): Promise<string> {
    const stream = this.stream;
    if (!stream) {
      return Promise.reject(new Error('터미널이 아직 연결되지 않았습니다.'));
    }
    const marker = `__VSSH_PWD_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}__`;

    return new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (data: Buffer): void => {
        buffer += this.decode(data);

        // 터미널 에코 때문에 우리가 보낸 명령어 자체(마커가 두 번 들어있는 원문)가 먼저 그대로
        // 되돌아온다. 그래서 처음 나오는 마커 한 쌍은 진짜 pwd 결과가 아니라 에코일 수 있다.
        // 에코(2개) + 실제 printf 출력(2개), 최소 4번 나올 때까지 기다렸다가 마지막 한 쌍
        // (가장 최근에 실행된 결과)만 신뢰한다.
        const indices: number[] = [];
        for (let idx = buffer.indexOf(marker); idx !== -1; idx = buffer.indexOf(marker, idx + marker.length)) {
          indices.push(idx);
        }
        if (indices.length < 4) return;

        const start = indices[indices.length - 2] + marker.length;
        const end = indices[indices.length - 1];
        cleanup();
        resolve(buffer.slice(start, end).trim());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('현재 경로를 확인하지 못했습니다 (응답 시간 초과).'));
      }, 5000);
      const cleanup = (): void => {
        clearTimeout(timer);
        stream.removeListener('data', onData);
      };

      stream.on('data', onData);
      stream.write(this.encode(`printf '\\n%s%s%s\\n' '${marker}' "$(pwd)" '${marker}'\n`));
    });
  }

  private decode(data: Buffer): string {
    return this.iconvEncoding === 'utf8' ? data.toString('utf8') : iconv.decode(data, this.iconvEncoding);
  }

  private encode(data: string): Buffer {
    return this.iconvEncoding === 'utf8' ? Buffer.from(data, 'utf8') : iconv.encode(data, this.iconvEncoding);
  }
}
