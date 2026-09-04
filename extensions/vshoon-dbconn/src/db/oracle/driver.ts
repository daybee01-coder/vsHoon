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
  ObjectRef,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
} from '../../types';
import { quoteQualified } from '../../sql/identifier';
import { abortPromise, CancelledError, TimeoutError, withTimeout } from '../../util/async';
import { log } from '../../util/logger';
import {
  ConnectError,
  DriverLoadError,
  type CatalogQueries,
  type Driver,
  type RawConnection,
} from '../driver';
import { toCellValue } from '../serialize';
import {
  buildAttributes,
  formatCount,
  groupForeignKeyRows,
  groupIndexRows,
} from '../catalogDetail';

/**
 * Oracle 드라이버 (oracledb thin 모드).
 *
 * thin 모드는 Oracle Instant Client 설치 없이 순수 JS 로 동작한다 (12.1 이상 서버).
 * 다른 방언과 다른 점 둘:
 *  - 행 수 제한을 SQL 재작성 대신 드라이버의 maxRows 로 처리한다 (더 안전).
 *  - 취소가 connection.break() 로 네이티브 지원된다 — 별도 커넥션이 필요 없다.
 */

interface OracleMetaData {
  name: string;
  dbTypeName?: string;
  nullable?: boolean;
  precision?: number;
  scale?: number;
}

interface OracleResult {
  rows?: unknown[][];
  metaData?: OracleMetaData[];
  rowsAffected?: number;
  outBinds?: unknown;
}

interface OracleConnection {
  execute(sql: string, binds: unknown, options: Record<string, unknown>): Promise<OracleResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(options?: Record<string, unknown>): Promise<void>;
  break(): Promise<void>;
  ping(): Promise<void>;
}

interface OracleModule {
  getConnection(config: Record<string, unknown>): Promise<OracleConnection>;
  OUT_FORMAT_ARRAY: number;
  DB_TYPE_CLOB: number;
  DB_TYPE_NCLOB: number;
  DB_TYPE_BLOB: number;
  STRING: number;
  BUFFER: number;
  fetchAsString: number[];
  fetchAsBuffer: number[];
  autoCommit: boolean;
  initOracleClient?(options: Record<string, unknown>): void;
  thin?: boolean;
}

let cachedModule: OracleModule | undefined;

async function loadOracle(): Promise<OracleModule> {
  if (cachedModule) {
    return cachedModule;
  }
  try {
    const mod = (await import('oracledb')) as unknown as OracleModule & { default?: OracleModule };
    const resolved = mod.default ?? mod;

    // LOB 은 스트림 핸들로 오면 다루기 번거롭다. 문자열/버퍼로 바로 받는다.
    resolved.fetchAsString = [resolved.DB_TYPE_CLOB, resolved.DB_TYPE_NCLOB];
    resolved.fetchAsBuffer = [resolved.DB_TYPE_BLOB];
    // 자동 커밋은 확장이 직접 관리한다 — 드라이버 기본값에 맡기지 않는다.
    resolved.autoCommit = false;

    cachedModule = resolved;
    return resolved;
  } catch (error) {
    throw new DriverLoadError('oracle', error);
  }
}

/** EZConnect 접속 서술자를 만든다. */
function buildConnectString(profile: ConnectionProfile): string {
  const custom = profile.oracle?.connectString?.trim();
  if (custom) {
    return custom;
  }
  const host = profile.host;
  const port = profile.port;
  const target = profile.database;
  if (profile.oracle?.connectType === 'sid') {
    // SID 는 EZConnect 로 표현할 수 없어 완전한 서술자를 쓴다.
    return (
      `(DESCRIPTION=(ADDRESS=(PROTOCOL=${profile.tls.enabled ? 'TCPS' : 'TCP'})` +
      `(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${target})))`
    );
  }
  return `${host}:${port}/${target}`;
}

class OracleRawConnection implements RawConnection {
  readonly id = `ora-${randomUUID().slice(0, 8)}`;
  readonly createdAt = Date.now();
  readonly backendId = undefined;
  private txOpen = false;
  /** 읽기 전용 프로필인가. 트랜잭션을 열 때 서버 쪽 잠금을 함께 건다. */
  private readOnly = false;
  private closed = false;
  /** 실행 중 여부 — break() 를 헛되이 부르지 않기 위해. */
  private busy = false;

