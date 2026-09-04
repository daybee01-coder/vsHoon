import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CatalogSnapshot, ColumnInfo, ColumnMeta } from '../types';
import { computeEditSource } from './editable';

/**
 * 편집 가능 판정은 "잘못 허용하는 것"이 훨씬 위험하다.
 * 그래서 테스트도 거부해야 하는 경우에 무게를 둔다 —
 * 조인·집계·서브쿼리·뷰·PK 누락에서 하나라도 새면
 * 엉뚱한 행을 고치는 UPDATE 가 만들어진다.
 */

function column(
  table: string,
  name: string,
  ordinal: number,
  isPrimaryKey = false,
): ColumnInfo {
  return {
    schema: 'public',
    table,
    name,
    typeName: 'text',
    nullable: !isPrimaryKey,
    isPrimaryKey,
    ordinal,
  };
}

function meta(names: string[]): ColumnMeta[] {
  return names.map((name, index) => ({ name, typeName: 'text', index }));
}

/** users(id PK, name, email) + orders(id PK, user_id) + v_users 뷰. */
function snapshot(): CatalogSnapshot {
  const users = [
    column('users', 'id', 1, true),
    column('users', 'name', 2),
    column('users', 'email', 3),
  ];
  const orders = [column('orders', 'id', 1, true), column('orders', 'user_id', 2)];
  const logs = [column('logs', 'message', 1)]; // 기본 키 없음
  const composite = [
    column('memberships', 'user_id', 1, true),
    column('memberships', 'group_id', 2, true),
    column('memberships', 'role', 3),
  ];

  return {
    loadedAt: Date.now(),
    defaultSchema: 'public',
    schemas: [{ name: 'public', isDefault: true }],
    tables: [
      { schema: 'public', name: 'users', kind: 'table' },
      { schema: 'public', name: 'orders', kind: 'table' },
      { schema: 'public', name: 'logs', kind: 'table' },
      { schema: 'public', name: 'memberships', kind: 'table' },
      { schema: 'public', name: 'v_users', kind: 'view' },
    ],
    objects: [],
    columnsByTable: new Map([
      ['public.users', users],
      ['public.orders', orders],
      ['public.logs', logs],
      ['public.memberships', composite],
      ['public.v_users', users],
    ]),
  };
}

function run(sql: string, columns: string[], overrides: { readOnly?: boolean } = {}) {
  return computeEditSource({
    sql,
    dialect: 'postgres',
    columns: meta(columns),
    snapshot: snapshot(),
    readOnlyConnection: overrides.readOnly ?? false,
  });
}

