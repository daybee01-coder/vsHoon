import { randomUUID } from 'node:crypto';
import type { PoolOptions, PoolStats } from '../types';
import { CancelledError, deferred, type Deferred } from '../util/async';
import { log } from '../util/logger';
import type { RawConnection } from './driver';

/**
 * 커넥션 풀.
 *
 * 설계 원칙 — "누수는 버그가 아니라 불가능해야 한다":
 *
 *  1) 모든 대여는 {@link ConnectionPool.withConnection} 을 통하고, 반납은 finally 에서 일어난다.
 *     원시 acquire 는 트랜잭션 세션 전용으로만 열어 둔다.
 *  2) 반납 시 커넥션이 트랜잭션 중이면 무조건 롤백한다. 열린 트랜잭션이
 *     풀로 돌아가 다음 사용자를 오염시키는 경로를 없앤다.
 *  3) 자니터가 주기적으로 대여 목록을 훑어 leaseTimeout 을 넘긴 대여를
 *     좀비로 간주하고 강제 회수한다. 상태를 신뢰할 수 없으므로 재사용하지 않고 폐기한다.
 *  4) 트랜잭션 세션은 유휴 시간이 transactionIdleTimeout 을 넘기면 자동 롤백한다.
 *     사용자가 편집기를 닫아 버려도 서버 측 잠금이 무한정 남지 않는다.
 */

const JANITOR_INTERVAL_MS = 10_000;
/** 이 시간 넘게 유휴였던 커넥션은 재사용 전에 핑을 보낸다. */
const VALIDATE_AFTER_IDLE_MS = 30_000;

export type LeaseReclaimReason =
  | 'lease-timeout'
  | 'transaction-idle-timeout'
  | 'pool-closing'
  | 'connection-error';

export interface PoolEvents {
  /** 좀비 대여가 강제 회수됐을 때. UI 로 경고를 띄우는 데 쓴다. */
  onReclaimed?(info: { purpose: string; ageMs: number; reason: LeaseReclaimReason }): void;
}

interface PoolEntry {
  connection: RawConnection;
  createdAt: number;
  idleSince: number;
  /** 현재 대여 중인지. */
  leased: boolean;
  /** 폐기 예정 표시 — 반납되면 바로 닫는다. */
  doomed: boolean;
}

export class Lease {
  readonly id = randomUUID();
  readonly acquiredAt = Date.now();
  private lastActivity = Date.now();
  private done = false;

  constructor(
    private readonly pool: ConnectionPool,
    private readonly entry: PoolEntry,
    /** 로그/진단용 — 어떤 작업이 이 커넥션을 쥐고 있는지. */
    readonly purpose: string,
    /**
     * 트랜잭션 세션처럼 오래 붙잡는 것이 정상인 대여.
     * leaseTimeout 대신 transactionIdleTimeout 이 적용된다.
     */
    readonly sticky: boolean,
    /** 대여 시점의 스택 — 누수 지점을 특정하는 데 쓴다. */
    readonly originStack: string | undefined,
  ) {}

  get connection(): RawConnection {
    if (this.done) {
      throw new Error(`이미 반납된 커넥션을 사용했습니다 (lease ${this.id}, ${this.purpose}).`);
    }
    return this.entry.connection;
  }

  get released(): boolean {
    return this.done;
  }

  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** 살아 있다는 신호. 트랜잭션 세션이 유휴 타임아웃에 걸리지 않게 한다. */
  touch(): void {
    this.lastActivity = Date.now();
  }

  /** 풀로 반납. 여러 번 불러도 안전하다. */
  async release(): Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    await this.pool.handleRelease(this.entry, this);
  }

  /** 재사용하지 않고 물리 커넥션을 폐기한다. */
  async destroy(reason: string): Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    this.entry.doomed = true;
    await this.pool.handleRelease(this.entry, this, reason);
  }

  /** 내부용 — 자니터가 강제 회수할 때. */
  markReclaimed(): void {
    this.done = true;
  }
}

interface Waiter {
  deferredLease: Deferred<Lease>;
  purpose: string;
  sticky: boolean;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

export class ConnectionPool {
  private readonly entries = new Set<PoolEntry>();
  private readonly idle: PoolEntry[] = [];
  private readonly leases = new Map<PoolEntry, Lease>();
  private readonly waiters: Waiter[] = [];

  private janitor: NodeJS.Timeout | undefined;
  private closing = false;
  /** 생성 중인 커넥션 수 — max 초과 생성을 막기 위해 센다. */
  private pending = 0;

  private readonly counters = {
    createdTotal: 0,
    destroyedTotal: 0,
    zombiesReclaimed: 0,
    acquireTimeouts: 0,
  };