  constructor(
    private readonly conn: OracleConnection,
    private readonly oracledb: OracleModule,
  ) {}

  get inTransaction(): boolean {
    return this.txOpen;
  }

  async execute(
    sql: string,
    params: readonly unknown[] | undefined,
    options: QueryOptions,
  ): Promise<QueryResult> {
    const started = Date.now();
    this.busy = true;

    // Oracle 은 SQL 끝의 세미콜론을 문법 오류로 본다 (PL/SQL 블록은 예외).
    const cleaned = stripTrailingSemicolon(sql);

    const run = this.conn.execute(cleaned, params ? [...params] : [], {
      outFormat: this.oracledb.OUT_FORMAT_ARRAY,
      // SQL 을 고치지 않고 드라이버가 페치를 멈춘다 — 가장 안전한 행 수 제한.
      maxRows: options.maxRows,
      // 자동 커밋은 세션 관리자가 결정한다.
      autoCommit: false,
      // 배열 페치 크기 — 왕복을 줄인다.
      fetchArraySize: Math.min(1000, Math.max(100, options.maxRows)),
    });

    let result: OracleResult;
    try {
      result = await Promise.race([
        withTimeout(run, options.timeoutMs, `쿼리가 ${options.timeoutMs}ms 안에 끝나지 않았습니다.`),
        abortPromise(options.signal),
      ]);
    } catch (error) {
      // break() 는 "지금 서버에서 돌고 있는 호출"을 끊는 신호다. race 에서
      // 타임아웃/취소가 이겨서 여기 온 경우에만 그 호출이 실제로 남아 있다.
      // run(실제 conn.execute) 자체가 던진 에러(ORA-00900 같은 SQL 오류 등)는
      // 서버가 이미 응답을 끝낸 뒤라 끊을 대상이 없는데, 그런데도 break() 를
      // 부르면 이 신호가 다음에 보내는 구문을 붙잡아 ORA-01013 으로 만들어
      // 버린다 — "재연결해야 풀린다"는 증상이 여기서 나온다.
      if (error instanceof TimeoutError || error instanceof CancelledError) {
        await this.cancel().catch(() => undefined);
      }
      throw error;
    } finally {
      this.busy = false;
    }

    const durationMs = Date.now() - started;

    if (!result.metaData || result.metaData.length === 0) {
      // DML/DDL — 영향 행 수만 있다.
      const affected = result.rowsAffected ?? 0;
      if (affected > 0 || isTransactional(cleaned)) {
        this.txOpen = true;
      }
      return {
        kind: 'update',
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: affected,
        truncated: false,
        durationMs,
        messages: [],
        sql,
      };
    }

    const columns: ColumnMeta[] = result.metaData.map((meta, index) => ({
      name: meta.name,
      typeName: oracleTypeName(meta),
      nullable: meta.nullable,
      index,
    }));

    const rows = (result.rows ?? []).map((row) => row.map(toCellValue));
    return {
      kind: 'rows',
      columns,
      rows,
      rowCount: rows.length,
      // maxRows 만큼 정확히 왔다면 더 있을 가능성이 높다.
      truncated: rows.length >= options.maxRows,
      durationMs,
      messages: [],
      sql,
    };
  }

  /**
   * Oracle 에는 명시적 BEGIN 이 없다 — 첫 DML 이 트랜잭션을 연다.
   * 상태만 표시해 두고 commit/rollback 시점에 정리한다.
   *
   * 읽기 전용 연결이면 여기서 `SET TRANSACTION READ ONLY` 를 건다. 이 자리가
   * 맞는 이유는 하나다: **이 트랜잭션은 반드시 끝난다** — 사용자가 커밋/롤백하거나,
   * 풀이 반납 시점에 롤백하거나, 자니터가 회수한다. 커넥션이 태어날 때 걸면
   * 끝내 줄 사람이 아무도 없다 (setSessionReadOnly 설명 참고).
   */
  async begin(): Promise<void> {
    this.txOpen = true;
    if (!this.readOnly) {
      return;
    }
    try {
      // 트랜잭션의 첫 구문이어야 한다. 이후 DML 은 ORA-01456 으로 거부된다.
      await this.conn.execute('SET TRANSACTION READ ONLY', [], { autoCommit: false });
    } catch (error) {
      log.debug(`[${this.id}] 읽기 전용 트랜잭션 설정 실패 (무시)`, error);
    }
  }

