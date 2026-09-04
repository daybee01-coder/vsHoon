import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatConnectionUrl, parseConnectionUrl } from './connectionUrl';

/** 성공을 기대하는 파싱 — 실패하면 그 자리에서 이유와 함께 죽는다. */
function parse(url: string) {
  const result = parseConnectionUrl(url);
  assert.ok(result.ok, `파싱 실패: ${result.ok ? '' : result.error}`);
  return result.value;
}

describe('parseConnectionUrl', () => {
  it('기본 URL 을 칸으로 나눈다', () => {
    const value = parse('mysql://app:secret@db.example.com:3307/orders');
    assert.equal(value.dialect, 'mysql');
    assert.equal(value.host, 'db.example.com');
    assert.equal(value.port, 3307);
    assert.equal(value.database, 'orders');
    assert.equal(value.user, 'app');
    assert.equal(value.password, 'secret');
  });

  it('포트를 생략하면 방언 기본 포트를 쓴다', () => {
    assert.equal(parse('postgresql://app@localhost/orders').port, 5432);
    assert.equal(parse('mariadb://app@localhost/orders').port, 3306);
    assert.equal(parse('oracle://system@localhost/XEPDB1').port, 1521);
  });

  it('postgres · postgresql · pgsql 을 모두 받는다', () => {
    for (const scheme of ['postgres', 'postgresql', 'pgsql']) {
      assert.equal(parse(`${scheme}://h/db`).dialect, 'postgres');
    }
  });

  it('퍼센트 인코딩된 자격 증명을 풀어 준다', () => {
    const value = parse('mysql://ap%40p:p%40ss%3Aword@h:3306/db');
    assert.equal(value.user, 'ap@p');
    assert.equal(value.password, 'p@ss:word');
  });

  it('IPv6 호스트에서 대괄호를 벗긴다', () => {
    assert.equal(parse('postgresql://app@[::1]:5432/db').host, '::1');
  });

  it('질의 문자열의 user · password 도 읽는다', () => {
    const value = parse('jdbc:mariadb://h:3306/db?user=app&password=secret');
    assert.equal(value.dialect, 'mariadb');
    assert.equal(value.user, 'app');
    assert.equal(value.password, 'secret');
  });

  it('sslmode 를 TLS 설정으로 옮긴다', () => {
    // require 는 암호화만 요구한다 — 검증은 켜지 않는다.
    const required = parse('postgresql://app@h/db?sslmode=require');
    assert.equal(required.tlsEnabled, true);
    assert.equal(required.tlsVerify, false);

    const verified = parse('postgresql://app@h/db?sslmode=verify-full');
    assert.equal(verified.tlsEnabled, true);
    assert.equal(verified.tlsVerify, true);

    const off = parse('postgresql://app@h/db?sslmode=disable');
    assert.equal(off.tlsEnabled, false);
  });

  it('ssl=true 는 검증까지 켠 TLS 로 본다', () => {
    const value = parse('mysql://app@h/db?ssl=true');
    assert.equal(value.tlsEnabled, true);
    assert.equal(value.tlsVerify, true);
  });

  it('TLS 를 말하지 않는 URL 은 TLS 설정을 건드리지 않는다', () => {
    const value = parse('mysql://app@h/db');
    assert.equal(value.tlsEnabled, undefined);
    assert.equal(value.tlsVerify, undefined);
  });

  it('모르는 파라미터는 버리되 이름을 남긴다', () => {
    const value = parse('mysql://app@h/db?serverTimezone=UTC&ssl=true&charset=utf8');
    assert.deepEqual(value.ignoredParams, ['serverTimezone', 'charset']);
  });

  it('Oracle 은 기본이 서비스 이름이고 connectType 으로 SID 가 된다', () => {
    assert.equal(parse('oracle://system@h:1521/XEPDB1').oracleConnectType, 'service');
    assert.equal(parse('oracle://system@h:1521/XE?connectType=sid').oracleConnectType, 'sid');
  });

  it('Oracle JDBC 의 서비스 이름 형태를 읽는다', () => {
    const value = parse('jdbc:oracle:thin:@//ora.example.com:1522/XEPDB1');
    assert.equal(value.dialect, 'oracle');
    assert.equal(value.host, 'ora.example.com');
    assert.equal(value.port, 1522);
    assert.equal(value.database, 'XEPDB1');
    assert.equal(value.oracleConnectType, 'service');
  });

  it('Oracle JDBC 의 SID 형태를 읽는다', () => {
    const value = parse('jdbc:oracle:thin:@ora.example.com:1521:XE');
    assert.equal(value.host, 'ora.example.com');
    assert.equal(value.port, 1521);
    assert.equal(value.database, 'XE');
    assert.equal(value.oracleConnectType, 'sid');
  });

  it('Oracle JDBC 앞에 붙은 user/password 를 읽는다', () => {
    const value = parse('jdbc:oracle:thin:system/manager@//h:1521/XEPDB1');
    assert.equal(value.user, 'system');
    assert.equal(value.password, 'manager');
  });

  it('jdbc: 접두어가 붙은 일반 URL 도 받는다', () => {
    assert.equal(parse('jdbc:postgresql://h:5432/db').dialect, 'postgres');
  });

  it('모르는 스킴과 빈 값은 이유를 붙여 거절한다', () => {
    for (const bad of ['', '   ', 'sqlserver://h/db', 'db.example.com:3306/orders']) {
      const result = parseConnectionUrl(bad);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.error.length > 0);
    }
  });

  it('포트가 범위를 벗어나면 거절한다', () => {
    // WHATWG URL 이 먼저 거르는 값도 있으므로 메시지가 아니라 실패만 본다.
    assert.equal(parseConnectionUrl('mysql://h:0/db').ok, false);
    assert.equal(parseConnectionUrl('jdbc:oracle:thin:@h:99999:XE').ok, false);
  });
});

describe('formatConnectionUrl', () => {
  it('비밀번호 없이 조립한다', () => {
    assert.equal(
      formatConnectionUrl({
        dialect: 'postgres',
        host: 'db.example.com',
        port: 5432,
        database: 'orders',
        user: 'app',
      }),
      'postgresql://app@db.example.com:5432/orders',
    );
  });

  it('TLS 와 Oracle SID 를 파라미터로 남긴다', () => {
    assert.equal(
      formatConnectionUrl({
        dialect: 'oracle',
        host: 'h',
        port: 1521,
        database: 'XE',
        user: 'system',
        tlsEnabled: true,
        tlsVerify: false,
        oracleConnectType: 'sid',
      }),
      'oracle://system@h:1521/XE?sslmode=require&connectType=sid',
    );
  });

  it('IPv6 호스트를 대괄호로 감싼다', () => {
    assert.equal(
      formatConnectionUrl({ dialect: 'mysql', host: '::1', port: 3306, database: 'db', user: 'root' }),
      'mysql://root@[::1]:3306/db',
    );
  });

  it('조립한 URL 을 다시 파싱하면 같은 값이 나온다', () => {
    const original = {
      dialect: 'mariadb' as const,
      host: 'db.example.com',
      port: 3307,
      database: 'orders',
      user: 'app',
    };
    const round = parse(formatConnectionUrl(original));
    assert.equal(round.dialect, original.dialect);
    assert.equal(round.host, original.host);
    assert.equal(round.port, original.port);
    assert.equal(round.database, original.database);
    assert.equal(round.user, original.user);
    assert.equal(round.password, undefined);
  });
});
