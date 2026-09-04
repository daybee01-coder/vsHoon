import { Client, ConnectConfig } from 'ssh2';
import * as vscode from 'vscode';
import { SessionProfile } from '../sessions/types';
import { resolveAuth } from './auth';
import { HostKeyStore } from './hostKeyStore';

export interface Connection {
  client: Client;
  profile: SessionProfile;
}

export async function connect(
  profile: SessionProfile,
  hostKeyStore: HostKeyStore,
  secrets: vscode.SecretStorage,
  passwordOverride?: string
): Promise<Connection> {
  const authConfig = passwordOverride === undefined ? await resolveAuth(profile, secrets) : { password: passwordOverride };
  const client = new Client();

  const config: ConnectConfig = {
    host: profile.hostName,
    port: profile.portNumber || 22,
    username: profile.userName,
    readyTimeout: 20000,
    ...authConfig,
    hostVerifier: ((key: Buffer, callback: (valid: boolean) => void) => {
      hostKeyStore.verify(profile.hostName, profile.portNumber || 22, key).then(callback);
    }) as unknown as ConnectConfig['hostVerifier'],
  };

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err: Error) => reject(err));
    client.connect(config);
  });

  return { client, profile };
}
