import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DialectId, EditSource } from '../types';
import type { Driver } from './driver';
import { buildDeleteStatement, buildInsertStatement, buildUpdateStatement } from './rowEditor';

/**
 * 편집 SQL 생성기.
 *
 * 확인해야 할 두 가지:
 *  1) 값이 SQL 문자열에 절대 끼어들지 않는다 (전부 바인드 파라미터)
 *  2) WHERE 가 기본 키 전체로 구성된다 (여러 행에 닿지 않는다)
 */

/** placeholder 만 있으면 되므로 나머지는 최소 구현. */
function fakeDriver(dialect: DialectId): Driver {
  const placeholder = (index: number): string => {
    if (dialect === 'postgres') {
      return `$${index}`;
    }
    if (dialect === 'oracle') {
      return `:${index}`;
    }
    return '?';
  };
  return { placeholder } as unknown as Driver;
}

const singleKey: EditSource = {
  schema: 'public',
  table: 'users',
  keyColumns: [{ name: 'id', index: 0 }],
  editableColumns: [
    { name: 'name', index: 1 },
    { name: 'email', index: 2 },
  ],
};

const compositeKey: EditSource = {
  schema: 'app',
  table: 'memberships',
  keyColumns: [
    { name: 'user_id', index: 0 },
    { name: 'group_id', index: 1 },
  ],
  editableColumns: [{ name: 'role', index: 2 }],
};

describe('buildUpdateStatement', () => {
  it('PostgreSQL 위치 매개변수를 쓴다', () => {
    const s = buildUpdateStatement(
      fakeDriver('postgres'),
      'postgres',
      singleKey,
      1,
      '새이름',
      [7, '옛이름', 'a@b.c'],
    );
    assert.match(s.sql, /UPDATE "public"\."users"/);
    assert.match(s.sql, /SET "name" = \$1/);
    assert.match(s.sql, /WHERE "id" = \$2/);
    assert.deepEqual(s.params, ['새이름', 7]);
  });

  it('MySQL 은 백틱과 ? 를 쓴다', () => {
    const s = buildUpdateStatement(
      fakeDriver('mysql'),
      'mysql',
      singleKey,
      2,
      'x@y.z',
      [7, '이름', 'a@b.c'],
    );
    assert.match(s.sql, /UPDATE `public`\.`users`/);
    assert.match(s.sql, /SET `email` = \?/);
    assert.match(s.sql, /WHERE `id` = \?/);
    assert.deepEqual(s.params, ['x@y.z', 7]);
  });

  it('Oracle 은 :n 바인드를 쓴다', () => {
    const s = buildUpdateStatement(
      fakeDriver('oracle'),
      'oracle',
      singleKey,
      1,
      'N',
      [1, 'O', 'e'],
    );
    assert.match(s.sql, /SET "name" = :1/);
    assert.match(s.sql, /WHERE "id" = :2/);
  });

  it('복합 키는 AND 로 모두 묶는다', () => {
    const s = buildUpdateStatement(
      fakeDriver('postgres'),
      'postgres',
      compositeKey,
      2,
      'admin',
      [10, 20, 'member'],
    );
    assert.match(s.sql, /WHERE "user_id" = \$2/);
    assert.match(s.sql, /AND "group_id" = \$3/);
    assert.deepEqual(s.params, ['admin', 10, 20]);
  });

  it('값에 든 SQL 이 문자열로 조립되지 않는다', () => {
    const evil = "'; DROP TABLE users; --";
    const s = buildUpdateStatement(
      fakeDriver('postgres'),
      'postgres',
      singleKey,
      1,
      evil,
      [1, 'old', 'e'],
    );
    // 생성된 SQL 어디에도 값이 나타나지 않는다.
    assert.ok(!s.sql.includes('DROP'), 'SQL 에 값이 끼어들었습니다');
    assert.equal(s.params[0], evil);
  });

  it('NULL 값도 파라미터로 넘긴다', () => {
    const s = buildUpdateStatement(
      fakeDriver('postgres'),
      'postgres',
      singleKey,
      1,
      null,
      [1, 'old', 'e'],
    );
    assert.match(s.sql, /SET "name" = \$1/);
    assert.equal(s.params[0], null);
    assert.match(s.preview, /= NULL/);
  });

  it('편집 대상이 아닌 컬럼은 거부한다', () => {
    assert.throws(
      () => buildUpdateStatement(fakeDriver('postgres'), 'postgres', singleKey, 0, 'x', [1, 'a', 'b']),
      /수정할 수 없습니다/,
    );
  });

  it('기본 키 값이 NULL 이면 거부한다', () => {
    assert.throws(
      () =>
        buildUpdateStatement(fakeDriver('postgres'), 'postgres', singleKey, 1, 'x', [
          null,
          'a',
          'b',
        ]),
      /NULL/,
    );
  });

  it('식별자에 든 인용부호가 이스케이프된다', () => {
    const nasty: EditSource = {
      schema: 'public',
      table: 'us"ers',
      keyColumns: [{ name: 'id', index: 0 }],
      editableColumns: [{ name: 'na"me', index: 1 }],
    };
    const s = buildUpdateStatement(fakeDriver('postgres'), 'postgres', nasty, 1, 'v', [1, 'x']);
    assert.match(s.sql, /"us""ers"/);
    assert.match(s.sql, /"na""me"/);
  });
});

