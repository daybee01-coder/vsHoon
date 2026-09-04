import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  ColumnInfo,
  DetailAttribute,
  ExplainOutcome,
  ForeignKeyInfo,
  IndexInfo,
  ColumnMeta,
  ConnectionProfile,
  DbObject,
  DialectId,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
} from '../../types';
import { quoteQualified } from '../../sql/identifier';
import { applyRowLimit } from '../../sql/limit';
import { abortPromise, withTimeout } from '../../util/async';
import { log } from '../../util/logger';
import { ConnectError, DriverLoadError, type CatalogQueries, type Driver, type RawConnection } from '../driver';
import { toCellValue } from '../serialize';
import {
  buildAttributes,
  formatBytes,
  formatCount,
  groupForeignKeyRows,
  groupIndexRows,
} from '../catalogDetail';
import { readTlsMaterial } from '../tls';

/**
 * MySQL / MariaDB 드라이버 (mysql2 기반).
 *
 * 보안상 중요한 설정 두 가지:
 *  - `multipleStatements: false` — 한 번의 query() 로 여러 구문이 실행되는 것을 막는다.
 *    이게 켜져 있으면 어떤 문자열 조립 실수도 곧바로 스택드 인젝션이 된다.
 *  - `ssl.rejectUnauthorized` — 기본값 true 를 유지한다.
 */

// mysql2 타입에 컴파일 타임으로 묶이지 않도록 필요한 표면만 국소 선언한다.
interface MySqlFieldPacket {
  name: string;
  type?: number;
  columnType?: number;
  flags?: number;
  columnLength?: number;
}

interface MySqlResultSetHeader {
  affectedRows: number;
  insertId: number | bigint;
  warningStatus: number;
  info: string;
  changedRows?: number;
}

interface MySqlCoreConnection {
  threadId: number | null;
  query(options: unknown, callback: (err: unknown, results: unknown, fields: unknown) => void): unknown;
  end(callback?: (err?: unknown) => void): void;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface MySqlModule {
  createConnection(config: Record<string, unknown>): Promise<MySqlPromiseConnection>;
}

interface MySqlPromiseConnection {
  connection: MySqlCoreConnection;
  query(options: unknown): Promise<[unknown, unknown]>;
  execute(options: unknown): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy(): void;
  ping(): Promise<void>;
}

let cachedModule: MySqlModule | undefined;

async function loadMysql(dialect: DialectId): Promise<MySqlModule> {
  if (cachedModule) {
    return cachedModule;
  }
  try {
    const mod = (await import('mysql2/promise')) as unknown as MySqlModule & { default?: MySqlModule };
    cachedModule = mod.default ?? mod;
    return cachedModule;
  } catch (error) {
    throw new DriverLoadError(dialect, error);
  }
}

async function buildConfig(
  profile: ConnectionProfile,
  password: string | undefined,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: password ?? '',
    database: profile.database || undefined,
    connectTimeout: profile.connectTimeoutMs,

    // ── 보안 ──
    // 한 번의 호출로 여러 구문이 실행되는 경로를 원천 차단한다.
    multipleStatements: false,
    // 로컬 파일을 서버로 보내는 LOAD DATA LOCAL INFILE 을 막는다
    // (악의적인 서버가 클라이언트 파일을 읽어가는 고전적인 공격 벡터).
    infileStreamFactory: undefined,

    // ── 값 표현 ──
    // 큰 정수와 DECIMAL 은 문자열로 받아 정밀도를 잃지 않는다.
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: false,
    charset: 'utf8mb4',
    rowsAsArray: true,
    namedPlaceholders: false,
    timezone: 'local',
  };

  if (profile.tls.enabled) {
    const material = await readTlsMaterial(profile.tls);
    config.ssl = {
      rejectUnauthorized: profile.tls.rejectUnauthorized,
      ...(material.ca ? { ca: material.ca } : {}),
      ...(material.cert ? { cert: material.cert } : {}),
      ...(material.key ? { key: material.key } : {}),
      ...(profile.tls.servername ? { servername: profile.tls.servername } : {}),
    };
  }

