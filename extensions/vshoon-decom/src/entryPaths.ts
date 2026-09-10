/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

/**
 * zip 항목 이름을 다루는 규칙. `vscode`를 참조하지 않는다 — 확장 호스트를 띄우지 않고도
 * 경로 경계와 제외 대상을 테스트할 수 있어야 하기 때문이다.
 */

/** Decom이 캐시 폴더에 두는 메타 폴더. JAR로 다시 저장할 때 제외한다. */
export const MANIFEST_DIRNAME = '.decom';
/** 편집기가 캐시 폴더에 만드는 설정 폴더. 원본 JAR의 내용이 아니므로 제외한다. */
export const VSCODE_DIRNAME = '.vscode';

/**
 * ZIP 스펙의 압축 방식 코드: 0 = STORED(무압축), 8 = DEFLATED. Spring Boot 등의 실행 가능한
 * jar는 `BOOT-INF/lib/*.jar` 같은 중첩 jar 항목이 STORED가 아니면 로더가 바이트 범위를 그대로
 * 중첩 zip으로 취급하지 못해 "must be stored without compression" 오류로 실행이 깨진다.
 */
export const ZIP_METHOD_STORED = 0;

const NESTED_ARCHIVE_RE = /\.(jar|war)$/i;

/** zip 항목 이름은 `/`가 표준이지만 `\`로 쓰인 파일도 있어 한쪽으로 맞춘다. */
export function normalizeEntryName(entryName: string): string {
    return entryName.replace(/\\/g, '/');
}

/** 압축하지 않고 그대로 저장해야 하는 중첩 아카이브인지. */
export function isNestedArchive(entryName: string): boolean {
    return NESTED_ARCHIVE_RE.test(entryName);
}

/** 캐시 폴더에만 있고 원본 JAR에는 없어야 하는 메타 경로인지. */
export function isMetaEntry(relativePath: string): boolean {
    const normalized = normalizeEntryName(relativePath);
    return [MANIFEST_DIRNAME, VSCODE_DIRNAME].some(
        (dir) => normalized === dir || normalized.startsWith(`${dir}/`)
    );
}

/**
 * 항목을 풀어낼 대상 경로. `destDir` 밖을 가리키는 항목이면 `undefined`.
 *
 * zip 항목 이름은 아카이브를 만든 쪽이 정하는 값이라 절대 경로나 `..`이 들어 있을 수 있고,
 * 그대로 이어 붙이면 캐시 폴더 밖의 사용자 파일을 덮어쓴다. `..`은 결과가 폴더 안이 되더라도
 * 거부한다 — 정상 jar에는 없는 형태이므로 좁게 막는 편이 안전하다.
 */
export function safeEntryTarget(destDir: string, entryName: string): string | undefined {
    const normalized = normalizeEntryName(entryName);
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
        return undefined;
    }
    const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
        return undefined;
    }
    const target = path.join(destDir, ...segments);
    const base = path.resolve(destDir);
    const resolved = path.resolve(target);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        return undefined;
    }
    return target;
}
