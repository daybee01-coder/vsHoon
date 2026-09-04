/**
 * 확장 전역에서 공유하는 도메인 타입.
 * 드라이버 구현( mysql2 / pg / oracledb )은 이 타입만 바라보고,
 * 각 라이브러리 고유 타입이 이 경계를 넘어오지 않도록 한다.
 */

export type DialectId = 'mysql' | 'mariadb' | 'postgres' | 'oracle';

export const DIALECT_LABELS: Record<DialectId, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
};

export const DEFAULT_PORTS: Record<DialectId, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  oracle: 1521,
};

// ─── 연결 프로필 ────────────────────────────────────────────────────────────

export interface TlsOptions {
  /** TLS 사용 여부. false 면 평문 연결. */
  enabled: boolean;
  /** 서버 인증서 검증. 기본 true — 끄는 경우 사용자에게 경고한다. */
  rejectUnauthorized: boolean;
  /** 사설 CA 인증서(PEM) 파일 경로. */
  caPath?: string;
  /** 클라이언트 인증서 / 키 (상호 TLS). */
  certPath?: string;
  keyPath?: string;
  /** SNI/호스트명 검증에 사용할 서버 이름. */
  servername?: string;
}

export interface PoolOptions {
  max: number;
  min: number;
  acquireTimeoutMs: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  /** 이 시간을 넘긴 대여는 좀비로 간주하고 강제 회수한다. */
  leaseTimeoutMs: number;
  /** 열린 트랜잭션의 유휴 허용 시간. 초과 시 자동 롤백. */
  transactionIdleTimeoutMs: number;
}

export interface OracleOptions {
  /** service name 또는 SID 중 무엇으로 접속할지. */
  connectType: 'service' | 'sid';
  /** 전체 접속 문자열을 직접 지정(EZConnect/TNS). 지정 시 host/port/database 를 무시. */
  connectString?: string;
}

/**
 * 이 연결이 어떤 환경을 가리키는지.
 *
 * 표시(색·꼬리표)와 안전장치(운영에서의 확인 강화)가 모두 이 값에서 갈린다.
 * 읽기 전용과는 별개다 — 운영이지만 쓰기가 필요한 연결이 실제로 흔하다.
 */
export type ConnectionEnvironment = 'development' | 'staging' | 'production';

export interface ConnectionProfile {
  id: string;
  name: string;
  dialect: DialectId;
  host: string;
  port: number;
  /** MySQL/MariaDB: database, PostgreSQL: database, Oracle: service name 또는 SID. */
  database: string;
  user: string;
  /** 비밀번호는 절대 이 객체에 담기지 않는다. SecretStorage 에만 존재. */
  savePassword: boolean;
  /** true 면 데이터 변경 구문을 클라이언트에서 차단하고 세션도 읽기 전용으로 설정. */
  readOnly: boolean;
  tls: TlsOptions;
  pool: PoolOptions;
  connectTimeoutMs: number;
  oracle?: OracleOptions;
  /** 트리/상태바 색상 힌트 (운영 DB 구분용). */
  color?: string;
  /** 트리에서 이 연결이 놓일 폴더 경로(예: `운영/서울`). 없으면 최상위. */
  folder?: string;
  /** 개발 / 스테이징 / 운영. 화면 경고와 확인 강도를 결정한다. */
  environment: ConnectionEnvironment;
  createdAt: number;
}

/** 저장 전 프로필 초안 — id/createdAt 이 아직 없다. */
export type ConnectionProfileDraft = Omit<ConnectionProfile, 'id' | 'createdAt'>;

// ─── 쿼리 실행 ──────────────────────────────────────────────────────────────

export interface ColumnMeta {
  name: string;
  /** 드라이버가 보고한 타입명 (표시용). */
  typeName: string;
  nullable?: boolean;
  /** 동일 이름 컬럼 구분을 위한 0-based 인덱스. */
  index: number;
}

export type CellValue = string | number | boolean | null;

/**
 * 결과 그리드에서 직접 수정/삭제가 가능한 경우의 근거 정보.
 *
 * 단일 테이블 조회이고 기본 키가 결과에 모두 포함될 때만 만들어진다.
 * 이게 없으면 그리드는 읽기 전용이다 — 어느 행을 고쳐야 할지
 * 확실히 알 수 없는 상태에서 UPDATE 를 만들어 내면 안 되기 때문이다.
 */
export interface EditSource {
  schema: string;
  table: string;
  /** WHERE 절을 구성할 기본 키 컬럼 — 결과 컬럼 인덱스와 실제 이름. */
  keyColumns: { name: string; index: number }[];
  /** 값을 고칠 수 있는 컬럼. 기본 키와 모호한 중복 이름은 제외된다. */
  editableColumns: { name: string; index: number }[];
}

export interface QueryResult {
  /** 결과 집합을 반환하는 구문인지, 영향 행 수만 반환하는 구문인지. */
  kind: 'rows' | 'update';
  columns: ColumnMeta[];
  /** 셀 값은 웹뷰로 보내기 위해 미리 직렬화된 형태로 담는다. */
  rows: CellValue[][];
  rowCount: number;
  affectedRows?: number;
  /** maxRows 제한으로 잘렸는지. */
  truncated: boolean;
  durationMs: number;
  /** PostgreSQL NOTICE, MySQL warning 등. */
  messages: string[];
  /** 실행된 SQL (표시/재실행용, 그대로 보관). */
  sql: string;
  /** 그리드에서 편집 가능한 경우의 대상 정보. 없으면 읽기 전용. */
  editSource?: EditSource;
}

