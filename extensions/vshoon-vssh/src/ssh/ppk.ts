import { parseFromFile, PPKError } from 'ppk-to-openssh';
import * as vscode from 'vscode';

/**
 * PuTTY .ppk 키 파일을 OpenSSH 형식 개인키 문자열로 변환한다.
 * ppk-to-openssh는 GPL-3.0이라 이 파일 하나에만 의존을 격리해서, 나중에 자체 파서로
 * 교체하거나(배포 전 라이선스 재검토 필요) 다른 라이브러리로 바꿀 때 이 파일만 손대면 된다.
 */
export async function loadPpkPrivateKey(filePath: string, sessionName: string): Promise<string> {
  try {
    const result = await parseFromFile(filePath);
    return result.privateKey;
  } catch (err) {
    if (!(err instanceof PPKError) || err.code !== 'PASSPHRASE_REQUIRED') {
      throw toFriendlyError(err);
    }
  }

  const passphrase = await vscode.window.showInputBox({
    title: `${sessionName}: PuTTY 키 암호`,
    prompt: `"${filePath}" 키 파일의 암호를 입력하세요`,
    password: true,
    ignoreFocusOut: true,
  });
  if (passphrase === undefined) {
    throw new Error('PuTTY 키 암호 입력이 취소되어 연결을 중단했습니다.');
  }

  try {
    const result = await parseFromFile(filePath, passphrase);
    return result.privateKey;
  } catch (err) {
    throw toFriendlyError(err);
  }
}

function toFriendlyError(err: unknown): Error {
  if (err instanceof PPKError) {
    if (err.code === 'INVALID_MAC') {
      return new Error('PuTTY 키 암호가 올바르지 않거나 파일이 손상되었습니다.');
    }
    return new Error(`PuTTY 키 파일을 읽을 수 없습니다: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
