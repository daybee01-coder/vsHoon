import * as vscode from 'vscode';
import type { CatalogSnapshot, ColumnInfo, DbObject, SchemaInfo, TableInfo } from '../types';
import type { Session } from '../db/session';
import { getDriver } from '../db/registry';
import { foldIdentifier } from '../sql/identifier';
import { SingleFlight } from '../util/async';
import { log } from '../util/logger';

/**
 * 자동 완성용 스키마 캐시.
 *
 * 자동 완성은 키 입력마다 호출된다. 매번 카탈로그를 조회하면 커넥션 풀이
 * 금방 마르고 서버에도 부담이 간다. 그래서:
 *  - 커넥션당 스냅샷 하나를 TTL 동안 재사용한다.
 *  - 동시에 들어온 요청은 SingleFlight 로 한 번만 실행한다.
 *  - 로딩 중에는 이전 스냅샷(있으면)을 즉시 돌려주고 백그라운드로 갱신한다.
 *    자동 완성 팝업이 네트워크를 기다리며 멈추는 것보다 낫다.
 */
export class CatalogCache implements vscode.Disposable {
  private readonly snapshots = new Map<string, CatalogSnapshot>();
  private readonly inflight = new SingleFlight<CatalogSnapshot>();

  private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  /** 캐시에 있으면 즉시 반환 (네트워크 없음). */
  peek(profileId: string): CatalogSnapshot | undefined {
    return this.snapshots.get(profileId);
  }

  /**
   * 스냅샷을 가져온다.
   * 유효한 캐시가 있으면 그대로, 만료됐으면 백그라운드 갱신을 시작하되
   * 기존 값을 먼저 돌려준다. 캐시가 아예 없을 때만 기다린다.
   */
  async get(session: Session): Promise<CatalogSnapshot | undefined> {
    const key = session.profile.id;
    const cached = this.snapshots.get(key);
    const ttl = vscode.workspace
      .getConfiguration('dbconn')
      .get<number>('metadata.cacheTtlMs', 300_000);

    if (cached && (ttl === 0 || Date.now() - cached.loadedAt < ttl)) {
      return cached;
    }

    if (cached) {
      // 만료됐지만 쓸 수 있다 — 갱신은 백그라운드로.
      void this.refresh(session).catch((error: unknown) => {
        log.debug('백그라운드 카탈로그 갱신 실패', error);
      });
      return cached;
    }

    try {
      return await this.refresh(session);
    } catch (error) {
      log.warn(`[${session.profile.name}] 스키마 정보를 불러오지 못했습니다.`, error);
      return undefined;
    }
  }

  /** 강제 갱신. */
  async refresh(session: Session): Promise<CatalogSnapshot> {
    const key = session.profile.id;
    return this.inflight.run(key, async () => {
      const snapshot = await loadSnapshot(session);
      this.snapshots.set(key, snapshot);
      this.onDidChangeEmitter.fire(key);
      log.debug(
        `[${session.profile.name}] 스키마 캐시 갱신 — 스키마 ${snapshot.schemas.length}개, ` +
          `테이블 ${snapshot.tables.length}개`,
      );
      return snapshot;
    });
  }

  invalidate(profileId: string): void {
    this.snapshots.delete(profileId);
    this.onDidChangeEmitter.fire(profileId);
  }

  clear(): void {
    this.snapshots.clear();
  }

  dispose(): void {
    this.snapshots.clear();
    this.inflight.clear();
    this.onDidChangeEmitter.dispose();
  }
}

/**
 * 카탈로그를 읽어 스냅샷을 만든다.
 *
 * 여기서 읽는 양이 곧 **서버에 주는 부하**다. MySQL/MariaDB 의
 * `information_schema` 는 특히 비싸다 — 스키마 하나의 컬럼을 훑는 것만으로도
 * 서버가 그 스키마의 테이블을 전부 열어 본다. 스키마 열두 개를 자동으로 훑으면
 * 운영 인스턴스에서는 그것만으로 다른 세션이 밀린다.
 *
 * 그래서 기본값은 **기본 스키마 하나**다. 나머지는 트리에서 펼칠 때,
 * 그 스키마만 조회한다 (`dbconn.metadata.prefetch` 로 조절).
 */
