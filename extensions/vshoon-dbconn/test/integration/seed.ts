import type { IntegrationTarget } from './harness';

/**
 * 통합 테스트용 스키마.
 *
 * 세 방언에서 **같은 모양**을 만든다 — 기본 키, NOT NULL, 기본값, 코멘트,
 * 외래 키(ON DELETE CASCADE), 보조 인덱스, 뷰, (지원하면) 시퀀스.
 * 카탈로그 조회가 실제로 무엇을 돌려주는지 확인하려면 이 요소들이 전부 필요하다.
 *
 * 실행은 항상 "지우고 다시 만들기"다. 앞선 실행이 중간에 끊겨도
 * 다음 실행이 깨끗한 상태에서 시작한다.
 */

export interface SeedStatement {
  sql: string;
  /** DROP 처럼 "없어도 정상"인 구문. 실패해도 넘어간다. */
  optional?: boolean;
}

export const USERS = 'dbconn_it_users';
export const ORDERS = 'dbconn_it_orders';
export const USER_VIEW = 'dbconn_it_user_view';
export const SEQUENCE = 'dbconn_it_seq';
export const ORDERS_INDEX = 'dbconn_it_orders_user_idx';
export const ORDERS_FK = 'dbconn_it_orders_user_fk';

/** 사용자 5명 — 페이징·정렬 확인에 쓰인다. */
const USER_ROWS: [number, string, string][] = [
  [1, 'alpha@example.com', '알파'],
  [2, 'bravo@example.com', '브라보'],
  [3, 'charlie@example.com', '찰리'],
  [4, 'delta@example.com', '델타'],
  [5, 'echo@example.com', '에코'],
];

const ORDER_ROWS: [number, number, string][] = [
  [10, 1, '1000.50'],
  [11, 1, '2000.00'],
  [12, 3, '30.25'],
];

export function seedStatements(target: IntegrationTarget): SeedStatement[] {
  switch (target.dialect) {
    case 'mysql':
    case 'mariadb':
      return mysqlSeed(target);
    case 'postgres':
      return postgresSeed();
    case 'oracle':
      return oracleSeed();
  }
}

function insertUsers(): SeedStatement[] {
  return USER_ROWS.map(([id, email, name]) => ({
    sql: `INSERT INTO ${USERS} (id, email, name, note) VALUES (${id}, '${email}', '${name}', 'none')`,
  }));
}

function insertOrders(): SeedStatement[] {
  return ORDER_ROWS.map(([id, userId, amount]) => ({
    sql: `INSERT INTO ${ORDERS} (id, user_id, amount) VALUES (${id}, ${userId}, ${amount})`,
  }));
}

function mysqlSeed(target: IntegrationTarget): SeedStatement[] {
  const statements: SeedStatement[] = [
    { sql: `DROP VIEW IF EXISTS ${USER_VIEW}`, optional: true },
    { sql: `DROP TABLE IF EXISTS ${ORDERS}`, optional: true },
    { sql: `DROP TABLE IF EXISTS ${USERS}`, optional: true },
    {
      sql: `CREATE TABLE ${USERS} (
              id INT NOT NULL,
              email VARCHAR(200) NOT NULL COMMENT '로그인 이메일',
              name VARCHAR(100),
              note VARCHAR(100) DEFAULT 'none',
              PRIMARY KEY (id)
            ) COMMENT='통합 테스트 사용자'`,
    },
    {
      sql: `CREATE TABLE ${ORDERS} (
              id INT NOT NULL,
              user_id INT NOT NULL,
              amount DECIMAL(10,2),
              PRIMARY KEY (id),
              CONSTRAINT ${ORDERS_FK} FOREIGN KEY (user_id)
                REFERENCES ${USERS}(id) ON DELETE CASCADE
            )`,
    },
    { sql: `CREATE INDEX ${ORDERS_INDEX} ON ${ORDERS} (user_id)` },
    { sql: `CREATE VIEW ${USER_VIEW} AS SELECT id, email FROM ${USERS}` },
  ];

  if (target.supportsSequence) {
    statements.unshift({ sql: `DROP SEQUENCE IF EXISTS ${SEQUENCE}`, optional: true });
    statements.push({ sql: `CREATE SEQUENCE ${SEQUENCE} START WITH 100 INCREMENT BY 5` });
  }

  return [...statements, ...insertUsers(), ...insertOrders()];
}

