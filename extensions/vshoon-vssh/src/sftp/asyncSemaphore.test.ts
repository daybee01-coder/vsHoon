/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AsyncSemaphore } from './asyncSemaphore';

/** 대기 중인 작업이 시작될 때까지 이벤트 루프를 한 바퀴 돌린다. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AsyncSemaphore', () => {
  it('한도까지만 동시에 실행하고 끝난 슬롯을 대기자에게 넘긴다', async () => {
    const semaphore = new AsyncSemaphore(2);
    const gates: Array<() => void> = [];
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 5 }, (_, index) =>
      semaphore.run(() => {
        started.push(index);
        active++;
        peak = Math.max(peak, active);
        return new Promise<number>((resolve) => {
          gates.push(() => {
            active--;
            resolve(index);
          });
        });
      })
    );

    await flush();
    const startedBeforeRelease = [...started];
    while (gates.length > 0) {
      gates.shift()!();
      await flush();
    }

    assert.deepStrictEqual(
      { startedBeforeRelease, peak, startOrder: started, results: await Promise.all(tasks) },
      { startedBeforeRelease: [0, 1], peak: 2, startOrder: [0, 1, 2, 3, 4], results: [0, 1, 2, 3, 4] }
    );
  });

  it('작업이 실패해도 슬롯을 반납한다', async () => {
    const semaphore = new AsyncSemaphore(1);
    await assert.rejects(
      semaphore.run(async () => {
        throw new Error('scan failed');
      }),
      /scan failed/
    );
    assert.strictEqual(await semaphore.run(async () => 'next'), 'next');
  });
});
