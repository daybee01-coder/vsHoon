/** 취소/타임아웃 처리를 위한 작은 비동기 헬퍼 모음. */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class CancelledError extends Error {
  constructor(message = '작업이 취소되었습니다.') {
    super(message);
    this.name = 'CancelledError';
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 타임아웃을 건다. 타임아웃되어도 원본 프라미스는 계속 진행되므로,
 * 호출부는 필요한 정리(취소/폐기)를 별도로 수행해야 한다.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 원래 사유를 그대로 넘긴다
        reject(e);
      },
    );
  });
}

/** AbortSignal 이 이미 중단됐거나 중단되면 reject 되는 프라미스. */
export function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) {
      return; // 영원히 pending — race 의 다른 쪽이 결정한다.
    }
    if (signal.aborted) {
      reject(new CancelledError());
      return;
    }
    signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 예외를 삼키고 로깅만 하는 정리 작업용 래퍼. */
export async function ignoreErrors<T>(fn: () => Promise<T>, onError?: (e: unknown) => void): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    onError?.(e);
    return undefined;
  }
}

/**
 * 같은 키에 대한 동시 호출을 하나로 합친다.
 * 메타데이터 로딩이 여러 자동 완성 요청에서 중복 실행되는 것을 막는 데 쓴다.
 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.inflight.clear();
  }
}

/** 순차 실행 큐 — 하나의 커넥션에 대한 명령이 서로 섞이지 않게 한다. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // 큐가 오류로 끊기지 않도록 tail 은 항상 성공 상태로 유지한다.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * 배열의 각 항목에 비동기 작업을 적용하되 동시에 실행하는 수를 제한한다.
 *
 * 결과는 입력 순서대로 돌려주므로 호출부의 정렬 기준(동순위 유지 포함)이
 * 실행 완료 순서에 흔들리지 않는다. 작업 하나가 reject 되면 반환 프라미스도
 * reject 되지만 이미 시작한 다른 작업은 계속 진행하므로, 정리가 필요한
 * 작업이라면 호출부가 각 작업 안에서 처리한다.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }
  const slots = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  const queue = items.map((item, index): [T, number] => [item, index]);
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [item, index] = job;
      results[index] = await task(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, items.length) }, worker));
  return results;
}
