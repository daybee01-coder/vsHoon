import * as vscode from 'vscode';
import type {
  ConnectionProfile,
  ExplainOptions,
  ExplainOutcome,
  PoolStats,
  QueryOptions,
  QueryResult,
  SessionStatus,
  TransactionState,
} from '../types';
import { analyzeStatement, assertAllowedInReadOnly, type StatementAnalysis } from '../sql/guard';
import { CancelledError, SerialQueue } from '../util/async';
import { log } from '../util/logger';
import type { Driver, RawConnection } from './driver';
import { ConnectionPool, Lease, isConnectionFatal } from './pool';
import { getDriver } from './registry';

/**
 * 하나의 연결 프로필에 대한 활성 세션.
 *
 * 트랜잭션 처리가 이 클래스의 핵심이다:
 *
 *  - 자동 커밋 모드: 매 실행이 풀에서 커넥션을 빌리고 finally 로 반납한다.
 *    커넥션이 사용자 사이에 걸쳐 남아 있지 않는다.
 *
 *  - 수동 커밋 모드: 트랜잭션 전용 커넥션 하나를 sticky 대여로 붙잡고,
 *    COMMIT/ROLLBACK 이 올 때까지 유지한다. 붙잡은 채 잊히더라도
 *    풀 자니터가 transactionIdleTimeout 후 롤백하고 회수한다.
 *
 * 어느 모드든 "열린 트랜잭션이 풀로 돌아가는" 경로는 존재하지 않는다.
 */
export class Session implements vscode.Disposable {
  readonly pool: ConnectionPool;
  private readonly driver: Driver;
  /** 수동 커밋 모드에서 트랜잭션을 붙잡고 있는 대여. */
  private txLease: Lease | undefined;
  private txState: TransactionState = 'none';
  private autoCommitFlag: boolean;
  /** 실행 중인 쿼리의 취소 핸들. */
  private running: { controller: AbortController; connection?: RawConnection } | undefined;
  /** 같은 세션에 대한 실행이 서로 끼어들지 않게 직렬화한다. */
  private readonly queue = new SerialQueue();
  private disposed = false;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  /**
   * 연결할 때의 프로필 사본.
   *
   * 접속에 쓰인 값(호스트·풀 설정 등)은 세션이 사는 동안 바뀌지 않아야 해서
   * 사본으로 든다. 다만 **이름은 표시용**이라 바뀔 수 있고, 그때는 상태바가
   * 옛 이름을 붙들고 있지 않도록 이 사본도 따라가야 한다 (rename 참고).
   */
  private profileState: ConnectionProfile;

  constructor(
    profile: ConnectionProfile,
    /**
     * 비밀번호는 풀이 커넥션을 새로 만들 때마다 필요하므로 세션이 살아 있는
     * 동안 메모리에 유지된다. disconnect 시 즉시 지운다.
     */
    private password: string | undefined,
    autoCommit: boolean,
    onZombieReclaimed: (info: { purpose: string; ageMs: number; reason: string }) => void,
  ) {
    this.profileState = profile;
    this.driver = getDriver(profile.dialect);
    this.autoCommitFlag = autoCommit;
    this.pool = new ConnectionPool(
      profile.name,
      profile.pool,
      (signal) => this.driver.connect(profile, this.password, signal),
      {
        onReclaimed: (info) => {
          if (info.reason === 'transaction-idle-timeout') {
            this.txLease = undefined;
            this.txState = 'none';
            this.onDidChangeEmitter.fire();
          }
          onZombieReclaimed(info);
        },
      },
    );
  }

  get profile(): ConnectionProfile {
    return this.profileState;
  }

  /**
   * 표시 이름만 바꾼다. 이미 열린 커넥션과 풀은 그대로다 —
   * 풀의 로그 이름은 만들 때 정해지므로 옛 이름으로 남는다.
   */
  rename(name: string): void {
    this.profileState = { ...this.profileState, name };
  }

  get autoCommit(): boolean {
    return this.autoCommitFlag;
  }

