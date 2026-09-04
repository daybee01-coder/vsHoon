import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPagedQuery, hasDuplicateColumnNames, isPageable } from './paging';

describe('isPageable', () => {
  it('평범한 SELECT 는 페이징할 수 있다', () => {
    assert.equal(isPageable('SELECT * FROM users', 'postgres'), true);
    assert.equal(isPageable('SELECT id FROM users ORDER BY id', 'mysql'), true);
    assert.equal(isPageable('WITH x AS (SELECT 1) SELECT * FROM x', 'postgres'), true);
  });

  it('DML/DDL 은 감싸지 않는다', () => {
    assert.equal(isPageable('UPDATE users SET name = 1', 'postgres'), false);
    assert.equal(isPageable('CREATE TABLE t (id int)', 'postgres'), false);
    assert.equal(isPageable('EXPLAIN SELECT 1', 'postgres'), false);
  });

  it('결과를 다른 곳으로 흘리는 SELECT 는 제외한다', () => {
    assert.equal(isPageable('SELECT id INTO temp_users FROM users', 'postgres'), false);
    assert.equal(isPageable('SELECT * FROM users FOR UPDATE', 'postgres'), false);
    assert.equal(isPageable('SELECT * FROM users LOCK IN SHARE MODE', 'mysql'), false);
  });

  it('서브쿼리 안의 INTO 는 최상위가 아니므로 무시한다', () => {
    assert.equal(
      isPageable("SELECT * FROM t WHERE name = (SELECT max(x) FROM y)", 'postgres'),
      true,
    );
  });
});

describe('buildPagedQuery', () => {
  it('LIMIT/OFFSET 으로 감싼다 (MySQL·PostgreSQL)', () => {
    const sql = buildPagedQuery('SELECT * FROM users', 'postgres', { limit: 100, offset: 200 });
    assert.match(sql, /^SELECT \* FROM \(\nSELECT \* FROM users\n\) dbconn_page\nLIMIT 100 OFFSET 200$/);
  });

  it('Oracle 은 OFFSET … FETCH NEXT 를 쓴다', () => {
    const sql = buildPagedQuery('SELECT * FROM users', 'oracle', { limit: 50, offset: 0 });
    assert.match(sql, /OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY$/);
  });

  it('정렬은 컬럼 위치로 건다 (이름 인용 문제를 피한다)', () => {
    const sql = buildPagedQuery('SELECT a, count(*) FROM t GROUP BY a', 'mysql', {
      limit: 10,
      offset: 0,
      orderBy: { index: 1, dir: 'desc' },
    });
    assert.match(sql, /\nORDER BY 2 DESC\nLIMIT 10 OFFSET 0$/);
  });

  it('원본의 세미콜론을 걷어낸다', () => {
    const sql = buildPagedQuery('SELECT 1;  ', 'postgres', { limit: 10, offset: 0 });
    assert.ok(!sql.includes(';'));
  });

  it('정수가 아닌 값은 거부한다', () => {
    assert.throws(() => buildPagedQuery('SELECT 1', 'postgres', { limit: 0, offset: 0 }));
    assert.throws(() => buildPagedQuery('SELECT 1', 'postgres', { limit: 10, offset: -1 }));
    assert.throws(() =>
      buildPagedQuery('SELECT 1', 'postgres', { limit: Number.NaN, offset: 0 }),
    );
  });
});

describe('hasDuplicateColumnNames', () => {
  it('대소문자를 무시하고 중복을 잡는다', () => {
    assert.equal(hasDuplicateColumnNames(['id', 'name']), false);
    assert.equal(hasDuplicateColumnNames(['id', 'ID']), true);
  });
});
