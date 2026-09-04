import type { ConnectionProfile, ConnectionProfileDraft } from '../types';
import { getDriver } from './registry';
import { log } from '../util/logger';

/**
 * 저장하기 전에 실제로 접속해 본다.
 *
 * 풀을 쓰지 않고 드라이버로 커넥션 하나를 직접 열었다가 닫는다 —
 * 테스트가 세션이나 풀 상태에 흔적을 남기면 안 되기 때문이다.
 * 성공하든 실패하든 커넥션은 반드시 닫는다.
 *
 * 비밀번호는 이 호출 동안에만 인자로 존재하고 어디에도 보관되지 않는다.
 */

export interface ConnectionTestResult {
  ok: boolean;
  /** 사용자에게 그대로 보여줄 한 줄 설명. */
  message: string;
  elapsedMs: number;
}

export async function testConnection(
  draft: ConnectionProfileDraft,
  password: string | undefined,
  timeoutMs: number,
): Promise<ConnectionTestResult> {
  // 드라이버는 완성된 프로필을 요구하지만, 저장하지 않을 임시 값이다.
  const profile: ConnectionProfile = {
    ...draft,
    id: 'connection-test',
    createdAt: Date.now(),
  };

  const driver = getDriver(profile.dialect);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  const startedAt = Date.now();

  let connection: Awaited<ReturnType<typeof driver.connect>> | undefined;
  try {
    connection = await driver.connect(profile, password, controller.signal);
    // 연결만 되고 실제 통신이 안 되는 경우가 있어 가벼운 핑까지 확인한다.
    const alive = await connection.validate();
    const elapsedMs = Date.now() - startedAt;
    return alive
      ? { ok: true, message: `연결에 성공했습니다 (${elapsedMs.toLocaleString()}ms).`, elapsedMs }
      : {
          ok: false,
          message: '연결은 열렸지만 응답하지 않습니다. 서버 상태를 확인하세요.',
          elapsedMs,
        };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    log.debug('연결 테스트 실패', error);
    return { ok: false, message: describe(error, controller.signal.aborted), elapsedMs };
  } finally {
    clearTimeout(timer);
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        log.debug('테스트 커넥션 종료 실패 (무시)', error);
      }
    }
  }
}

function describe(error: unknown, aborted: boolean): string {
  if (aborted) {
    return '제한 시간 안에 응답하지 않았습니다. 호스트·포트·방화벽을 확인하세요.';
  }
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n')[0] ?? message;
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}