  async commit(): Promise<void> {
    try {
      await this.conn.commit();
    } finally {
      this.txOpen = false;
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.conn.rollback();
    } finally {
      this.txOpen = false;
    }
  }

  /**
   * 읽기 전용 표시.
   *
   * **여기서 구문을 보내지 않는다.** Oracle 에는 세션 단위 읽기 전용이 없고,
   * `SET TRANSACTION READ ONLY` 는 이름 그대로 **트랜잭션을 연다**
   * (MySQL 의 `SET SESSION ...`, PostgreSQL 의 `SET SESSION CHARACTERISTICS ...`
   * 와 결정적으로 다른 점이다).
   *
   * 커넥션이 태어날 때 걸어 두면 그 트랜잭션이 커넥션 수명(기본 30분) 내내
   * 열린 채로 남고, 두 가지가 따라온다:
   *
   *  1. **옛 데이터를 본다.** 읽기 일관성 스냅샷이 그 시점에 고정되므로,
   *     이후 조회는 30분 전 상태를 돌려준다. 운영 데이터를 확인하러 붙은
   *     사람에게 이건 조용한 오답이다.
   *  2. **undo 를 붙든다.** 그 스냅샷을 되돌릴 undo 를 서버가 계속 보관해야 해서,
   *     쓰기가 많은 DB 에서는 undo 압박(다른 세션의 ORA-01555, 심하면 쓰기 쪽
   *     ORA-30036)으로 번진다.
   *
   * 게다가 이 구문은 커넥션 래퍼를 거치지 않아 `inTransaction` 이 false 로 남았고,
   * 그래서 "반납 시 열린 트랜잭션은 롤백한다"는 풀의 안전장치도 비껴갔다.
   *
   * 변경 구문 차단은 실행 전 클라이언트 검사(assertAllowedInReadOnly)가 이미 한다.
   * 서버 쪽 이중 잠금은 트랜잭션이 실제로 열릴 때(begin) 걸면 범위가 정확해진다.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- 인터페이스가 Promise 를 요구한다
  async setSessionReadOnly(readOnly: boolean): Promise<void> {
    this.readOnly = readOnly;
  }

  async cancel(): Promise<void> {
    if (!this.busy) {
      return;
    }
    try {
      // break() 는 진행 중인 호출을 ORA-01013 으로 중단시킨다.
      await this.conn.break();
      log.debug(`[${this.id}] break() 전송`);
    } catch (error) {
      log.debug(`[${this.id}] 쿼리 취소 실패`, error);
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
      await withTimeout(this.conn.close(), 5000, 'close timeout');
    } catch (error) {
      log.debug(`[${this.id}] 종료 실패 — drop 시도`, error);
      try {
        await this.conn.close({ drop: true });
      } catch {
        /* 이미 닫힘 */
      }
    }
  }
}

/** 트랜잭션을 여는 구문인지 (Oracle 은 암묵적으로 시작된다). */
function isTransactional(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|MERGE|BEGIN|DECLARE)\b/i.test(sql);
}

/** Oracle 은 단일 SQL 끝의 세미콜론을 허용하지 않는다. PL/SQL 블록은 필요하다. */
function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim();
  if (/\bEND\s*;$/i.test(trimmed) || /^\s*(BEGIN|DECLARE)\b/i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/;+$/, '');
}

