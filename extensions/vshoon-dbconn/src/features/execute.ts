import * as vscode from 'vscode';
import type { ConnectionManager } from '../db/connectionManager';
import type { Session } from '../db/session';
import type { CatalogCache } from '../metadata/catalog';
import type { QueryResult } from '../types';
import type { ResultPage, ResultPager, ResultTab, ResultsPanel } from '../views/resultsPanel';
import type { QueryHistory } from './queryHistory';
import { computeEditSource } from '../sql/editable';
import {
  analyzeStatement,
  ReadOnlyViolationError,
  targetObjectName,
  type StatementAnalysis,
} from '../sql/guard';
import { environmentLabel, isProduction } from '../config/environment';
import { buildPagedQuery, hasDuplicateColumnNames, isPageable } from '../sql/paging';
import { splitStatements, statementAt, type SqlStatement } from '../sql/statements';
import { CancelledError } from '../util/async';
import { log } from '../util/logger';

/**
 * 쿼리 실행 명령.
 *
 * Ctrl+Enter 의 동작 규칙 (DBeaver/DataGrip 관례를 따른다):
 *  - 선택 영역이 있으면 그것만 실행한다.
 *  - 없으면 커서가 있는 문장을 실행한다. 세미콜론이 없어도 되고,
 *    문장 중간 어디에 커서가 있어도 된다.
 *  - 실행되는 범위를 잠깐 하이라이트해서 "무엇이 실행됐는지" 보이게 한다.
 *
 * 결과 탭은 **편집기 문서마다 하나의 묶음**으로 관리된다. 같은 문서에서
 * 다시 실행하면 고정되지 않은 이전 결과를 대체한다.
 */

/** 실행된 구문을 잠시 강조하는 데코레이션. */
const executedDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  isWholeLine: false,
});

