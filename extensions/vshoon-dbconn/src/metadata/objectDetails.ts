import type { CatalogCache } from './catalog';
import { tableKey } from './catalog';
import type { Session } from '../db/session';
import { getDriver } from '../db/registry';
import { buildApproximateDdl } from '../db/catalogDetail';
import { foldIdentifier } from '../sql/identifier';
import type { ColumnInfo, IndexInfo, ObjectDetail, ObjectRef } from '../types';
import { log } from '../util/logger';

/**
 * 객체 상세 정보를 모은다.
 *
 * 조각(컬럼 · 인덱스 · 속성 · DDL)마다 실패할 수 있고, 실패는 흔하다 —
 * DDL 을 읽을 권한이 없거나(Oracle 의 DBMS_METADATA), 서버 버전에 그 뷰가
 * 없는 경우가 많다. 그래서 조각별로 잡아서 안내 문구로 남기고, 얻은 것만 보여준다.
 * 하나 실패했다고 화면 전체가 오류가 되면 도구로 쓸 수 없다.
 *
 * 커넥션은 한 번만 빌려 모든 조회를 처리한다 — 조각마다 대여하면
 * 풀이 순간적으로 마른다.
 */

/** FROM 절에 올 수 있는 것들 — 컬럼과 인덱스를 가진다. */
function isRelation(ref: ObjectRef): boolean {
  return ref.kind === 'table' || ref.kind === 'view' || ref.kind === 'materialized-view';
}

export async function loadObjectDetail(
  session: Session,
  catalog: CatalogCache,
  ref: ObjectRef,
): Promise<ObjectDetail> {
  const driver = getDriver(session.profile.dialect);
  const dialect = session.profile.dialect;
  const notes: string[] = [];
  const snapshot = catalog.peek(session.profile.id);

  const detail: ObjectDetail = {
    ref,
    connectionName: session.profile.name,
    profileId: session.profile.id,
    dialect,
    attributes: [],
    notes,
    loadedAt: Date.now(),
  };

  // 카탈로그 캐시에 이미 있는 설명은 조회 없이 쓴다.
  const relation = snapshot?.tables.find(
    (t) =>
      foldIdentifier(t.name) === foldIdentifier(ref.name) &&
      foldIdentifier(t.schema) === foldIdentifier(ref.schema),
  );
  if (relation?.comment) {
    detail.comment = relation.comment;
  }
  const object = snapshot?.objects.find(
    (o) =>
      foldIdentifier(o.name) === foldIdentifier(ref.name) &&
      foldIdentifier(o.schema) === foldIdentifier(ref.schema),
  );
  if (!detail.comment && object?.comment) {
    detail.comment = object.comment;
  }

  await session.pool.withConnection(`detail: ${ref.schema}.${ref.name}`, async (conn) => {
    let columns: ColumnInfo[] | undefined;
    let indexes: IndexInfo[] | undefined;

    if (isRelation(ref)) {
      // 캐시에 있으면 그대로 — 스키마 전체 컬럼 조회는 큰 DB 에서 비싸다.
      const cached = snapshot?.columnsByTable.get(tableKey(ref.schema, ref.name));
      if (cached && cached.length > 0) {
        columns = cached;
      } else {
        try {
          const all = await driver.catalog.listColumns(conn, ref.schema);
          columns = all.filter((c) => foldIdentifier(c.table) === foldIdentifier(ref.name));
        } catch (error) {
          notes.push(`컬럼 정보를 읽지 못했습니다: ${describe(error)}`);
        }
      }

      try {
        indexes = await driver.catalog.listIndexes(conn, ref.schema, ref.name);
      } catch (error) {
        log.debug('인덱스 조회 실패', error);
        notes.push('인덱스 정보를 읽지 못했습니다 (권한 또는 서버 버전).');
      }

      // 나가는 참조와 들어오는 참조를 따로 읽는다. 들어오는 쪽이 있어야
      // "이 행을 지우면 무엇이 깨지나"를 볼 수 있다.
      try {
        detail.foreignKeys = await driver.catalog.listForeignKeys(
          conn,
          ref.schema,
          ref.name,
          'outgoing',
        );
        detail.referencedBy = await driver.catalog.listForeignKeys(
          conn,
          ref.schema,
          ref.name,
          'incoming',
        );
      } catch (error) {
        log.debug('외래 키 조회 실패', error);
        notes.push('외래 키 정보를 읽지 못했습니다 (권한 또는 서버 버전).');
      }
    }

    try {
      detail.attributes = await driver.catalog.objectAttributes(conn, ref);
    } catch (error) {
      log.debug('객체 속성 조회 실패', error);
      notes.push('부가 속성을 읽지 못했습니다 (권한 또는 서버 버전).');
    }

    try {
      detail.definition = await driver.catalog.objectDefinition(conn, ref);
    } catch (error) {
      log.debug('객체 정의 조회 실패', error);
      notes.push(`정의(DDL)를 서버에서 받지 못했습니다: ${describe(error)}`);
    }

    detail.columns = columns;
    detail.indexes = indexes;

    // 서버가 DDL 을 주지 않는 경우(PostgreSQL 테이블 등) 메타데이터로 근사치를 만든다.
    if (!detail.definition && ref.kind === 'table' && columns && columns.length > 0) {
      const approximate = buildApproximateDdl(ref, columns, indexes ?? [], dialect);
      if (approximate) {
        detail.definition = approximate;
        detail.definitionIsApproximate = true;
      }
    }
  });

  return detail;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n')[0] ?? message;
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}