/**
 * 실행 계획 조회 결과.
 *
 * 방언마다 모양이 다르다. PostgreSQL/Oracle 은 여러 줄 텍스트가 자연스럽고,
 * MySQL 의 기본 EXPLAIN 은 표가 자연스럽다. 둘 중 얻은 쪽을 채운다.
 */
export interface ExplainOutcome {
  /** 여러 줄 텍스트 계획. */
  text?: string;
  /** 표 형태 계획. */
  result?: QueryResult;
  /** 사용자에게 알릴 제약 (예: Oracle 은 ANALYZE 를 지원하지 않음). */
  note?: string;
}

export interface ExplainOptions {
  /**
   * 실제로 실행하며 측정할지. **구문이 실제로 수행된다** —
   * 호출부는 SELECT 인지 반드시 먼저 확인해야 한다.
   */
  analyze: boolean;
}

export interface QueryOptions {
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecutionError {
  message: string;
  code?: string;
  /** 서버가 알려준 오류 위치(문자 오프셋, 1-based). PostgreSQL 이 제공. */
  position?: number;
  detail?: string;
  hint?: string;
}

// ─── 메타데이터 ─────────────────────────────────────────────────────────────

export interface SchemaInfo {
  name: string;
  isDefault: boolean;
}

/** FROM 절에 올 수 있는 객체 — 행을 가진 것들. */
export type RelationKind = 'table' | 'view' | 'materialized-view';

/** 관계형이 아닌 스키마 객체. 자동 완성에서 분류별로 순환 제시된다. */
export type OtherObjectKind =
  | 'sequence'
  | 'function'
  | 'procedure'
  | 'package'
  | 'synonym'
  | 'type';

export type ObjectKind = RelationKind | OtherObjectKind;

export interface TableInfo {
  schema: string;
  name: string;
  kind: RelationKind;
  comment?: string;
  estimatedRows?: number;
}

export interface DbObject {
  schema: string;
  name: string;
  kind: OtherObjectKind;
  comment?: string;
  /** 루틴 인자 시그니처, 동의어 대상 등 부가 표시. */
  detail?: string;
}

export interface ColumnInfo {
  schema: string;
  table: string;
  name: string;
  typeName: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  comment?: string;
  ordinal: number;
}

export interface IndexInfo {
  schema: string;
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/**
 * 외래 키 하나. 복합 키면 columns 와 referencedColumns 가 같은 순서로 짝을 이룬다.
 * 방향은 이 객체에 담지 않는다 — 조회할 때 정해지고, 화면에서 구획으로 나뉜다.
 */
export interface ForeignKeyInfo {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  /** ON DELETE / ON UPDATE 동작 (서버가 알려주는 경우). */
  onDelete?: string;
  onUpdate?: string;
}

/** 외래 키 조회 방향. */
export type ForeignKeyDirection =
  /** 이 테이블이 다른 테이블을 참조하는 것. */
  | 'outgoing'
  /** 다른 테이블이 이 테이블을 참조하는 것. */
  | 'incoming';

// ─── 객체 상세 ──────────────────────────────────────────────────────────────

/** 상세 정보를 볼 대상. 트리 노드에서 만들어 패널로 넘긴다. */
export interface ObjectRef {
  schema: string;
  name: string;
  kind: ObjectKind;
}

/** 상세 화면 위쪽에 표로 늘어놓는 속성 하나. */
export interface DetailAttribute {
  label: string;
  value: string;
}

/**
 * 객체 상세 화면에 필요한 모든 것.
 *
 * 각 조각은 따로 실패할 수 있다 — 권한이 없어 DDL 을 못 읽어도 컬럼 목록은
 * 보여야 하므로, 실패한 조각은 undefined 로 두고 화면에서 생략한다.
 */
export interface ObjectDetail {
  ref: ObjectRef;
  connectionName: string;
  profileId: string;
  dialect: DialectId;
  comment?: string;
  attributes: DetailAttribute[];
  columns?: ColumnInfo[];
  indexes?: IndexInfo[];
  /** 이 테이블이 참조하는 외래 키. */
  foreignKeys?: ForeignKeyInfo[];
  /** 이 테이블을 참조하는 외래 키. */
  referencedBy?: ForeignKeyInfo[];
  /** 서버가 준 DDL 또는 루틴 소스. */
  definition?: string;
  /** definition 이 서버 DDL 이 아니라 메타데이터로 조립한 근사치인지. */
  definitionIsApproximate?: boolean;
  /** 부분 실패 안내 (예: "DDL 을 읽을 권한이 없습니다"). */
  notes: string[];
  loadedAt: number;
}

/** 자동 완성이 사용하는 스냅샷. 커넥션당 하나를 캐시한다. */
export interface CatalogSnapshot {
  loadedAt: number;
  defaultSchema: string;
  schemas: SchemaInfo[];
  tables: TableInfo[];
  /** 시퀀스 / 루틴 / 동의어 등 관계형이 아닌 객체. */
  objects: DbObject[];
  /** `schema.table` (소문자) → 컬럼 목록. */
  columnsByTable: Map<string, ColumnInfo[]>;
}

// ─── 트랜잭션 ───────────────────────────────────────────────────────────────

export type TransactionState = 'none' | 'active' | 'failed';

export interface SessionStatus {
  profileId: string;
  profileName: string;
  dialect: DialectId;
  connected: boolean;
  autoCommit: boolean;
  transaction: TransactionState;
  readOnly: boolean;
}

export interface PoolStats {
  size: number;
  idle: number;
  leased: number;
  pendingAcquires: number;
  createdTotal: number;
  destroyedTotal: number;
  zombiesReclaimed: number;
  acquireTimeouts: number;
}