const catalog: CatalogQueries = {
  async defaultSchema(conn): Promise<string> {
    const result = await conn.execute(
      `SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL`,
      undefined,
      defaultCatalogOptions(),
    );
    return String(result.rows[0]?.[0] ?? '');
  },

  async listSchemas(conn): Promise<SchemaInfo[]> {
    // ALL_USERS 는 접근 가능한 스키마만 보여준다. DBA_ 뷰는 권한이 없을 수 있다.
    const result = await conn.execute(
      `SELECT u.USERNAME,
              CASE WHEN u.USERNAME = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') THEN 1 ELSE 0 END
         FROM ALL_USERS u
        ORDER BY u.USERNAME`,
      undefined,
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      isDefault: Number(row[1]) === 1,
    }));
  },

  async listTables(conn, schema): Promise<TableInfo[]> {
    const result = await conn.execute(
      `SELECT o.OBJECT_NAME, o.OBJECT_TYPE, c.COMMENTS, t.NUM_ROWS
         FROM ALL_OBJECTS o
         LEFT JOIN ALL_TAB_COMMENTS c
                ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME
         LEFT JOIN ALL_TABLES t
                ON t.OWNER = o.OWNER AND t.TABLE_NAME = o.OBJECT_NAME
        WHERE o.OWNER = :owner
          AND o.OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
        ORDER BY o.OBJECT_NAME`,
      [schema],
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      schema,
      name: String(row[0]),
      kind: oracleObjectKind(String(row[1])),
      comment: row[2] === null ? undefined : String(row[2]),
      estimatedRows: row[3] === null ? undefined : Number(row[3]),
    }));
  },

  async listOtherObjects(conn, schema): Promise<DbObject[]> {
    // Oracle 은 모든 객체가 ALL_OBJECTS 한 곳에 있어 한 번에 읽을 수 있다.
    const result = await conn.execute(
      `SELECT o.OBJECT_NAME, o.OBJECT_TYPE, s.TABLE_OWNER, s.TABLE_NAME
         FROM ALL_OBJECTS o
         LEFT JOIN ALL_SYNONYMS s
                ON s.OWNER = o.OWNER AND s.SYNONYM_NAME = o.OBJECT_NAME
        WHERE o.OWNER = :owner
          AND o.OBJECT_TYPE IN
              ('SEQUENCE', 'FUNCTION', 'PROCEDURE', 'PACKAGE', 'SYNONYM', 'TYPE')
        ORDER BY o.OBJECT_TYPE, o.OBJECT_NAME`,
      [schema],
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => {
      const target =
        row[2] !== null && row[3] !== null ? `→ ${String(row[2])}.${String(row[3])}` : undefined;
      return {
        schema,
        name: String(row[0]),
        kind: oracleOtherKind(String(row[1])),
        detail: target,
      };
    });
  },

  async listColumns(conn, schema): Promise<ColumnInfo[]> {
    const result = await conn.execute(
      `SELECT c.TABLE_NAME,
              c.COLUMN_NAME,
              c.DATA_TYPE,
              c.DATA_LENGTH,
              c.DATA_PRECISION,
              c.DATA_SCALE,
              c.NULLABLE,
              c.DATA_DEFAULT,
              cc.COMMENTS,
              c.COLUMN_ID,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
         FROM ALL_TAB_COLUMNS c
         LEFT JOIN ALL_COL_COMMENTS cc
                ON cc.OWNER = c.OWNER
               AND cc.TABLE_NAME = c.TABLE_NAME
               AND cc.COLUMN_NAME = c.COLUMN_NAME
         LEFT JOIN (
              SELECT acc.OWNER, acc.TABLE_NAME, acc.COLUMN_NAME
                FROM ALL_CONSTRAINTS ac
                JOIN ALL_CONS_COLUMNS acc
                  ON acc.OWNER = ac.OWNER
                 AND acc.CONSTRAINT_NAME = ac.CONSTRAINT_NAME
               WHERE ac.CONSTRAINT_TYPE = 'P'
                 AND ac.OWNER = :owner1
         ) pk ON pk.OWNER = c.OWNER
             AND pk.TABLE_NAME = c.TABLE_NAME
             AND pk.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.OWNER = :owner2
        ORDER BY c.TABLE_NAME, c.COLUMN_ID`,
      [schema, schema],
      defaultCatalogOptions(),
    );
    return result.rows.map((row) => ({
      schema,
      table: String(row[0]),
      name: String(row[1]),
      typeName: formatOracleType(
        String(row[2]),
        toNumber(row[3]),
        toNumber(row[4]),
        toNumber(row[5]),
      ),
      nullable: String(row[6]).toUpperCase() === 'Y',
      defaultValue: row[7] === null ? undefined : String(row[7]).trim(),
      isPrimaryKey: Number(row[10]) === 1,
      comment: row[8] === null ? undefined : String(row[8]),
      ordinal: Number(row[9] ?? 0),
    }));
  },

  async listIndexes(conn, schema, table): Promise<IndexInfo[]> {
    const result = await conn.execute(
      `SELECT i.INDEX_NAME, i.UNIQUENESS, c.COLUMN_NAME
         FROM ALL_INDEXES i
         JOIN ALL_IND_COLUMNS c
           ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME
        WHERE i.TABLE_OWNER = :owner AND i.TABLE_NAME = :name
        ORDER BY i.INDEX_NAME, c.COLUMN_POSITION`,
      [schema, table],
      defaultCatalogOptions(),
    );
    return groupIndexRows(
      schema,
      table,
      result.rows.map((row) => ({
        name: String(row[0]),
        unique: String(row[1]).toUpperCase() === 'UNIQUE',
        column: row[2] === null ? '(식)' : String(row[2]),
      })),
    );
  },

  async listForeignKeys(conn, schema, table, direction): Promise<ForeignKeyInfo[]> {
    // 참조 대상 컬럼은 상대 제약(R_CONSTRAINT_NAME)의 컬럼을 같은 POSITION 으로 맞춘다.
    const where =
      direction === 'outgoing'
        ? 'c.OWNER = :owner AND c.TABLE_NAME = :name'
        : 'rc.OWNER = :owner AND rc.TABLE_NAME = :name';

    const result = await conn.execute(
      `SELECT c.CONSTRAINT_NAME, c.OWNER, c.TABLE_NAME, cc.COLUMN_NAME,
              rc.OWNER AS R_OWNER, rc.TABLE_NAME AS R_TABLE, rcc.COLUMN_NAME AS R_COLUMN,
              c.DELETE_RULE
         FROM ALL_CONSTRAINTS c
         JOIN ALL_CONS_COLUMNS cc
           ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
         JOIN ALL_CONSTRAINTS rc
           ON rc.OWNER = c.R_OWNER AND rc.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
         JOIN ALL_CONS_COLUMNS rcc
           ON rcc.OWNER = rc.OWNER
          AND rcc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
          AND rcc.POSITION = cc.POSITION
        WHERE c.CONSTRAINT_TYPE = 'R' AND ${where}
        ORDER BY c.CONSTRAINT_NAME, cc.POSITION`,
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
        // Oracle 은 UPDATE 규칙을 지원하지 않는다 (항상 NO ACTION).
        onDelete: row[7] === null ? undefined : String(row[7]),
      })),
    );
  },

  async objectAttributes(conn, ref): Promise<DetailAttribute[]> {
    if (ref.kind === 'sequence') {
      const result = await conn.execute(
        `SELECT LAST_NUMBER, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, CACHE_SIZE
           FROM ALL_SEQUENCES
          WHERE SEQUENCE_OWNER = :owner AND SEQUENCE_NAME = :name`,
        [ref.schema, ref.name],
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
        ['증가치', row[3]],
        ['순환', row[4]],
        ['캐시', row[5]],
      ]);
    }

    const attributes: DetailAttribute[] = [];

    if (ref.kind === 'table' || ref.kind === 'materialized-view') {
      const result = await conn.execute(
        `SELECT t.TABLESPACE_NAME, t.NUM_ROWS, t.LAST_ANALYZED, t.PARTITIONED, t.TEMPORARY
           FROM ALL_TABLES t
          WHERE t.OWNER = :owner AND t.TABLE_NAME = :name`,
        [ref.schema, ref.name],
        defaultCatalogOptions(),
      );
      const row = result.rows[0];
      if (row) {
        attributes.push(
          ...buildAttributes([
            ['테이블스페이스', row[0]],
            ['통계상 행 수', formatCount(row[1] ?? null)],
            ['마지막 분석', row[2]],
            ['파티션', row[3]],
            ['임시 테이블', row[4]],
          ]),
        );
      }
    }

    // 상태·생성 시각은 모든 종류에 공통이다.
    const meta = await conn.execute(
      `SELECT OBJECT_TYPE, STATUS, CREATED, LAST_DDL_TIME
         FROM ALL_OBJECTS
        WHERE OWNER = :owner AND OBJECT_NAME = :name
        ORDER BY OBJECT_TYPE
        FETCH FIRST 1 ROWS ONLY`,
      [ref.schema, ref.name],
      defaultCatalogOptions(),
    );
    const metaRow = meta.rows[0];
    if (metaRow) {
      attributes.push(
        ...buildAttributes([
          ['종류', metaRow[0]],
          ['상태', metaRow[1]],
          ['생성', metaRow[2]],
          ['마지막 DDL', metaRow[3]],
        ]),
      );
    }
    return attributes;
  },

  async objectDefinition(conn, ref): Promise<string | undefined> {
    const type = DBMS_METADATA_TYPE[ref.kind];
    if (!type) {
      return undefined;
    }
    // CLOB 은 커넥션 설정(fetchAsString)에 의해 문자열로 온다.
    const result = await conn.execute(
      `SELECT DBMS_METADATA.GET_DDL(:type, :name, :owner) FROM DUAL`,
      [type, ref.name, ref.schema],
      defaultCatalogOptions(),
    );
    const value = result.rows[0]?.[0];
    const text = value === null || value === undefined ? '' : String(value).trim();
    return text.length === 0 ? undefined : text;
  },
};