  get transactionState(): TransactionState {
    return this.txState;
  }

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  status(): SessionStatus {
    return {
      profileId: this.profile.id,
      profileName: this.profile.name,
      dialect: this.profile.dialect,
      connected: !this.disposed,
      autoCommit: this.autoCommitFlag,
      transaction: this.txState,
      readOnly: this.profile.readOnly,
    };
  }

  stats(): PoolStats {
    return this.pool.stats();
  }

  /** 연결 확인 — 커넥션을 하나 만들어 보고 바로 반납한다. */
  async testConnection(): Promise<void> {
    await this.pool.withConnection('connection-test', async (conn) => {
      const ok = await conn.validate();
      if (!ok) {
        throw new Error('커넥션이 살아 있지 않습니다.');
      }
    });
  }

  // ── 쿼리 실행 ─────────────────────────────────────────────────────────────

  /**
   * SQL 한 구문을 실행한다.
   *
   * 호출자는 이 메서드가 던지는 예외를 그대로 사용자에게 보여도 된다 —
   * 드라이버 오류는 각 드라이버에서 이미 읽을 수 있는 문장으로 감싸 놓았다.
   */
  async execute(
    sql: string,
    options: Omit<QueryOptions, 'signal'>,
    /** 바인드 파라미터. 그리드 편집이 만든 UPDATE/DELETE 가 사용한다. */
    params?: readonly unknown[],
  ): Promise<QueryResult> {
    if (this.disposed) {
      throw new Error(`"${this.profile.name}" 연결이 이미 해제됐습니다.`);
    }

    const analysis = analyzeStatement(sql, this.profile.dialect);
    if (this.profile.readOnly) {
      // 서버 측 읽기 전용 세션이 1차 방어선이지만, 여기서 먼저 막아야
      // 사용자가 오류 대신 명확한 안내를 즉시 받는다.
      assertAllowedInReadOnly(analysis);
    }

    return this.queue.run(() => this.executeSerialized(sql, analysis, options, params));
  }

  /**
   * 실행 계획을 얻는다.
   *
   * execute 와 경로가 다른 이유: Oracle 은 `EXPLAIN PLAN FOR` 와
   * `DBMS_XPLAN.DISPLAY` 를 **같은 세션**에서 연달아 실행해야 해서,
   * 드라이버가 커넥션을 직접 잡고 두 구문을 처리한다.
   *
   * analyze 는 구문을 실제로 수행한다. 그래서 SELECT 가 아니면 거부한다 —
   * "계획만 보려다 UPDATE 가 돌아가는" 사고는 절대 나면 안 된다.
   */
  async explain(
    sql: string,
    explainOptions: ExplainOptions,
    options: Omit<QueryOptions, 'signal'>,
  ): Promise<ExplainOutcome> {
    if (this.disposed) {
      throw new Error(`"${this.profile.name}" 연결이 이미 해제됐습니다.`);
    }

    const analysis = analyzeStatement(sql, this.profile.dialect);
    if (explainOptions.analyze) {
      if (analysis.category !== 'select') {
        throw new Error(
          '실제 실행을 동반하는 계획 측정(ANALYZE)은 SELECT 구문에만 허용됩니다. ' +
            '변경 구문은 계획만 확인하세요.',
        );
      }
      if (this.profile.readOnly) {
        assertAllowedInReadOnly(analysis);
      }
    }

    return this.queue.run(async () => {
      const controller = new AbortController();
      this.running = { controller };
      this.onDidChangeEmitter.fire();
      try {
        const queryOptions: QueryOptions = { ...options, signal: controller.signal };

        // 트랜잭션이 열려 있으면 그 커넥션에서 본다 — 다른 커넥션에서는
        // 아직 커밋되지 않은 스키마 변경이 보이지 않는다.
        const lease = this.txLease;
        if (lease && !lease.released) {
          lease.touch();
          this.running = { controller, connection: lease.connection };
          const outcome = await this.driver.explain(
            lease.connection,
            sql,
            explainOptions,
            queryOptions,
          );
          lease.touch();
          return outcome;
        }

        return await this.pool.withConnection(
          `explain: ${preview(sql)}`,
          async (conn) => {
            this.running = { controller, connection: conn };
            const outcome = await this.driver.explain(conn, sql, explainOptions, queryOptions);
            // Oracle 의 EXPLAIN PLAN 은 PLAN_TABLE 에 행을 넣어 트랜잭션을 연다.
            // 롤백하면 그 임시 행까지 함께 정리된다.
            if (conn.inTransaction) {
              await conn.rollback();
            }
            return outcome;
          },
          controller.signal,
        );
      } finally {
        this.running = undefined;
        this.onDidChangeEmitter.fire();
      }
    });
  }

