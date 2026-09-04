import type { ConnectionEnvironment, DialectId } from '../types';

/**
 * 방언 아이콘 파일 이름 규칙.
 *
 * 이름을 짓는 쪽(확장)과 파일을 만드는 쪽(scripts/build-icons.js)이 갈라져 있어서,
 * 규칙이 어긋나면 아이콘이 조용히 사라진다 — 오류도 로그도 없이 빈 칸만 남는다.
 * 그래서 규칙을 한 곳에 두고, 테스트가 실제 파일과 대조한다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

export interface DialectIconState {
  connected: boolean;
  environment: ConnectionEnvironment;
}

export const ICON_DIRECTORY = 'resources/dialects';

export function dialectIconFileName(dialect: DialectId, state: DialectIconState): string {
  const suffix = state.environment === 'development' ? '' : `-${state.environment}`;
  return `${dialect}-${state.connected ? 'on' : 'off'}${suffix}.svg`;
}
