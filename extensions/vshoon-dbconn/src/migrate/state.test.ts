import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseExtensionState, parsePasswordSecretKey, type StoredKeys } from './state';

const KEYS: StoredKeys = {
  profiles: 'dbconn.profiles.v1',
  folders: 'dbconn.folders.v1',
  secretPrefix: 'dbconn.password.',
};

const secretKey = (extensionId: string, key: string) =>
  `secret://${JSON.stringify({ extensionId, key })}`;

describe('parseExtensionState', () => {
  it('프로필과 폴더를 뽑아낸다', () => {
    const value = JSON.stringify({
      'dbconn.profiles.v1': [{ id: 'a' }, { id: 'b' }],
      'dbconn.folders.v1': ['운영', 42, '운영/서울'],
      'dbconn.history.v1': [{ sql: 'select 1' }],
    });
    assert.deepStrictEqual(parseExtensionState(value, KEYS), {
      profiles: [{ id: 'a' }, { id: 'b' }],
      folders: ['운영', '운영/서울'],
    });
  });

  it('값이 없거나 깨졌으면 빈 결과를 준다', () => {
    assert.deepStrictEqual(
      [
        parseExtensionState(undefined, KEYS),
        parseExtensionState('', KEYS),
        parseExtensionState('{oops', KEYS),
        parseExtensionState('{"dbconn.profiles.v1":"nope"}', KEYS),
      ],
      [
        { profiles: [], folders: [] },
        { profiles: [], folders: [] },
        { profiles: [], folders: [] },
        { profiles: [], folders: [] },
      ],
    );
  });
});

describe('parsePasswordSecretKey', () => {
  it('같은 확장의 비밀번호 키에서 프로필 id 를 뽑는다', () => {
    const key = secretKey('dbconn.dbconn', 'dbconn.password.9056759b');
    assert.equal(parsePasswordSecretKey(key, 'dbconn.dbconn', KEYS.secretPrefix), '9056759b');
  });

  it('다른 확장·다른 용도·깨진 키는 걸러낸다', () => {
    assert.deepStrictEqual(
      [
        parsePasswordSecretKey(
          secretKey('other.ext', 'dbconn.password.9056759b'),
          'dbconn.dbconn',
          KEYS.secretPrefix,
        ),
        parsePasswordSecretKey(
          secretKey('dbconn.dbconn', 'dbconn.token.9056759b'),
          'dbconn.dbconn',
          KEYS.secretPrefix,
        ),
        parsePasswordSecretKey(
          secretKey('dbconn.dbconn', 'dbconn.password.'),
          'dbconn.dbconn',
          KEYS.secretPrefix,
        ),
        parsePasswordSecretKey('secret://{oops', 'dbconn.dbconn', KEYS.secretPrefix),
        parsePasswordSecretKey('dbconn.profiles.v1', 'dbconn.dbconn', KEYS.secretPrefix),
      ],
      [undefined, undefined, undefined, undefined, undefined],
    );
  });
});