  private async executeSerialized(
    sql: string,
    analysis: StatementAnalysis,
    options: Omit<QueryOptions, 'signal'>,
    params: readonly unknown[] | undefined,
  ): Promise<QueryResult> {
    const controller = new AbortController();
    this.running = { controller };
    this.onDidChangeEmitter.fire();

    try {
      // COMMIT/ROLLBACK 은 SQL 로 보내지 않고 세션 API 로 처리한다.
      // 그래야 확장이 아는 트랜잭션 상태와 실제 상태가 어긋나지 않는다.
      const tcl = this.interceptTransactionControl(analysis, sql);
      if (tcl) {
        return await tcl;
      }

      const queryOptions: QueryOptions = { ...options, signal: controller.signal };

      if (this.autoCommitFlag && !this.txLease) {
        return await this.executeAutoCommit(sql, queryOptions, params);
      }
      return await this.executeInTransaction(sql, analysis, queryOptions, params);
    } finally {
      this.running = undefined;
      this.onDidChangeEmitter.fire();
    }
  }

  /** 자동 커밋: 빌려서 실행하고 반드시 반납. */
  private async executeAutoCommit(
    sql: string,
    options: QueryOptions,
    params: readonly unknown[] | undefined,
  ): Promise<QueryResult> {
    return this.pool.withConnection(
      `query: ${preview(sql)}`,
      async (conn) => {
        this.running = { controller: this.running!.controller, connection: conn };
        const result = await conn.execute(sql, params, options);
        // Oracle 처럼 암묵적으로 트랜잭션이 열리는 경우를 정리한다.
        if (conn.inTransaction) {
          await conn.commit();
        }
        return result;
      },
      options.signal,
    );
  }

  /** 수동 커밋: 트랜잭션 전용 커넥션을 잡아 두고 재사용. */
  private async executeInTransaction(
    sql: string,
    analysis: StatementAnalysis,
    options: QueryOptions,
    params: readonly unknown[] | undefined,
  ): Promise<QueryResult> {
    const lease = await this.ensureTransactionLease(options.signal);
    lease.touch();
    this.running = { controller: this.running!.controller, connection: lease.connection };

    try {
      const result = await lease.connection.execute(sql, params, options);
      lease.touch();
      if (analysis.mutates) {
        this.txState = 'active';
        this.onDidChangeEmitter.fire();
      }
      return result;
    } catch (error) {
      if (isConnectionFatal(error)) {
        // 커넥션이 죽었으면 트랜잭션도 이미 사라졌다. 상태를 정리한다.
        this.txLease = undefined;
        this.txState = 'none';
        await lease.destroy('connection-error');
        this.onDidChangeEmitter.fire();
        throw error;
      }
      // PostgreSQL 은 오류 후 트랜잭션이 aborted 상태가 되어 이후 구문을 모두 거부한다.
      // 사용자가 ROLLBACK 해야 함을 상태로 알린다.
      if (this.profile.dialect === 'postgres') {
        this.txState = 'failed';
        this.onDidChangeEmitter.fire();
      }
      throw error;
    }
  }

  private async ensureTransactionLease(signal?: AbortSignal): Promise<Lease> {
    if (this.txLease && !this.txLease.released) {
      return this.txLease;
    }
    const lease = await this.pool.acquire('transaction', true, signal);
    try {
      await lease.connection.begin();
    } catch (error) {
      await lease.destroy('begin-failed');
      throw error;
    }
    this.txLease = lease;
    this.txState = 'active';
    this.onDidChangeEmitter.fire();
    return lease;
  }

