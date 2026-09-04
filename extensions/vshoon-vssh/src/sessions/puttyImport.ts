import { listSessionKeys, readSessionValues, RegValue, unmungeSessionName } from './puttyRegistry';
import { AuthMethod, SessionProfile } from './types';

const DEFAULT_SETTINGS_KEY = 'Default%20Settings';

function getStr(raw: Map<string, RegValue>, name: string, fallback = ''): string {
  const v = raw.get(name);
  return v && v.type === 'REG_SZ' ? String(v.data) : fallback;
}

function getNum(raw: Map<string, RegValue>, name: string, fallback: number): number {
  const v = raw.get(name);
  return v && v.type === 'REG_DWORD' ? Number(v.data) : fallback;
}

function inferAuthMethod(privateKeyPath: string): AuthMethod {
  if (!privateKeyPath) return 'password';
  return privateKeyPath.toLowerCase().endsWith('.ppk') ? 'ppk' : 'openssh-key';
}

export interface ImportablePuttySession {
  name: string;
  profile: Omit<SessionProfile, 'id'>;
}

/** 실제 PuTTY 레지스트리에 저장된 세션 목록을 읽기만 한다 (더 이상 쓰지는 않음). */
export async function listPuttySessionsForImport(): Promise<ImportablePuttySession[]> {
  const keys = await listSessionKeys();
  const results: ImportablePuttySession[] = [];
  for (const key of keys) {
    if (key === DEFAULT_SETTINGS_KEY) continue;
    const raw = await readSessionValues(key);
    if (raw.size === 0) continue;
    const sessionName = unmungeSessionName(key);
    const privateKeyPath = getStr(raw, 'PublicKeyFile');
    results.push({
      name: sessionName,
      profile: {
        sessionName,
        hostName: getStr(raw, 'HostName'),
        portNumber: getNum(raw, 'PortNumber', 22),
        userName: getStr(raw, 'UserName'),
        authMethod: inferAuthMethod(privateKeyPath),
        privateKeyPath: privateKeyPath || undefined,
        encoding: getStr(raw, 'LineCodePage') || undefined,
        fontFamily: getStr(raw, 'Font') || undefined,
        fontSize: raw.has('FontHeight') ? getNum(raw, 'FontHeight', 0) : undefined,
      },
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return results;
}
