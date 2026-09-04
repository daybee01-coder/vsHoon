import { execFile } from 'child_process';
import { promisify } from 'util';
import * as iconv from 'iconv-lite';
import { codepageToIconvEncoding, getSystemOemCodepage, getSystemAnsiCodepage } from './windowsCodepage';

const execFileAsync = promisify(execFile);

export const SESSIONS_KEY = 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions';
const SESSIONS_KEY_FULL = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions';

export type RegValueType = 'REG_SZ' | 'REG_DWORD';

export interface RegValue {
  type: RegValueType;
  data: string | number;
}

/**
 * 이 파일은 이제 세션을 확장 자체 저장소로 가져오기(import)할 때만 쓴다 - 더 이상
 * PuTTY 레지스트리에 쓰지 않는다. munge/unmunge는 실제 PuTTY의 escape_registry_key()
 * (windows/winmisc.c)와 바이트 단위로 동일하게 동작하도록 리버스 엔지니어링한 것이며,
 * 읽어들인 세션 이름을 원래 문자열로 복원하는 unmunge만 여전히 필요하다.
 */
export function unmungeSessionName(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i];
    if (ch === '%' && i + 2 < encoded.length) {
      const val = parseInt(encoded.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(val)) {
        bytes.push(val);
        i += 2;
        continue;
      }
    }
    bytes.push(encoded.charCodeAt(i) & 0xff);
  }
  const encoding = codepageToIconvEncoding(getSystemAnsiCodepage());
  return iconv.decode(Buffer.from(bytes), encoding);
}

async function runReg(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('reg', args, {
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
  });
  const encoding = codepageToIconvEncoding(getSystemOemCodepage());
  return iconv.decode(stdout as unknown as Buffer, encoding);
}

/** PuTTY 세션 이름 목록 (레지스트리 키 이름 그대로, 아직 unmunge 전). */
export async function listSessionKeys(): Promise<string[]> {
  let text: string;
  try {
    text = await runReg(['query', SESSIONS_KEY]);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith(SESSIONS_KEY_FULL + '\\')) {
      names.push(line.slice(SESSIONS_KEY_FULL.length + 1));
    }
  }
  return names;
}

const VALUE_LINE_RE = /^ {4}(\S.*?) {4}(REG_[A-Z_]+) {4}(.*)$/;

export async function readSessionValues(encodedName: string): Promise<Map<string, RegValue>> {
  const key = `${SESSIONS_KEY}\\${encodedName}`;
  let text: string;
  try {
    text = await runReg(['query', key]);
  } catch {
    return new Map();
  }
  const values = new Map<string, RegValue>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(VALUE_LINE_RE);
    if (!m) continue;
    const [, name, type, data] = m;
    if (type === 'REG_DWORD') {
      values.set(name, { type: 'REG_DWORD', data: parseInt(data.replace(/^0x/i, ''), 16) });
    } else if (type === 'REG_SZ') {
      values.set(name, { type: 'REG_SZ', data });
    }
  }
  return values;
}