async function loadSnapshot(session: Session): Promise<CatalogSnapshot> {
  const driver = getDriver(session.profile.dialect);
  const config = vscode.workspace.getConfiguration('dbconn');
  const maxItems = config.get<number>('completion.maxMetadataItems', 3000);
  const scope = config.get<string>('metadata.prefetch', 'default-schema');

  return session.pool.withConnection('catalog-load', async (conn) => {
    const defaultSchema = await driver.catalog.defaultSchema(conn, session.profile);
    const schemas = await driver.catalog.listSchemas(conn);

    // 컬럼까지 읽을 스키마를 고른다: 기본 스키마를 최우선, 그다음 시스템이 아닌 것들.
    const targets = pickSchemas(schemas, defaultSchema, session.profile.dialect, schemaLimit(scope));

    const tables: TableInfo[] = [];
    const objects: DbObject[] = [];
    const columnsByTable = new Map<string, ColumnInfo[]>();
    let budget = maxItems;

    for (const schema of targets) {
      if (budget <= 0) {
        break;
      }
      try {
        const schemaTables = await driver.catalog.listTables(conn, schema);
        tables.push(...schemaTables);
        budget -= schemaTables.length;

        const columns = await driver.catalog.listColumns(conn, schema);
        budget -= columns.length;
        for (const column of columns) {
          const key = tableKey(column.schema, column.table);
          const list = columnsByTable.get(key);
          if (list) {
            list.push(column);
          } else {
            columnsByTable.set(key, [column]);
          }
        }
      } catch (error) {
        // 권한이 없는 스키마는 흔하다 — 조용히 건너뛴다.
        log.debug(`스키마 "${schema}" 메타데이터 조회 실패 (건너뜀)`, error);
      }

      // 시퀀스/루틴은 테이블과 별개로 실패할 수 있다 (권한·버전).
      // 실패해도 테이블 자동 완성은 살아 있어야 하므로 따로 감싼다.
      try {
        const schemaObjects = await driver.catalog.listOtherObjects(conn, schema);
        objects.push(...schemaObjects);
        budget -= schemaObjects.length;
      } catch (error) {
        log.debug(`스키마 "${schema}" 객체 조회 실패 (건너뜀)`, error);
      }
    }

    return {
      loadedAt: Date.now(),
      defaultSchema,
      schemas,
      tables,
      objects,
      columnsByTable,
    };
  });
}

/**
 * 설정이 말하는 "몇 개까지 훑을까".
 *
 * `off` 는 0 이다 — 스키마 목록만 읽고 테이블·컬럼은 건드리지 않는다.
 * 트리에서 펼치거나 자동 완성을 부르면 그때 그 스키마만 읽는다.
 */
function schemaLimit(scope: string): number {
  switch (scope) {
    case 'off':
      return 0;
    case 'all':
      return 12;
    default:
      return 1;
  }
}

/** 컬럼까지 미리 읽어 둘 스키마 목록. */
function pickSchemas(
  schemas: SchemaInfo[],
  defaultSchema: string,
  dialect: string,
  limit: number,
): string[] {
  const system = SYSTEM_SCHEMAS[dialect] ?? new Set<string>();
  const ordered: string[] = [];

  if (defaultSchema) {
    ordered.push(defaultSchema);
  }
  for (const schema of schemas) {
    if (schema.name === defaultSchema) {
      continue;
    }
    if (system.has(schema.name.toUpperCase())) {
      continue;
    }
    ordered.push(schema.name);
  }

  // 스키마가 아주 많은 인스턴스에서 첫 로딩이 몇 분씩 걸리지 않게 상한을 둔다.
  return ordered.slice(0, Math.max(0, limit));
}

const SYSTEM_SCHEMAS: Record<string, Set<string>> = {
  mysql: new Set(['INFORMATION_SCHEMA', 'PERFORMANCE_SCHEMA', 'MYSQL', 'SYS']),
  mariadb: new Set(['INFORMATION_SCHEMA', 'PERFORMANCE_SCHEMA', 'MYSQL', 'SYS']),
  postgres: new Set(['PG_CATALOG', 'INFORMATION_SCHEMA', 'PG_TOAST']),
  oracle: new Set([
    'SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'CTXSYS', 'MDSYS',
    'OLAPSYS', 'ORDDATA', 'ORDSYS', 'WMSYS', 'XDB', 'LBACSYS', 'GSMADMIN_INTERNAL',
    'AUDSYS', 'DVSYS', 'DVF', 'OJVMSYS', 'ANONYMOUS', 'XS$NULL', 'REMOTE_SCHEDULER_AGENT',
  ]),
};

/** `schema.table` 캐시 키 — 대소문자를 무시해 조회한다. */
export function tableKey(schema: string, table: string): string {
  return `${foldIdentifier(schema)}.${foldIdentifier(table)}`;
}

/** 스키마를 모를 때 이름만으로 테이블을 찾는다. 여러 개면 기본 스키마 우선. */
export function findTables(snapshot: CatalogSnapshot, name: string): TableInfo[] {
  const folded = foldIdentifier(name);
  const matches = snapshot.tables.filter((t) => foldIdentifier(t.name) === folded);
  return matches.sort((a, b) => {
    const aDefault = foldIdentifier(a.schema) === foldIdentifier(snapshot.defaultSchema) ? 0 : 1;
    const bDefault = foldIdentifier(b.schema) === foldIdentifier(snapshot.defaultSchema) ? 0 : 1;
    return aDefault - bDefault;
  });
}