/**
 * DBMS_METADATA.GET_DDL 의 객체 종류.
 * 권한이 없으면 ORA-31603 으로 실패하고, 호출부가 근사 DDL 로 넘어간다.
 */
const DBMS_METADATA_TYPE: Partial<Record<ObjectRef['kind'], string>> = {
  table: 'TABLE',
  view: 'VIEW',
  'materialized-view': 'MATERIALIZED_VIEW',
  sequence: 'SEQUENCE',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  package: 'PACKAGE',
  synonym: 'SYNONYM',
  type: 'TYPE',
};

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function oracleOtherKind(objectType: string): DbObject['kind'] {
  switch (objectType) {
    case 'SEQUENCE':
      return 'sequence';
    case 'PROCEDURE':
      return 'procedure';
    case 'PACKAGE':
      return 'package';
    case 'SYNONYM':
      return 'synonym';
    case 'TYPE':
      return 'type';
    default:
      return 'function';
  }
}

function oracleObjectKind(objectType: string): TableInfo['kind'] {
  switch (objectType) {
    case 'VIEW':
      return 'view';
    case 'MATERIALIZED VIEW':
      return 'materialized-view';
    default:
      return 'table';
  }
}

function formatOracleType(
  dataType: string,
  length: number | undefined,
  precision: number | undefined,
  scale: number | undefined,
): string {
  if (dataType === 'NUMBER') {
    if (precision === undefined) {
      return 'NUMBER';
    }
    return scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  }
  if (/CHAR|RAW/.test(dataType) && length !== undefined) {
    return `${dataType}(${length})`;
  }
  return dataType;
}

