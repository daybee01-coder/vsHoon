import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/**
 * wsl.exe는 파이프로 리다이렉트될 때 UTF-16LE(+BOM)로 출력하는 경우가 있어
 * child_process로 캡처하면 그대로 utf8로 디코딩하면 깨진다. BOM 유무와 널바이트
 * 비율을 보고 UTF-16LE 여부를 판단해서 디코딩한다.
 */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  let nullCount = 0;
  for (let i = 1; i < buf.length; i += 2) {
    if (buf[i] === 0x00) nullCount++;
  }
  if (buf.length > 4 && nullCount > buf.length / 4) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

/** wsl.exe -d <distro> [...args]를 실행하고 디코딩된 stdout(trim)을 반환한다. */
export async function execWsl(distro: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('wsl.exe', ['-d', distro, ...args], {
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
  });
  return decodeWslOutput(stdout as unknown as Buffer).replace(/\0/g, '').trim();
}

// Docker Desktop이 내부적으로 등록하는 시스템용 배포판. 대화형 터미널 목적이 아니라 목록에서 제외한다.
const HIDDEN_DISTROS = new Set(['docker-desktop', 'docker-desktop-data']);

/** WSL을 시작하지 않고 사용자 레지스트리에서 등록된 배포판 이름을 읽는다. */
async function listRegisteredWslDistros(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s', '/v', 'DistributionName'],
      { windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 }
    );
    const text = (stdout as unknown as Buffer).toString('utf8').replace(/\0/g, '');
    const names = text
      .split(/\r?\n/)
      .map((line) => /DistributionName\s+REG_SZ\s+(.+)$/i.exec(line)?.[1]?.trim())
      .filter((name): name is string => !!name && !HIDDEN_DISTROS.has(name));
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** 설치된 WSL 배포판 이름 목록. wsl.exe가 없거나 WSL이 설치되지 않은 환경에서는 빈 배열을 반환한다. */
export async function listWslDistros(allowWslFallback = true): Promise<string[]> {
  const registered = await listRegisteredWslDistros();
  if (registered.length > 0 || !allowWslFallback) return registered;
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], {
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 1024 * 1024,
    });
    return decodeWslOutput(stdout as unknown as Buffer)
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').trim())
      .filter((line) => line.length > 0 && !HIDDEN_DISTROS.has(line));
  } catch {
    return [];
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WSL 터미널이 지금 실제로 위치한 디렉터리를 알아낸다.
 *
 * 일반 vscode.Terminal은 출력을 읽을 방법이 아예 없다(그래서 예전엔 WSL을 지원하지 않았다).
 * 대신 터미널에 pwd 결과를 배포판 안 임시 파일로 떨구게 시키고, 그 파일을 별도 wsl.exe로
 * 읽어온다. 같은 배포판이면 별도 실행이라도 같은 파일시스템을 보므로 값이 그대로 전달된다.
 * SSH 쪽 getCurrentDirectory와 마찬가지로 명령이 터미널 화면에 잠깐 보인다.
 */
export async function getWslTerminalDirectory(terminal: vscode.Terminal, distro: string): Promise<string> {
  const marker = `/tmp/.vssh-pwd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  terminal.sendText(`pwd > '${marker}'`, true);

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await delay(120);
      // 셸이 아직 명령을 실행하기 전이면 파일이 없어서 cat이 실패한다 - 생길 때까지 기다린다.
      const out = await execWsl(distro, ['--', 'cat', marker]).catch(() => '');
      if (out) return out;
    }
    throw new Error('현재 경로를 확인하지 못했습니다 (응답 시간 초과).');
  } finally {
    void execWsl(distro, ['--', 'rm', '-f', marker]).catch(() => undefined);
  }
}

/** SSH를 거치지 않고 wsl.exe를 직접 실행하는 로컬 터미널을 연다. */
export function openWslTerminal(distro?: string): vscode.Terminal {
  const shellArgs = distro ? ['-d', distro, '--cd', '/'] : ['--cd', '/'];
  const terminal = vscode.window.createTerminal({
    name: distro ? `WSL: ${distro}` : 'WSL',
    shellPath: 'wsl.exe',
    shellArgs,
    location: vscode.TerminalLocation.Editor,
  });
  terminal.show();
  return terminal;
}
