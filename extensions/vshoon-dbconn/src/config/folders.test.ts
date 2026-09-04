import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  folderChain,
  folderDepth,
  folderName,
  isWithinFolder,
  joinFolder,
  normalizeFolderPath,
  parentFolder,
  rerootFolder,
  validateFolderName,
} from './folders';

/** 리터럴로 적으면 편집기에서 보이지 않으므로 코드로 만든다. */
const CONTROL = String.fromCharCode(1);

describe('normalizeFolderPath', () => {
  it('빈 값은 undefined 로 통일한다', () => {
    assert.equal(normalizeFolderPath(undefined), undefined);
    assert.equal(normalizeFolderPath(''), undefined);
    assert.equal(normalizeFolderPath('   '), undefined);
    assert.equal(normalizeFolderPath('///'), undefined);
  });

  it('앞뒤 구분자와 중복 구분자를 정리한다', () => {
    assert.equal(normalizeFolderPath('/운영/'), '운영');
    assert.equal(normalizeFolderPath('운영//서울'), '운영/서울');
    assert.equal(normalizeFolderPath(' 운영 / 서울 '), '운영/서울');
  });

  it('제어 문자를 제거한다', () => {
    assert.equal(normalizeFolderPath(`운${CONTROL}영/서울`), '운영/서울');
  });

  it('깊이를 8단계로 제한한다', () => {
    const deep = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('/');
    assert.equal(folderDepth(normalizeFolderPath(deep)!), 8);
  });
});

describe('validateFolderName', () => {
  it('빈 이름과 구분자를 거부한다', () => {
    assert.ok(validateFolderName(''));
    assert.ok(validateFolderName('운영/서울'));
    assert.ok(validateFolderName('운영' + String.fromCharCode(92) + '서울'));
    assert.ok(validateFolderName(`운영${CONTROL}`));
  });

  it('평범한 이름은 통과한다', () => {
    assert.equal(validateFolderName('운영 DB'), undefined);
  });
});

describe('경로 조작', () => {
  it('이름과 상위 경로', () => {
    assert.equal(folderName('운영/서울'), '서울');
    assert.equal(parentFolder('운영/서울'), '운영');
    assert.equal(parentFolder('운영'), undefined);
  });

  it('joinFolder 는 상위가 없으면 최상위 폴더를 만든다', () => {
    assert.equal(joinFolder(undefined, '운영'), '운영');
    assert.equal(joinFolder('운영', '서울'), '운영/서울');
  });

  it('folderChain 은 조상을 모두 낸다', () => {
    assert.deepEqual(folderChain('a/b/c'), ['a', 'a/b', 'a/b/c']);
  });

  it('isWithinFolder 는 이름이 겹치는 형제를 자식으로 보지 않는다', () => {
    assert.equal(isWithinFolder('운영/서울', '운영'), true);
    assert.equal(isWithinFolder('운영', '운영'), true);
    assert.equal(isWithinFolder('운영2/서울', '운영'), false);
  });
});

describe('rerootFolder', () => {
  it('폴더 이름 변경은 하위 경로까지 따라간다', () => {
    assert.equal(rerootFolder('운영/서울', '운영', '운영계'), '운영계/서울');
    assert.equal(rerootFolder('운영', '운영', '운영계'), '운영계');
  });

  it('다른 폴더로 옮긴다', () => {
    assert.equal(rerootFolder('운영/서울', '운영', '아시아/운영'), '아시아/운영/서울');
  });

  it('최상위로 끌어올린다', () => {
    assert.equal(rerootFolder('운영/서울', '운영', undefined), '서울');
    assert.equal(rerootFolder('운영', '운영', undefined), undefined);
  });

  it('대상 밖의 경로는 건드리지 않는다', () => {
    assert.equal(rerootFolder('개발/서울', '운영', '운영계'), '개발/서울');
    assert.equal(rerootFolder('운영2', '운영', '운영계'), '운영2');
  });
});
