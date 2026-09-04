import * as vscode from 'vscode';
import type { ConnectionProfile, DialectId } from '../types';
import { dialectIconFileName, ICON_DIRECTORY, type DialectIconState } from './dialectIconName';

/**
 * 방언별 연결 아이콘.
 *
 * 트리와 선택 목록에서 같은 그림을 써야 한다 — 목록에서 고른 것과 트리에 있는 것이
 * 다르게 보이면 어느 연결인지 다시 확인하게 된다.
 *
 * 아이콘 파일은 `scripts/build-icons.js` 가 제품 로고를 합성해 만든다
 * (조합이 24개라 손으로 두면 어긋난다).
 * 여기서는 이름 규칙만 안다: `<방언>-<on|off>[-<환경>].svg`
 */

export function dialectIcon(
  extensionUri: vscode.Uri,
  dialect: DialectId,
  state: DialectIconState,
): vscode.Uri {
  return vscode.Uri.joinPath(
    extensionUri,
    ...ICON_DIRECTORY.split('/'),
    dialectIconFileName(dialect, state),
  );
}

/** 프로필 하나에 대한 아이콘. 연결 여부는 호출부가 알려 준다. */
export function profileIcon(
  extensionUri: vscode.Uri,
  profile: ConnectionProfile,
  connected: boolean,
): vscode.Uri {
  return dialectIcon(extensionUri, profile.dialect, {
    connected,
    environment: profile.environment,
  });
}
