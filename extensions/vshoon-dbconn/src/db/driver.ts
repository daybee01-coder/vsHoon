import type {
  ColumnInfo,
  DbObject,
  ConnectionProfile,
  DetailAttribute,
  DialectId,
  ExplainOptions,
  ExplainOutcome,
  ForeignKeyDirection,
  ForeignKeyInfo,
  IndexInfo,
  ObjectRef,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
} from '../types';

/**
 * 물리 커넥션 하나에 대한 방언 중립 인터페이스.
 *
 * 구현체는 mysql2 / pg / oracledb 를 감싼다. 이 경계 밖으로는
 * 각 라이브러리의 타입이나 객체가 절대 새어 나가지 않는다.
 */
export interface RawConnection {
  /** 진단 로그에서 커넥션을 추적하기 위한 프로세스 내 고유 id. */
  readonly id: string;
  readonly createdAt: number;
  /** 서버 측 세션/프로세스 식별자 (취소 명령에 사용). */
  readonly backendId: string | number | undefined;

  execute(sql: string, params: readonly unknown[] | undefined, options: QueryOptions): Promise<QueryResult>;

  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;

  /** 세션 수준 읽기 전용 설정. 서버가 지원하지 않으면 조용히 무시한다. */
  setSessionReadOnly(readOnly: boolean): Promise<void>;

  /**
   * 현재 실행 중인 구문을 서버 측에서 취소한다.
   * 별도 커넥션을 열어야 하는 방언도 있으므로 실패할 수 있고, 실패는 치명적이지 않다.
   */
  cancel(): Promise<void>;

  /** 재사용 전 살아 있는지 확인 (가벼운 핑). */
  validate(): Promise<boolean>;

  /** 물리 커넥션을 닫는다. 몇 번 호출해도 안전해야 한다. */
  close(): Promise<void>;

  /** 이 커넥션에서 트랜잭션이 열려 있는지 (드라이버가 아는 범위에서). */
  readonly inTransaction: boolean;
}

/** 방언별 카탈로그 조회. 모든 구현은 바인드 파라미터를 사용해야 한다. */
export interface CatalogQueries {
  defaultSchema(conn: RawConnection, profile: ConnectionProfile): Promise<string>;
  listSchemas(conn: RawConnection): Promise<SchemaInfo[]>;
  /** 테이블 / 뷰 / 구체화 뷰 — FROM 절에 올 수 있는 것들. */
  listTables(conn: RawConnection, schema: string): Promise<TableInfo[]>;
  /**
   * 시퀀스 / 함수 / 프로시저 / 패키지 / 동의어 등.
   * 자동 완성이 분류별로 순환 제시하는 데 쓴다.
   * 권한이나 서버 버전 문제로 일부만 얻어져도 되므로 부분 실패를 허용한다.
   */
  listOtherObjects(conn: RawConnection, schema: string): Promise<DbObject[]>;
  /** schema 전체의 컬럼을 한 번에 가져온다 (테이블마다 왕복하면 느리다). */
  listColumns(conn: RawConnection, schema: string): Promise<ColumnInfo[]>;

  /**
   * 테이블/뷰 하나의 인덱스. 상세 화면에서만 쓴다.
   * 권한이나 서버 버전 때문에 실패할 수 있고, 실패해도 화면은 떠야 한다.
   */
  listIndexes(conn: RawConnection, schema: string, table: string): Promise<IndexInfo[]>;

  /**
   * 외래 키. `outgoing` 은 이 테이블이 참조하는 것, `incoming` 은
   * 이 테이블을 참조하는 것 — 후자가 있어야 "이 행을 지우면 무엇이 깨지나"를 볼 수 있다.
   */
  listForeignKeys(
    conn: RawConnection,
    schema: string,
    table: string,
    direction: ForeignKeyDirection,
  ): Promise<ForeignKeyInfo[]>;

  /** 상세 화면 위쪽에 보여줄 부가 속성 (엔진·크기·소유자·시퀀스 현재값 등). */
  objectAttributes(conn: RawConnection, ref: ObjectRef): Promise<DetailAttribute[]>;

  /**
   * DDL 또는 루틴 소스. 서버가 주지 못하면 undefined —
   * 그 경우 호출부가 메타데이터로 근사 DDL 을 만든다.
   */
  objectDefinition(conn: RawConnection, ref: ObjectRef): Promise<string | undefined>;
}

export interface Driver {
  readonly dialect: DialectId;

  /**
   * 새 물리 커넥션을 만든다.
   * password 는 이 호출 동안에만 메모리에 존재해야 하며, 어디에도 보관하지 않는다.
   */
  connect(
    profile: ConnectionProfile,
    password: string | undefined,
    signal?: AbortSignal,
  ): Promise<RawConnection>;

  readonly catalog: CatalogQueries;

  /**
   * 실행 계획을 얻는다.
   *
   * 방언마다 절차가 달라(특히 Oracle 은 EXPLAIN PLAN + DBMS_XPLAN 두 단계)
   * 드라이버가 커넥션을 직접 받아 통째로 처리한다. 두 구문이 **같은 세션**에서
   * 실행돼야 하므로 커넥션을 나눠 쓸 수 없다.
   */
  explain(
    conn: RawConnection,
    sql: string,
    explainOptions: ExplainOptions,
    options: QueryOptions,
  ): Promise<ExplainOutcome>;

  /** 테이블 미리보기 SQL. 식별자는 반드시 인용해서 조립한다. */
  buildPreviewQuery(schema: string, table: string, limit: number): string;

  /**
   * 바인드 파라미터 자리 표시자. index 는 1부터.
   * 그리드 편집이 UPDATE/DELETE 를 조립할 때 쓴다 —
   * 값은 어떤 경우에도 문자열로 SQL 에 끼워 넣지 않는다.
   */
  placeholder(index: number): string;

  /** 사용자가 결과 행 수를 제한하지 않았을 때 서버 측에서 자를 수 있으면 그렇게 한다. */
  applyRowLimit(sql: string, limit: number): string;
}

/** 드라이버 로딩 실패를 사용자에게 설명 가능한 형태로 감싼다. */
export class DriverLoadError extends Error {
  constructor(dialect: DialectId, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${dialect} 드라이버를 불러오지 못했습니다. 확장의 node_modules 설치가 온전한지 확인하세요. (${detail})`,
    );
    this.name = 'DriverLoadError';
  }
}

/** 연결 실패를 사용자 친화적 메시지로 감싼다. */
export class ConnectError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}