  constructor(
    private readonly label: string,
    private options: PoolOptions,
    private readonly factory: (signal?: AbortSignal) => Promise<RawConnection>,
    private readonly events: PoolEvents = {},
  ) {
    this.janitor = setInterval(() => {
      void this.runJanitor();
    }, JANITOR_INTERVAL_MS);
    // 자니터 때문에 확장 호스트가 종료되지 못하는 일이 없게 한다.
    this.janitor.unref?.();
  }

  updateOptions(options: PoolOptions): void {
    this.options = options;
  }

  stats(): PoolStats {
    return {
      size: this.entries.size,
      idle: this.idle.length,
      leased: this.leases.size,
      pendingAcquires: this.waiters.length,
      ...this.counters,
    };
  }

  /**
   * 커넥션을 빌려 fn 을 실행하고 무조건 반납한다.
   * 일반 쿼리 실행은 전부 이 경로를 쓴다.
   */
  async withConnection<T>(
    purpose: string,
    fn: (connection: RawConnection) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lease = await this.acquire(purpose, false, signal);
    try {
      return await fn(lease.connection);
    } catch (error) {
      // 커넥션 자체가 깨진 경우 풀로 되돌리면 다음 사용자가 같은 오류를 만난다.
      if (isConnectionFatal(error)) {
        await lease.destroy('connection-error');
        throw error;
      }
      throw error;
    } finally {
      await lease.release();
    }
  }

  /**
   * 원시 대여. 트랜잭션 세션처럼 호출 간에 커넥션을 유지해야 할 때만 쓴다.
   * 호출자는 반드시 release() 를 보장해야 하며, 잊더라도 자니터가 회수한다.
   */
  async acquire(purpose: string, sticky = false, signal?: AbortSignal): Promise<Lease> {
    if (this.closing) {
      throw new Error(`풀이 닫히는 중입니다 (${this.label}).`);
    }
    if (signal?.aborted) {
      throw new CancelledError();
    }

    const reusable = this.takeReusableIdle();
    if (reusable) {
      const ok = await this.validateIfStale(reusable);
      if (ok) {
        return this.lease(reusable, purpose, sticky);
      }
      // 죽은 커넥션이었다 — 폐기하고 처음부터 다시.
      await this.destroyEntry(reusable, 'validation-failed');
      return this.acquire(purpose, sticky, signal);
    }

    if (this.entries.size + this.pending < this.options.max) {
      const entry = await this.createEntry(signal);
      return this.lease(entry, purpose, sticky);
    }

    return this.waitForConnection(purpose, sticky, signal);
  }

  private lease(entry: PoolEntry, purpose: string, sticky: boolean): Lease {
    entry.leased = true;
    const stack = captureStack();
    const lease = new Lease(this, entry, purpose, sticky, stack);
    this.leases.set(entry, lease);
    log.trace(`[pool ${this.label}] 대여 ${lease.id} (${purpose}) conn=${entry.connection.id}`);
    return lease;
  }

  private takeReusableIdle(): PoolEntry | undefined {
    const now = Date.now();
    while (this.idle.length > 0) {
      const entry = this.idle.pop()!;
      if (entry.doomed) {
        void this.destroyEntry(entry, 'doomed');
        continue;
      }
      if (this.options.maxLifetimeMs > 0 && now - entry.createdAt > this.options.maxLifetimeMs) {
        void this.destroyEntry(entry, 'max-lifetime');
        continue;
      }
      return entry;
    }
    return undefined;
  }

  private async validateIfStale(entry: PoolEntry): Promise<boolean> {
    if (Date.now() - entry.idleSince < VALIDATE_AFTER_IDLE_MS) {
      return true;
    }
    try {
      return await entry.connection.validate();
    } catch {
      return false;
    }
  }

  private async createEntry(signal?: AbortSignal): Promise<PoolEntry> {
    this.pending++;
    try {
      const connection = await this.factory(signal);
      const now = Date.now();
      const entry: PoolEntry = {
        connection,
        createdAt: now,
        idleSince: now,
        leased: false,
        doomed: false,
      };
      this.entries.add(entry);
      this.counters.createdTotal++;
      log.debug(`[pool ${this.label}] 커넥션 생성 ${connection.id} (총 ${this.entries.size})`);
      return entry;
    } finally {
      this.pending--;
    }
  }

