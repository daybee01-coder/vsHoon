import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitStatements, statementAt } from './statements';

/**
 * 문장 분리는 Ctrl+Enter 의 정확성을 결정한다.
 * 여기서 경계를 잘못 잡으면 사용자가 의도하지 않은 SQL 이 실행된다 —
 * 이 확장에서 가장 위험한 실패 유형이다.
 */

describe('splitStatements', () => {
  it('세미콜론으로 단순 분리한다', () => {
    const sql = 'SELECT 1; SELECT 2;';
    const statements = splitStatements(sql, 'postgres');
    assert.deepEqual(
      statements.map((s) => s.text),
      ['SELECT 1', 'SELECT 2'],
    );
  });

  it('마지막 세미콜론이 없어도 문장으로 잡는다', () => {
    const statements = splitStatements('SELECT 1;\nSELECT 2', 'postgres');
    assert.equal(statements.length, 2);
    assert.equal(statements[1]!.text, 'SELECT 2');
  });

  it('문자열 리터럴 안의 세미콜론에서 자르지 않는다', () => {
    const sql = "SELECT 'a;b' AS x; SELECT 2";
    const statements = splitStatements(sql, 'postgres');
    assert.deepEqual(
      statements.map((s) => s.text),
      ["SELECT 'a;b' AS x", 'SELECT 2'],
    );
  });

  it("작은따옴표 이스케이프('')를 문자열 종료로 오인하지 않는다", () => {
    const sql = "SELECT 'it''s; fine' AS x; SELECT 2";
    const statements = splitStatements(sql, 'postgres');
    assert.equal(statements.length, 2);
    assert.equal(statements[0]!.text, "SELECT 'it''s; fine' AS x");
  });

  it('줄 주석 안의 세미콜론을 무시한다', () => {
    const sql = 'SELECT 1 -- 주석; 아님\n; SELECT 2';
    const statements = splitStatements(sql, 'postgres');
    assert.equal(statements.length, 2);
    assert.match(statements[0]!.text, /^SELECT 1/);
  });

  it('블록 주석 안의 세미콜론을 무시한다', () => {
    const sql = 'SELECT /* a; b */ 1; SELECT 2';
    const statements = splitStatements(sql, 'postgres');
    assert.equal(statements.length, 2);
  });

  it('주석만 있는 조각은 문장으로 세지 않는다', () => {
    const statements = splitStatements('-- 그냥 메모\n\n/* 또 메모 */', 'postgres');
    assert.equal(statements.length, 0);
  });

  it('PostgreSQL 달러 인용 블록을 통째로 유지한다', () => {
    const sql = [
      'CREATE FUNCTION f() RETURNS int AS $$',
      'BEGIN',
      '  RETURN 1;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'SELECT f();',
    ].join('\n');
    const statements = splitStatements(sql, 'postgres');
    assert.equal(statements.length, 2);
    assert.match(statements[0]!.text, /LANGUAGE plpgsql$/);
    assert.equal(statements[1]!.text, 'SELECT f()');
  });

  it('태그가 붙은 달러 인용도 처리한다', () => {
    const sql = "SELECT $tag$ a; b $tag$ AS x; SELECT 2";
    const statements = splitStatements(sql, 'postgres');
    assert.equal(statements.length, 2);
  });

  it('MySQL 백틱 식별자 안의 세미콜론을 무시한다', () => {
    const sql = 'SELECT `we;ird` FROM t; SELECT 2';
    const statements = splitStatements(sql, 'mysql');
    assert.equal(statements.length, 2);
    assert.equal(statements[0]!.text, 'SELECT `we;ird` FROM t');
  });

  it('MySQL 해시 주석을 인식한다', () => {
    const sql = 'SELECT 1 # 주석; 아님\n; SELECT 2';
    const statements = splitStatements(sql, 'mysql');
    assert.equal(statements.length, 2);
  });

  it('MySQL 백슬래시 이스케이프를 문자열 종료로 오인하지 않는다', () => {
    const sql = "SELECT '\\'; still string' AS x; SELECT 2";
    const statements = splitStatements(sql, 'mysql');
    assert.equal(statements.length, 2);
  });

  it('Oracle PL/SQL 블록은 단독 / 줄까지를 한 문장으로 본다', () => {
    const sql = [
      'BEGIN',
      "  INSERT INTO t VALUES (1);",
      '  COMMIT;',
      'END;',
      '/',
      'SELECT 1 FROM DUAL;',
    ].join('\n');
    const statements = splitStatements(sql, 'oracle');
    assert.equal(statements.length, 2);
    assert.match(statements[0]!.text, /^BEGIN/);
    assert.match(statements[0]!.text, /END;$/);
    assert.equal(statements[1]!.text, 'SELECT 1 FROM DUAL');
  });

  it('Oracle CREATE OR REPLACE PROCEDURE 도 블록으로 본다', () => {
    const sql = [
      'CREATE OR REPLACE PROCEDURE p AS',
      'BEGIN',
      '  NULL;',
      'END;',
      '/',
      'SELECT 1 FROM DUAL',
    ].join('\n');
    const statements = splitStatements(sql, 'oracle');
    assert.equal(statements.length, 2);
    assert.match(statements[0]!.text, /^CREATE OR REPLACE PROCEDURE/);
  });

  it('MySQL DELIMITER 구간을 하나의 문장으로 넘긴다', () => {
    const sql = [
      'DELIMITER $$',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      'END$$',
      'DELIMITER ;',
    ].join('\n');
    const statements = splitStatements(sql, 'mysql');
    // DELIMITER 자체는 서버로 보내지 않고, 본문만 하나의 문장이 된다.
    assert.equal(statements.length, 1);
    assert.match(statements[0]!.text, /^CREATE PROCEDURE/);
    assert.match(statements[0]!.text, /END$/);
  });

  it('오프셋이 원문 기준으로 정확하다', () => {
    const sql = '  SELECT 1;\n\nSELECT 2';
    const statements = splitStatements(sql, 'postgres');
    assert.equal(sql.slice(statements[0]!.start, statements[0]!.end), 'SELECT 1');
    assert.equal(sql.slice(statements[1]!.start, statements[1]!.end), 'SELECT 2');
  });
});

describe('statementAt', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';

  it('문장 내부의 커서를 그 문장에 매핑한다', () => {
    const at = statementAt(sql, sql.indexOf('SELECT 2') + 3, 'postgres');
    assert.equal(at?.text, 'SELECT 2');
  });

  it('문장 시작 경계도 그 문장으로 본다', () => {
    const at = statementAt(sql, sql.indexOf('SELECT 2'), 'postgres');
    assert.equal(at?.text, 'SELECT 2');
  });

  it('문장 끝(세미콜론 직전)도 그 문장으로 본다', () => {
    const at = statementAt(sql, sql.indexOf('SELECT 2') + 'SELECT 2'.length, 'postgres');
    assert.equal(at?.text, 'SELECT 2');
  });

  it('문장 사이 빈 줄에서는 바로 앞 문장을 고른다', () => {
    const text = 'SELECT 1;\n\n\nSELECT 2;';
    const at = statementAt(text, text.indexOf('\n\n') + 2, 'postgres');
    assert.equal(at?.text, 'SELECT 1');
  });

  it('첫 문장 앞의 커서는 첫 문장을 고른다', () => {
    const text = '\n\nSELECT 1;';
    const at = statementAt(text, 0, 'postgres');
    assert.equal(at?.text, 'SELECT 1');
  });

  it('빈 문서에서는 undefined', () => {
    assert.equal(statementAt('   \n\n', 2, 'postgres'), undefined);
  });
});
