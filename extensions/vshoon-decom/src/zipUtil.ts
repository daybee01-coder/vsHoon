/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AdmZip = require('adm-zip');
import * as fs from 'fs';
import * as path from 'path';
import {
    ZIP_METHOD_STORED,
    isMetaEntry,
    isNestedArchive,
    normalizeEntryName,
    safeEntryTarget
} from './entryPaths';
import {
    ExtractResult,
    JarOperationCancelledError,
    JarProgress,
    REBUILD_TEMP_SUFFIX,
    RebuildResult
} from './jarWorkerProtocol';
import { longPath } from './longpath';

export type { ExtractResult, RebuildResult };

export interface JarEntryInfo {
    entryName: string;
    isDirectory: boolean;
    isClass: boolean;
}

/**
 * 압축/해제는 동기로 돈다. 확장 호스트를 막지 않기 위해 이 함수들은 워커 스레드에서
 * 호출하며([jarWorker.ts](./jarWorker.ts)), 워커는 아래 두 콜백으로 진행 상황을 알리고
 * 취소를 확인한다. 취소되면 `JarOperationCancelledError`를 던진다.
 */
export interface JarOperationOptions {
    onProgress?: (progress: JarProgress) => void;
    shouldCancel?: () => boolean;
}

/** 항목 하나하나마다 확인/보고하면 그 자체가 비용이라 이 간격으로만 본다. */
const PROGRESS_INTERVAL = 50;

function openZip(jarPath: string): AdmZip {
    // 경로가 아닌 버퍼로 열어서, adm-zip 내부의 fs 접근이 Windows MAX_PATH 제한에 걸리지
    // 않도록 한다 (longPath()는 여기 이 읽기 한 곳에만 적용하면 된다).
    return new AdmZip(fs.readFileSync(longPath(jarPath)));
}

export function listJarEntries(jarPath: string): JarEntryInfo[] {
    const zip = openZip(jarPath);
    return zip.getEntries().map((e) => ({
        entryName: normalizeEntryName(e.entryName),
        isDirectory: e.isDirectory,
        isClass: !e.isDirectory && e.entryName.toLowerCase().endsWith('.class')
    }));
}

/** 재빌드 결과를 원본 자리로 옮기기 전에 쓰는 임시 파일의 경로. */
export function rebuildTempPath(jarPath: string): string {
    return `${jarPath}${REBUILD_TEMP_SUFFIX}`;
}

/**
 * jar 내 모든 항목(.class 포함)을 원본 바이트 그대로 destDir 아래에 원본 경로 구조로 추출한다.
 * .class는 디컴파일하지 않고 그대로 두며, 열람 시에만 on-demand로 디컴파일한다.
 *
 * destDir 밖을 가리키는 항목은 쓰지 않고 건너뛴다 — 그런 항목 하나 때문에 jar 열기 전체를
 * 실패시키지는 않되, 조용히 넘기지도 않도록 호출부에 이름을 돌려준다.
 *
 * 취소되면 이미 쓴 파일은 그대로 남는다. 호출부가 매니페스트를 남기지 않아 이 반쪽 캐시가
 * 유효한 것으로 재사용되지 않게 하는 것이 복구 경로다.
 */
export function extractAllEntries(
    jarPath: string,
    destDir: string,
    options: JarOperationOptions = {}
): ExtractResult {
    const zip = openZip(jarPath);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const extracted: string[] = [];
    const skipped: string[] = [];
    let done = 0;
    for (const entry of entries) {
        if (done % PROGRESS_INTERVAL === 0) {
            checkCancelled(options);
            report(options, { phase: 'extract', done, total: entries.length });
        }
        done++;
        const normalized = normalizeEntryName(entry.entryName);
        const destPath = safeEntryTarget(destDir, normalized);
        if (!destPath) {
            skipped.push(normalized);
            continue;
        }
        fs.mkdirSync(longPath(path.dirname(destPath)), { recursive: true });
        fs.writeFileSync(longPath(destPath), entry.getData());
        extracted.push(normalized);
    }
    report(options, { phase: 'extract', done, total: entries.length });
    return { extracted, skipped };
}

