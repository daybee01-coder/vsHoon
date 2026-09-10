/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 확장 호스트와 JAR 워커가 주고받는 값. `vscode`도 `adm-zip`도 참조하지 않는다 — 양쪽이
 * 같은 타입을 쓰되, 호스트가 이 파일을 불러오는 것만으로 압축 라이브러리를 로드하지는
 * 않도록 하기 위해서다.
 */

/** 재빌드 결과를 원본 자리로 옮기기 전에 쓰는 임시 파일의 접미사. */
export const REBUILD_TEMP_SUFFIX = '.decom-tmp';

/** 진행 단계. `total`이 0이면 전체 개수를 아직 모른다는 뜻이다. */
export interface JarProgress {
    phase: 'extract' | 'collect' | 'compress' | 'write';
    done: number;
    total: number;
}

export interface ExtractResult {
    /** 풀어낸 항목 이름. */
    extracted: string[];
    /** destDir 밖을 가리켜 건너뛴 항목 이름. 정상 jar에서는 비어 있다. */
    skipped: string[];
}

export interface RebuildResult {
    fileCount: number;
}

export type JarWorkerRequest =
    | { kind: 'extract'; jarPath: string; destDir: string }
    | { kind: 'rebuild'; cacheDir: string; jarPath: string };

export interface JarWorkerData {
    request: JarWorkerRequest;
    /**
     * 취소 플래그. 워커가 도는 동안은 동기 압축이 이벤트 루프를 잡고 있어 `postMessage`가
     * 전달되지 않으므로, 공유 메모리 한 칸을 `Atomics`로 읽어 항목 사이에서 확인한다.
     */
    cancelFlag: SharedArrayBuffer;
}

export type JarWorkerMessage =
    | { type: 'progress'; progress: JarProgress }
    | { type: 'extracted'; result: ExtractResult }
    | { type: 'rebuilt'; result: RebuildResult }
    | { type: 'cancelled' }
    | { type: 'error'; message: string; stack?: string };

/** 사용자가 취소해서 중단됐음을 나타낸다. 오류 알림 대신 조용히 끝내는 경로에 쓴다. */
export class JarOperationCancelledError extends Error {
    constructor() {
        super('JAR 작업이 취소되었습니다.');
        this.name = 'JarOperationCancelledError';
    }
}

export function isCancellation(error: unknown): boolean {
    return error instanceof Error && error.name === 'JarOperationCancelledError';
}
