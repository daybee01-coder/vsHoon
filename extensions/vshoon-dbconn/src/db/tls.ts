import { readFile } from 'node:fs/promises';
import type { TlsOptions } from '../types';

/**
 * TLS 자료 로딩.
 *
 * 인증서/키 경로는 사용자가 설정한 것이므로 읽기 실패를 조용히 넘기지 않는다.
 * CA 를 지정했는데 못 읽었다면 시스템 신뢰 저장소로 조용히 폴백해서는 안 된다 —
 * 사용자가 의도한 검증 기준이 사라지기 때문이다.
 */

export interface TlsMaterial {
  ca?: string;
  cert?: string;
  key?: string;
}

export class TlsMaterialError extends Error {
  constructor(kind: string, path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${kind} 파일을 읽을 수 없습니다: ${path} (${detail})`);
    this.name = 'TlsMaterialError';
  }
}

export async function readTlsMaterial(options: TlsOptions): Promise<TlsMaterial> {
  const material: TlsMaterial = {};
  if (options.caPath) {
    material.ca = await readPem('CA 인증서', options.caPath);
  }
  if (options.certPath) {
    material.cert = await readPem('클라이언트 인증서', options.certPath);
  }
  if (options.keyPath) {
    material.key = await readPem('클라이언트 키', options.keyPath);
  }
  return material;
}

async function readPem(kind: string, path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new TlsMaterialError(kind, path, error);
  }
}

/**
 * 검증을 끈 TLS 는 평문보다 낫지만 중간자 공격을 막지 못한다.
 * 설정에서 명시적으로 허용한 경우에만 통과시키고, 그 사실을 호출부가 알리게 한다.
 */
export function describeTlsRisk(options: TlsOptions): string | undefined {
  if (!options.enabled) {
    return '이 연결은 TLS 를 사용하지 않습니다. 비밀번호와 쿼리가 평문으로 전송됩니다.';
  }
  if (!options.rejectUnauthorized) {
    return '서버 인증서 검증이 꺼져 있습니다. 중간자 공격을 탐지할 수 없습니다. 사설 CA 를 쓴다면 CA 파일 경로를 지정하세요.';
  }
  return undefined;
}
