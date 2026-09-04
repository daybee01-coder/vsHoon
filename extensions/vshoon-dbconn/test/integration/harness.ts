import { getDriver } from '../../src/db/registry';
import type { RawConnection } from '../../src/db/driver';
import type { ConnectionProfile, DialectId, QueryOptions } from '../../src/types';

/**
 * 통합 테스트 대상 정의와 접속·시드 도우미.
 *
 * 단위 테스트(순수 로직)와 달리 여기서는 **실제 서버에 SQL 을 던진다.**
 * 방언별 카탈로그 쿼리는 문법이 조금만 어긋나도 실패하는데, 단위 테스트로는
 * 그걸 잡을 수 없다 — 그래서 이 층이 필요하다.
 *
 * 접속되지 않는 대상은 실패가 아니라 **건너뛴다.** 개발자가 Postgres 만 띄우고
 * 작업하는 것이 정상이고, 그때 Oracle 때문에 빨간불이 뜨면 아무도 이 테스트를 돌리지 않는다.
 */

export interface IntegrationTarget {
  dialect: DialectId;
  label: string;
  profile: ConnectionProfile;
  /** 카탈로그 조회에 넘길 스키마 이름. */
  schema: string;
  /** 방언의 식별자 정규화 규칙에 맞춘 객체 이름 (Oracle 은 대문자). */
  name(base: string): string;
  supportsSequence: boolean;
  /** 서버가 테이블 DDL 을 만들어 주는지. PostgreSQL 은 만들어 주지 않는다. */
  expectsTableDdl: boolean;
}

export const QUERY_OPTIONS: QueryOptions = { maxRows: 1000, timeoutMs: 30_000 };

/** 접속 확인용 짧은 제한. 서버가 없으면 빨리 포기하고 건너뛴다. */
const CONNECT_TIMEOUT_MS = Number(process.env.DBCONN_IT_CONNECT_TIMEOUT_MS ?? 8_000);

/** 풀 옵션은 설정과 무관하게 고정한다 — 테스트가 사용자 설정에 좌우되면 안 된다. */
function poolDefaults(): ConnectionProfile['pool'] {
  return {
    max: 2,
    min: 0,
    acquireTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    maxLifetimeMs: 300_000,
    leaseTimeoutMs: 60_000,
    transactionIdleTimeoutMs: 60_000,
  };
}

function env(dialect: DialectId, key: string, fallback: string): string {
  return process.env[`DBCONN_IT_${dialect.toUpperCase()}_${key}`] ?? fallback;
}

function skipped(dialect: DialectId): boolean {
  const list = (process.env.DBCONN_IT_SKIP ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(dialect);
}

function makeProfile(
  dialect: DialectId,
  overrides: Partial<ConnectionProfile>,
): ConnectionProfile {
  return {
    id: `integration-${dialect}`,
    name: `IT ${dialect}`,
    dialect,
    host: env(dialect, 'HOST', '127.0.0.1'),
    port: Number(env(dialect, 'PORT', '0')),
    database: '',
    user: '',
    savePassword: false,
    readOnly: false,
    environment: 'development',
    tls: { enabled: false, rejectUnauthorized: true },
    pool: poolDefaults(),
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** docker-compose.yml 의 기본값. 환경 변수로 덮어쓸 수 있다. */
export function targets(): IntegrationTarget[] {
  const all: IntegrationTarget[] = [];

  for (const dialect of ['mysql', 'mariadb'] as const) {
    const database = env(dialect, 'DATABASE', 'dbconn_it');
    all.push({
      dialect,
      label: dialect === 'mysql' ? 'MySQL' : 'MariaDB',
      profile: makeProfile(dialect, {
        port: Number(env(dialect, 'PORT', dialect === 'mysql' ? '13306' : '13307')),
        database,
        user: env(dialect, 'USER', 'root'),
      }),
      schema: database,
      name: (base) => base,
      // 시퀀스는 MariaDB 10.3+ 에만 있다.
      supportsSequence: dialect === 'mariadb',
      expectsTableDdl: true,
    });
  }

  all.push({
    dialect: 'postgres',
    label: 'PostgreSQL',
    profile: makeProfile('postgres', {
      port: Number(env('postgres', 'PORT', '15432')),
      database: env('postgres', 'DATABASE', 'dbconn_it'),
      user: env('postgres', 'USER', 'postgres'),
    }),
    schema: env('postgres', 'SCHEMA', 'public'),
    name: (base) => base,
    supportsSequence: true,
    // PostgreSQL 은 테이블 DDL 을 만들어 주는 함수가 없다 — 근사 DDL 로 대체된다.
    expectsTableDdl: false,
  });

  const oracleUser = env('oracle', 'USER', 'system');
  all.push({
    dialect: 'oracle',
    label: 'Oracle',
    profile: makeProfile('oracle', {
      port: Number(env('oracle', 'PORT', '11521')),
      database: env('oracle', 'DATABASE', 'FREEPDB1'),
      user: oracleUser,
      oracle: { connectType: 'service' },
    }),
    // Oracle 은 인용하지 않은 식별자를 대문자로 저장한다.
    schema: env('oracle', 'SCHEMA', oracleUser.toUpperCase()),
    name: (base) => base.toUpperCase(),
    supportsSequence: true,
    expectsTableDdl: true,
  });

  return all.filter((target) => !skipped(target.dialect));
}

export function password(dialect: DialectId): string {
  return env(dialect, 'PASSWORD', 'dbconn');
}

/** 접속을 시도한다. 실패하면 건너뛸 사유를 담아 던진다. */
export async function connect(target: IntegrationTarget): Promise<RawConnection> {
  const driver = getDriver(target.dialect);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    return await driver.connect(target.profile, password(target.dialect), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function describeSkip(target: IntegrationTarget, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    `${target.label} 서버에 접속하지 못해 건너뜁니다 ` +
    `(${target.profile.host}:${target.profile.port}) — ${message.split('\n')[0]}`
  );
}