/**
 * cacheDir의 현재 상태(추가/수정/삭제 포함)로 jarPath를 완전히 다시 빌드한다. Decom의 내부
 * 메타 폴더(.decom, .vscode)는 제외한다. .jar/.war로 끝나는 항목(중첩 라이브러리 jar 등)은
 * 압축하지 않고 그대로 저장한다. (물리적인 zip 항목 순서는 adm-zip이 저장 시 자체 재정렬하므로
 * 보장되지 않지만, JVM/Spring Boot 등은 central directory로 항목을 찾기 때문에 순서는 동작에
 * 영향을 주지 않는다.)
 *
 * 결과는 같은 폴더의 임시 파일에 먼저 쓰고 원본 자리로 옮긴다. 읽기·압축 중 오류가 나거나
 * 쓰기가 중간에 끊겨도 원본 jar가 반쯤 덮인 상태로 남지 않게 하려는 것이다. 취소도 같은
 * 성질을 쓴다 — 원본 자리로 옮기기 전에만 멈추므로 원본은 손대지 않은 채로 남는다.
 */
export function rebuildJarFromFolder(
    cacheDir: string,
    jarPath: string,
    options: JarOperationOptions = {}
): RebuildResult {
    const zip = new AdmZip();
    let fileCount = 0;

    const stack: string[] = [cacheDir];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(longPath(dir), { withFileTypes: true })) {
            if (fileCount % PROGRESS_INTERVAL === 0) {
                checkCancelled(options);
                report(options, { phase: 'collect', done: fileCount, total: 0 });
            }
            const full = path.join(dir, entry.name);
            const rel = normalizeEntryName(path.relative(cacheDir, full));
            if (isMetaEntry(rel)) {
                continue;
            }
            if (entry.isDirectory()) {
                // 빈 디렉터리뿐 아니라, Spring Boot 같은 로더가 "BOOT-INF/classes/" 같은
                // 디렉터리 항목의 존재 자체로 nested archive 루트를 판별하는 경우가 있어
                // 디렉터리 zip 항목을 반드시 함께 써야 한다 (누락 시 ClassNotFoundException).
                zip.addFile(`${rel}/`, Buffer.alloc(0));
                stack.push(full);
                continue;
            }
            const data = fs.readFileSync(longPath(full));
            const added = zip.addFile(rel, data);
            try {
                added.header.time = fs.statSync(longPath(full)).mtime;
            } catch {
                // 타임스탬프 설정 실패는 무시해도 무방 (내용/구조에는 영향 없음)
            }
            if (isNestedArchive(rel)) {
                added.header.method = ZIP_METHOD_STORED;
            }
            fileCount++;
        }
    }

    checkCancelled(options);
    report(options, { phase: 'compress', done: fileCount, total: fileCount });
    const buffer = zip.toBuffer();

    // 압축은 한 덩어리라 중간에 끊을 수 없다. 끝난 뒤 여기서 한 번 더 확인해, 취소한
    // 사용자가 원본이 바뀌는 것을 보지 않게 한다.
    checkCancelled(options);
    report(options, { phase: 'write', done: fileCount, total: fileCount });
    writeAtomically(jarPath, buffer);
    return { fileCount };
}

function report(options: JarOperationOptions, progress: JarProgress): void {
    options.onProgress?.(progress);
}

function checkCancelled(options: JarOperationOptions): void {
    if (options.shouldCancel?.()) {
        throw new JarOperationCancelledError();
    }
}

/** 같은 폴더의 임시 파일에 쓴 뒤 원본 자리로 옮긴다. 실패하면 임시 파일을 지우고 원본을 남긴다. */
function writeAtomically(targetPath: string, data: Buffer): void {
    const tempPath = rebuildTempPath(targetPath);
    try {
        fs.writeFileSync(longPath(tempPath), data);
        fs.renameSync(longPath(tempPath), longPath(targetPath));
    } catch (error) {
        try {
            fs.rmSync(longPath(tempPath), { force: true });
        } catch {
            // 임시 파일 정리 실패는 원래 오류를 가리지 않도록 무시한다.
        }
        throw error;
    }
}