function oracleTypeName(meta: OracleMetaData): string {
  const base = meta.dbTypeName ?? 'UNKNOWN';
  if (base === 'NUMBER' && meta.precision) {
    return meta.scale ? `NUMBER(${meta.precision},${meta.scale})` : `NUMBER(${meta.precision})`;
  }
  return base;
}

function defaultCatalogOptions(): QueryOptions {
  return { maxRows: 100_000, timeoutMs: 30_000 };
}

export function createOracleDriver(): Driver {
  return {
    dialect: 'oracle',
    catalog,

    /**
     * Oracle 은 두 단계다: 계획을 PLAN_TABLE 에 넣고, DBMS_XPLAN 으로 읽는다.
     * PLAN_TABLE 은 세션 단위라 **같은 커넥션**에서 두 구문을 실행해야 한다.
     *
     * 실제 수행하며 측정하는 방식(GATHER_PLAN_STATISTICS + DISPLAY_CURSOR)은
     * 지원하지 않는다 — 구문을 실제로 돌려야 해서 위험이 크고, 힌트를 넣으려면
     * 사용자 SQL 을 고쳐야 한다.
     */
    async explain(conn, sql, explainOptions, options): Promise<ExplainOutcome> {
      // 문장 끝 세미콜론이 남아 있으면 EXPLAIN PLAN FOR 가 실패한다.
      const target = sql.replace(/[\s;]+$/, '');
      await conn.execute(`EXPLAIN PLAN FOR ${target}`, undefined, options);
      const plan = await conn.execute(
        'SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())',
        undefined,
        options,
      );
      const text = plan.rows.map((row) => String(row[0] ?? '')).join('\n');
      return {
        text,
        note: explainOptions.analyze
          ? 'Oracle 에서는 실제 실행 통계(ANALYZE)를 지원하지 않아 예상 계획만 보여줍니다.'
          : undefined,
      };
    },

    async connect(profile, password, signal): Promise<RawConnection> {
      const oracledb = await loadOracle();

      const config: Record<string, unknown> = {
        user: profile.user,
        password: password ?? '',
        connectString: buildConnectString(profile),
      };

      if (profile.tls.enabled) {
        // thin 모드의 TCPS. 서버 인증서 DN 검증은 접속 서술자에서 지정한다.
        config.walletLocation = undefined;
        if (!profile.tls.rejectUnauthorized) {
          // oracledb 는 검증을 끄는 옵션이 없다 — 접속 서술자로 표현해야 한다.
          log.warn(
            'Oracle 은 인증서 검증을 끄는 옵션을 제공하지 않습니다. ' +
              'SSL_SERVER_DN_MATCH=no 를 접속 문자열에 직접 지정하세요.',
          );
        }
      }

      let conn: OracleConnection;
      try {
        conn = await Promise.race([
          withTimeout(
            oracledb.getConnection(config),
            profile.connectTimeoutMs,
            `${profile.host}:${profile.port} 연결이 ${profile.connectTimeoutMs}ms 안에 완료되지 않았습니다.`,
          ),
          abortPromise(signal),
        ]);
      } catch (error) {
        throw toConnectError(error, profile);
      }

      const connection = new OracleRawConnection(conn, oracledb);
      if (profile.readOnly) {
        await connection.setSessionReadOnly(true);
      }
      return connection;
    },

    buildPreviewQuery(schema, table, limit): string {
      // 12.1+ 표준 문법. 구버전은 ROWNUM 을 써야 한다.
      return (
        `SELECT * FROM ${quoteQualified(schema, table, 'oracle')} ` +
        `FETCH FIRST ${Math.floor(limit)} ROWS ONLY`
      );
    },

    applyRowLimit(sql): string {
      // Oracle 은 드라이버 maxRows 로 처리하므로 SQL 을 고치지 않는다.
      return sql;
    },

    placeholder(index: number): string {
      // oracledb 는 배열 바인드를 :1, :2 … 로 받는다.
      return ':' + index;
    },
  };
}