  return config;
}

class MySqlConnection implements RawConnection {
  readonly id = `mysql-${randomUUID().slice(0, 8)}`;
  readonly createdAt = Date.now();
  private txDepth = 0;
  private closed = false;

  constructor(
    private readonly conn: MySqlPromiseConnection,
    private readonly dialect: DialectId,
    /** 취소는 별도 커넥션에서 KILL QUERY 를 보내야 한다. */
    private readonly openControlConnection: () => Promise<MySqlPromiseConnection>,
  ) {
    conn.connection.on('error', (error: unknown) => {
      // 처리되지 않은 'error' 이벤트는 확장 호스트를 죽인다. 반드시 삼킨다.
      log.debug(`[${this.id}] 커넥션 오류 이벤트`, error);
      this.closed = true;
    });
  }

  get backendId(): number | undefined {
    return this.conn.connection.threadId ?? undefined;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  async execute(
    sql: string,
    params: readonly unknown[] | undefined,
    options: QueryOptions,
  ): Promise<QueryResult> {
    const limited = applyRowLimit(sql, options.maxRows, this.dialect);
    const started = Date.now();

    const run = this.conn.query({
      sql: limited.sql,
      values: params ? [...params] : undefined,
      rowsAsArray: true,
    });

    let raw: [unknown, unknown];
    try {
      raw = await Promise.race([
        withTimeout(run, options.timeoutMs, `쿼리가 ${options.timeoutMs}ms 안에 끝나지 않았습니다.`),
        abortPromise(options.signal),
      ]);
    } catch (error) {
      // 타임아웃/취소 시 서버 측 실행을 멈춘다. 그러지 않으면 커넥션을
      // 반납해도 서버는 계속 돌면서 자원을 잡고 있다.
      await this.cancel().catch(() => undefined);
      throw error;
    }

    const durationMs = Date.now() - started;
    const [results, fields] = raw;
    return this.shapeResult(results, fields, sql, durationMs, limited.applied, options.maxRows);
  }

  private shapeResult(
    results: unknown,
    fields: unknown,
    originalSql: string,
    durationMs: number,
    serverLimited: boolean,
    maxRows: number,
  ): QueryResult {
    // CALL 처럼 결과 집합이 여러 개면 첫 번째만 표시한다.
    let rowsSource = results;
    let fieldsSource = fields;
    if (Array.isArray(fields) && Array.isArray(fields[0])) {
      fieldsSource = fields[0];
      rowsSource = Array.isArray(results) ? results[0] : results;
    }

    if (!Array.isArray(rowsSource)) {
      const header = rowsSource as MySqlResultSetHeader | undefined;
      return {
        kind: 'update',
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: header?.affectedRows ?? 0,
        truncated: false,
        durationMs,
        messages: header?.info ? [header.info] : [],
        sql: originalSql,
      };
    }

    const packets = (Array.isArray(fieldsSource) ? fieldsSource : []) as MySqlFieldPacket[];
    const columns: ColumnMeta[] = packets.map((field, index) => ({
      name: field.name,
      typeName: mysqlTypeName(field),
      nullable: field.flags === undefined ? undefined : (field.flags & 1) === 0,
      index,
    }));

    const allRows = rowsSource as unknown[][];
    const truncated = !serverLimited && allRows.length > maxRows;
    const kept = truncated ? allRows.slice(0, maxRows) : allRows;
    const rows = kept.map((row) => row.map(toCellValue));

    return {
      kind: 'rows',
      columns,
      rows,
      rowCount: rows.length,
      truncated: truncated || (serverLimited && allRows.length >= maxRows),
      durationMs,
      messages: [],
      sql: originalSql,
    };
  }

  async begin(): Promise<void> {
    await this.conn.query({ sql: 'START TRANSACTION' });
    this.txDepth = 1;
  }

  async commit(): Promise<void> {
    try {
      await this.conn.query({ sql: 'COMMIT' });
    } finally {
      this.txDepth = 0;
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.conn.query({ sql: 'ROLLBACK' });
    } finally {
      this.txDepth = 0;
    }
  }

  async setSessionReadOnly(readOnly: boolean): Promise<void> {
    // MariaDB 10.0+ / MySQL 5.6+ 에서 지원. 실패해도 클라이언트 측 차단이 남아 있다.
    try {
      await this.conn.query({
        sql: `SET SESSION TRANSACTION READ ${readOnly ? 'ONLY' : 'WRITE'}`,
      });
    } catch (error) {
      log.debug(`[${this.id}] 세션 읽기 전용 설정 실패 (무시)`, error);
    }
  }

  async cancel(): Promise<void> {
    const threadId = this.conn.connection.threadId;
    if (threadId === null || threadId === undefined) {
      return;
    }
    // 실행 중인 커넥션 자신에게는 명령을 보낼 수 없다 — 새 커넥션이 필요하다.
    let control: MySqlPromiseConnection | undefined;
    try {
      control = await this.openControlConnection();
      // KILL QUERY 는 세션이 아니라 현재 구문만 중단시킨다.
      await control.query({ sql: 'KILL QUERY ?', values: [threadId] });
      log.debug(`[${this.id}] KILL QUERY ${threadId} 전송`);
    } catch (error) {
      log.debug(`[${this.id}] 쿼리 취소 실패`, error);
    } finally {
      if (control) {
        control.destroy();
      }
    }
  }

  async validate(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      await withTimeout(this.conn.ping(), 5000, 'ping timeout');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await withTimeout(this.conn.end(), 5000, 'end timeout');
    } catch {
      // 정상 종료가 안 되면 소켓을 강제로 끊는다. 여기서 멈추면 안 된다.
      try {
        this.conn.destroy();
      } catch {
        /* 이미 닫힘 */
      }
    }
  }
}

