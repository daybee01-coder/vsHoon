/**
 * 저장되는 쿼리 파일의 이름 규칙.
 *
 * 새 SQL 편집기를 이름 없는 문서가 아니라 **실제 파일**로 만들기 때문에,
 * 이름은 사람이 목록에서 훑어 찾을 수 있어야 한다. 그래서 두 가지만 담는다:
 * 어느 연결에서 시작했는지, 언제 만들었는지.
 *
 * 파일 이름은 사용자 입력(연결 이름)에서 나온다. 경로 구분자나 제어 문자가
 * 섞이면 폴더 밖에 쓰게 되므로, 여기가 그 안전 경계다. 지울 것을 나열하는
 * 대신 **남길 것만 허용한다** — 빠뜨린 문자가 그대로 통과하는 쪽이 위험하다.
 *
 * vscode API 를 쓰지 않는다 — 테스트에서 그대로 부를 수 있게.
 */

/** 이름에 넣을 꼬리표의 최대 길이. 너무 길면 목록에서 시각이 잘려 보인다. */
const MAX_LABEL = 32;

/**
 * 연결 이름 등을 파일 이름 조각으로 바꾼다.
 *
 * 글자 · 숫자 · `.` `_` `-` 만 남기고 나머지는 하이픈으로 모은다.
 * 남는 것이 없으면 빈 문자열 — 부르는 쪽이 시각만으로 이름을 만든다.
 */
export function sanitizeLabel(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    // 점·하이픈만 남은 이름(`.`, `..`, `--`)이 되지 않게 앞뒤를 정리한다.
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, MAX_LABEL)
    .replace(/[.-]+$/g, '');
}

/** `2026-08-21_143005` — 정렬하면 시간순이 되도록 큰 단위부터. */
export function timeStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** `주문DB_2026-08-21_143005.sql`. 꼬리표가 없으면 시각만. */
export function queryFileName(now: Date, label?: string): string {
  const tag = label ? sanitizeLabel(label) : '';
  return `${tag ? `${tag}_` : ''}${timeStamp(now)}.sql`;
}

/**
 * 같은 이름이 이미 있으면 번호를 붙인다.
 *
 * 시각이 초 단위라 같은 초에 두 번 만들지 않으면 부딪히지 않는다. 다만
 * 부딪혔을 때 기존 파일을 덮어쓰는 것만은 절대 안 된다 — 거기 사용자의
 * 쿼리가 들어 있다.
 */
export function uniqueFileName(name: string, taken: Iterable<string>): string {
  const existing = new Set([...taken].map((value) => value.toLowerCase()));
  if (!existing.has(name.toLowerCase())) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? '' : name.slice(dot);
  for (let index = 2; index < 1000; index++) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  // 여기까지 올 일은 없지만, 그래도 덮어쓰지는 않는다.
  return `${stem}-${Date.now()}${extension}`;
}

/** 목록에 보여줄 이름 — 확장자는 군더더기다. */
export function queryDisplayName(fileName: string): string {
  return fileName.replace(/\.sql$/i, '');
}