  /** COMMIT/ROLLBACK/BEGIN 을 세션 API 로 돌린다. 아니면 undefined. */
  private interceptTransactionControl(
    analysis: StatementAnalysis,
    sql: string,
  ): Promise<QueryResult> | undefined {
    if (analysis.category !== 'tcl') {
      return undefined;
    }
    const keyword = analysis.leadingKeyword;
    const started = Date.now();
    const wrap = (message: string): QueryResult => ({
      kind: 'update',
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: 0,
      truncated: false,
      durationMs: Date.now() - started,
      messages: [message],
      sql,
    });

    if (keyword === 'COMMIT') {
      return this.commit().then(() => wrap('커밋했습니다.'));
    }
    if (keyword === 'ROLLBACK') {
      return this.rollback().then(() => wrap('롤백했습니다.'));
    }
    if (keyword === 'BEGIN' || keyword === 'START') {
      return this.beginTransaction().then(() => wrap('트랜잭션을 시작했습니다.'));
    }
    // SAVEPOINT / RELEASE 는 그대로 서버로 보낸다.
    return undefined;
  }

  // ── 트랜잭션 제어 ─────────────────────────────────────────────────────────

  async beginTransaction(): Promise<void> {
    this.autoCommitFlag = false;
    await this.ensureTransactionLease();
  }

  async commit(): Promise<void> {
    const lease = this.txLease;
    if (!lease || lease.released) {
      this.txState = 'none';
      this.onDidChangeEmitter.fire();
      return;
    }
    try {
      await lease.connection.commit();
      log.info(`[${this.profile.name}] 커밋 완료`);
    } finally {
      this.txLease = undefined;
      this.txState = 'none';
      await lease.release();
      this.onDidChangeEmitter.fire();
    }
  }

  async rollback(): Promise<void> {
    const lease = this.txLease;
    if (!lease || lease.released) {
      this.txState = 'none';
      this.onDidChangeEmitter.fire();
      return;
    }
    try {
      await lease.connection.rollback();
      log.info(`[${this.profile.name}] 롤백 완료`);
    } finally {
      this.txLease = undefined;
      this.txState = 'none';
      await lease.release();
      this.onDidChangeEmitter.fire();
    }
  }

  /**
   * 자동 커밋을 켜면 열려 있던 트랜잭션을 먼저 정리해야 한다.
   * 사용자가 어느 쪽을 원하는지는 호출부(명령)에서 물어보고 넘긴다.
   */
  async setAutoCommit(enabled: boolean, pendingAction: 'commit' | 'rollback' = 'rollback'): Promise<void> {
    if (enabled && this.txLease) {
      if (pendingAction === 'commit') {
        await this.commit();
      } else {
        await this.rollback();
      }
    }
    this.autoCommitFlag = enabled;
    this.onDidChangeEmitter.fire();
  }

  // ── 취소 ──────────────────────────────────────────────────────────────────

  /** 실행 중인 쿼리를 취소한다. 서버 측 취소도 함께 시도한다. */
  async cancelRunning(): Promise<boolean> {
    const running = this.running;
    if (!running) {
      return false;
    }
    log.info(`[${this.profile.name}] 실행 중인 쿼리 취소 요청`);
    running.controller.abort();
    if (running.connection) {
      await running.connection.cancel().catch((error: unknown) => {
        log.debug('서버 측 취소 실패', error);
      });
    }
    return true;
  }

  // ── 정리 ──────────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // 실행 중인 쿼리를 먼저 끊는다.
    if (this.running) {
      this.running.controller.abort();
      await this.running.connection?.cancel().catch(() => undefined);
    }

    // 커밋되지 않은 트랜잭션은 롤백한다. 종료가 곧 커밋이 되어서는 안 된다.
    if (this.txLease && !this.txLease.released) {
      try {
        await this.txLease.connection.rollback();
        log.warn(`[${this.profile.name}] 연결 해제 시 미완료 트랜잭션을 롤백했습니다.`);
      } catch (error) {
        log.debug('종료 중 롤백 실패 (무시)', error);
      }
      await this.txLease.release();
      this.txLease = undefined;
    }

    await this.pool.close();
    // 메모리에서 비밀번호를 즉시 지운다.
    this.password = undefined;
    this.txState = 'none';
    this.onDidChangeEmitter.fire();
    this.onDidChangeEmitter.dispose();
  }
}

function preview(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

export { CancelledError };
