import { randomUUID } from 'node:crypto';
import type {
  ColumnInfo,
  ColumnMeta,
  ConnectionProfile,
  DbObject,
  DetailAttribute,
  ExplainOutcome,
  ForeignKeyInfo,
  IndexInfo,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
} from '../../types';
import { quoteQualified } from '../../sql/identifier';
import {
  buildAttributes,
  formatCount,
  groupForeignKeyRows,
  groupIndexRows,
  pgReferentialAction,
} from '../catalogDetail';
import { applyRowLimit } from '../../sql/limit';
import { abortPromise, withTimeout } from '../../util/async';
import { log } from '../../util/logger';
import {
  ConnectError,
  DriverLoadError,
  type CatalogQueries,
  type Driver,
  type RawConnection,
} from '../driver';
import { toCellValue } from '../serialize';
import { readTlsMaterial } from '../tls';

/**
 * PostgreSQL 드라이버 (pg 기반).
 *
 * pg 는 하나의 Client 에서 여러 구문을 세미콜론으로 이어 보내는 것을 허용한다.
 * 따라서 확장 쪽에서 항상 단일 구문만 보내도록 보장해야 한다 —
 * 문장 분리기가 그 역할을 한다. 파라미터가 있는 쿼리는 확장 프로토콜로
 * 나가므로 다중 구문 자체가 불가능하다.
 */

interface PgNotice {
  message?: string;
  severity?: string;
  detail?: string;
  hint?: string;
}

interface PgField {
  name: string;
  dataTypeID: number;
  tableID: number;
  columnID: number;
}

interface PgResult {
  command: string;
  rowCount: number | null;
  rows: unknown[][];
  fields: PgField[];
}

interface PgClient {
  processID: number | null;
  connect(): Promise<void>;
  query(config: unknown): Promise<PgResult | PgResult[]>;
  end(): Promise<void>;
  on(event: string, listener: (arg: unknown) => void): unknown;
  removeAllListeners(event?: string): unknown;
}

interface PgModule {
  Client: new (config: Record<string, unknown>) => PgClient;
  types: {
    setTypeParser(oid: number, parser: (value: string) => unknown): void;
    getTypeParser(oid: number, format?: string): (value: string) => unknown;
  };
}

let cachedModule: PgModule | undefined;

async function loadPg(): Promise<PgModule> {
  if (cachedModule) {
    return cachedModule;
  }
  try {
    const mod = (await import('pg')) as unknown as PgModule & { default?: PgModule };
    const resolved = mod.default ?? mod;
    configureTypeParsers(resolved);
    cachedModule = resolved;
    return resolved;
  } catch (error) {
    throw new DriverLoadError('postgres', error);
  }
}

/**
 * 기본 파서는 정밀도를 잃거나 표시를 왜곡하는 경우가 있어 몇 가지를 바꾼다.
 * 전역 설정이지만 이 확장 프로세스 안에서만 유효하다.
 */