const catalog: CatalogQueries = {
  async defaultSchema(conn, profile): Promise<string> {
    if (profile.database) {
      return profile.database;
    }
    const result = await conn.execute('SELECT DATABASE()', undefined, defaultCatalogOptions());
    return String(result.rows[0]?.[0] ?? '');
  },

  async listSchemas(conn): Promise<SchemaInfo[]> {
    const result = await conn.execute(
      `SELECT SCHEMA_NAME, SCHEMA_NAME = DATABASE() AS IS_DEFAULT
         FROM information_schema.SCHEMATA
        ORDER BY SCHEMA_NAME`,
      undefined,
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      isDefault: row[1] === 1 || row[1] === true || row[1] === '1',
    }));
  },

  /**
   * 테이블 목록.
   *
   * **TABLE_ROWS 는 공짜가 아니다.** `innodb_stats_on_metadata` 가 켜져 있으면
   * 이 열을 읽는 것만으로 스키마 안 **모든 테이블**의 인덱스 통계를 다시 표집한다.
   * 운영 인스턴스에서는 이 한 줄 때문에 다른 세션이 줄줄이 밀리는 일이 실제로
   * 일어난다 — PostgreSQL(reltuples)·Oracle(NUM_ROWS)이 저장된 값을 그냥 읽는
   * 것과 완전히 다르다. 그래서 기본은 끄고, 원하는 사람만 켠다.
   */
  async listTables(conn, schema): Promise<TableInfo[]> {
    const withRows = estimateRowsEnabled();
    const result = await conn.execute(
      // MariaDB 10.3+ 는 시퀀스도 TABLES 에 나타난다. 관계형 목록에서 제외한다.
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT${withRows ? ', TABLE_ROWS' : ''}
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
          AND TABLE_TYPE <> 'SEQUENCE'
        ORDER BY TABLE_NAME`,
      [schema],
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      schema,
      name: String(row[0]),
      kind: String(row[1]) === 'VIEW' ? ('view' as const) : ('table' as const),
      comment: row[2] ? String(row[2]) : undefined,
      estimatedRows: !withRows || row[3] === null ? undefined : Number(row[3]),
    }));
  },

  async listOtherObjects(conn, schema): Promise<DbObject[]> {
    const objects: DbObject[] = [];

    // 시퀀스 — MariaDB 10.3+ 에만 존재한다. MySQL 에서는 빈 결과가 나올 뿐이라
    // 버전 분기 없이 같은 쿼리를 쓴다.
    await collect<DbObject>(objects, async () => {
      const result = await conn.execute(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'SEQUENCE'
          ORDER BY TABLE_NAME`,
        [schema],
        defaultCatalogOptions(),
      );
      return result.rows.map((row) => ({
        schema,
        name: String(row[0]),
        kind: 'sequence' as const,
      }));
    });

    // 저장 프로시저 / 함수
    await collect(objects, async () => {
      const result = await conn.execute(
        `SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT, DTD_IDENTIFIER
           FROM information_schema.ROUTINES
          WHERE ROUTINE_SCHEMA = ?
          ORDER BY ROUTINE_NAME`,
        [schema],
        defaultCatalogOptions(),
      );
      return result.rows.map((row) => ({
        schema,
        name: String(row[0]),
        kind: String(row[1]) === 'PROCEDURE' ? ('procedure' as const) : ('function' as const),
        comment: row[2] ? String(row[2]) : undefined,
        detail: row[3] ? `→ ${String(row[3])}` : undefined,
      }));
    });

    return objects;
  },

  async listColumns(conn, schema): Promise<ColumnInfo[]> {
    const result = await conn.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT, ORDINAL_POSITION
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [schema],
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      schema,
      table: String(row[0]),
      name: String(row[1]),
      typeName: String(row[2]),
      nullable: String(row[3]).toUpperCase() === 'YES',
      defaultValue: row[4] === null ? undefined : String(row[4]),
      isPrimaryKey: String(row[5]) === 'PRI',
      comment: row[6] ? String(row[6]) : undefined,
      ordinal: Number(row[7]),
    }));
  },

  async listIndexes(conn, schema, table): Promise<IndexInfo[]> {
    // EXPRESSION 열은 MySQL 8.0+ 에만 있어 선택하지 않는다 —
    // 없는 열을 고르면 구버전과 MariaDB 에서 쿼리 자체가 실패한다.
    const result = await conn.execute(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema, table],
      defaultCatalogOptions(),
    );
    return groupIndexRows(
      schema,
      table,
      result.rows.map((row) => ({
        name: String(row[0]),
        unique: Number(row[1]) === 0,
        column: row[2] === null ? '(식)' : String(row[2]),
      })),
    );
  },

  async listForeignKeys(conn, schema, table, direction): Promise<ForeignKeyInfo[]> {
    // 방향에 따라 WHERE 대상만 바뀐다. 바인드 순서를 헷갈리지 않도록 절을 따로 둔다.
    const where =
      direction === 'outgoing'
        ? 'k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?'
        : 'k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?';

    const result = await conn.execute(
      `SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME,
              k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              r.DELETE_RULE, r.UPDATE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.REFERENCED_TABLE_NAME IS NOT NULL AND ${where}
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [schema, table],
      defaultCatalogOptions(),
    );

    return groupForeignKeyRows(
      result.rows.map((row) => ({
        name: String(row[0]),
        schema: String(row[1]),
        table: String(row[2]),
        column: row[3] === null ? '' : String(row[3]),
        referencedSchema: String(row[4] ?? ''),
        referencedTable: String(row[5] ?? ''),
        referencedColumn: row[6] === null ? '' : String(row[6]),
        onDelete: row[7] === null ? undefined : String(row[7]),
        onUpdate: row[8] === null ? undefined : String(row[8]),
      })),
    );
  },

  async objectAttributes(conn, ref): Promise<DetailAttribute[]> {
    switch (ref.kind) {
      case 'table':
      case 'view':
      case 'materialized-view': {
        const result = await conn.execute(
          `SELECT ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
                  TABLE_COLLATION, CREATE_TIME, UPDATE_TIME, TABLE_COMMENT
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
          [ref.schema, ref.name],
          defaultCatalogOptions(),
        );
        const row = result.rows[0];
        if (!row) {
          return [];
        }
        return buildAttributes([
          ['엔진', row[0]],
          ['예상 행 수', formatCount(row[1] ?? null)],
          ['데이터 크기', formatBytes(row[2] ?? null)],
          ['인덱스 크기', formatBytes(row[3] ?? null)],
          ['콜레이션', row[4]],
          ['생성', row[5]],
          ['마지막 변경', row[6]],
        ]);
      }

      case 'sequence': {
        // MariaDB 10.3+ 의 시퀀스는 테이블처럼 조회한다.
        const result = await conn.execute(
          `SELECT NEXT_NOT_CACHED_VALUE, MINIMUM_VALUE, MAXIMUM_VALUE,
                  START_VALUE, INCREMENT, CYCLE_OPTION
             FROM ${quoteQualified(ref.schema, ref.name, 'mysql')}`,
          undefined,
          defaultCatalogOptions(),
        );
        const row = result.rows[0];
        if (!row) {
          return [];
        }
        return buildAttributes([
          ['다음 값', row[0]],
          ['최솟값', row[1]],
          ['최댓값', row[2]],
          ['시작값', row[3]],
          ['증가치', row[4]],
          ['순환', row[5]],
        ]);
      }

      case 'function':
      case 'procedure': {
        const result = await conn.execute(
          `SELECT ROUTINE_TYPE, DTD_IDENTIFIER, IS_DETERMINISTIC, SECURITY_TYPE,
                  CREATED, LAST_ALTERED, ROUTINE_COMMENT
             FROM information_schema.ROUTINES
            WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?`,
          [ref.schema, ref.name],
          defaultCatalogOptions(),
        );
        const row = result.rows[0];
        if (!row) {
          return [];
        }
        return buildAttributes([
          ['종류', row[0]],
          ['반환 타입', row[1]],
          ['결정적', row[2]],
          ['보안 컨텍스트', row[3]],
          ['생성', row[4]],
          ['마지막 변경', row[5]],
        ]);
      }

      default:
        return [];
    }
  },

  async objectDefinition(conn, ref): Promise<string | undefined> {
    const keyword = SHOW_CREATE_KEYWORD[ref.kind];
    if (!keyword) {
      return undefined;
    }
    const result = await conn.execute(
      `SHOW CREATE ${keyword} ${quoteQualified(ref.schema, ref.name, 'mysql')}`,
      undefined,
      defaultCatalogOptions(),
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    // 열 위치가 종류마다 다르므로(Create Table / Create View / Create Function)
    // 이름으로 찾는다.
    const index = result.columns.findIndex((column) => /^create/i.test(column.name));
    const value = index === -1 ? row[row.length - 1] : row[index];
    return value === null || value === undefined ? undefined : String(value);
  },
};

