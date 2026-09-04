import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { getDriver } from '../../src/db/registry';
import type { RawConnection } from '../../src/db/driver';
import { buildDeleteStatement, buildUpdateStatement } from '../../src/db/rowEditor';
import { computeEditSource } from '../../src/sql/editable';
import { buildPagedQuery } from '../../src/sql/paging';
import { tableKey } from '../../src/metadata/catalog';
import type { CatalogSnapshot, ColumnInfo, EditSource } from '../../src/types';
import {
  connect,
  describeSkip,
  QUERY_OPTIONS,
  targets,
  type IntegrationTarget,
} from './harness';
import { ORDERS, ORDERS_FK, ORDERS_INDEX, SEQUENCE, USER_VIEW, USERS, seedStatements } from './seed';

/**
 * 방언별 SQL 통합 테스트.
 *
 * 단위 테스트가 덮지 못하는 부분을 겨냥한다: 카탈로그 쿼리 문법, 서버 버전별
 * 뷰 존재 여부, 실행 계획 절차, 페이징 래퍼가 실제로 도는지, 편집 SQL 이
 * 정확히 한 행에만 닿는지.
 *
 * 서버가 없으면 실패가 아니라 건너뛴다 (harness.ts 참고).
 */

for (const target of targets()) {
  describe(`${target.label} 통합`, () => {
    const driver = getDriver(target.dialect);
    let conn: RawConnection | undefined;
    let skipReason: string | undefined;

    before(async () => {
      try {
        conn = await connect(target);
      } catch (error) {
        skipReason = describeSkip(target, error);
        return;
      }
      try {
        for (const statement of seedStatements(target)) {
          try {
            await conn.execute(statement.sql, undefined, QUERY_OPTIONS);
          } catch (error) {
            if (!statement.optional) {
              throw error;
            }
          }
        }
        if (conn.inTransaction) {
          await conn.commit();
        }
      } catch (error) {
        skipReason = `${target.label} 시드 실패 — ${describeError(error)}`;
      }
    });

    after(async () => {
      await conn?.close();
      conn = undefined;
    });

    /**
     * 접속이 안 됐으면 이 스위트의 모든 테스트를 건너뛴다.
     * 연결을 그대로 돌려주므로 테스트 본문에서 다시 undefined 검사를 하지 않아도 된다.
     */
    function ready(t: TestContext): RawConnection | undefined {
      if (skipReason || !conn) {
        t.skip(skipReason ?? '접속되지 않았습니다.');
        return undefined;
      }
      return conn;
    }

    const users = target.name(USERS);
    const orders = target.name(ORDERS);

    it('기본 스키마와 스키마 목록', async (t) => {
      const db = ready(t);
      if (!db) return;
      const schema = await driver.catalog.defaultSchema(db, target.profile);
      assert.ok(schema.length > 0, '기본 스키마 이름이 비어 있으면 자동 완성이 아무것도 못 찾는다');

      const schemas = await driver.catalog.listSchemas(db);
      assert.ok(schemas.length > 0);
      assert.ok(
        schemas.some((s) => s.name.toLowerCase() === target.schema.toLowerCase()),
        `스키마 목록에 ${target.schema} 가 있어야 한다`,
      );
    });

    it('테이블 · 뷰 목록과 코멘트', async (t) => {
      const db = ready(t);
      if (!db) return;
      const tables = await driver.catalog.listTables(db, target.schema);
      const table = tables.find((entry) => entry.name === users);
      const view = tables.find((entry) => entry.name === target.name(USER_VIEW));

      assert.ok(table, `${users} 를 찾지 못했습니다`);
      assert.equal(table.kind, 'table');
      assert.ok(view, `${target.name(USER_VIEW)} 를 찾지 못했습니다`);
      assert.equal(view.kind, 'view');
      assert.ok(
        (table.comment ?? '').includes('통합 테스트'),
        '테이블 코멘트를 읽지 못했습니다',
      );
    });

    it('컬럼 메타데이터 (기본 키 · NOT NULL · 기본값 · 코멘트)', async (t) => {
      const db = ready(t);
      if (!db) return;
      const columns = await driver.catalog.listColumns(db, target.schema);
      const mine = columns.filter((column) => column.table === users);
      assert.equal(mine.length, 4, `${users} 의 컬럼 4개를 기대했습니다`);

      const id = mine.find((column) => column.name.toLowerCase() === 'id');
      const email = mine.find((column) => column.name.toLowerCase() === 'email');
      const note = mine.find((column) => column.name.toLowerCase() === 'note');

      assert.ok(id?.isPrimaryKey, '기본 키를 인식하지 못하면 그리드 편집이 열리지 않는다');
      assert.equal(id?.nullable, false);
      assert.equal(email?.nullable, false);
      assert.ok((note?.defaultValue ?? '').includes('none'), '기본값을 읽지 못했습니다');
      assert.ok((email?.comment ?? '').includes('이메일'), '컬럼 코멘트를 읽지 못했습니다');
      assert.ok(id.ordinal <= email.ordinal, '컬럼 순서가 유지되어야 한다');
    });

    it('인덱스', async (t) => {
      const db = ready(t);
      if (!db) return;
      const indexes = await driver.catalog.listIndexes(db, target.schema, orders);
      const secondary = indexes.find(
        (index) => index.name.toLowerCase() === ORDERS_INDEX.toLowerCase(),
      );
      assert.ok(secondary, `${ORDERS_INDEX} 를 찾지 못했습니다`);
      assert.deepEqual(
        secondary.columns.map((column) => column.toLowerCase()),
        ['user_id'],
      );

      const primary = indexes.find((index) => index.unique);
      assert.ok(primary, '기본 키 인덱스가 목록에 있어야 한다');
    });

    it('외래 키 — 나가는 참조', async (t) => {
      const db = ready(t);
      if (!db) return;
      const keys = await driver.catalog.listForeignKeys(db, target.schema, orders, 'outgoing');
      assert.equal(keys.length, 1, `${orders} 의 외래 키 1개를 기대했습니다`);

      const key = keys[0]!;
      assert.equal(key.name.toLowerCase(), ORDERS_FK.toLowerCase());
      assert.deepEqual(
        key.columns.map((column) => column.toLowerCase()),
        ['user_id'],
      );
      assert.equal(key.referencedTable.toLowerCase(), USERS.toLowerCase());
      assert.deepEqual(
        key.referencedColumns.map((column) => column.toLowerCase()),
        ['id'],
      );
      assert.ok(
        (key.onDelete ?? '').toUpperCase().includes('CASCADE'),
        'ON DELETE 규칙을 읽지 못했습니다',
      );
    });

    it('외래 키 — 들어오는 참조', async (t) => {
      const db = ready(t);
      if (!db) return;
      const keys = await driver.catalog.listForeignKeys(db, target.schema, users, 'incoming');
      assert.ok(
        keys.some((key) => key.table.toLowerCase() === ORDERS.toLowerCase()),
        '이 테이블을 참조하는 쪽을 찾지 못했습니다 — "지우면 무엇이 깨지나"를 볼 수 없다',
      );
    });

    it('시퀀스 · 기타 객체', async (t) => {
      const db = ready(t);
      if (!db) return;
      const objects = await driver.catalog.listOtherObjects(db, target.schema);
      if (!target.supportsSequence) {
        // MySQL 에는 시퀀스가 없다 — 빈 목록이어도 오류가 아니어야 한다.
        assert.ok(Array.isArray(objects));
        return;
      }
      const sequence = objects.find(
        (object) => object.name.toLowerCase() === SEQUENCE.toLowerCase(),
      );
      assert.ok(sequence, `${SEQUENCE} 를 찾지 못했습니다`);
      assert.equal(sequence.kind, 'sequence');
    });

    it('객체 속성 (테이블 · 시퀀스)', async (t) => {
      const db = ready(t);
      if (!db) return;
      const tableAttributes = await driver.catalog.objectAttributes(db, {
        schema: target.schema,
        name: users,
        kind: 'table',
      });
      assert.ok(tableAttributes.length > 0, '테이블 속성이 하나도 없으면 상세 화면이 빈다');
      assert.ok(tableAttributes.every((attribute) => attribute.value.length > 0));

      if (target.supportsSequence) {
        const sequenceAttributes = await driver.catalog.objectAttributes(db, {
          schema: target.schema,
          name: target.name(SEQUENCE),
          kind: 'sequence',
        });
        assert.ok(sequenceAttributes.length > 0, '시퀀스 현재값을 읽지 못했습니다');
      }
    });

    it('객체 정의 (DDL)', async (t) => {
      const db = ready(t);
      if (!db) return;
      const viewDefinition = await driver.catalog.objectDefinition(db, {
        schema: target.schema,
        name: target.name(USER_VIEW),
        kind: 'view',
      });
      assert.ok(
        (viewDefinition ?? '').toLowerCase().includes('select'),
        '뷰 정의를 읽지 못했습니다',
      );

      const tableDefinition = await driver.catalog.objectDefinition(db, {
        schema: target.schema,
        name: users,
        kind: 'table',
      });
      if (target.expectsTableDdl) {
        assert.ok(
          (tableDefinition ?? '').toLowerCase().includes(USERS.toLowerCase()),
          '테이블 DDL 을 읽지 못했습니다',
        );
      } else {
        // PostgreSQL 은 테이블 DDL 을 만들어 주지 않는다 — 근사 DDL 로 대체하는 경로다.
        assert.equal(tableDefinition, undefined);
      }
    });

    it('실행 계획', async (t) => {
      const db = ready(t);
      if (!db) return;
      const outcome = await driver.explain(
        db,
        `SELECT id, email FROM ${users} WHERE id > 1`,
        { analyze: false },
        QUERY_OPTIONS,
      );
      const hasText = (outcome.text ?? '').trim().length > 0;
      const hasRows = (outcome.result?.rows.length ?? 0) > 0;
      assert.ok(hasText || hasRows, '실행 계획이 비어 있습니다');
    });

    it('페이징 래퍼가 실제로 돈다', async (t) => {
      const db = ready(t);
      if (!db) return;
      const sql = buildPagedQuery(`SELECT id FROM ${users} ORDER BY id`, target.dialect, {
        limit: 2,
        offset: 1,
      });
      const result = await db.execute(sql, undefined, QUERY_OPTIONS);
      assert.equal(result.rows.length, 2);
      assert.deepEqual(
        result.rows.map((row) => Number(row[0])),
        [2, 3],
        'OFFSET 이 적용되지 않았습니다',
      );
    });

    it('페이징 + 서버 정렬 (컬럼 위치)', async (t) => {
      const db = ready(t);
      if (!db) return;
      const sql = buildPagedQuery(`SELECT id, email FROM ${users}`, target.dialect, {
        limit: 3,
        offset: 0,
        orderBy: { index: 0, dir: 'desc' },
      });
      const result = await db.execute(sql, undefined, QUERY_OPTIONS);
      assert.deepEqual(
        result.rows.map((row) => Number(row[0])),
        [5, 4, 3],
        'ORDER BY <위치> 가 적용되지 않았습니다',
      );
    });

    it('미리보기 쿼리와 행 제한', async (t) => {
      const db = ready(t);
      if (!db) return;
      const preview = driver.buildPreviewQuery(target.schema, users, 3);
      const result = await db.execute(preview, undefined, QUERY_OPTIONS);
      assert.ok(result.rows.length <= 3, '미리보기가 제한을 넘겼습니다');
      assert.ok(result.columns.length >= 4);

      const limited = driver.applyRowLimit(`SELECT id FROM ${users}`, 2);
      const limitedResult = await db.execute(limited, undefined, {
        maxRows: 2,
        timeoutMs: QUERY_OPTIONS.timeoutMs,
      });
      assert.ok(limitedResult.rows.length <= 2);
    });

    it('그리드 편집 SQL 이 정확히 한 행에만 닿는다', async (t) => {
      const db = ready(t);
      if (!db) return;
      const columns = await driver.catalog.listColumns(db, target.schema);
      const source = editSourceFor(columns, target, users);

      // id = 2 인 행의 name 을 바꾼다.
      const row = ['2', 'bravo@example.com', '브라보', 'none'];
      const update = buildUpdateStatement(driver, target.dialect, source, 2, '수정됨', [
        2,
        row[1]!,
        row[2]!,
        row[3]!,
      ]);
      const updated = await db.execute(update.sql, update.params, QUERY_OPTIONS);
      if (db.inTransaction) {
        await db.commit();
      }
      assert.equal(updated.affectedRows, 1, '영향 행 수가 1이 아니면 WHERE 가 잘못된 것이다');

      const check = await db.execute(
        `SELECT name FROM ${users} WHERE id = 2`,
        undefined,
        QUERY_OPTIONS,
      );
      assert.equal(String(check.rows[0]?.[0]), '수정됨');

      // 참조가 없는 행(id = 5)을 지운다.
      const remove = buildDeleteStatement(driver, target.dialect, source, [5, '', '', '']);
      const deleted = await db.execute(remove.sql, remove.params, QUERY_OPTIONS);
      if (db.inTransaction) {
        await db.commit();
      }
      assert.equal(deleted.affectedRows, 1);
    });

    it('실제 카탈로그로 편집 가능 판정', async (t) => {
      const db = ready(t);
      if (!db) return;
      const columns = await driver.catalog.listColumns(db, target.schema);
      const tables = await driver.catalog.listTables(db, target.schema);
      const snapshot: CatalogSnapshot = {
        loadedAt: Date.now(),
        defaultSchema: target.schema,
        schemas: [{ name: target.schema, isDefault: true }],
        tables,
        objects: [],
        columnsByTable: groupColumns(columns),
      };

      const result = await db.execute(`SELECT * FROM ${users}`, undefined, QUERY_OPTIONS);
      const outcome = computeEditSource({
        sql: `SELECT * FROM ${users}`,
        dialect: target.dialect,
        columns: result.columns,
        snapshot,
        readOnlyConnection: false,
      });

      assert.equal(outcome.editable, true, '단일 테이블 조회가 편집 가능으로 판정되어야 한다');
      if (outcome.editable) {
        assert.equal(outcome.source.keyColumns.length, 1);
        assert.equal(outcome.source.keyColumns[0]!.index, 0);
        assert.ok(outcome.source.editableColumns.length >= 2);
      }
    });
  });
}

/** 결과 컬럼 순서대로 EditSource 를 만든다 (id, email, name, note). */
function editSourceFor(
  columns: ColumnInfo[],
  target: IntegrationTarget,
  table: string,
): EditSource {
  const mine = columns
    .filter((column) => column.table === table)
    .sort((a, b) => a.ordinal - b.ordinal);
  const indexOf = (name: string): number =>
    mine.findIndex((column) => column.name.toLowerCase() === name);

  return {
    schema: target.schema,
    table,
    keyColumns: [{ name: mine[indexOf('id')]!.name, index: indexOf('id') }],
    editableColumns: [
      { name: mine[indexOf('name')]!.name, index: indexOf('name') },
      { name: mine[indexOf('note')]!.name, index: indexOf('note') },
    ],
  };
}

function groupColumns(columns: ColumnInfo[]): Map<string, ColumnInfo[]> {
  const map = new Map<string, ColumnInfo[]>();
  for (const column of columns) {
    const key = tableKey(column.schema, column.table);
    const list = map.get(key);
    if (list) {
      list.push(column);
    } else {
      map.set(key, [column]);
    }
  }
  return map;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