function configureTypeParsers(pg: PgModule): void {
  const asString = (value: string): string => value;
  // int8(bigint) — JS number 로 바꾸면 2^53 이상에서 값이 틀어진다.
  pg.types.setTypeParser(20, asString);
  // numeric / money — 부동소수점으로 바꾸면 안 된다.
  pg.types.setTypeParser(1700, asString);
  pg.types.setTypeParser(790, asString);
  // date / timestamp / timestamptz — 서버가 준 텍스트 표현을 그대로 보여준다.
  pg.types.setTypeParser(1082, asString);
  pg.types.setTypeParser(1114, asString);
  pg.types.setTypeParser(1184, asString);
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
    connectionTimeoutMillis: profile.connectTimeoutMs,
    // 행을 배열로 받아 동일 이름 컬럼이 뭉개지지 않게 한다.
    rowMode: 'array',
    application_name: 'vscode-dbconn',
    // pg 자체 statement_timeout — 서버가 강제 종료해 주므로 가장 확실한 안전장치.
    statement_timeout: 0, // 실행 시점에 세션 단위로 설정한다.
    ssl: false,
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

class PostgresConnection implements RawConnection {
  readonly id = `pg-${randomUUID().slice(0, 8)}`;
  readonly createdAt = Date.now();
  private txDepth = 0;
  private closed = false;
  private notices: string[] = [];
  /** 현재 세션에 적용된 statement_timeout 값 — 매번 다시 보내지 않기 위해. */
  private appliedTimeoutMs = -1;

  constructor(
    private readonly client: PgClient,
    private readonly openControlClient: () => Promise<PgClient>,
  ) {
    client.on('notice', (notice: unknown) => {
      const n = notice as PgNotice;
      const text = [n.severity, n.message].filter(Boolean).join(': ');
      if (text) {
        this.notices.push(text);
      }
    });
    client.on('error', (error: unknown) => {
      // 처리되지 않은 error 이벤트는 확장 호스트를 종료시킨다.
      log.debug(`[${this.id}] 커넥션 오류 이벤트`, error);
      this.closed = true;
    });
  }

  get backendId(): number | undefined {
    return this.client.processID ?? undefined;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  async execute(
    sql: string,
    params: readonly unknown[] | undefined,
    options: QueryOptions,
  ): Promise<QueryResult> {
    await this.ensureStatementTimeout(options.timeoutMs);
    const limited = applyRowLimit(sql, options.maxRows, 'postgres');
    this.notices = [];
    const started = Date.now();

    const run = this.client.query({
      text: limited.sql,
      values: params ? [...params] : undefined,
      rowMode: 'array',
    });

    let result: PgResult | PgResult[];
    try {
      result = await Promise.race([
        // 서버 측 statement_timeout 이 1차 방어선이고, 이건 네트워크가 멈춘
        // 경우까지 잡기 위한 여유 있는 2차 방어선이다.
        withTimeout(
          run,
          options.timeoutMs + 5000,
          `쿼리가 ${options.timeoutMs}ms 안에 끝나지 않았습니다.`,
        ),
        abortPromise(options.signal),
      ]);
    } catch (error) {
      await this.cancel().catch(() => undefined);
      // 트랜잭션 중 오류가 나면 PostgreSQL 은 세션을 aborted 상태로 만든다.
      throw enrichPgError(error);
    }

    const durationMs = Date.now() - started;
    // 세미콜론으로 이어진 구문은 배열로 온다 — 마지막 결과를 보여준다.
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    return this.shapeResult(last, sql, durationMs, limited.applied, options.maxRows);
  }

  private shapeResult(
    result: PgResult | undefined,
    originalSql: string,
    durationMs: number,
    serverLimited: boolean,
    maxRows: number,
  ): QueryResult {
    const messages = this.notices;
    this.notices = [];

    if (!result) {
      return {
        kind: 'update',
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        truncated: false,
        durationMs,
        messages,
        sql: originalSql,
      };
    }

    const hasFields = Array.isArray(result.fields) && result.fields.length > 0;
    if (!hasFields) {
      return {
        kind: 'update',
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: result.rowCount ?? 0,
        truncated: false,
        durationMs,
        messages,
        sql: originalSql,
      };
    }

    const columns: ColumnMeta[] = result.fields.map((field, index) => ({
      name: field.name,
      typeName: PG_TYPES[field.dataTypeID] ?? `oid:${field.dataTypeID}`,
      index,
    }));

    const allRows = result.rows ?? [];
    const truncated = !serverLimited && allRows.length > maxRows;
    const kept = truncated ? allRows.slice(0, maxRows) : allRows;

    return {
      kind: 'rows',
      columns,
      rows: kept.map((row) => row.map(toCellValue)),
      rowCount: kept.length,
      truncated: truncated || (serverLimited && allRows.length >= maxRows),
      durationMs,
      messages,
      sql: originalSql,
    };
  }

  /** statement_timeout 을 세션에 적용한다. 서버가 알아서 끊어 주는 게 가장 확실하다. */
  private async ensureStatementTimeout(timeoutMs: number): Promise<void> {
    const value = Math.max(0, Math.floor(timeoutMs));
    if (value === this.appliedTimeoutMs) {
      return;
    }
    // 정수 리터럴이므로 문자열 조립이 안전하다 (Number 로 강제 변환됨).
    await this.client.query({ text: `SET statement_timeout = ${value}` });
    this.appliedTimeoutMs = value;
  }

  async begin(): Promise<void> {
    await this.client.query({ text: 'BEGIN' });
    this.txDepth = 1;
  }

  async commit(): Promise<void> {
    try {
      await this.client.query({ text: 'COMMIT' });
    } finally {
      this.txDepth = 0;
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.client.query({ text: 'ROLLBACK' });
    } finally {
      this.txDepth = 0;
    }
  }

  async setSessionReadOnly(readOnly: boolean): Promise<void> {
    try {
      await this.client.query({
        text: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ${readOnly ? 'ONLY' : 'WRITE'}`,
      });
    } catch (error) {
      log.debug(`[${this.id}] 세션 읽기 전용 설정 실패 (무시)`, error);
    }
  }

  async cancel(): Promise<void> {
    const pid = this.client.processID;
    if (!pid) {
      return;
    }
    let control: PgClient | undefined;
    try {
      control = await this.openControlClient();
      await control.query({ text: 'SELECT pg_cancel_backend($1)', values: [pid] });
      log.debug(`[${this.id}] pg_cancel_backend(${pid}) 전송`);
    } catch (error) {
      log.debug(`[${this.id}] 쿼리 취소 실패`, error);
    } finally {
      if (control) {
        await control.end().catch(() => undefined);
      }
    }
  }

  async validate(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      await withTimeout(this.client.query({ text: 'SELECT 1' }), 5000, 'ping timeout');
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
    this.client.removeAllListeners('error');
    this.client.on('error', () => undefined);
    try {
      await withTimeout(this.client.end(), 5000, 'end timeout');
    } catch (error) {
      log.debug(`[${this.id}] 종료 실패 (무시)`, error);
    }
  }
}

const catalog: CatalogQueries = {
  async defaultSchema(conn): Promise<string> {
    const result = await conn.execute(
      'SELECT current_schema()',
      undefined,
      defaultCatalogOptions(),
    );
    return String(result.rows[0]?.[0] ?? 'public');
  },

  async listSchemas(conn): Promise<SchemaInfo[]> {
    const result = await conn.execute(
      `SELECT nspname, nspname = current_schema() AS is_default
         FROM pg_catalog.pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%'
          AND nspname <> 'information_schema'
        ORDER BY nspname`,
      undefined,
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      isDefault: row[1] === true || row[1] === 'true' || row[1] === 't',
    }));
  },

  async listTables(conn, schema): Promise<TableInfo[]> {
    const result = await conn.execute(
      `SELECT c.relname,
              c.relkind,
              obj_description(c.oid, 'pg_class') AS comment,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples END AS est_rows
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind = ANY (ARRAY['r','p','v','m','f'])
        ORDER BY c.relname`,
      [schema],
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      schema,
      name: String(row[0]),
      kind: pgRelKind(String(row[1])),
      comment: row[2] === null ? undefined : String(row[2]),
      estimatedRows: row[3] === null ? undefined : Math.max(0, Math.round(Number(row[3]))),
    }));
  },

  async listOtherObjects(conn, schema): Promise<DbObject[]> {
    const objects: DbObject[] = [];

    await collect<DbObject>(objects, async () => {
      const result = await conn.execute(
        `SELECT c.relname, obj_description(c.oid, 'pg_class')
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'S'
          ORDER BY c.relname`,
        [schema],
        defaultCatalogOptions(),
      );
      return result.rows.map((row) => ({
        schema,
        name: String(row[0]),
        kind: 'sequence' as const,
        comment: row[1] === null ? undefined : String(row[1]),
      }));
    });

    // prokind 는 PostgreSQL 11 부터다. 실패하면 그냥 루틴 목록을 비운다 —
    // 구버전 호환을 위해 별도 분기를 두는 것보다 조용히 없는 편이 낫다.
    await collect(objects, async () => {
      const result = await conn.execute(
        `SELECT p.proname,
                p.prokind,
                pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                obj_description(p.oid, 'pg_proc') AS comment
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1
            AND p.prokind IN ('f', 'p')
          ORDER BY p.proname`,
        [schema],
        defaultCatalogOptions(),
      );
      return result.rows.map((row) => ({
        schema,
        name: String(row[0]),
        kind: String(row[1]) === 'p' ? ('procedure' as const) : ('function' as const),
        detail: row[2] ? `(${String(row[2])})` : '()',
        comment: row[3] === null ? undefined : String(row[3]),
      }));
    });

    return objects;
  },

  async listColumns(conn, schema): Promise<ColumnInfo[]> {
    const result = await conn.execute(
      `SELECT c.relname                                        AS table_name,
              a.attname                                        AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod)  AS data_type,
              NOT a.attnotnull                                 AS is_nullable,
              pg_get_expr(d.adbin, d.adrelid)                  AS default_value,
              COALESCE(pk.is_pk, false)                        AS is_pk,
              col_description(c.oid, a.attnum)                 AS comment,
              a.attnum                                         AS ordinal
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c     ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_attrdef d
                ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN LATERAL (
              SELECT true AS is_pk
                FROM pg_catalog.pg_index i
               WHERE i.indrelid = c.oid
                 AND i.indisprimary
                 AND a.attnum = ANY (i.indkey)
               LIMIT 1
         ) pk ON true
        WHERE n.nspname = $1
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND c.relkind = ANY (ARRAY['r','p','v','m','f'])
        ORDER BY c.relname, a.attnum`,
      [schema],
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      schema,
      table: String(row[0]),
      name: String(row[1]),
      typeName: String(row[2]),
      nullable: row[3] === true || row[3] === 'true' || row[3] === 't',
      defaultValue: row[4] === null ? undefined : String(row[4]),
      isPrimaryKey: row[5] === true || row[5] === 'true' || row[5] === 't',
      comment: row[6] === null ? undefined : String(row[6]),
      ordinal: Number(row[7]),
    }));
  },

  async listIndexes(conn, schema, table): Promise<IndexInfo[]> {
    // 식 인덱스는 attname 이 비므로 pg_get_indexdef 로 식 텍스트를 얻는다.
    const result = await conn.execute(
      `SELECT i.relname AS index_name,
              ix.indisunique AS is_unique,
              COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.ord::int, true)) AS column_name
         FROM pg_catalog.pg_index ix
         JOIN pg_catalog.pg_class i     ON i.oid = ix.indexrelid
         JOIN pg_catalog.pg_class c     ON c.oid = ix.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         LEFT JOIN pg_catalog.pg_attribute a
                ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND c.relname = $2
        ORDER BY i.relname, k.ord`,
      [schema, table],
      defaultCatalogOptions(),
    );
    return groupIndexRows(
      schema,
      table,
      result.rows.map((row) => ({
        name: String(row[0]),
        unique: row[1] === true || row[1] === 't' || row[1] === 'true',
        column: row[2] === null ? '(식)' : String(row[2]),
      })),
    );
  },

  async listForeignKeys(conn, schema, table, direction): Promise<ForeignKeyInfo[]> {
    // 출발 테이블(cl) 기준인지 참조 대상(fcl) 기준인지만 다르다.
    const where =
      direction === 'outgoing'
        ? 'ns.nspname = $1 AND cl.relname = $2'
        : 'fns.nspname = $1 AND fcl.relname = $2';

    const result = await conn.execute(
      `SELECT con.conname,
              ns.nspname   AS src_schema,
              cl.relname   AS src_table,
              a.attname    AS src_column,
              fns.nspname  AS ref_schema,
              fcl.relname  AS ref_table,
              fa.attname   AS ref_column,
              con.confdeltype,
              con.confupdtype
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class cl      ON cl.oid = con.conrelid
         JOIN pg_catalog.pg_namespace ns  ON ns.oid = cl.relnamespace
         JOIN pg_catalog.pg_class fcl     ON fcl.oid = con.confrelid
         JOIN pg_catalog.pg_namespace fns ON fns.oid = fcl.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
                     WITH ORDINALITY AS k(src_attnum, ref_attnum, ord)
         LEFT JOIN pg_catalog.pg_attribute a
                ON a.attrelid = cl.oid AND a.attnum = k.src_attnum
         LEFT JOIN pg_catalog.pg_attribute fa
                ON fa.attrelid = fcl.oid AND fa.attnum = k.ref_attnum
        WHERE con.contype = 'f' AND ${where}
        ORDER BY con.conname, k.ord`,
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
        onDelete: pgReferentialAction(row[7] ?? null),
        onUpdate: pgReferentialAction(row[8] ?? null),
      })),
    );
  },

  async objectAttributes(conn, ref): Promise<DetailAttribute[]> {
    if (ref.kind === 'sequence') {
      // pg_sequences 는 PostgreSQL 10+ 다. 구버전에서는 실패하고 호출부가 넘어간다.
      const result = await conn.execute(
        `SELECT last_value, start_value, increment_by, min_value, max_value, cache_size, cycle
           FROM pg_catalog.pg_sequences
          WHERE schemaname = $1 AND sequencename = $2`,
        [ref.schema, ref.name],
        defaultCatalogOptions(),
      );
      const row = result.rows[0];
      if (!row) {
        return [];
      }
      return buildAttributes([
        ['마지막 값', row[0]],
        ['시작값', row[1]],
        ['증가치', row[2]],
        ['최솟값', row[3]],
        ['최댓값', row[4]],
        ['캐시', row[5]],
        ['순환', row[6]],
      ]);
    }

    if (ref.kind === 'function' || ref.kind === 'procedure') {
      const result = await conn.execute(
        `SELECT pg_get_function_result(p.oid)     AS result_type,
                l.lanname                          AS language,
                CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE'
                                   WHEN 's' THEN 'STABLE'
                                   ELSE 'VOLATILE' END AS volatility,
                pg_get_userbyid(p.proowner)        AS owner
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_catalog.pg_language l  ON l.oid = p.prolang
          WHERE n.nspname = $1 AND p.proname = $2
          ORDER BY p.oid
          LIMIT 1`,
        [ref.schema, ref.name],
        defaultCatalogOptions(),
      );
      const row = result.rows[0];
      if (!row) {
        return [];
      }
      return buildAttributes([
        ['반환 타입', row[0]],
        ['언어', row[1]],
        ['휘발성', row[2]],
        ['소유자', row[3]],
      ]);
    }

    const result = await conn.execute(
      `SELECT pg_get_userbyid(c.relowner)                     AS owner,
              pg_size_pretty(pg_total_relation_size(c.oid))   AS total_size,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples END AS est_rows,
              COALESCE(t.spcname, 'pg_default')               AS tablespace,
              c.relhasindex                                   AS has_index,
              CASE c.relpersistence WHEN 'u' THEN 'UNLOGGED'
                                    WHEN 't' THEN 'TEMPORARY'
                                    ELSE 'PERMANENT' END      AS persistence
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_tablespace t ON t.oid = c.reltablespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [ref.schema, ref.name],
      defaultCatalogOptions(),
    );
    const row = result.rows[0];
    if (!row) {
      return [];
    }
    return buildAttributes([
      ['소유자', row[0]],
      ['전체 크기', row[1]],
      ['예상 행 수', formatCount(row[2] ?? null)],
      ['테이블스페이스', row[3]],
      ['지속성', row[5]],
    ]);
  },

  async objectDefinition(conn, ref): Promise<string | undefined> {
    if (ref.kind === 'view' || ref.kind === 'materialized-view') {
      const result = await conn.execute(
        `SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true)`,
        [ref.schema, ref.name],
        defaultCatalogOptions(),
      );
      const value = result.rows[0]?.[0];
      return value === null || value === undefined ? undefined : String(value);
    }

    if (ref.kind === 'function' || ref.kind === 'procedure') {
      // 오버로드가 있으면 여러 정의가 나온다 — 전부 이어 붙여 보여 준다.
      const result = await conn.execute(
        `SELECT pg_get_functiondef(p.oid)
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = $2
          ORDER BY p.oid`,
        [ref.schema, ref.name],
        defaultCatalogOptions(),
      );
      const definitions = result.rows
        .map((row) => (row[0] === null ? '' : String(row[0])))
        .filter((text) => text.length > 0);
      return definitions.length === 0 ? undefined : definitions.join('\n\n');
    }

    // 테이블은 서버가 DDL 을 만들어 주지 않는다 — 호출부가 근사 DDL 을 만든다.
    return undefined;
  },
};

function pgRelKind(relkind: string): TableInfo['kind'] {
  switch (relkind) {
    case 'v':
      return 'view';
    case 'm':
      return 'materialized-view';
    default:
      return 'table';
  }
}

function defaultCatalogOptions(): QueryOptions {
  return { maxRows: 100_000, timeoutMs: 30_000 };
}

/** 카탈로그 하위 조회 하나가 실패해도 나머지는 살린다. */
async function collect<T>(into: T[], load: () => Promise<T[]>): Promise<void> {
  try {
    into.push(...(await load()));
  } catch (error) {
    log.debug('카탈로그 하위 조회 실패 (건너뜀)', error);
  }
}

export function createPostgresDriver(): Driver {
  return {
    dialect: 'postgres',
    catalog,

    /** PostgreSQL 은 한 컬럼짜리 여러 행으로 계획을 준다 — 그대로 이어 붙인다. */
    async explain(conn, sql, explainOptions, options): Promise<ExplainOutcome> {
      const flags = explainOptions.analyze
        ? '(ANALYZE, BUFFERS, VERBOSE, COSTS, FORMAT TEXT)'
        : '(VERBOSE, COSTS, FORMAT TEXT)';
      const result = await conn.execute(`EXPLAIN ${flags} ${sql}`, undefined, options);
      return { text: result.rows.map((row) => String(row[0] ?? '')).join('\n') };
    },

    async connect(profile, password, signal): Promise<RawConnection> {
      const pg = await loadPg();
      const config = await buildConfig(profile, password);

      const open = async (): Promise<PgClient> => {
        const client = new pg.Client(config);
        // connect 실패 시 error 리스너가 없으면 프로세스가 죽는다.
        client.on('error', () => undefined);
        await client.connect();
        return client;
      };

      let client: PgClient;
      try {
        client = await Promise.race([
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

      const connection = new PostgresConnection(client, open);
      if (profile.readOnly) {
        await connection.setSessionReadOnly(true);
      }
      return connection;
    },

    buildPreviewQuery(schema, table, limit): string {
      return `SELECT * FROM ${quoteQualified(schema, table, 'postgres')} LIMIT ${Math.floor(limit)}`;
    },

    applyRowLimit(sql, limit): string {
      return applyRowLimit(sql, limit, 'postgres').sql;
    },

    placeholder(index: number): string {
      // PostgreSQL 확장 프로토콜의 위치 매개변수.
      return `$${index}`;
    },
  };
}

/** PostgreSQL 오류의 position/detail/hint 를 메시지에 살려 둔다. */
function enrichPgError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const e = error as Error & { detail?: string; hint?: string; position?: string; code?: string };
  const extras: string[] = [];
  if (e.detail) {
    extras.push(`상세: ${e.detail}`);
  }
  if (e.hint) {
    extras.push(`힌트: ${e.hint}`);
  }
  if (e.position) {
    extras.push(`위치: ${e.position}번째 문자`);
  }
  if (extras.length > 0 && !error.message.includes(extras[0]!)) {
    error.message = `${error.message}\n${extras.join('\n')}`;
  }
  return error;
}

function toConnectError(error: unknown, profile: ConnectionProfile): ConnectError {
  const code = (error as { code?: string } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);

  switch (code) {
    case '28P01':
    case '28000':
      return new ConnectError(`인증에 실패했습니다. 사용자 "${profile.user}" 의 비밀번호를 확인하세요.`, code);
    case '3D000':
      return new ConnectError(`데이터베이스 "${profile.database}" 를 찾을 수 없습니다.`, code);
    case 'ECONNREFUSED':
      return new ConnectError(`${profile.host}:${profile.port} 에 연결할 수 없습니다. 서버가 실행 중인지, listen_addresses 설정을 확인하세요.`, code);
    case 'ENOTFOUND':
      return new ConnectError(`호스트 "${profile.host}" 를 찾을 수 없습니다.`, code);
    default:
      if (/no pg_hba\.conf entry/i.test(message)) {
        return new ConnectError(`서버가 이 클라이언트의 접속을 허용하지 않습니다 (pg_hba.conf). ${message}`, code);
      }
      if (/self[- ]signed certificate|unable to verify/i.test(message)) {
        return new ConnectError(
          `서버 인증서를 검증하지 못했습니다. 사설 CA 를 사용한다면 연결 설정에서 CA 파일 경로를 지정하세요. (${message})`,
          code,
        );
      }
      return new ConnectError(message, code);
  }
}

/** 자주 쓰이는 PostgreSQL 타입 OID → 이름. */
const PG_TYPES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  600: 'point',
  700: 'float4',
  701: 'float8',
  790: 'money',
  829: 'macaddr',
  869: 'inet',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  3904: 'int4range',
  3926: 'int8range',
};
