import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDbconnApi } from './api';
import type { ConnectionProfile } from './types';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: '운영 쇼핑몰',
    dialect: 'postgres',
    host: 'db.internal',
    port: 5432,
    database: 'shop',
    user: 'app',
    savePassword: true,
    readOnly: true,
    tls: { enabled: true, rejectUnauthorized: true },
    pool: {
      max: 5,
      min: 0,
      acquireTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxLifetimeMs: 1000,
      leaseTimeoutMs: 1000,
      transactionIdleTimeoutMs: 1000,
    },
    connectTimeoutMs: 1000,
    folder: '운영/서울',
    environment: 'production',
    createdAt: 42,
    ...overrides,
  };
}

function api(profiles: ConnectionProfile[], connected: string[] = []) {
  return createDbconnApi({
    listProfiles: () => profiles,
    isConnected: (id) => connected.includes(id),
    onDidChange: () => ({ dispose: () => {} }),
  });
}

describe('공개 API', () => {
  it('프로필을 계약된 필드만으로 내보낸다', () => {
    assert.deepStrictEqual(api([profile()], ['p1']).getProfiles(), [
      {
        id: 'p1',
        name: '운영 쇼핑몰',
        dialect: 'postgres',
        host: 'db.internal',
        port: 5432,
        database: 'shop',
        user: 'app',
        environment: 'production',
        readOnly: true,
        tlsEnabled: true,
        folder: '운영/서울',
        connected: true,
      },
    ]);
  });

  it('내부 전용 필드는 새어 나가지 않는다', () => {
    const info = api([profile()]).getProfile('p1');
    assert.deepStrictEqual(
      ['savePassword', 'pool', 'tls', 'connectTimeoutMs', 'createdAt', 'password'].filter(
        (key) => info !== undefined && key in info,
      ),
      [],
    );
  });

  it('연결 URL 은 비밀번호 없이 만들어진다', () => {
    assert.equal(
      api([profile()]).getConnectionUrl('p1'),
      'postgresql://app@db.internal:5432/shop?sslmode=verify-full',
    );
  });

  it('없는 id 는 undefined 로 답한다', () => {
    const a = api([profile()]);
    assert.deepStrictEqual([a.getProfile('nope'), a.getConnectionUrl('nope')], [
      undefined,
      undefined,
    ]);
  });
});
