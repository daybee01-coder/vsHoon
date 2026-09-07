/**
 * VS Code SecretStorage 에 저장된 값을 되돌려 읽는다.
 *
 * 저장 경로는 두 겹이다:
 *  1. 확장이 넘긴 문자열을 Electron `safeStorage` 가 AES-256-GCM 으로 암호화한다.
 *     (Chromium os_crypt 형식 — `v10` 접두어 + 12바이트 nonce + 본문 + 16바이트 태그)
 *  2. 그 AES 키는 앱 데이터 폴더의 `Local State` 안에 있고, Windows DPAPI 가
 *     현재 사용자 계정으로 보호한다.
 *
 * 그래서 같은 Windows 사용자로 로그인해 있는 동안에만 풀 수 있다 — 다른 계정이나
 * 다른 기계로 파일만 옮겨서는 읽히지 않는다. 이 파일은 오직 읽기만 하며,
 * 원본 저장소를 건드리지 않는다.
 */

import { execFile } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Chromium os_crypt 버전 접두어. */
const VERSION_PREFIX = /^v1[01]$/;
const VERSION_LENGTH = 3;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const DPAPI_PREFIX = 'DPAPI';
/** PowerShell 스크립트에 값을 넣기 전 확인하는 base64 문자 집합. */
const BASE64_STRICT = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_LOOSE = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * `ItemTable` 에 담긴 secret 값을 바이트로 되돌린다.
 *
 * 버전에 따라 `{"type":"Buffer","data":[…]}` JSON 이거나 base64 문자열이다.
 * 어느 쪽인지 모른 채 하나만 가정하면 조용히 빈 결과가 나오므로 둘 다 받는다.
 */
export function secretValueToBytes(value: unknown): Buffer | undefined {
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; data?: unknown };
      if (parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
        return Buffer.from(parsed.data as number[]);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (BASE64_LOOSE.test(trimmed)) {
    return Buffer.from(trimmed, 'base64');
  }
  return undefined;
}

/**
 * `Local State` 에서 DPAPI 로 보호된 AES 키를 꺼낸다.
 * 아직 풀리지 않은 상태 — 푸는 것은 {@link unprotectDpapi} 가 한다.
 */
export function protectedKeyFromLocalState(json: string): Buffer | undefined {
  let parsed: { os_crypt?: { encrypted_key?: unknown } };
  try {
    parsed = JSON.parse(json) as { os_crypt?: { encrypted_key?: unknown } };
  } catch {
    return undefined;
  }
  const encoded = parsed.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string' || !encoded) {
    return undefined;
  }
  const blob = Buffer.from(encoded, 'base64');
  if (blob.subarray(0, DPAPI_PREFIX.length).toString('latin1') === DPAPI_PREFIX) {
    return blob.subarray(DPAPI_PREFIX.length);
  }
  return blob;
}

/**
 * DPAPI(현재 사용자 범위)로 보호된 값을 푼다.
 *
 * Node 에는 DPAPI 바인딩이 없고, 이 하나 때문에 네이티브 모듈을 들이고 싶지도
 * 않다. Windows 에 항상 있는 PowerShell 의 `ProtectedData` 를 쓴다.
 */
export async function unprotectDpapi(blob: Buffer): Promise<Buffer> {
  const encoded = blob.toString('base64');
  if (!BASE64_STRICT.test(encoded)) {
    // 스크립트에 문자열을 그대로 넣기 때문에, 인용부호를 깨뜨릴 수 있는
    // 문자가 섞여 들어오지 않는지 확인한다.
    throw new Error('보호된 키를 인코딩하지 못했습니다.');
  }
  const script = [
    'Add-Type -AssemblyName System.Security;',
    `$blob=[Convert]::FromBase64String('${encoded}');`,
    '[Convert]::ToBase64String(' +
      "[System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,'CurrentUser'))",
  ].join(' ');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const decoded = Buffer.from(stdout.trim(), 'base64');
  if (decoded.length === 0) {
    throw new Error('DPAPI 복호화가 빈 값을 돌려주었습니다.');
  }
  return decoded;
}

/** safeStorage 가 암호화한 값인지 — 아니면 옛 버전의 DPAPI 단독 암호화다. */
export function isSafeStorageEncrypted(bytes: Buffer): boolean {
  return (
    bytes.length > VERSION_LENGTH + NONCE_LENGTH + TAG_LENGTH &&
    VERSION_PREFIX.test(bytes.subarray(0, VERSION_LENGTH).toString('latin1'))
  );
}

/** safeStorage 값을 원래 문자열로 되돌린다. 키가 틀리면 예외가 난다. */
export function decryptSafeStorage(bytes: Buffer, key: Buffer): string {
  if (!isSafeStorageEncrypted(bytes)) {
    throw new Error('safeStorage 형식이 아닙니다.');
  }
  const nonce = bytes.subarray(VERSION_LENGTH, VERSION_LENGTH + NONCE_LENGTH);
  const body = bytes.subarray(VERSION_LENGTH + NONCE_LENGTH, bytes.length - TAG_LENGTH);
  const tag = bytes.subarray(bytes.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
