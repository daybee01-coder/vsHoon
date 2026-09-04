import type { ConnectionEnvironment } from '../types';

/**
 * 연결 환경(개발 · 스테이징 · 운영) 표시 규칙.
 *
 * 사고의 대부분은 "운영에 붙어 있는 줄 모르고" 일어난다. 그래서 환경은
 * 프로필의 부가 정보가 아니라 **화면 어디서나 같은 색과 같은 말로** 보여야 한다 —
 * 트리 아이콘, 상태바, 결과 패널, 확인 대화상자가 전부 여기를 거친다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

export const ENVIRONMENTS: ConnectionEnvironment[] = ['development', 'staging', 'production'];

const LABELS: Record<ConnectionEnvironment, string> = {
  development: '개발',
  staging: '스테이징',
  production: '운영',
};

const DESCRIPTIONS: Record<ConnectionEnvironment, string> = {
  development: '경고 표시 없음',
  staging: '노란색으로 구분',
  production: '빨간색 경고 + 변경 구문 실행 전 확인 강화',
};

export function environmentLabel(environment: ConnectionEnvironment): string {
  return LABELS[environment];
}

export function environmentDescription(environment: ConnectionEnvironment): string {
  return DESCRIPTIONS[environment];
}

export function isProduction(environment: ConnectionEnvironment): boolean {
  return environment === 'production';
}

/** 트리·상태바에 붙이는 짧은 꼬리표. 개발 환경은 조용히 둔다. */
export function environmentBadge(environment: ConnectionEnvironment): string | undefined {
  return environment === 'development' ? undefined : LABELS[environment];
}

/**
 * 상태바 배경색 (ThemeColor id).
 *
 * 트리 아이콘의 환경 표시는 ThemeColor 를 쓸 수 없어(SVG 파일이다)
 * `scripts/build-icons.js` 가 같은 의미의 색을 직접 칠한다. 둘을 바꿀 때는 함께 본다.
 * 운영은 오류색을 쓴다 — 눈에 거슬리는 것이 목적이다.
 */
export function environmentStatusBackground(
  environment: ConnectionEnvironment,
): string | undefined {
  switch (environment) {
    case 'production':
      return 'statusBarItem.errorBackground';
    case 'staging':
      return 'statusBarItem.warningBackground';
    default:
      return undefined;
  }
}

/** 저장된 값이나 사용자 입력을 신뢰하지 않고 환경으로 정규화한다. */
export function normalizeEnvironment(raw: unknown): ConnectionEnvironment {
  return raw === 'production' || raw === 'staging' || raw === 'development'
    ? raw
    : 'development';
}
