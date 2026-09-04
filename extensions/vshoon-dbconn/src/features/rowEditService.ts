import * as vscode from 'vscode';
import type { CellValue, ConnectionProfile, EditSource } from '../types';
import type { ConnectionManager } from '../db/connectionManager';
import { getDriver } from '../db/registry';
import { buildDeleteStatement, buildInsertStatement, buildUpdateStatement } from '../db/rowEditor';
import { environmentLabel, isProduction } from '../config/environment';
import type { QueryHistory } from './queryHistory';
import { log } from '../util/logger';

/**
 * 결과 그리드 편집을 실제 UPDATE/DELETE 로 수행한다.
 *
 * 안전장치가 이 클래스의 존재 이유다:
 *  - 실행 전 사용자에게 생성된 구문을 그대로 보여주고 확인받는다.
 *  - WHERE 는 기본 키 전체로 구성되므로 최대 1행에만 닿는다.
 *  - 영향 행 수가 1이 아니면 실패로 취급하고 사용자에게 알린다.
 *    (0이면 다른 곳에서 이미 지웠거나 바꾼 것 — 조용히 넘어가면 안 된다)
 */

export interface EditRequest {
  profileId: string;
  editSource: EditSource;
  /** 대상 행의 현재 값 전체 — 기본 키를 여기서 읽는다. */
  row: CellValue[];
}

export interface UpdateRequest extends EditRequest {
  columnIndex: number;
  newValue: CellValue;
}

export interface InsertRequest {
  profileId: string;
  editSource: EditSource;
  /** 사용자가 값을 채운 셀만. 비운 컬럼은 서버 기본값에 맡긴다. */
  cells: { index: number; value: CellValue }[];
}

export type EditOutcome = { ok: true; message: string } | { ok: false; message: string };

export class RowEditService {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly history: QueryHistory,
  ) {}

  async updateCell(request: UpdateRequest): Promise<EditOutcome> {
    return this.run(request, (driver, dialect) =>
      buildUpdateStatement(
        driver,
        dialect,
        request.editSource,
        request.columnIndex,
        request.newValue,
        request.row,
      ),
    );
  }

  async insertRow(request: InsertRequest): Promise<EditOutcome> {
    // INSERT 는 WHERE 가 없어 "1행" 검사가 다른 의미를 갖는다 — 전용 경로로 다룬다.
    return this.run(
      { profileId: request.profileId, editSource: request.editSource, row: [] },
      (driver, dialect) => buildInsertStatement(driver, dialect, request.editSource, request.cells),
      { verb: '추가', expectSingleRow: false },
    );
  }

  async deleteRow(request: EditRequest): Promise<EditOutcome> {
    return this.run(request, (driver, dialect) =>
      buildDeleteStatement(driver, dialect, request.editSource, request.row),
    );
  }

  private async run(
    request: EditRequest,
    build: (
      driver: ReturnType<typeof getDriver>,
      dialect: import('../types').DialectId,
    ) => { sql: string; params: unknown[]; preview: string },
    options: { verb: string; expectSingleRow: boolean } = { verb: '변경', expectSingleRow: true },
  ): Promise<EditOutcome> {
    const session = this.connections.get(request.profileId);
    if (!session) {
      return { ok: false, message: '연결이 해제되어 변경을 적용할 수 없습니다.' };
    }
    if (session.profile.readOnly) {
      return { ok: false, message: '읽기 전용 연결입니다.' };
    }

    const dialect = session.profile.dialect;
    const driver = getDriver(dialect);

    let statement: { sql: string; params: unknown[]; preview: string };
    try {
      statement = build(driver, dialect);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    const confirmed = await this.confirm(statement.preview, session.profile);
    if (!confirmed) {
      return { ok: false, message: '취소했습니다.' };
    }

    const config = vscode.workspace.getConfiguration('dbconn');
    const startedAt = Date.now();
    try {
      const result = await session.execute(
        statement.sql,
        { maxRows: 1, timeoutMs: config.get<number>('execution.queryTimeoutMs', 60_000) },
        statement.params,
      );

      // 이력에는 값이 채워진 미리보기를 남긴다 — 바인드 자리 표시자만 남기면
      // 나중에 "무엇을 바꿨는지" 알아볼 수 없다.
      this.history.record({
        sql: statement.preview,
        profileId: session.profile.id,
        connectionName: session.profile.name,
        dialect,
        origin: 'grid-edit',
        startedAt,
        durationMs: result.durationMs,
        status: 'ok',
        affectedRows: result.affectedRows,
      });

      const affected = result.affectedRows ?? 0;
      if (affected === 0) {
        return {
          ok: false,
          message: options.expectSingleRow
            ? '해당 행을 찾지 못했습니다 (0행 영향). 다른 곳에서 이미 변경되었을 수 있습니다. 다시 조회하세요.'
            : '행이 추가되지 않았습니다 (0행 영향).',
        };
      }
      if (affected > 1 && options.expectSingleRow) {
        // 기본 키로 WHERE 를 만들었으므로 여기 오면 안 된다.
        // 그래도 왔다면 사용자가 즉시 알아야 한다.
        log.error(
          `[${session.profile.name}] 그리드 편집이 ${affected}행에 영향을 줬습니다. ` +
            `기본 키가 실제로 고유하지 않을 수 있습니다.\n${statement.preview}`,
        );
        return {
          ok: false,
          message: `예상과 달리 ${affected}행이 변경됐습니다. 로그를 확인하고 필요하면 롤백하세요.`,
        };
      }

      log.info(`[${session.profile.name}] 그리드 편집 적용\n${statement.preview}`);
      const note = session.autoCommit ? '' : ' (커밋 필요)';
      return { ok: true, message: `${affected}행이 ${options.verb}됐습니다.${note}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[${session.profile.name}] 그리드 편집 실패: ${message}`);
      this.history.record({
        sql: statement.preview,
        profileId: session.profile.id,
        connectionName: session.profile.name,
        dialect,
        origin: 'grid-edit',
        startedAt,
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: message,
      });
      return { ok: false, message };
    }
  }

  /**
   * 생성된 구문을 그대로 보여주고 확인받는다.
   *
   * 매번 묻는 게 번거로울 수 있지만, 그리드에서 실수로 친 키 하나가
   * 조용히 운영 데이터를 바꾸는 것보다는 낫다. 끄고 싶으면 설정으로 끈다 —
   * 단, **운영 연결에서는 설정과 무관하게 항상 묻는다.** 확인을 꺼 둔 채
   * 운영에 붙는 것이 가장 흔한 사고 경로이기 때문이다.
   */
  private async confirm(preview: string, profile: ConnectionProfile): Promise<boolean> {
    const production = isProduction(profile.environment);
    const enabled = vscode.workspace
      .getConfiguration('dbconn')
      .get<boolean>('edit.confirmEachChange', true);
    if (!enabled && !production) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      production ? '운영 데이터를 변경합니다.' : '데이터를 변경합니다.',
      {
        modal: true,
        detail: `연결: ${profile.name} (${environmentLabel(profile.environment)})\n\n${preview}`,
      },
      '적용',
    );
    return choice === '적용';
  }
}
