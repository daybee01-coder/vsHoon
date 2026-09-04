/**
 * 연결 이름 짓기 규칙.
 *
 * 지금은 복사본 이름 하나뿐이지만 규칙을 따로 둔 이유가 있다: 복사는 연달아
 * 일어나고(붙여넣기를 세 번 누르는 것이 자연스럽다), 그때마다 이름이 겹치거나
 * 꼬리가 자라면 목록에서 무엇이 무엇인지 알 수 없게 된다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

/** 이름 끝에 붙는 복사본 꼬리 — `(복사본)` 또는 `(복사본 3)`. */
const COPY_SUFFIX = /\s*\(복사본(?:\s+\d+)?\)$/;

/**
 * 겹치지 않는 복사본 이름을 만든다.
 *
 * `운영 DB` → `운영 DB (복사본)` → `운영 DB (복사본 2)` → …
 *
 * 복사본을 다시 복사해도 `(복사본) (복사본)` 으로 자라지 않는다. 꼬리를 떼고
 * 다시 붙이므로 언제나 원본 이름 + 번호 하나로 유지된다.
 */
export function duplicateName(original: string, taken: Iterable<string>): string {
  const existing = new Set(taken);
  const base = baseName(original);
  let candidate = `${base} (복사본)`;
  for (let n = 2; existing.has(candidate); n++) {
    candidate = `${base} (복사본 ${n})`;
  }
  return candidate;
}

/** 복사본 꼬리를 떼어 낸 원래 이름. 꼬리만 남는 이름이면 원본을 그대로 둔다. */
function baseName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(COPY_SUFFIX, '').trim();
  return stripped || trimmed;
}
