import * as fs from 'fs';
import { ConnectConfig, utils } from 'ssh2';
import * as vscode from 'vscode';
import { passwordSecretKey } from '../sessions/passwordSecrets';
import { SessionProfile } from '../sessions/types';
import { loadPpkPrivateKey } from './ppk';

export async function resolveAuth(
  profile: SessionProfile,
  secrets: vscode.SecretStorage
): Promise<Partial<ConnectConfig>> {
  switch (profile.authMethod) {
    case 'password':
      return resolvePasswordAuth(profile, secrets);
    case 'openssh-key':
      return resolveOpenSshKeyAuth(profile);
    case 'ppk':
      return resolvePpkAuth(profile);
    default:
      throw new Error(`알 수 없는 인증 방식입니다: ${profile.authMethod}`);
  }
}

async function resolvePasswordAuth(
  profile: SessionProfile,
  secrets: vscode.SecretStorage
): Promise<Partial<ConnectConfig>> {
  const saved = await secrets.get(passwordSecretKey(profile.id));
  if (saved !== undefined) {
    return { password: saved };
  }

  const password = await vscode.window.showInputBox({
    title: `${profile.sessionName} 로그인`,
    prompt: `${profile.userName}@${profile.hostName} 비밀번호를 입력하세요`,
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    throw new Error('비밀번호 입력이 취소되어 연결을 중단했습니다.');
  }
  return { password };
}

async function resolveOpenSshKeyAuth(profile: SessionProfile): Promise<Partial<ConnectConfig>> {
  if (!profile.privateKeyPath) {
    throw new Error('개인키 파일 경로가 설정되지 않았습니다.');
  }
  const keyData = await fs.promises.readFile(profile.privateKeyPath);

  // 암호 없이 먼저 파싱해서, 암호가 걸린 키인지 확인한다.
  const unlocked = utils.parseKey(keyData);
  if (!(unlocked instanceof Error)) {
    return { privateKey: keyData };
  }

  const passphrase = await vscode.window.showInputBox({
    title: `${profile.sessionName}: 개인키 암호`,
    prompt: `"${profile.privateKeyPath}" 키의 암호를 입력하세요`,
    password: true,
    ignoreFocusOut: true,
  });
  if (passphrase === undefined) {
    throw new Error('개인키 암호 입력이 취소되어 연결을 중단했습니다.');
  }

  const parsed = utils.parseKey(keyData, passphrase);
  if (parsed instanceof Error) {
    throw new Error(`개인키를 읽을 수 없습니다: ${parsed.message}`);
  }
  return { privateKey: keyData, passphrase };
}

async function resolvePpkAuth(profile: SessionProfile): Promise<Partial<ConnectConfig>> {
  if (!profile.privateKeyPath) {
    throw new Error('PuTTY 키(.ppk) 파일 경로가 설정되지 않았습니다.');
  }
  const privateKey = await loadPpkPrivateKey(profile.privateKeyPath, profile.sessionName);
  return { privateKey };
}