  private waitForConnection(
    purpose: string,
    sticky: boolean,
    signal?: AbortSignal,
  ): Promise<Lease> {
    const d = deferred<Lease>();
    const waiter: Waiter = {
      deferredLease: d,
      purpose,
      sticky,
      settled: false,
      timer: setTimeout(() => {
        this.settleWaiter(waiter, () => {
          this.counters.acquireTimeouts++;
          d.reject(
            new Error(
              `커넥션을 얻지 못했습니다 (${this.label}). ` +
                `${this.options.acquireTimeoutMs}ms 동안 대기했고 풀이 가득 찼습니다 ` +
                `(max=${this.options.max}, 사용 중=${this.leases.size}). ` +
                '실행 중인 쿼리를 취소하거나 dbconn.pool.max 를 늘리세요.',
            ),
          );
        });
      }, this.options.acquireTimeoutMs),
    };

    if (signal) {
      waiter.signal = signal;
      waiter.onAbort = () => {
        this.settleWaiter(waiter, () => d.reject(new CancelledError()));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }

    this.waiters.push(waiter);
    return d.promise;
  }

  /** 대기자를 큐에서 빼고 정리한 뒤 한 번만 결론짓는다. */
  private settleWaiter(waiter: Waiter, settle: () => void): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) {
      this.waiters.splice(index, 1);
    }
    settle();
  }

  /** Lease.release()/destroy() 에서만 호출된다. */
  async handleRelease(entry: PoolEntry, lease: Lease, destroyReason?: string): Promise<void> {
    this.leases.delete(entry);
    entry.leased = false;

    // 열린 트랜잭션은 절대 풀로 돌려보내지 않는다.
    if (entry.connection.inTransaction) {
      log.warn(
        `[pool ${this.label}] 반납 시점에 트랜잭션이 열려 있어 롤백합니다 ` +
          `(lease ${lease.id}, ${lease.purpose}).`,
      );
      try {
        await entry.connection.rollback();
      } catch (error) {
        log.error(`[pool ${this.label}] 반납 중 롤백 실패 — 커넥션을 폐기합니다.`, error);
        entry.doomed = true;
      }
    }

    if (destroyReason || entry.doomed || this.closing) {
      await this.destroyEntry(entry, destroyReason ?? 'released-doomed');
      this.pumpWaiters();
      return;
    }

    if (
      this.options.maxLifetimeMs > 0 &&
      Date.now() - entry.createdAt > this.options.maxLifetimeMs
    ) {
      await this.destroyEntry(entry, 'max-lifetime');
      this.pumpWaiters();
      return;
    }

    entry.idleSince = Date.now();
    this.idle.push(entry);
    log.trace(`[pool ${this.label}] 반납 ${lease.id} conn=${entry.connection.id}`);
    this.pumpWaiters();
  }

  /** 유휴 커넥션이 생겼을 때 대기자에게 넘긴다. */
  private pumpWaiters(): void {
    while (this.waiters.length > 0) {
      const entry = this.takeReusableIdle();
      if (!entry) {
        break;
      }
      const waiter = this.waiters[0]!;
      this.settleWaiter(waiter, () => {
        waiter.deferredLease.resolve(this.lease(entry, waiter.purpose, waiter.sticky));
      });
      // settleWaiter 가 이미 처리된 대기자였다면 커넥션을 되돌려 놓는다.
      if (!entry.leased) {
        this.idle.push(entry);
        break;
      }
    }

    // 대기자가 남았는데 풀에 여유가 있으면 새 커넥션을 만든다.
    while (this.waiters.length > 0 && this.entries.size + this.pending < this.options.max) {
      const waiter = this.waiters[0]!;
      void this.createEntry()
        .then((entry) => {
          this.settleWaiter(waiter, () => {
            waiter.deferredLease.resolve(this.lease(entry, waiter.purpose, waiter.sticky));
          });
          if (!entry.leased) {
            this.idle.push(entry);
          }
        })
        .catch((error: unknown) => {
          this.settleWaiter(waiter, () => waiter.deferredLease.reject(error));
        });
      // 생성이 비동기이므로 이번 루프에서는 하나만 시작하고 빠진다.
      break;
    }
  }

  private async destroyEntry(entry: PoolEntry, reason: string): Promise<void> {
    const index = this.idle.indexOf(entry);
    if (index !== -1) {
      this.idle.splice(index, 1);
    }
    if (!this.entries.delete(entry)) {
      return; // 이미 폐기됨
    }
    this.leases.delete(entry);
    this.counters.destroyedTotal++;
    log.debug(
      `[pool ${this.label}] 커넥션 폐기 ${entry.connection.id} (${reason}, 남은 ${this.entries.size})`,
    );
    try {
      await entry.connection.close();
    } catch (error) {
      log.debug(`[pool ${this.label}] close 실패 (무시)`, error);
    }
  }

  // ── 자니터 ────────────────────────────────────────────────────────────────