describe('computeEditSource — 허용', () => {
  it('단일 테이블 SELECT * 는 편집 가능', () => {
    const result = run('SELECT * FROM users', ['id', 'name', 'email']);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.equal(result.source.table, 'users');
    assert.equal(result.source.schema, 'public');
    assert.deepEqual(result.source.keyColumns, [{ name: 'id', index: 0 }]);
    assert.deepEqual(result.source.editableColumns, [
      { name: 'name', index: 1 },
      { name: 'email', index: 2 },
    ]);
  });

  it('WHERE / ORDER BY 가 있어도 편집 가능', () => {
    const result = run(
      "SELECT id, name FROM users WHERE name LIKE 'a%' ORDER BY name",
      ['id', 'name'],
    );
    assert.equal(result.editable, true);
  });

  it('컬럼 순서가 바뀌어도 인덱스를 올바로 잡는다', () => {
    const result = run('SELECT name, id FROM users', ['name', 'id']);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.deepEqual(result.source.keyColumns, [{ name: 'id', index: 1 }]);
    assert.deepEqual(result.source.editableColumns, [{ name: 'name', index: 0 }]);
  });

  it('복합 기본 키를 모두 WHERE 대상으로 잡는다', () => {
    const result = run('SELECT * FROM memberships', ['user_id', 'group_id', 'role']);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.equal(result.source.keyColumns.length, 2);
    assert.deepEqual(result.source.editableColumns, [{ name: 'role', index: 2 }]);
  });

  it('별칭이 붙어도 편집 가능', () => {
    const result = run('SELECT u.id, u.name FROM users u', ['id', 'name']);
    assert.equal(result.editable, true);
  });

  it('스키마 한정 이름도 편집 가능', () => {
    const result = run('SELECT * FROM public.users', ['id', 'name', 'email']);
    assert.equal(result.editable, true);
  });

  it('컬럼에 별칭이 붙어도 원본 컬럼을 찾아 편집 가능', () => {
    // 드라이버는 별칭(nm)으로 컬럼 이름을 보고하지만, UPDATE 는
    // 실제 컬럼 이름(name)으로 나가야 한다.
    const result = run('SELECT id, name AS nm FROM users', ['id', 'nm']);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.deepEqual(result.source.editableColumns, [{ name: 'name', index: 1 }]);
  });

  it('AS 없는 별칭도 원본 컬럼으로 이어진다', () => {
    const result = run('SELECT id, name nm FROM users', ['id', 'nm']);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.deepEqual(result.source.editableColumns, [{ name: 'name', index: 1 }]);
  });

  it('WHERE 절의 함수는 편집을 막지 않는다', () => {
    const result = run(
      "SELECT id, name FROM users WHERE UPPER(name) = 'A'",
      ['id', 'name'],
    );
    assert.equal(result.editable, true);
  });

  it('가공된 컬럼만 빠지고 나머지는 편집 가능', () => {
    const result = run('SELECT id, name, LOWER(email) AS email_lc FROM users', [
      'id',
      'name',
      'email_lc',
    ]);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.deepEqual(
      result.source.editableColumns,
      [{ name: 'name', index: 1 }],
      '함수를 거친 email_lc 는 편집 대상이 아니다',
    );
  });

  it('별표와 함께 있는 표현식은 이름이 겹쳐도 편집 대상에서 빠진다', () => {
    const result = run("SELECT *, 'x' AS email FROM users", [
      'id',
      'name',
      'email',
      'email',
    ]);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.deepEqual(
      result.source.editableColumns.map((c) => c.name),
      ['name'],
      '중복된 email 은 원본이든 표현식이든 모두 제외된다',
    );
  });
});

