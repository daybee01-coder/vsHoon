import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  needsQuoting,
  quoteIdentifier,
  quoteIfNeeded,
  quoteQualified,
  UnsafeIdentifierError,
} from './identifier';

/**
 * 식별자 인용은 SQL 을 문자열로 조립하는 모든 지점의 마지막 방어선이다.
 * 여기가 뚫리면 테이블 이름 하나로 임의 SQL 이 실행된다.
 */

describe('quoteIdentifier', () => {
  it('MySQL 은 백틱으로 감싼다', () => {
    assert.equal(quoteIdentifier('users', 'mysql'), '`users`');
    assert.equal(quoteIdentifier('users', 'mariadb'), '`users`');
  });

  it('PostgreSQL / Oracle 은 큰따옴표로 감싼다', () => {
    assert.equal(quoteIdentifier('users', 'postgres'), '"users"');
    assert.equal(quoteIdentifier('USERS', 'oracle'), '"USERS"');
  });

  it('백틱을 배가해서 탈출을 막는다', () => {
    // `t` 안에 백틱이 있어도 인용 경계를 벗어나지 못한다.
    assert.equal(quoteIdentifier('a`b', 'mysql'), '`a``b`');
  });

  it('큰따옴표를 배가해서 탈출을 막는다', () => {
    assert.equal(quoteIdentifier('a"b', 'postgres'), '"a""b"');
  });

  it('인젝션 시도가 하나의 식별자로 봉인된다', () => {
    const evil = 'users`; DROP TABLE t; --';
    const quoted = quoteIdentifier(evil, 'mysql');
    assert.equal(quoted, '`users``; DROP TABLE t; --`');
    // 여는 백틱과 닫는 백틱 사이의 모든 백틱이 배가되어 있어야 한다.
    const inner = quoted.slice(1, -1);
    assert.equal(inner.replace(/``/g, ''), 'users; DROP TABLE t; --');
  });

  it('큰따옴표 방언에서도 같은 시도가 봉인된다', () => {
    const quoted = quoteIdentifier('users"; DROP TABLE t; --', 'postgres');
    assert.equal(quoted, '"users""; DROP TABLE t; --"');
  });

  it('제어 문자가 든 이름은 거부한다', () => {
    assert.throws(() => quoteIdentifier('a\u0000b', 'postgres'), UnsafeIdentifierError);
    assert.throws(() => quoteIdentifier('a\nb', 'postgres'), UnsafeIdentifierError);
  });

  it('빈 이름은 거부한다', () => {
    assert.throws(() => quoteIdentifier('', 'postgres'), UnsafeIdentifierError);
  });

  it('한글 이름도 그대로 인용한다', () => {
    assert.equal(quoteIdentifier('사용자', 'postgres'), '"사용자"');
  });
});

describe('quoteQualified', () => {
  it('스키마와 테이블을 각각 인용한다', () => {
    assert.equal(quoteQualified('public', 'users', 'postgres'), '"public"."users"');
    assert.equal(quoteQualified('db', 'users', 'mysql'), '`db`.`users`');
  });

  it('스키마가 없으면 테이블만 인용한다', () => {
    assert.equal(quoteQualified(undefined, 'users', 'postgres'), '"users"');
  });

  it('스키마 이름의 인용부호도 이스케이프한다', () => {
    assert.equal(quoteQualified('a"b', 'c', 'postgres'), '"a""b"."c"');
  });
});

describe('needsQuoting / quoteIfNeeded', () => {
  it('평범한 소문자 이름은 PostgreSQL 에서 인용이 필요 없다', () => {
    assert.equal(needsQuoting('users', 'postgres'), false);
    assert.equal(quoteIfNeeded('users', 'postgres'), 'users');
  });

  it('PostgreSQL 에서 대문자가 섞이면 인용이 필요하다', () => {
    // 인용하지 않으면 소문자로 접혀 다른 객체를 가리킨다.
    assert.equal(needsQuoting('Users', 'postgres'), true);
    assert.equal(quoteIfNeeded('Users', 'postgres'), '"Users"');
  });

  it('Oracle 에서 소문자가 섞이면 인용이 필요하다', () => {
    assert.equal(needsQuoting('Users', 'oracle'), true);
    assert.equal(needsQuoting('USERS', 'oracle'), false);
  });

  it('예약어는 인용한다', () => {
    assert.equal(needsQuoting('select', 'postgres'), true);
    assert.equal(needsQuoting('order', 'postgres'), true);
  });

  it('특수문자나 공백이 있으면 인용한다', () => {
    assert.equal(needsQuoting('my table', 'postgres'), true);
    assert.equal(needsQuoting('사용자', 'postgres'), true);
  });

  it('숫자로 시작하면 인용한다', () => {
    assert.equal(needsQuoting('1st_col', 'postgres'), true);
  });
});