  private async runJanitor(): Promise<void> {
    if (this.closing) {
      return;
    }
    const now = Date.now();

    // 1) 좀비 대여 회수
    for (const [entry, lease] of [...this.leases]) {
      const reason = this.zombieReason(lease, now);
      if (!reason) {
        continue;
      }
      const ageMs = now - lease.acquiredAt;
      log.warn(
        `[pool ${this.label}] 좀비 대여를 회수합니다 — ${reason}, ` +
          `${Math.round(ageMs / 1000)}초 경과, 용도="${lease.purpose}"` +
          (lease.originStack ? `\n대여 지점:\n${lease.originStack}` : ''),
      );
      this.counters.zombiesReclaimed++;
      lease.markReclaimed();
      this.leases.delete(entry);

      // 상태를 알 수 없으므로 되돌리지 않고 폐기한다. 롤백은 시도만 한다.
      if (entry.connection.inTransaction) {
        try {
          await entry.connection.rollback();
        } catch (error) {
          log.debug(`[pool ${this.label}] 좀비 롤백 실패 (무시)`, error);
        }
      }
      await this.destroyEntry(entry, reason);
      this.events.onReclaimed?.({ purpose: lease.purpose, ageMs, reason });
    }

    // 2) 유휴 커넥션 정리 (min 유지, 수명 초과 폐기)
    for (const entry of [...this.idle]) {
      const idleFor = now - entry.idleSince;
      const overLifetime =
        this.options.maxLifetimeMs > 0 && now - entry.createdAt > this.options.maxLifetimeMs;
      const overIdle =
        this.options.idleTimeoutMs > 0 &&
        idleFor > this.options.idleTimeoutMs &&
        this.entries.size > this.options.min;
      if (overLifetime || overIdle) {
        await this.destroyEntry(entry, overLifetime ? 'max-lifetime' : 'idle-timeout');
      }
    }

    this.pumpWaiters();
  }

  private zombieReason(lease: Lease, now: number): LeaseReclaimReason | undefined {
    if (lease.sticky) {
      const idleFor = now - lease.lastActivityAt;
      if (
        this.options.transactionIdleTimeoutMs > 0 &&
        idleFor > this.options.transactionIdleTimeoutMs
      ) {
        return 'transaction-idle-timeout';
      }
      return undefined;
    }
    if (this.options.leaseTimeoutMs > 0 && now - lease.acquiredAt > this.options.leaseTimeoutMs) {
      return 'lease-timeout';
    }
    return undefined;
  }

  // ── 종료 ──────────────────────────────────────────────────────────────────

  /** 모든 커넥션을 닫는다. 대여 중인 것도 롤백 후 강제로 닫는다. */
  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    if (this.janitor) {
      clearInterval(this.janitor);
      this.janitor = undefined;
    }

    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, () =>
        waiter.deferredLease.reject(new Error(`풀이 닫혔습니다 (${this.label}).`)),
      );
    }

    const tasks: Promise<void>[] = [];
    for (const [entry, lease] of [...this.leases]) {
      lease.markReclaimed();
      this.leases.delete(entry);
      tasks.push(
        (async () => {
          if (entry.connection.inTransaction) {
            try {
              await entry.connection.rollback();
            } catch {
              /* 종료 중이므로 무시 */
            }
          }
          await this.destroyEntry(entry, 'pool-closing');
        })(),
      );
    }
    for (const entry of [...this.entries]) {
      tasks.push(this.destroyEntry(entry, 'pool-closing'));
    }

    await Promise.allSettled(tasks);
    log.info(`[pool ${this.label}] 종료 완료 — ${JSON.stringify(this.counters)}`);
  }
}

/** 드라이버 오류의 code/message 를 문자열로 안전하게 꺼낸다. */
function asText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** 커넥션 자체가 회복 불가능한 상태임을 시사하는 오류인지. */
export function isConnectionFatal(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  // code/message 가 객체일 수 있다 — 그대로 String() 하면 '[object Object]' 가 되어
  // 아래 문자열 비교가 조용히 전부 실패한다.
  const code = asText((error as { code?: unknown }).code);
  const message = asText((error as { message?: unknown }).message);
  return (
    [
      'PROTOCOL_CONNECTION_LOST',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ERR_STREAM_DESTROYED',
      '57P01', // PostgreSQL: admin_shutdown
      '08006', // connection_failure
      '08003', // connection_does_not_exist
    ].includes(code) ||
    /connection (?:is )?(?:closed|lost|terminated)/i.test(message) ||
    /server closed the connection/i.test(message) ||
    /NJS-500|ORA-03113|ORA-03114|ORA-12571|DPI-1080/i.test(message)
  );
}

function captureStack(): string | undefined {
  const err = new Error();
  const lines = err.stack?.split('\n') ?? [];
  // Error 헤더 + captureStack + lease 프레임을 건너뛰고 호출자만 남긴다.
  return lines.slice(3, 8).join('\n') || undefined;
}