describe('buildInsertStatement', () => {
  it('값을 채운 컬럼만 구문에 넣는다', () => {
    // 빈 칸까지 NULL 로 밀어 넣으면 NOT NULL 컬럼이 있는 테이블에
    // 아무 행도 추가할 수 없다 — 생략해야 서버 기본값이 채운다.
    const statement = buildInsertStatement(fakeDriver('postgres'), 'postgres', singleKey, [
      { index: 0, value: '7' },
      { index: 1, value: '홍길동' },
    ]);
    assert.equal(
      statement.sql,
      'INSERT INTO "public"."users"\n       ("id", "name")\nVALUES ($1, $2)',
    );
    assert.deepEqual(statement.params, ['7', '홍길동']);
  });

  it('값은 전부 바인드 파라미터로 나간다', () => {
    const statement = buildInsertStatement(fakeDriver('mysql'), 'mysql', singleKey, [
      { index: 1, value: "'); DROP TABLE users; --" },
    ]);
    assert.ok(!statement.sql.includes('DROP TABLE'), '값이 SQL 에 끼어들면 안 된다');
    assert.deepEqual(statement.params, ["'); DROP TABLE users; --"]);

    // MySQL 은 백틱으로 인용한다.
    const bt = String.fromCharCode(96);
    assert.equal(
      statement.sql,
      `INSERT INTO ${bt}public${bt}.${bt}users${bt}\n       (${bt}name${bt})\nVALUES (?)`,
    );
  });

  it('편집 대상이 아닌 컬럼은 거부한다', () => {
    assert.throws(
      () =>
        buildInsertStatement(fakeDriver('postgres'), 'postgres', singleKey, [
          { index: 9, value: 'x' },
        ]),
      /값을 넣을 수 없습니다/,
    );
  });

  it('빈 입력은 거부한다', () => {
    assert.throws(
      () => buildInsertStatement(fakeDriver('postgres'), 'postgres', singleKey, []),
      /입력한 값이 없습니다/,
    );
  });

  it('복합 키도 직접 넣을 수 있다', () => {
    const statement = buildInsertStatement(fakeDriver('oracle'), 'oracle', compositeKey, [
      { index: 0, value: '1' },
      { index: 1, value: '2' },
      { index: 2, value: 'admin' },
    ]);
    assert.match(statement.sql, /VALUES \(:1, :2, :3\)/);
    assert.equal(statement.params.length, 3);
  });
});

describe('buildDeleteStatement', () => {
  it('기본 키로만 WHERE 를 만든다', () => {
    const s = buildDeleteStatement(fakeDriver('postgres'), 'postgres', singleKey, [
      42,
      'name',
      'e',
    ]);
    assert.match(s.sql, /DELETE FROM "public"\."users"/);
    assert.match(s.sql, /WHERE "id" = \$1/);
    assert.deepEqual(s.params, [42]);
  });

  it('복합 키를 모두 포함한다', () => {
    const s = buildDeleteStatement(fakeDriver('mysql'), 'mysql', compositeKey, [1, 2, 'r']);
    assert.match(s.sql, /WHERE `user_id` = \?/);
    assert.match(s.sql, /AND `group_id` = \?/);
    assert.deepEqual(s.params, [1, 2]);
  });

  it('WHERE 없는 DELETE 는 만들어지지 않는다', () => {
    // 기본 키가 비어 있으면 전체 삭제가 되므로 반드시 실패해야 한다.
    const noKey: EditSource = {
      schema: 'public',
      table: 'users',
      keyColumns: [],
      editableColumns: [{ name: 'name', index: 1 }],
    };
    assert.throws(
      () => buildDeleteStatement(fakeDriver('postgres'), 'postgres', noKey, [1, 'a']),
      /기본 키/,
    );
  });
});