/** SHOW CREATE 에 쓰는 객체 종류 키워드. 없는 종류는 DDL 을 얻을 수 없다. */
const SHOW_CREATE_KEYWORD: Partial<Record<string, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  sequence: 'SEQUENCE',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
};

function defaultCatalogOptions(): QueryOptions {
  return { maxRows: 100_000, timeoutMs: 30_000 };
}

/** 예상 행 수를 읽을지. 기본은 끔 — listTables 의 설명 참고. */
function estimateRowsEnabled(): boolean {
  return vscode.workspace.getConfiguration('dbconn').get<boolean>('metadata.estimateRows', false);
}

/**
 * 카탈로그 하위 조회 하나가 실패해도 나머지는 살린다.
 * 권한이 없거나 서버 버전에 그 뷰가 없는 경우가 흔하고,
 * 그 때문에 자동 완성 전체가 비어 버리면 안 된다.
 */
async function collect<T>(into: T[], load: () => Promise<T[]>): Promise<void> {
  try {
    into.push(...(await load()));
  } catch (error) {
    log.debug('카탈로그 하위 조회 실패 (건너뜀)', error);
  }
}

export function createMySqlDriver(dialect: 'mysql' | 'mariadb'): Driver {
  return {
    dialect,
    catalog,

    /**
     * MySQL 은 EXPLAIN 이 표로 나온다. ANALYZE 는 한 컬럼짜리 트리 텍스트라
     * 그때는 텍스트로 돌려준다.
     */
    async explain(conn, sql, explainOptions, options): Promise<ExplainOutcome> {
      const prefix = explainOptions.analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN';
      const result = await conn.execute(`${prefix} ${sql}`, undefined, options);
      if (result.columns.length === 1) {
        return { text: result.rows.map((row) => String(row[0] ?? '')).join('\n') };
      }
      return { result };
    },

    async connect(profile, password, signal): Promise<RawConnection> {
      const mysql = await loadMysql(dialect);
      const config = await buildConfig(profile, password);

      const open = async (): Promise<MySqlPromiseConnection> => mysql.createConnection(config);

      let promiseConn: MySqlPromiseConnection;
      try {
        promiseConn = await Promise.race([
          withTimeout(
            open(),
            profile.connectTimeoutMs,
            `${profile.host}:${profile.port} 연결이 ${profile.connectTimeoutMs}ms 안에 완료되지 않았습니다.`,
          ),
          abortPromise(signal),
        ]);
      } catch (error) {
        throw toConnectError(error, profile);
      }

      const connection = new MySqlConnection(promiseConn, dialect, open);
      if (profile.readOnly) {
        await connection.setSessionReadOnly(true);
      }
      return connection;
    },

    buildPreviewQuery(schema, table, limit): string {
      return `SELECT * FROM ${quoteQualified(schema, table, dialect)} LIMIT ${Math.floor(limit)}`;
    },

    applyRowLimit(sql, limit): string {
      return applyRowLimit(sql, limit, dialect).sql;
    },

    placeholder(): string {
      // MySQL 프로토콜은 위치 기반 '?' 만 쓴다.
      return '?';
    },
  };
}

