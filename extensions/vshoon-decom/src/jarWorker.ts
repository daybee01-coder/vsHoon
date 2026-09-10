/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * JAR 압축/해제를 담당하는 워커 스레드.
 *
 * 왜 워커인가:
 * adm-zip의 읽기·쓰기·압축은 전부 동기다. 큰 JAR을 확장 호스트에서 직접 처리하면 그동안
 * 같은 호스트의 다른 확장이 통째로 멈추고, 사용자에게는 진행률도 취소도 줄 수 없다.
 * 여기서 돌리면 호스트의 이벤트 루프는 계속 돌고, 취소는 공유 메모리 플래그로 전한다
 * (동기 루프가 도는 동안에는 `postMessage`가 워커에 도달하지 못하기 때문이다).
 *
 * 여기서는 vscode 모듈을 쓸 수 없다. 파일 접근은 node fs 로 한다.
 */
import { parentPort, workerData } from 'worker_threads';
import {
    JarOperationCancelledError,
    JarProgress,
    JarWorkerData,
    JarWorkerMessage
} from './jarWorkerProtocol';
import { extractAllEntries, rebuildJarFromFolder } from './zipUtil';

/**
 * 진행률을 부모에 보내는 간격. 항목 수를 기준으로 보내면 작은 항목이 많은 jar에서 메시지가
 * 몰려, 정작 막지 않으려던 호스트의 이벤트 루프를 다시 채우게 된다. 단계가 바뀌는 순간은
 * 사용자가 봐야 하므로 간격과 무관하게 내보낸다.
 */
const PROGRESS_MIN_INTERVAL_MS = 100;

function run(data: JarWorkerData): void {
    const port = parentPort;
    if (!port) {
        return;
    }
    const post = (message: JarWorkerMessage) => port.postMessage(message);
    const cancelFlag = new Int32Array(data.cancelFlag);
    let lastPhase: JarProgress['phase'] | undefined;
    let lastPostedAt = 0;
    const options = {
        onProgress: (progress: JarProgress) => {
            const now = Date.now();
            if (progress.phase === lastPhase && now - lastPostedAt < PROGRESS_MIN_INTERVAL_MS) {
                return;
            }
            lastPhase = progress.phase;
            lastPostedAt = now;
            post({ type: 'progress', progress });
        },
        shouldCancel: () => Atomics.load(cancelFlag, 0) !== 0
    };

    try {
        if (data.request.kind === 'extract') {
            const result = extractAllEntries(data.request.jarPath, data.request.destDir, options);
            post({ type: 'extracted', result });
        } else {
            const result = rebuildJarFromFolder(data.request.cacheDir, data.request.jarPath, options);
            post({ type: 'rebuilt', result });
        }
    } catch (error) {
        if (error instanceof JarOperationCancelledError) {
            post({ type: 'cancelled' });
            return;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        post({ type: 'error', message: failure.message, stack: failure.stack });
    }
}

run(workerData as JarWorkerData);
