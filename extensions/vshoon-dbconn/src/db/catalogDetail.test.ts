import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColumnInfo, IndexInfo, ObjectRef } from '../types';
import {
  buildApproximateDdl,
  buildAttributes,
  formatBytes,
  formatCount,
  groupForeignKeyRows,
  groupIndexRows,
  pgReferentialAction,
} from './catalogDetail';

function column(
  name: string,
  typeName: string,
  overrides: Partial<ColumnInfo> = {},
): ColumnInfo {
  return {
    schema: 'public',
    table: 'users',
    name,
    typeName,
    nullable: true,
    isPrimaryKey: false,
    ordinal: 1,
    ...overrides,
  };
}

describe('groupIndexRows', () => {
  it('인덱스별로 컬럼을 순서대로 묶는다', () => {
    const indexes = groupIndexRows('public', 'users', [
      { name: 'users_pkey', unique: true, column: 'id' },
      { name: 'users_name_idx', unique: false, column: 'last_name' },
      { name: 'users_name_idx', unique: false, column: 'first_name' },
    ]);
    assert.equal(indexes.length, 2);
    assert.deepEqual(indexes[0], {
      schema: 'public',
      table: 'users',
      name: 'users_pkey',
      unique: true,
      columns: ['id'],
    });
    assert.deepEqual(
      indexes[1]!.columns,
      ['last_name', 'first_name'],
      '인덱스에서 컬럼 순서는 의미가 있으므로 조회 순서를 보존해야 한다',
    );
  });

  it('컬럼이 비어 있어도 인덱스는 남는다', () => {
    const indexes = groupIndexRows('public', 'users', [
      { name: 'weird_idx', unique: false, column: '' },
    ]);
    assert.deepEqual(indexes[0]!.columns, []);
  });
});

describe('groupForeignKeyRows', () => {
  it('복합 키의 컬럼 짝을 순서대로 유지한다', () => {
    const keys = groupForeignKeyRows([
      {
        name: 'fk_membership',
        schema: 'public',
        table: 'memberships',
        column: 'user_id',
        referencedSchema: 'public',
        referencedTable: 'users',
        referencedColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        name: 'fk_membership',
        schema: 'public',
        table: 'memberships',
        column: 'group_id',
        referencedSchema: 'public',
        referencedTable: 'groups',
        referencedColumn: 'id',
      },
    ]);
    assert.equal(keys.length, 1);
    assert.deepEqual(keys[0]!.columns, ['user_id', 'group_id']);
    assert.deepEqual(keys[0]!.referencedColumns, ['id', 'id']);
    assert.equal(keys[0]!.onDelete, 'CASCADE');
  });

  it('이름이 같아도 출발 테이블이 다르면 따로 묶는다', () => {
    const keys = groupForeignKeyRows([
      {
        name: 'fk_owner',
        schema: 'public',
        table: 'orders',
        column: 'user_id',
        referencedSchema: 'public',
        referencedTable: 'users',
        referencedColumn: 'id',
      },
      {
        name: 'fk_owner',
        schema: 'public',
        table: 'invoices',
        column: 'user_id',
        referencedSchema: 'public',
        referencedTable: 'users',
        referencedColumn: 'id',
      },
    ]);
    assert.equal(keys.length, 2, 'Oracle 처럼 제약 이름이 겹치는 경우를 구분해야 한다');
    assert.deepEqual(keys.map((k) => k.table), ['orders', 'invoices']);
  });
});

describe('pgReferentialAction', () => {
  it('한 글자 코드를 문장으로 바꾼다', () => {
    assert.equal(pgReferentialAction('c'), 'CASCADE');
    assert.equal(pgReferentialAction('n'), 'SET NULL');
    assert.equal(pgReferentialAction('a'), 'NO ACTION');
    assert.equal(pgReferentialAction(null), undefined);
    assert.equal(pgReferentialAction('?'), undefined);
  });
});

describe('buildAttributes', () => {
  it('비어 있는 값은 버린다', () => {
    const attributes = buildAttributes([
      ['엔진', 'InnoDB'],
      ['콜레이션', null],
      ['코멘트', '   '],
      ['순환', false],
    ]);
    assert.deepEqual(attributes, [
      { label: '엔진', value: 'InnoDB' },
      { label: '순환', value: '아니오' },
    ]);
  });
});

describe('숫자 포맷', () => {
  it('바이트를 단위로 줄인다', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
    assert.equal(formatBytes(null), undefined);
    assert.equal(formatBytes('알 수 없음'), undefined);
  });

  it('문자열로 온 숫자도 센다', () => {
    assert.equal(formatCount('12345'), (12345).toLocaleString());
    assert.equal(formatCount(null), undefined);
  });
});

describe('buildApproximateDdl', () => {
  const ref: ObjectRef = { schema: 'public', name: 'users', kind: 'table' };
  const columns: ColumnInfo[] = [
    column('id', 'integer', { nullable: false, isPrimaryKey: true }),
    column('email', 'text', { nullable: false }),
    column('note', 'text', { defaultValue: "'없음'::text" }),
  ];

  it('컬럼과 기본 키로 CREATE TABLE 을 만든다', () => {
    const ddl = buildApproximateDdl(ref, columns, [], 'postgres');
    assert.ok(ddl);
    assert.match(ddl, /CREATE TABLE "public"\."users"/);
    assert.match(ddl, /"id" integer NOT NULL/);
    assert.match(ddl, /"note" text DEFAULT '없음'::text/);
    assert.match(ddl, /PRIMARY KEY \("id"\)/);
  });

  it('기본 키 인덱스는 다시 적지 않는다', () => {
    const indexes: IndexInfo[] = [
      { schema: 'public', table: 'users', name: 'users_pkey', unique: true, columns: ['id'] },
      { schema: 'public', table: 'users', name: 'users_email_idx', unique: true, columns: ['email'] },
    ];
    const ddl = buildApproximateDdl(ref, columns, indexes, 'postgres')!;
    assert.ok(!ddl.includes('users_pkey'), '기본 키 인덱스는 PRIMARY KEY 로 이미 표현된다');
    assert.match(ddl, /CREATE UNIQUE INDEX "users_email_idx" ON "public"\."users" \("email"\);/);
  });

  it('식 인덱스는 인용하지 않는다', () => {
    const indexes: IndexInfo[] = [
      {
        schema: 'public',
        table: 'users',
        name: 'users_lower_idx',
        unique: false,
        columns: ['lower(email)'],
      },
    ];
    const ddl = buildApproximateDdl(ref, columns, indexes, 'postgres')!;
    assert.match(ddl, /\(lower\(email\)\);/);
  });

  it('MySQL 은 백틱으로 인용한다', () => {
    const ddl = buildApproximateDdl(ref, columns, [], 'mysql')!;
    assert.match(ddl, /CREATE TABLE `public`\.`users`/);
  });

  it('컬럼이 없으면 만들지 않는다', () => {
    assert.equal(buildApproximateDdl(ref, [], [], 'postgres'), undefined);
  });
});
