/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 동시에 실행할 비동기 작업 수를 제한한다.
 *
 * SFTP 패널의 스캔과 로컬 패널 목록이 같은 구현을 쓰도록 별도 모듈로 둔다.
 */
export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // 현재 슬롯을 대기자에게 직접 넘긴다.
    } else {
      this.active--;
    }
  }
}

/**
 * 로컬 파일 시스템 스캔의 동시 실행 한도.
 *
 * 기존 SFTP 패널 스캔이 쓰던 값과 맞춘 것이며 측정으로 정한 최적값이 아니다.
 */
export const LOCAL_SCAN_CONCURRENCY = 8;
