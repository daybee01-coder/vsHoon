/**
 * 연결 목록의 폴더 경로 유틸리티.
 *
 * 폴더는 별도 엔티티가 아니라 프로필에 붙은 **경로 문자열**이다
 * (`운영/서울`). 트리는 이 경로를 쪼개서 계층을 만든다. 이렇게 하면
 * 폴더 삭제·이름 변경이 문자열 조작으로 끝나고, 프로필과 폴더가
 * 서로 어긋난 상태(고아 폴더 참조)가 생길 수 없다.
 *
 * 여기 함수들은 vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

/** 윈도우 경로에서 흔히 섞여 들어오므로 구분자와 함께 막는다. */
const BACKSLASH = String.fromCharCode(92);

/** 경로 구분자. 세그먼트 안에는 들어갈 수 없다. */
export const FOLDER_SEPARATOR = '/';

/** 지나치게 깊은 트리는 UI 에서 다루기 어렵다. */
const MAX_DEPTH = 8;
const MAX_SEGMENT_LENGTH = 64;

/** 허용되는 최대 깊이 — 이동/생성 전에 확인한다. */
export const MAX_FOLDER_DEPTH = MAX_DEPTH;

/** 제어 문자인지. 트리 라벨과 저장 값에 섞이면 표시가 깨진다. */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

function stripControlChars(text: string): string {
  return Array.from(text)
    .filter((ch) => !isControlChar(ch))
    .join('');
}

/**
 * 저장·비교에 쓸 정규 형태로 만든다.
 * 빈 경로(폴더 없음)는 undefined 로 통일한다 — '' 과 undefined 가
 * 섞이면 "루트에 있음" 판정이 두 갈래로 갈린다.
 */
export function normalizeFolderPath(input: string | undefined | null): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const segments = input
    .split(FOLDER_SEPARATOR)
    .map((segment) => stripControlChars(segment).trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.slice(0, MAX_SEGMENT_LENGTH))
    .slice(0, MAX_DEPTH);
  return segments.length === 0 ? undefined : segments.join(FOLDER_SEPARATOR);
}

/** 폴더 이름(마지막 세그먼트) 하나가 쓸 수 있는 값인지. */
export function validateFolderName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '폴더 이름을 입력하세요.';
  }
  if (trimmed.includes(FOLDER_SEPARATOR) || trimmed.includes(BACKSLASH)) {
    return '폴더 이름에 경로 구분자를 쓸 수 없습니다.';
  }
  if (Array.from(trimmed).some(isControlChar)) {
    return '폴더 이름에 제어 문자를 쓸 수 없습니다.';
  }
  if (trimmed.length > MAX_SEGMENT_LENGTH) {
    return `폴더 이름은 ${MAX_SEGMENT_LENGTH}자 이하여야 합니다.`;
  }
  return undefined;
}

export function folderSegments(path: string): string[] {
  return path.split(FOLDER_SEPARATOR).filter((segment) => segment.length > 0);
}

/** 트리에 표시할 이름 — 마지막 세그먼트. */
export function folderName(path: string): string {
  const segments = folderSegments(path);
  return segments[segments.length - 1] ?? path;
}

/** 상위 폴더 경로. 최상위면 undefined. */
export function parentFolder(path: string): string | undefined {
  const segments = folderSegments(path);
  segments.pop();
  return segments.length === 0 ? undefined : segments.join(FOLDER_SEPARATOR);
}

/** 상위 경로에 이름 하나를 붙인다. */
export function joinFolder(parent: string | undefined, name: string): string | undefined {
  return normalizeFolderPath(parent ? `${parent}${FOLDER_SEPARATOR}${name}` : name);
}

/** 깊이. 최상위 폴더가 1. */
export function folderDepth(path: string): number {
  return folderSegments(path).length;
}

/** `path` 가 `ancestor` 와 같거나 그 아래인지. */
export function isWithinFolder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor + FOLDER_SEPARATOR);
}

/** 자기 자신을 포함한 모든 조상 경로 — 빈 상위 폴더까지 트리에 세울 때 쓴다. */
export function folderChain(path: string): string[] {
  const segments = folderSegments(path);
  const chain: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    chain.push(segments.slice(0, i).join(FOLDER_SEPARATOR));
  }
  return chain;
}

/**
 * `oldRoot` 아래의 경로를 `newRoot` 아래로 옮긴 경로를 만든다.
 * 폴더 이름 변경과 폴더 이동은 같은 연산이므로 하나로 처리한다.
 * `path` 가 `oldRoot` 아래가 아니면 그대로 돌려준다.
 * `newRoot` 가 undefined 면 최상위로 끌어올린다.
 */
export function rerootFolder(
  path: string,
  oldRoot: string,
  newRoot: string | undefined,
): string | undefined {
  if (!isWithinFolder(path, oldRoot)) {
    return path;
  }
  const rest = folderSegments(path.slice(oldRoot.length)).join(FOLDER_SEPARATOR);
  if (newRoot === undefined) {
    return normalizeFolderPath(rest);
  }
  return normalizeFolderPath(rest ? `${newRoot}${FOLDER_SEPARATOR}${rest}` : newRoot);
}

/** 트리 정렬 — 사람이 읽는 순서(로케일 + 숫자 인식). */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
