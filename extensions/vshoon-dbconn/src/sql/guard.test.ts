import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeStatement,
  assertAllowedInReadOnly,
  ReadOnlyViolationError,
  targetObjectName,
} from './guard';

/**
 * 구문 분류가 틀리면 두 가지 사고가 난다:
 *  - 읽기 전용 연결에서 쓰기 구문이 통과한다
 *  - WHERE 없는 DELETE 가 확인 없이 실행된다
 * 둘 다 복구가 어려우므로 경계 사례를 촘촘히 잡아 둔다.
 */

describe('analyzeStatement — 분류', () => {
  const cases: Array<[string, string, boolean, boolean]> = [
    // [sql, category, mutates, producesRows]
    ['SELECT * FROM t', 'select', false, true],
    ['  select 1', 'select', false, true],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'select', false, true],
    ['VALUES (1), (2)', 'select', false, true],
    ['INSERT INTO t VALUES (1)', 'dml', true, false],
    ['UPDATE t SET a = 1 WHERE id = 2', 'dml', true, false],
    ['DELETE FROM t WHERE id = 1', 'dml', true, false],
    ['MERGE INTO t USING s ON (1=1)', 'dml', true, false],
    ['CREATE TABLE t (a int)', 'ddl', true, false],
    ['DROP TABLE t', 'ddl', true, false],
    ['TRUNCATE TABLE t', 'ddl', true, false],
    ['ALTER TABLE t ADD COLUMN b int', 'ddl', true, false],
    ['GRANT SELECT ON t TO u', 'dcl', true, false],
    ['COMMIT', 'tcl', false, false],
    ['ROLLBACK', 'tcl', false, false],
    ['BEGIN TRANSACTION', 'tcl', false, false],
    ['EXPLAIN SELECT 1', 'utility', false, true],
    ['SHOW TABLES', 'utility', false, true],
    ['SET search_path = x', 'utility', false, false],
  ];

  for (const [sql, category, mutates, producesRows] of cases) {
    it(`${sql} → ${category}`, () => {
      const analysis = analyzeStatement(sql, 'postgres');
      assert.equal(analysis.category, category, 'category');
      assert.equal(analysis.mutates, mutates, 'mutates');
      assert.equal(analysis.producesRows, producesRows, 'producesRows');
    });
  }

  it('데이터 변경 CTE 는 SELECT 가 아니라 DML 로 본다', () => {
    const sql = 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d';
    const analysis = analyzeStatement(sql, 'postgres');
    assert.equal(analysis.category, 'dml');
    assert.equal(analysis.mutates, true);
  });

  it('익명 PL/SQL 블록의 BEGIN 은 트랜잭션 제어가 아니다', () => {
    const analysis = analyzeStatement('BEGIN NULL; END;', 'oracle');
    assert.equal(analysis.category, 'utility');
  });

  it('RETURNING 이 있는 DML 은 결과 집합을 만든다', () => {
    const analysis = analyzeStatement('INSERT INTO t VALUES (1) RETURNING id', 'postgres');
    assert.equal(analysis.producesRows, true);
    assert.equal(analysis.mutates, true);
  });

  it('빈 입력에서 터지지 않는다', () => {
    const analysis = analyzeStatement('   \n  ', 'postgres');
    assert.equal(analysis.category, 'unknown');
    assert.equal(analysis.mutates, false);
  });
});

describe('analyzeStatement — 위험도', () => {
  it('WHERE 없는 DELETE 는 high', () => {
    const analysis = analyzeStatement('DELETE FROM users', 'postgres');
    assert.equal(analysis.risk, 'high');
    assert.match(analysis.reasons.join(' '), /WHERE/);
  });

  it('WHERE 없는 UPDATE 는 high', () => {
    assert.equal(analyzeStatement('UPDATE users SET active = false', 'postgres').risk, 'high');
  });

  it('WHERE 가 있으면 elevated 로 낮춘다', () => {
    assert.equal(analyzeStatement('DELETE FROM users WHERE id = 1', 'postgres').risk, 'elevated');
  });

  it('서브쿼리 안의 WHERE 는 최상위 WHERE 로 세지 않는다', () => {
    const sql = 'DELETE FROM users u USING (SELECT id FROM x WHERE y = 1) s';
    assert.equal(analyzeStatement(sql, 'postgres').risk, 'high');
  });

  it('DROP / TRUNCATE 는 high', () => {
    assert.equal(analyzeStatement('DROP TABLE users', 'postgres').risk, 'high');
    assert.equal(analyzeStatement('TRUNCATE TABLE users', 'postgres').risk, 'high');
  });

  it('SELECT 는 위험하지 않다', () => {
    assert.equal(analyzeStatement('SELECT * FROM users', 'postgres').risk, 'none');
  });
});

describe('assertAllowedInReadOnly', () => {
  it('SELECT 는 통과한다', () => {
    assert.doesNotThrow(() =>
      assertAllowedInReadOnly(analyzeStatement('SELECT 1', 'postgres')),
    );
  });

  it('COMMIT 같은 트랜잭션 제어도 통과한다', () => {
    assert.doesNotThrow(() =>
      assertAllowedInReadOnly(analyzeStatement('COMMIT', 'postgres')),
    );
  });

  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'TRUNCATE TABLE t',
    'CREATE TABLE t (a int)',
    'GRANT ALL ON t TO u',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
  ]) {
    it(`차단: ${sql}`, () => {
      assert.throws(
        () => assertAllowedInReadOnly(analyzeStatement(sql, 'postgres')),
        ReadOnlyViolationError,
      );
    });
  }
});

/**
 * 운영 연결에서는 이 이름을 사용자가 직접 입력해야 실행된다.
 * 엉뚱한 이름을 돌려주면 확인 절차가 무의미해지므로 구문별로 확인한다.
 */
describe('targetObjectName', () => {
  const target = (sql: string, dialect: 'postgres' | 'mysql' | 'oracle' = 'postgres') =>
    targetObjectName(sql, dialect);

  it('DML 의 대상 테이블을 찾는다', () => {
    assert.equal(target('UPDATE users SET name = 1 WHERE id = 2'), 'users');
    assert.equal(target('DELETE FROM orders WHERE id = 1'), 'orders');
    assert.equal(target('INSERT INTO logs (a) VALUES (1)'), 'logs');
    assert.equal(target('MERGE INTO targets t USING src s ON (1=1)'), 'targets');
  });

  it('DDL 의 수식어를 건너뛴다', () => {
    assert.equal(target('DROP TABLE IF EXISTS users'), 'users');
    assert.equal(target('TRUNCATE TABLE users'), 'users');
    assert.equal(target('ALTER TABLE users ADD COLUMN x int'), 'users');
    assert.equal(target('DROP MATERIALIZED VIEW sales_mv'), 'sales_mv');
    assert.equal(target('CREATE OR REPLACE VIEW v_users AS SELECT 1'), 'v_users');
  });

  it('한정 이름은 마지막 조각을 쓴다 (사용자가 실제로 타이핑할 이름)', () => {
    assert.equal(target('DELETE FROM public.orders'), 'orders');
    assert.equal(target('UPDATE "public"."users" SET a = 1'), 'users');
    assert.equal(target('UPDATE `shop`.`users` SET a = 1', 'mysql'), 'users');
  });

  it('대상을 알 수 없으면 undefined', () => {
    assert.equal(target('SELECT * FROM users'), undefined);
    assert.equal(target('COMMIT'), undefined);
    assert.equal(target(''), undefined);
  });
});
