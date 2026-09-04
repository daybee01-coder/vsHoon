import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duplicateName } from './profileNames';

describe('duplicateName', () => {
  it('겹치는 이름이 없으면 꼬리만 붙인다', () => {
    assert.equal(duplicateName('운영 DB', []), '운영 DB (복사본)');
  });

  it('이미 복사본이 있으면 번호를 붙인다', () => {
    assert.equal(duplicateName('운영 DB', ['운영 DB', '운영 DB (복사본)']), '운영 DB (복사본 2)');
    assert.equal(
      duplicateName('운영 DB', ['운영 DB (복사본)', '운영 DB (복사본 2)']),
      '운영 DB (복사본 3)',
    );
  });

  it('비어 있는 번호를 찾아 채운다', () => {
    // (복사본 2) 를 지운 뒤 다시 복사하면 그 자리를 쓴다.
    assert.equal(
      duplicateName('운영 DB', ['운영 DB (복사본)', '운영 DB (복사본 3)']),
      '운영 DB (복사본 2)',
    );
  });

  it('복사본의 복사본이라도 꼬리가 자라지 않는다', () => {
    assert.equal(
      duplicateName('운영 DB (복사본)', ['운영 DB (복사본)']),
      '운영 DB (복사본 2)',
    );
    assert.equal(
      duplicateName('운영 DB (복사본 2)', ['운영 DB (복사본)', '운영 DB (복사본 2)']),
      '운영 DB (복사본 3)',
    );
  });

  it('앞뒤 공백은 정리한다', () => {
    assert.equal(duplicateName('  운영 DB  ', []), '운영 DB (복사본)');
  });

  it('꼬리만 있는 이름은 원본을 잃지 않는다', () => {
    assert.equal(duplicateName('(복사본)', []), '(복사본) (복사본)');
  });
});