function toConnectError(error: unknown, profile: ConnectionProfile): ConnectError {
  const code = (error as { code?: string } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);

  switch (code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return new ConnectError(`인증에 실패했습니다. 사용자 "${profile.user}" 의 비밀번호를 확인하세요.`, code);
    case 'ER_BAD_DB_ERROR':
      return new ConnectError(`데이터베이스 "${profile.database}" 를 찾을 수 없습니다.`, code);
    case 'ECONNREFUSED':
      return new ConnectError(`${profile.host}:${profile.port} 에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요.`, code);
    case 'ENOTFOUND':
      return new ConnectError(`호스트 "${profile.host}" 를 찾을 수 없습니다.`, code);
    case 'ETIMEDOUT':
      return new ConnectError(`${profile.host}:${profile.port} 연결이 시간 초과됐습니다. 방화벽 설정을 확인하세요.`, code);
    case 'HANDSHAKE_SSL_ERROR':
      return new ConnectError(`TLS 핸드셰이크에 실패했습니다: ${message}`, code);
    default:
      return new ConnectError(message, code);
  }
}

/** field 패킷의 숫자 타입 코드를 사람이 읽는 이름으로. */
function mysqlTypeName(field: MySqlFieldPacket): string {
  const code = field.columnType ?? field.type;
  if (code === undefined) {
    return 'unknown';
  }
  return MYSQL_TYPES[code] ?? `type(${code})`;
}

/** mysql2 의 타입 코드 → 이름. (protocol/constants/types.js 기준) */
const MYSQL_TYPES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARCHAR',
  254: 'CHAR',
  255: 'GEOMETRY',
};