export class QueryExecutor implements ResultPager {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly results: ResultsPanel,
    private readonly catalog: CatalogCache,
    private readonly history: QueryHistory,
  ) {}

  /** Ctrl+Enter — 커서 위치의 한 문장(또는 선택 영역). */
  async executeAtCursor(editor: vscode.TextEditor): Promise<void> {
    const session = await this.requireSession(editor);
    if (!session) {
      return;
    }

    const statements = this.statementsAtCursor(editor, session.profile.dialect);
    if (statements.length === 0) {
      void vscode.window.showInformationMessage('실행할 SQL 을 찾지 못했습니다.');
      return;
    }

    await this.runSequence(session, editor, statements);
  }

  /** 선택 영역이 있으면 그 안의 구문들, 없으면 커서가 놓인 구문 하나. */
  private statementsAtCursor(
    editor: vscode.TextEditor,
    dialect: import('../types').DialectId,
  ): SqlStatement[] {
    const document = editor.document;
    const selection = editor.selection;

    if (!selection.isEmpty) {
      const text = document.getText(selection);
      const base = document.offsetAt(selection.start);
      return splitStatements(text, dialect).map((s) => ({
        ...s,
        start: s.start + base,
        end: s.end + base,
      }));
    }

    const found = statementAt(
      document.getText(),
      document.offsetAt(selection.active),
      dialect,
    );
    return found ? [found] : [];
  }

  /**
   * 커서 위치 구문의 실행 계획.
   *
   * analyze 는 구문을 **실제로 실행하며** 측정한다. 세션이 SELECT 인지 다시
   * 확인하지만, 사용자에게도 먼저 확인을 받는다 — 계획을 보려던 것이
   * 실행으로 이어지는 일은 없어야 한다.
   *
   * 계획 탭은 기존 결과 탭을 밀어내지 않는다. 결과와 계획을 나란히 두고
   * 비교하는 것이 이 기능을 쓰는 이유이기 때문이다.
   */
  async explainAtCursor(editor: vscode.TextEditor, analyze: boolean): Promise<void> {
    const session = await this.requireSession(editor);
    if (!session) {
      return;
    }

    const statements = this.statementsAtCursor(editor, session.profile.dialect);
    const statement = statements[0];
    if (!statement) {
      void vscode.window.showInformationMessage('계획을 볼 SQL 을 찾지 못했습니다.');
      return;
    }

    if (analyze) {
      const choice = await vscode.window.showWarningMessage(
        '실행하며 측정합니다. 구문이 실제로 수행됩니다.',
        {
          modal: true,
          detail: `연결: ${session.profile.name}\n\n${statement.text.slice(0, 300)}`,
        },
        '실행하며 측정',
      );
      if (choice !== '실행하며 측정') {
        return;
      }
    }

    this.highlight(editor, [statement]);

    const config = vscode.workspace.getConfiguration('dbconn');
    const timeoutMs = config.get<number>('execution.queryTimeoutMs', 60_000);
    const sourceKey = editor.document.uri.toString();
    const tabId = this.results.beginQuery(
      statement.text,
      session.profile.name,
      session.profile.id,
      sourceKey,
      analyze ? '측정' : '계획',
      session.profile.environment,
    );

    const startedAt = Date.now();
    try {
      const outcome = await session.explain(
        statement.text,
        { analyze },
        { maxRows: 10_000, timeoutMs },
      );
      const durationMs = Date.now() - startedAt;

      if (outcome.result) {
        this.results.completeQuery(tabId, outcome.result);
      } else {
        this.results.completePlan(tabId, {
          text: outcome.text ?? '',
          note: outcome.note,
          durationMs,
        });
      }
      this.history.record({
        sql: statement.text,
        profileId: session.profile.id,
        connectionName: session.profile.name,
        dialect: session.profile.dialect,
        origin: 'explain',
        startedAt,
        durationMs,
        status: 'ok',
      });
    } catch (error) {
      this.results.failQuery(tabId, error);
      this.history.record({
        sql: statement.text,
        profileId: session.profile.id,
        connectionName: session.profile.name,
        dialect: session.profile.dialect,
        origin: 'explain',
        startedAt,
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      this.reportError(error, session);
    }
  }

  /** Ctrl+Shift+Enter — 문서 전체(또는 선택 영역)의 모든 문장. */
  async executeAll(editor: vscode.TextEditor): Promise<void> {
    const session = await this.requireSession(editor);
    if (!session) {
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const useSelection = !selection.isEmpty;
    const text = useSelection ? document.getText(selection) : document.getText();
    const base = useSelection ? document.offsetAt(selection.start) : 0;

    const statements = splitStatements(text, session.profile.dialect).map((s) => ({
      ...s,
      start: s.start + base,
      end: s.end + base,
    }));

    if (statements.length === 0) {
      void vscode.window.showInformationMessage('실행할 SQL 을 찾지 못했습니다.');
      return;
    }

    await this.runSequence(session, editor, statements);
  }

  /**
   * 문장들을 순서대로 실행한다.
   * 하나라도 실패하면 뒤는 실행하지 않는다 — 앞 구문이 실패했는데
   * 뒤를 계속 밀어붙이면 데이터가 어중간한 상태로 남는다.
   */
  private async runSequence(
    session: Session,
    editor: vscode.TextEditor,
    statements: SqlStatement[],
  ): Promise<void> {
    const confirmed = await this.confirmBeforeRun(session, statements);
    if (!confirmed) {
      return;
    }

    this.highlight(editor, statements);

    const config = vscode.workspace.getConfiguration('dbconn');
    const maxRows = config.get<number>('execution.maxRows', 1000);
    const timeoutMs = config.get<number>('execution.queryTimeoutMs', 60_000);

    // 이 문서의 이전 결과(고정하지 않은 것)를 비우고 새 묶음을 시작한다.
    const sourceKey = editor.document.uri.toString();
    this.results.beginRun(sourceKey);

    await vscode.commands.executeCommand('setContext', 'dbconn.running', true);
    try {
      for (const statement of statements) {
        const tabId = this.results.beginQuery(
          statement.text,
          session.profile.name,
          session.profile.id,
          sourceKey,
          undefined,
          session.profile.environment,
        );
        const startedAt = Date.now();
        try {
          const result = await session.execute(statement.text, { maxRows, timeoutMs });
          await this.attachEditSource(session, result, tabId);
          this.results.completeQuery(
            tabId,
            result,
            this.initialPage(statement.text, session, result, maxRows),
          );
          this.history.record({
            sql: statement.text,
            profileId: session.profile.id,
            connectionName: session.profile.name,
            dialect: session.profile.dialect,
            origin: 'editor',
            startedAt,
            durationMs: result.durationMs,
            status: 'ok',
            rowCount: result.kind === 'rows' ? result.rowCount : undefined,
            affectedRows: result.affectedRows,
          });
          log.info(
            `[${session.profile.name}] 실행 완료 — ${result.durationMs}ms, ` +
              (result.kind === 'rows'
                ? `${result.rowCount}행`
                : `${result.affectedRows ?? 0}행 영향`),
          );
        } catch (error) {
          this.results.failQuery(tabId, error);
          this.history.record({
            sql: statement.text,
            profileId: session.profile.id,
            connectionName: session.profile.name,
            dialect: session.profile.dialect,
            origin: 'editor',
            startedAt,
            durationMs: Date.now() - startedAt,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          this.reportError(error, session);
          return; // 실패 지점에서 멈춘다.
        }
      }
    } finally {
      await vscode.commands.executeCommand('setContext', 'dbconn.running', false);
    }
  }

  /**
   * 첫 실행 결과에 페이징 상태를 만들어 붙인다.
   *
   * 첫 쪽은 사용자가 쓴 SQL 을 그대로 돌린 결과다 — 감싸지 않는다.
   * 잘린 결과(truncated)면 다음 쪽이 있다는 뜻이다.
   */
  private initialPage(
    sql: string,
    session: Session,
    result: QueryResult,
    pageSize: number,
  ): ResultPage | undefined {
    if (result.kind !== 'rows' || !isPageable(sql, session.profile.dialect)) {
      return undefined;
    }
    // 이름이 겹치는 컬럼이 있으면 SELECT * 로 감쌀 수 없다 (MySQL·Oracle 이 거부).
    if (hasDuplicateColumnNames(result.columns.map((column) => column.name))) {
      return undefined;
    }
    return { sql, offset: 0, pageSize, hasMore: result.truncated };
  }

  /**
   * 다음/이전 쪽, 또는 서버 측 정렬로 같은 탭을 다시 채운다.
   *
   * 한 행을 더 요청해서 "다음 쪽이 있는지"를 정확히 판단한다. 총 건수를
   * 세지 않는 이유는 COUNT(*) 가 큰 테이블에서 페이지 이동보다 훨씬 비싸기 때문이다.
   */
  async runPage(
    tab: ResultTab,
    request: {
      offset: number;
      sort?: { index: number; dir: 'asc' | 'desc' };
      append?: boolean;
    },
  ): Promise<void> {
    const page = tab.page;
    if (!page) {
      return;
    }
    const append = request.append === true;
    const session = this.connections.get(tab.profileId);
    if (!session) {
      void vscode.window.showWarningMessage('연결이 해제되어 다른 쪽을 불러올 수 없습니다.');
      if (append) {
        this.results.failAppend(tab.id);
      }
      return;
    }

    const timeoutMs = vscode.workspace
      .getConfiguration('dbconn')
      .get<number>('execution.queryTimeoutMs', 60_000);
    const pageSize = page.pageSize;

    let sql: string;
    try {
      sql = buildPagedQuery(page.sql, session.profile.dialect, {
        limit: pageSize + 1,
        offset: request.offset,
        orderBy: request.sort,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      if (append) {
        this.results.failAppend(tab.id);
      }
      return;
    }

    // 이어 붙이기는 그리드를 비우지 않는다 — 보고 있던 위치와 선택을 지킨다.
    // 붙일 자리를 요청 시점에 찍어 둔다. 응답이 오는 사이 쪽이 바뀌었으면
    // 결과 패널이 이 묶음을 버린다.
    const expected = { offset: page.offset, loaded: tab.result?.rows.length ?? 0 };
    if (append) {
      this.results.beginAppend(tab.id);
    } else {
      this.results.beginReload(tab.id);
    }

    try {
      const result = await session.execute(sql, { maxRows: pageSize + 1, timeoutMs });

      // 한 행 더 받아 왔으면 다음 쪽이 있다는 뜻 — 그 행은 화면에 넣지 않는다.
      const hasMore = result.rows.length > pageSize;
      if (hasMore) {
        result.rows.length = pageSize;
        result.rowCount = result.rows.length;
      }
      result.truncated = false;
      // 표시·편집 판정은 원본 SQL 기준이어야 한다. 감싼 쿼리는 서브쿼리로 보여
      // 편집이 막히고, "SQL 열기"도 사용자가 쓰지 않은 문장을 보여주게 된다.
      result.sql = page.sql;

      if (append) {
        this.results.appendRows(tab.id, result.rows, hasMore, expected);
        return;
      }

      await this.attachEditSource(session, result, tab.id);
      this.results.completeQuery(tab.id, result, {
        ...page,
        offset: request.offset,
        hasMore,
        sort: request.sort,
      });
    } catch (error) {
      if (append) {
        // 이미 받아 둔 행까지 오류 화면으로 덮으면 손해가 크다.
        this.results.failAppend(tab.id);
      } else {
        this.results.failQuery(tab.id, error);
      }
      this.reportError(error, session);
    }
  }

  /**
   * 결과가 단일 테이블 조회면 그리드에서 편집할 수 있게 근거를 붙인다.
   * 판정은 보수적이라 조건에 조금이라도 안 맞으면 읽기 전용으로 남는다.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- 호출부의 비동기 계약을 유지한다
  async attachEditSource(session: Session, result: QueryResult, tabId?: string): Promise<void> {
    if (result.kind !== 'rows' || result.columns.length === 0) {
      return;
    }
    if (!vscode.workspace.getConfiguration('dbconn').get<boolean>('edit.enabled', true)) {
      return;
    }

    // 이미 캐시된 스냅샷만 쓴다. 편집 가능 여부를 알아내려고
    // 실행 경로에서 카탈로그를 새로 읽어 오면 결과 표시가 느려진다.
    const snapshot = this.catalog.peek(session.profile.id);
    const outcome = computeEditSource({
      sql: result.sql,
      dialect: session.profile.dialect,
      columns: result.columns,
      snapshot,
      readOnlyConnection: session.profile.readOnly,
    });

    if (outcome.editable) {
      result.editSource = outcome.source;
      return;
    }

    log.debug(`그리드 편집 불가: ${outcome.reason}`);

    // 메타데이터가 아직 없어서 못 정한 것뿐이라면, 결과를 먼저 보여 준 뒤
    // 카탈로그가 도착하면 다시 판정해 그리드를 편집 가능으로 바꾼다.
    // (연결 직후 첫 조회에서 편집이 안 되는 문제를 없앤다)
    if (outcome.reason === 'no-metadata' && !snapshot && tabId) {
      this.retryEditSourceLater(session, result, tabId);
    }
  }

  /** 카탈로그 로딩을 기다렸다가 편집 가능 여부를 한 번 더 본다. */
  private retryEditSourceLater(session: Session, result: QueryResult, tabId: string): void {
    void this.catalog
      .get(session)
      .then((snapshot) => {
        if (!snapshot) {
          return;
        }
        const outcome = computeEditSource({
          sql: result.sql,
          dialect: session.profile.dialect,
          columns: result.columns,
          snapshot,
          readOnlyConnection: session.profile.readOnly,
        });
        if (outcome.editable) {
          this.results.setEditSource(tabId, outcome.source);
        }
      })
      .catch((error: unknown) => {
        log.debug('편집 가능 여부 재판정 실패', error);
      });
  }

  /**
   * 실행 전 확인.
   *
   * 두 축으로 본다:
   *  - **구문 자체의 위험도** — WHERE 없는 DELETE, DROP/TRUNCATE 등.
   *  - **연결 환경** — 운영 연결에서는 평범한 UPDATE 한 줄도 사고가 된다.
   *
   * 운영에서는 확인 한 번으로 끝내지 않고 대상 이름을 직접 입력하게 한다.
   * 손이 기억한 대로 Enter 를 누르는 것을 막는 것이 목적이다.
   */
  private async confirmBeforeRun(
    session: Session,
    statements: SqlStatement[],
  ): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('dbconn');
    const analyzed = statements.map((statement) => ({
      statement,
      analysis: analyzeStatement(statement.text, session.profile.dialect),
    }));
    const mutating = analyzed.filter((entry) => entry.analysis.mutates);
    const risky = analyzed.filter((entry) => entry.analysis.risk === 'high');

    // ── 운영 연결 ──
    if (isProduction(session.profile.environment) && mutating.length > 0) {
      const mode = config.get<string>('execution.productionGuard', 'type-to-confirm');
      if (mode !== 'off') {
        const accepted = await this.confirmProduction(session, mutating, risky, mode);
        if (!accepted) {
          return false;
        }
        // 운영 확인을 통과했으면 같은 내용을 또 묻지 않는다.
        return true;
      }
    }

    // ── 일반 위험 구문 ──
    if (!config.get<boolean>('execution.confirmDestructive', true) || risky.length === 0) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `위험할 수 있는 구문 ${risky.length}개를 실행하려고 합니다.`,
      { modal: true, detail: this.buildRiskDetail(session, risky) },
      '실행',
    );
    return choice === '실행';
  }

  /** 운영 연결에서의 변경 구문 — 무엇이 도는지 보여주고, 대상 이름을 받아 확인한다. */
  private async confirmProduction(
    session: Session,
    mutating: { statement: SqlStatement; analysis: StatementAnalysis }[],
    risky: { statement: SqlStatement; analysis: StatementAnalysis }[],
    mode: string,
  ): Promise<boolean> {
    const shown = risky.length > 0 ? risky : mutating;
    const choice = await vscode.window.showWarningMessage(
      `운영 연결에서 변경 구문 ${mutating.length}개를 실행하려고 합니다.`,
      { modal: true, detail: this.buildRiskDetail(session, shown) },
      '계속',
    );
    if (choice !== '계속') {
      return false;
    }
    if (mode !== 'type-to-confirm') {
      return true;
    }

    // 대상 이름을 알 수 없으면(드문 구문) 연결 이름으로 대신한다.
    const target =
      targetObjectName(shown[0]!.statement.text, session.profile.dialect) ?? session.profile.name;
    const typed = await vscode.window.showInputBox({
      title: `운영 실행 확인 — ${session.profile.name}`,
      prompt: `실행하려면 "${target}" 을(를) 그대로 입력하세요.`,
      placeHolder: target,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() === target ? undefined : `"${target}" 을(를) 정확히 입력해야 실행됩니다.`,
    });
    return typed?.trim() === target;
  }

  private buildRiskDetail(
    session: Session,
    entries: { statement: SqlStatement; analysis: StatementAnalysis }[],
  ): string {
    const reasons = [...new Set(entries.flatMap((entry) => entry.analysis.reasons))];
    return [
      `연결: ${session.profile.name} (${environmentLabel(session.profile.environment)})`,
      ...reasons.map((reason) => `• ${reason}`),
      '',
      entries[0]!.statement.text.slice(0, 300),
    ].join('\n');
  }

  /** 실행된 범위를 잠깐 보여 준다 — 무엇이 돌았는지 눈으로 확인되게. */
  private highlight(editor: vscode.TextEditor, statements: SqlStatement[]): void {
    const ranges = statements.map(
      (s) =>
        new vscode.Range(editor.document.positionAt(s.start), editor.document.positionAt(s.end)),
    );
    editor.setDecorations(executedDecoration, ranges);
    setTimeout(() => {
      // 편집기가 이미 닫혔을 수 있다.
      if (vscode.window.visibleTextEditors.includes(editor)) {
        editor.setDecorations(executedDecoration, []);
      }
    }, 400);
  }

  private reportError(error: unknown, session: Session): void {
    if (error instanceof CancelledError) {
      void vscode.window.setStatusBarMessage('$(stop-circle) 쿼리를 취소했습니다.', 3000);
      return;
    }
    if (error instanceof ReadOnlyViolationError) {
      void vscode.window.showErrorMessage(error.message, '연결 편집').then((choice) => {
        if (choice === '연결 편집') {
          void vscode.commands.executeCommand('dbconn.editConnection', {
            profileId: session.profile.id,
          });
        }
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[${session.profile.name}] 실행 실패: ${message}`);
    // 상세 내용은 결과 패널에 이미 있으므로 알림은 짧게.
    void vscode.window.showErrorMessage(firstLine(message), '로그 보기').then((choice) => {
      if (choice === '로그 보기') {
        log.show();
      }
    });
  }

  /**
   * 실행에 쓸 연결을 확보한다.
   *
   * 순서가 중요하다: **이 편집기에 지정된 연결이 언제나 먼저**다. 지정해 둔
   * 연결이 아직 접속 전이라고 전역 기본으로 넘어가면, 개발용 편집기의 쿼리가
   * 운영에서 도는 사고가 난다. 그래서 지정이 있으면 그 연결을 열고,
   * 열지 못하면 실행하지 않는다.
   */
  private async requireSession(editor?: vscode.TextEditor): Promise<Session | undefined> {
    const bound = this.connections.boundProfileId(editor?.document.uri.toString());
    if (bound) {
      return this.connections.get(bound) ?? (await this.connections.connectById(bound));
    }

    const active = this.connections.activeSession();
    if (active) {
      return active;
    }
    await vscode.commands.executeCommand('dbconn.setActiveConnection');
    return this.connections.activeSession();
  }

  dispose(): void {
    executedDecoration.dispose();
  }
}

function firstLine(text: string): string {
  const index = text.indexOf('\n');
  return index === -1 ? text : text.slice(0, index);
}
