/**
 * 저장하기로 한 비밀번호는 확장 자체 세션 저장소에도 넣지 않고 VSCode의 SecretStorage
 * (OS 자격 증명 저장소 - Windows Credential Manager 등)에 세션 id를 키로 별도 보관한다.
 * 이름이 아니라 id를 쓰는 이유: 폴더가 다르면 이름이 같은 세션이 있을 수 있고,
 * 이름/폴더는 언제든 바뀔 수 있지만 id는 세션이 존재하는 한 바뀌지 않는다.
 */
export function passwordSecretKey(sessionId: string): string {
  return `vssh.password.${sessionId}`;
}
