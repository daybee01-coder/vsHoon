/**
 * 대상 위치에 이미 같은 이름이 있으면 탐색기처럼 "이름 사본", "이름 사본 2" 식으로
 * 자동으로 겹치지 않는 이름을 만든다. SFTP 파일/폴더 붙여넣기와 세션 복사 양쪽에서 쓴다.
 */
export function pickAvailableName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  let candidate = `${base} 사본${ext}`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${base} 사본 ${n}${ext}`;
    n++;
  }
  return candidate;
}