function toConnectError(error: unknown, profile: ConnectionProfile): ConnectError {
  const message = error instanceof Error ? error.message : String(error);
  const oraMatch = /ORA-(\d{5})/.exec(message);
  const code = oraMatch ? `ORA-${oraMatch[1]}` : (error as { code?: string } | undefined)?.code;

  if (/ORA-01017/.test(message)) {
    return new ConnectError(`인증에 실패했습니다. 사용자 "${profile.user}" 의 비밀번호를 확인하세요.`, code);
  }
  if (/ORA-12514|ORA-12505/.test(message)) {
    return new ConnectError(
      `리스너가 "${profile.database}" 서비스를 모릅니다. ` +
        `서비스 이름/SID 구분과 값이 맞는지 확인하세요. (${message})`,
      code,
    );
  }
  if (/ORA-12541|ECONNREFUSED/.test(message)) {
    return new ConnectError(`${profile.host}:${profile.port} 의 리스너에 연결할 수 없습니다.`, code);
  }
  if (/ORA-28040|NJS-116/.test(message)) {
    return new ConnectError(
      `서버가 이 인증 프로토콜을 거부했습니다. Oracle 11g 이하라면 thin 모드로 접속할 수 없습니다. (${message})`,
      code,
    );
  }
  if (/NJS-501|ENOTFOUND/.test(message)) {
    return new ConnectError(`호스트 "${profile.host}" 에 접근할 수 없습니다. (${message})`, code);
  }
  return new ConnectError(message, code);
}