function postgresSeed(): SeedStatement[] {
  return [
    { sql: `DROP VIEW IF EXISTS ${USER_VIEW}`, optional: true },
    { sql: `DROP TABLE IF EXISTS ${ORDERS}`, optional: true },
    { sql: `DROP TABLE IF EXISTS ${USERS}`, optional: true },
    { sql: `DROP SEQUENCE IF EXISTS ${SEQUENCE}`, optional: true },
    {
      sql: `CREATE TABLE ${USERS} (
              id integer PRIMARY KEY,
              email varchar(200) NOT NULL,
              name varchar(100),
              note varchar(100) DEFAULT 'none'
            )`,
    },
    { sql: `COMMENT ON TABLE ${USERS} IS '통합 테스트 사용자'` },
    { sql: `COMMENT ON COLUMN ${USERS}.email IS '로그인 이메일'` },
    {
      sql: `CREATE TABLE ${ORDERS} (
              id integer PRIMARY KEY,
              user_id integer NOT NULL,
              amount numeric(10,2),
              CONSTRAINT ${ORDERS_FK} FOREIGN KEY (user_id)
                REFERENCES ${USERS}(id) ON DELETE CASCADE
            )`,
    },
    { sql: `CREATE INDEX ${ORDERS_INDEX} ON ${ORDERS} (user_id)` },
    { sql: `CREATE SEQUENCE ${SEQUENCE} START WITH 100 INCREMENT BY 5` },
    { sql: `CREATE VIEW ${USER_VIEW} AS SELECT id, email FROM ${USERS}` },
    ...insertUsers(),
    ...insertOrders(),
  ];
}

function oracleSeed(): SeedStatement[] {
  return [
    // Oracle 은 구문 끝에 세미콜론을 붙이지 않는다 (드라이버가 한 구문씩 보낸다).
    { sql: `DROP VIEW ${USER_VIEW}`, optional: true },
    { sql: `DROP TABLE ${ORDERS} CASCADE CONSTRAINTS`, optional: true },
    { sql: `DROP TABLE ${USERS} CASCADE CONSTRAINTS`, optional: true },
    { sql: `DROP SEQUENCE ${SEQUENCE}`, optional: true },
    {
      sql: `CREATE TABLE ${USERS} (
              id NUMBER PRIMARY KEY,
              email VARCHAR2(200) NOT NULL,
              name VARCHAR2(100),
              note VARCHAR2(100) DEFAULT 'none'
            )`,
    },
    { sql: `COMMENT ON TABLE ${USERS} IS '통합 테스트 사용자'` },
    { sql: `COMMENT ON COLUMN ${USERS}.email IS '로그인 이메일'` },
    {
      sql: `CREATE TABLE ${ORDERS} (
              id NUMBER PRIMARY KEY,
              user_id NUMBER NOT NULL,
              amount NUMBER(10,2),
              CONSTRAINT ${ORDERS_FK} FOREIGN KEY (user_id)
                REFERENCES ${USERS}(id) ON DELETE CASCADE
            )`,
    },
    { sql: `CREATE INDEX ${ORDERS_INDEX} ON ${ORDERS} (user_id)` },
    { sql: `CREATE SEQUENCE ${SEQUENCE} START WITH 100 INCREMENT BY 5` },
    { sql: `CREATE VIEW ${USER_VIEW} AS SELECT id, email FROM ${USERS}` },
    ...insertUsers(),
    ...insertOrders(),
  ];
}
