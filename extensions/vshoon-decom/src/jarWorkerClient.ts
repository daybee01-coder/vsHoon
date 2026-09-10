/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 확장 호스트 쪽에서 JAR 워커를 띄우고 결과를 받는 부분.
 *
 * `vscode`를 참조하지 않는다 — 취소는 `vscode.CancellationToken`이 구조적으로 만족하는
 * 최소 형태로만 받으므로, 확장 호스트 없이도 이 경로를 테스트할 수 있다.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import {
    ExtractResult,
    JarOperationCancelledError,
    JarProgress,
    JarWorkerData,
    JarWorkerMessage,
    JarWorkerRequest,
    REBUILD_TEMP_SUFFIX,
    RebuildResult
} from './jarWorkerProtocol';
import { longPath } from './longpath';

export interface CancellationLike {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface JarWorkerOptions {
    token?: CancellationLike;
    onProgress?: (progress: JarProgress) => void;
}

/**
 * 취소를 알린 뒤 워커가 스스로 끝나기를 기다리는 시간. 동기 압축 한 덩어리는 중간에 끊을 수
 * 없으므로 그만큼은 기다려 주고, 그래도 끝나지 않으면 강제로 내린다.
 */
const CANCEL_GRACE_MS = 5_000;

/** jar 항목을 캐시 폴더로 풀어낸다. 압축 해제는 워커에서 돌아 확장 호스트를 막지 않는다. */
export async function extractJarInWorker(
    jarPath: string,
    destDir: string,
    options: JarWorkerOptions = {}
): Promise<ExtractResult> {
    return runInWorker<ExtractResult>({ kind: 'extract', jarPath, destDir }, 'extracted', options);
}

/**
 * 캐시 폴더의 현재 상태로 jar를 다시 빌드한다. 취소되거나 워커를 강제로 내린 경우, 남았을지
 * 모르는 임시 결과 파일을 지운다 — 원본 jar 옆에 `.decom-tmp`가 남지 않게 하려는 것이다.
 */
export async function rebuildJarInWorker(
    cacheDir: string,
    jarPath: string,
    options: JarWorkerOptions = {}
): Promise<RebuildResult> {
    try {
        return await runInWorker<RebuildResult>({ kind: 'rebuild', cacheDir, jarPath }, 'rebuilt', options);
    } catch (error) {
        removeRebuildTemp(jarPath);
        throw error;
    }
}

/** 재빌드가 끝내 완료되지 못했을 때 남을 수 있는 임시 파일을 지운다. */
export function removeRebuildTemp(jarPath: string): void {
    try {
        fs.rmSync(longPath(`${jarPath}${REBUILD_TEMP_SUFFIX}`), { force: true });
    } catch {
        // 지우지 못해도 원본 jar는 온전하므로, 여기서 더 할 일은 없다.
    }
}

function runInWorker<T>(
    request: JarWorkerRequest,
    expected: 'extracted' | 'rebuilt',
    options: JarWorkerOptions
): Promise<T> {
    if (options.token?.isCancellationRequested) {
        return Promise.reject(new JarOperationCancelledError());
    }

    const cancelFlag = new SharedArrayBuffer(4);
    const cancelView = new Int32Array(cancelFlag);
    const workerData: JarWorkerData = { request, cancelFlag };

    return new Promise<T>((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'jarWorker.js'), { workerData });
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;

        const finish = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (killTimer) {
                clearTimeout(killTimer);
            }
            cancelSub.dispose();
            void worker.terminate();
            fn();
        };

        const cancelSub = options.token
            ? options.token.onCancellationRequested(() => {
                Atomics.store(cancelView, 0, 1);
                // 워커가 항목 사이에서 플래그를 보고 스스로 정리하고 끝내는 것이 정상 경로다.
                // 압축 한 덩어리에 갇혀 그 시간을 넘기면 강제로 내린다.
                killTimer = setTimeout(() => finish(() => reject(new JarOperationCancelledError())), CANCEL_GRACE_MS);
            })
            : { dispose: () => { } };

        worker.on('message', (message: JarWorkerMessage) => {
            if (message.type === 'progress') {
                options.onProgress?.(message.progress);
            } else if (message.type === expected) {
                // 어느 결과 메시지를 기다리는지는 호출부가 `expected`로 정하므로, 그 짝인
                // 결과 타입은 여기서 좁혀지지 않는다.
                const result = message.result as unknown as T;
                finish(() => resolve(result));
            } else if (message.type === 'cancelled') {
                finish(() => reject(new JarOperationCancelledError()));
            } else if (message.type === 'error') {
                const error = new Error(message.message);
                error.stack = message.stack ?? error.stack;
                finish(() => reject(error));
            }
        });

        worker.on('error', (error) => finish(() => reject(error)));
        worker.on('exit', (code) => {
            // 결과 메시지 없이 끝났다는 뜻이므로, 성공으로 볼 수 있는 경로는 없다.
            finish(() => reject(new Error(`JAR 작업이 예기치 않게 끝났습니다. (code ${code})`)));
        });
    });
}
