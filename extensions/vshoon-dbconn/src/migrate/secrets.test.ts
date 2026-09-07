import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  decryptSafeStorage,
  isSafeStorageEncrypted,
  protectedKeyFromLocalState,
  secretValueToBytes,
} from './secrets';

/** safeStorage 가 만드는 것과 같은 모양의 값을 만든다 — v10 + nonce + 본문 + 태그. */
function encrypt(plaintext: string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, body, cipher.getAuthTag()]);
}

describe('secretValueToBytes', () => {
  it('버전에 따라 달라지는 저장 형태를 모두 받는다', () => {
    const bytes = Buffer.from([1, 2, 3]);
    assert.deepStrictEqual(
      [
        secretValueToBytes(JSON.stringify({ type: 'Buffer', data: [1, 2, 3] })),
        secretValueToBytes(bytes.toString('base64')),
        secretValueToBytes(new Uint8Array([1, 2, 3])),
      ],
      [bytes, bytes, bytes],
    );
  });

  it('알 수 없는 값은 무시한다', () => {
    assert.deepStrictEqual(
      [
        secretValueToBytes(undefined),
        secretValueToBytes(''),
        secretValueToBytes('{oops'),
        secretValueToBytes('{"type":"Other"}'),
        secretValueToBytes(42),
      ],
      [undefined, undefined, undefined, undefined, undefined],
    );
  });
});

describe('protectedKeyFromLocalState', () => {
  it('DPAPI 접두어를 떼고 보호된 키만 준다', () => {
    const blob = Buffer.concat([Buffer.from('DPAPI', 'latin1'), Buffer.from([9, 8, 7])]);
    const json = JSON.stringify({ os_crypt: { encrypted_key: blob.toString('base64') } });
    assert.deepStrictEqual(protectedKeyFromLocalState(json), Buffer.from([9, 8, 7]));
  });

  it('키가 없거나 깨졌으면 undefined', () => {
    assert.deepStrictEqual(
      [
        protectedKeyFromLocalState('{oops'),
        protectedKeyFromLocalState('{}'),
        protectedKeyFromLocalState('{"os_crypt":{}}'),
      ],
      [undefined, undefined, undefined],
    );
  });
});

describe('decryptSafeStorage', () => {
  it('safeStorage 형식을 원래 문자열로 되돌린다', () => {
    const key = randomBytes(32);
    const encrypted = encrypt('비밀번호 p@ss:w/rd', key);
    assert.deepStrictEqual(
      [isSafeStorageEncrypted(encrypted), decryptSafeStorage(encrypted, key)],
      [true, '비밀번호 p@ss:w/rd'],
    );
  });

  it('키가 틀리면 조용히 넘어가지 않고 예외가 난다', () => {
    const encrypted = encrypt('secret', randomBytes(32));
    assert.throws(() => decryptSafeStorage(encrypted, randomBytes(32)));
  });

  it('safeStorage 형식이 아니면 형식임을 주장하지 않는다', () => {
    const legacy = Buffer.from('01000000d08c9ddf', 'hex');
    assert.deepStrictEqual(
      [isSafeStorageEncrypted(legacy), isSafeStorageEncrypted(Buffer.from('v10', 'latin1'))],
      [false, false],
    );
  });
});
