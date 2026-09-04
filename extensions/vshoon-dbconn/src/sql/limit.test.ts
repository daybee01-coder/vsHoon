import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyRowLimit } from './limit';

/**
 * LIMIT 자동 삽입은 사용자가 쓴 SQL 을 고치는 유일한 지점이다.
 * 의미를 바꿔서는 안 되므로, "확신할 때만 건드린다"는 규칙을 검증한다.
 */

describe('applyRowLimit — 적용하는 경우', () => {
  it('평범한 SELECT 에 LIMIT 을 붙인다', () => {
    const result = applyRowLimit('SELECT * FROM t', 100, 'postgres');
    assert.equal(result.applied, true);
    assert.match(result.sql, /LIMIT 100$/);
  });

  it('MySQL 도 동일하게 붙인다', () => {
    const result = applyRowLimit('SELECT * FROM t', 50, 'mysql');
    assert.equal(result.applied, true);
    assert.match(result.sql, /LIMIT 50$/);
  });

  it('끝의 세미콜론을 제거하고 붙인다', () => {
    const result = applyRowLimit('SELECT * FROM t;', 10, 'postgres');
    assert.equal(result.applied, true);
    assert.doesNotMatch(result.sql, /;/);
    assert.match(result.sql, /LIMIT 10$/);
  });

  it('WITH 로 시작하는 조회에도 붙인다', () => {
    const result = applyRowLimit('WITH x AS (SELECT 1) SELECT * FROM x', 10, 'postgres');
    assert.equal(result.applied, true);
  });

  it('서브쿼리 안의 LIMIT 은 최상위 제한으로 보지 않는다', () => {
    const sql = 'SELECT * FROM (SELECT a FROM t LIMIT 5) s';
    const result = applyRowLimit(sql, 100, 'postgres');
    assert.equal(result.applied, true);
    assert.match(result.sql, /LIMIT 100$/);
  });

  it('소수점 limit 은 정수로 내린다', () => {
    const result = applyRowLimit('SELECT 1', 10.7, 'postgres');
    assert.match(result.sql, /LIMIT 10$/);
  });
});

describe('applyRowLimit — 건드리지 않는 경우', () => {
  const untouched = (sql: string, dialect: 'postgres' | 'mysql' | 'oracle' = 'postgres') => {
    const result = applyRowLimit(sql, 100, dialect);
    assert.equal(result.applied, false, `applied 가 true 였습니다: ${sql}`);
    assert.equal(result.sql, sql, 'SQL 이 변경됐습니다');
  };

  it('이미 LIMIT 이 있으면 그대로 둔다', () => {
    untouched('SELECT * FROM t LIMIT 5');
  });

  it('FETCH FIRST 가 있으면 그대로 둔다', () => {
    untouched('SELECT * FROM t FETCH FIRST 5 ROWS ONLY');
  });

  it('INSERT 는 건드리지 않는다', () => {
    untouched('INSERT INTO t VALUES (1)');
  });

  it('UPDATE 는 건드리지 않는다', () => {
    // UPDATE 에 LIMIT 을 붙이면 갱신 대상이 달라진다 — 절대 안 된다.
    untouched('UPDATE t SET a = 1 WHERE b = 2');
  });

  it('DELETE 는 건드리지 않는다', () => {
    untouched('DELETE FROM t WHERE id = 1');
  });

  it('DDL 은 건드리지 않는다', () => {
    untouched('CREATE TABLE t (a int)');
  });

  it('SELECT ... INTO 는 건드리지 않는다', () => {
    untouched('SELECT a INTO newtable FROM t');
  });

  it('FOR UPDATE 가 붙은 조회는 건드리지 않는다', () => {
    untouched('SELECT * FROM t FOR UPDATE');
  });

  it('Oracle 은 드라이버 maxRows 를 쓰므로 SQL 을 고치지 않는다', () => {
    untouched('SELECT * FROM t', 'oracle');
  });

  it('limit 이 0 이하면 아무것도 하지 않는다', () => {
    const result = applyRowLimit('SELECT 1', 0, 'postgres');
    assert.equal(result.applied, false);
    assert.equal(result.sql, 'SELECT 1');
  });

  it('빈 SQL 에서 터지지 않는다', () => {
    const result = applyRowLimit('   ', 100, 'postgres');
    assert.equal(result.applied, false);
  });

  it('LIMIT 이라는 문자열이 리터럴 안에 있으면 제한으로 보지 않는다', () => {
    const result = applyRowLimit("SELECT 'LIMIT 5' AS x FROM t", 100, 'postgres');
    assert.equal(result.applied, true);
  });
});