describe('computeEditSource — 거부', () => {
  const reject = (sql: string, columns: string[], reason: string) => {
    const result = run(sql, columns);
    assert.equal(result.editable, false, `허용되면 안 됩니다: ${sql}`);
    if (!result.editable) {
      assert.equal(result.reason, reason);
    }
  };

  it('읽기 전용 연결', () => {
    const result = run('SELECT * FROM users', ['id', 'name'], { readOnly: true });
    assert.equal(result.editable, false);
    if (!result.editable) {
      assert.equal(result.reason, 'read-only-connection');
    }
  });

  it('조인이 있으면 거부', () => {
    reject(
      'SELECT u.id, u.name FROM users u JOIN orders o ON u.id = o.user_id',
      ['id', 'name'],
      'not-a-simple-select',
    );
  });

  it('집계가 있으면 거부', () => {
    reject('SELECT COUNT(*) FROM users', ['count'], 'not-a-simple-select');
  });

  it('GROUP BY 가 있으면 거부', () => {
    reject('SELECT name FROM users GROUP BY name', ['name'], 'not-a-simple-select');
  });

  it('DISTINCT 가 있으면 거부', () => {
    reject('SELECT DISTINCT name FROM users', ['name'], 'not-a-simple-select');
  });

  it('UNION 이 있으면 거부', () => {
    reject(
      'SELECT id FROM users UNION SELECT id FROM orders',
      ['id'],
      'not-a-simple-select',
    );
  });

  it('서브쿼리가 있으면 거부', () => {
    reject(
      'SELECT id, name FROM users WHERE id IN (SELECT user_id FROM orders)',
      ['id', 'name'],
      'not-a-simple-select',
    );
  });

  it('윈도 함수(OVER)가 있으면 거부', () => {
    reject(
      'SELECT id, ROW_NUMBER() OVER (ORDER BY id) FROM users',
      ['id', 'rn'],
      'not-a-simple-select',
    );
  });

  it('CTE 가 있으면 거부', () => {
    reject(
      'WITH x AS (SELECT 1) SELECT id FROM users',
      ['id'],
      'not-a-simple-select',
    );
  });

  it('SELECT 가 아니면 거부', () => {
    reject('UPDATE users SET name = 1', ['id'], 'not-a-simple-select');
    reject('INSERT INTO users VALUES (1)', ['id'], 'not-a-simple-select');
  });

  it('뷰는 거부', () => {
    reject('SELECT * FROM v_users', ['id', 'name', 'email'], 'not-a-table');
  });

  it('기본 키가 없는 테이블은 거부', () => {
    reject('SELECT * FROM logs', ['message'], 'no-primary-key');
  });

  it('기본 키가 SELECT 목록에 없으면 거부', () => {
    // WHERE 를 만들 수 없으므로 어느 행인지 특정할 방법이 없다.
    reject('SELECT name, email FROM users', ['name', 'email'], 'primary-key-not-selected');
  });

  it('복합 키 중 하나만 있으면 거부', () => {
    reject('SELECT user_id, role FROM memberships', ['user_id', 'role'], 'primary-key-not-selected');
  });

  it('카탈로그에 없는 테이블은 거부', () => {
    reject('SELECT * FROM unknown_table', ['id'], 'unknown-table');
  });

  it('기본 키 이름이 중복되면 거부', () => {
    reject('SELECT id, id FROM users', ['id', 'id'], 'ambiguous-columns');
  });

  it('수정 가능한 컬럼이 없으면 거부', () => {
    // 기본 키만 조회한 경우 — 고칠 것이 없다.
    reject('SELECT id FROM users', ['id'], 'no-editable-columns');
  });

  it('메타데이터가 없으면 거부', () => {
    const result = computeEditSource({
      sql: 'SELECT * FROM users',
      dialect: 'postgres',
      columns: meta(['id', 'name']),
      snapshot: undefined,
      readOnlyConnection: false,
    });
    assert.equal(result.editable, false);
    if (!result.editable) {
      assert.equal(result.reason, 'no-metadata');
    }
  });

  it('중복된 컬럼만 남으면 편집 대상이 없어 거부된다', () => {
    // id 는 유일해서 키로 쓸 수 있지만, name 이 둘이라 어느 쪽을 고칠지
    // 알 수 없으므로 제외된다 — 남는 편집 대상이 없다.
    reject('SELECT id, name, name FROM users', ['id', 'name', 'name'], 'no-editable-columns');
  });

  it('함수를 거친 값에 원본 컬럼 이름을 별칭으로 붙여도 편집되지 않는다', () => {
    // 이름만 보고 맞추면 UPPER(name) 결과를 name 컬럼으로 착각해
    // 사용자가 화면에서 본 적 없는 값을 그대로 쓰는 UPDATE 가 나간다.
    reject(
      'SELECT id, UPPER(name) AS name FROM users',
      ['id', 'name'],
      'no-editable-columns',
    );
  });

  it('같은 컬럼을 두 번 뽑으면 별칭이 달라도 편집 대상에서 빠진다', () => {
    reject('SELECT id, name, name AS n2 FROM users', ['id', 'name', 'n2'], 'no-editable-columns');
  });

  it('중복 컬럼이 있어도 다른 컬럼은 편집 대상으로 남는다', () => {
    const result = run('SELECT id, name, name, email FROM users', [
      'id',
      'name',
      'name',
      'email',
    ]);
    assert.equal(result.editable, true);
    if (!result.editable) {
      return;
    }
    assert.deepEqual(
      result.source.editableColumns.map((c) => c.name),
      ['email'],
      '중복된 name 은 빠지고 email 만 남아야 한다',
    );
  });
});
