import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeContext } from './context';

/**
 * 커서 위치를 `|` 로 표시한 SQL 을 받아 분석한다.
 * 테스트를 읽기 쉽게 하려고 쓰는 헬퍼다.
 */
function at(sqlWithCursor: string, dialect: 'postgres' | 'mysql' | 'oracle' = 'postgres') {
  const cursor = sqlWithCursor.indexOf('|');
  assert.notEqual(cursor, -1, '커서 표시(|)가 필요합니다');
  const sql = sqlWithCursor.slice(0, cursor) + sqlWithCursor.slice(cursor + 1);
  return analyzeContext(sql, cursor, dialect);
}

describe('analyzeContext — 접두사와 한정자', () => {
  it('입력 중인 단어를 접두사로 잡는다', () => {
    const ctx = at('SELECT na| FROM users');
    assert.equal(ctx.prefix, 'na');
    assert.deepEqual(ctx.qualifiers, []);
  });

  it('점 뒤에서는 한정자를 인식한다', () => {
    const ctx = at('SELECT u.| FROM users u');
    assert.deepEqual(ctx.qualifiers, ['u']);
    assert.equal(ctx.prefix, '');
  });

  it('점 뒤에 입력 중인 단어도 함께 잡는다', () => {
    const ctx = at('SELECT u.na| FROM users u');
    assert.deepEqual(ctx.qualifiers, ['u']);
    assert.equal(ctx.prefix, 'na');
  });

  it('스키마.테이블. 2단 한정자를 인식한다', () => {
    const ctx = at('SELECT public.users.| FROM public.users');
    assert.deepEqual(ctx.qualifiers, ['public', 'users']);
  });

  it('인용된 한정자의 따옴표를 벗긴다', () => {
    const ctx = at('SELECT "My Table".| FROM x');
    assert.deepEqual(ctx.qualifiers, ['My Table']);
  });

  it('문자열 리터럴 안에서는 제안을 억제한다', () => {
    const ctx = at("SELECT 'abc| def' FROM t");
    assert.equal(ctx.suppressed, true);
  });

  it('주석 안에서는 제안을 억제한다', () => {
    const ctx = at('SELECT 1 -- 여기 comm| 는 주석');
    assert.equal(ctx.suppressed, true);
  });

  it('정상 위치에서는 억제하지 않는다', () => {
    assert.equal(at('SELECT | FROM t').suppressed, false);
  });

  it('replaceStart 가 입력 중인 단어의 시작을 가리킨다', () => {
    const sql = 'SELECT nam FROM t';
    const ctx = analyzeContext(sql, 'SELECT nam'.length, 'postgres');
    assert.equal(ctx.replaceStart, 'SELECT '.length);
  });
});

describe('analyzeContext — 절 판별', () => {
  it('SELECT 절', () => {
    assert.equal(at('SELECT | FROM t').clause, 'select');
  });
  it('FROM 절', () => {
    assert.equal(at('SELECT * FROM |').clause, 'from');
  });
  it('JOIN 절', () => {
    assert.equal(at('SELECT * FROM a JOIN |').clause, 'join');
  });
  it('ON 절', () => {
    assert.equal(at('SELECT * FROM a JOIN b ON |').clause, 'on');
  });
  it('WHERE 절', () => {
    assert.equal(at('SELECT * FROM t WHERE |').clause, 'where');
  });
  it('ORDER BY 절', () => {
    assert.equal(at('SELECT * FROM t ORDER |').clause, 'order-by');
  });
  it('UPDATE ... SET 절', () => {
    assert.equal(at('UPDATE t SET |').clause, 'set');
  });
  it('INSERT INTO 절', () => {
    assert.equal(at('INSERT INTO |').clause, 'insert-into');
  });
});

describe('analyzeContext — 테이블 참조 수집', () => {
  it('FROM 의 테이블과 별칭을 잡는다', () => {
    const ctx = at('SELECT | FROM users u');
    assert.deepEqual(ctx.tables, [{ schema: undefined, name: 'users', alias: 'u' }]);
  });

  it('AS 별칭을 잡는다', () => {
    const ctx = at('SELECT | FROM users AS u');
    assert.equal(ctx.tables[0]!.alias, 'u');
  });

  it('별칭이 없으면 undefined', () => {
    const ctx = at('SELECT | FROM users');
    assert.deepEqual(ctx.tables, [{ schema: undefined, name: 'users', alias: undefined }]);
  });

  it('스키마 한정 테이블을 분해한다', () => {
    const ctx = at('SELECT | FROM public.users u');
    assert.deepEqual(ctx.tables, [{ schema: 'public', name: 'users', alias: 'u' }]);
  });

  it('JOIN 으로 이어진 여러 테이블을 모두 잡는다', () => {
    const ctx = at('SELECT | FROM users u JOIN orders o ON u.id = o.user_id');
    assert.deepEqual(ctx.tables, [
      { schema: undefined, name: 'users', alias: 'u' },
      { schema: undefined, name: 'orders', alias: 'o' },
    ]);
  });

  it('쉼표로 나열한 테이블을 모두 잡는다', () => {
    const ctx = at('SELECT | FROM users u, orders o');
    assert.equal(ctx.tables.length, 2);
    assert.equal(ctx.tables[1]!.name, 'orders');
  });

  it('WHERE 를 별칭으로 오인하지 않는다', () => {
    const ctx = at('SELECT * FROM users WHERE |');
    assert.deepEqual(ctx.tables, [{ schema: undefined, name: 'users', alias: undefined }]);
  });

  it('LEFT JOIN 뒤의 테이블도 잡는다', () => {
    const ctx = at('SELECT | FROM a LEFT JOIN b ON a.id = b.id');
    assert.equal(ctx.tables.length, 2);
    assert.equal(ctx.tables[1]!.name, 'b');
  });

  it('UPDATE 대상 테이블을 잡는다', () => {
    const ctx = at('UPDATE users SET name = | WHERE id = 1');
    assert.equal(ctx.tables[0]!.name, 'users');
  });

  it('INSERT INTO 대상 테이블을 잡는다', () => {
    const ctx = at('INSERT INTO users (|) VALUES (1)');
    assert.equal(ctx.tables[0]!.name, 'users');
  });

  it('서브쿼리는 파고들지 않고 별칭만 취한다', () => {
    const ctx = at('SELECT | FROM (SELECT 1 AS x) sub');
    assert.equal(ctx.tables.length, 1);
    assert.equal(ctx.tables[0]!.alias, 'sub');
    assert.equal(ctx.tables[0]!.name, '');
  });

  it('인용된 테이블명의 따옴표를 벗긴다', () => {
    const ctx = at('SELECT | FROM "My Table" t');
    assert.equal(ctx.tables[0]!.name, 'My Table');
    assert.equal(ctx.tables[0]!.alias, 't');
  });

  it('MySQL 백틱 테이블명도 처리한다', () => {
    const ctx = at('SELECT | FROM `my table` t', 'mysql');
    assert.equal(ctx.tables[0]!.name, 'my table');
  });

  it('커서가 FROM 앞에 있어도 뒤쪽 테이블을 본다', () => {
    // 실제 편집 흐름: FROM 을 먼저 쓰고 SELECT 목록으로 돌아온다.
    const ctx = at('SELECT u.| FROM users u JOIN orders o ON u.id = o.user_id');
    assert.equal(ctx.tables.length, 2);
  });
});
