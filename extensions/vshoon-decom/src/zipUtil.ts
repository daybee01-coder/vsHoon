import AdmZip = require('adm-zip');
import * as fs from 'fs';
import * as path from 'path';
import { MANIFEST_DIRNAME } from './manifest';
import { longPath } from './longpath';

export interface JarEntryInfo {
    entryName: string;
    isDirectory: boolean;
    isClass: boolean;
}

function openZip(jarPath: string): AdmZip {
    // 경로가 아닌 버퍼로 열어서, adm-zip 내부의 fs 접근이 Windows MAX_PATH 제한에 걸리지
    // 않도록 한다 (longPath()는 여기 이 읽기 한 곳에만 적용하면 된다).
    return new AdmZip(fs.readFileSync(longPath(jarPath)));
}

export function listJarEntries(jarPath: string): JarEntryInfo[] {
    const zip = openZip(jarPath);
    return zip.getEntries().map((e) => ({
        entryName: e.entryName.replace(/\\/g, '/'),
        isDirectory: e.isDirectory,
        isClass: !e.isDirectory && e.entryName.toLowerCase().endsWith('.class')
    }));
}

/**
 * jar 내 모든 항목(.class 포함)을 원본 바이트 그대로 destDir 아래에 원본 경로 구조로 추출한다.
 * .class는 디컴파일하지 않고 그대로 두며, 열람 시에만 on-demand로 디컴파일한다.
 */
export function extractAllEntries(jarPath: string, destDir: string): string[] {
    const zip = openZip(jarPath);
    const extracted: string[] = [];
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const normalized = entry.entryName.replace(/\\/g, '/');
        const destPath = path.join(destDir, ...normalized.split('/'));
        fs.mkdirSync(longPath(path.dirname(destPath)), { recursive: true });
        fs.writeFileSync(longPath(destPath), entry.getData());
        extracted.push(normalized);
    }
    return extracted;
}

const VSCODE_DIRNAME = '.vscode';

// ZIP 스펙의 압축 방식 코드: 0 = STORED(무압축), 8 = DEFLATED. Spring Boot 등의 실행 가능한
// jar는 BOOT-INF/lib/*.jar 같은 중첩 jar 항목이 STORED가 아니면 로더가 바이트 범위를 그대로
// 중첩 zip으로 취급하지 못해 "must be stored without compression" 오류로 실행이 깨진다.
const ZIP_METHOD_STORED = 0;
const NESTED_ARCHIVE_RE = /\.(jar|war)$/i;

/**
 * cacheDir의 현재 상태(추가/수정/삭제 포함)로 jarPath를 완전히 다시 빌드한다. Decom의 내부
 * 메타 폴더(.decom, .vscode)는 제외한다. .jar/.war로 끝나는 항목(중첩 라이브러리 jar 등)은
 * 압축하지 않고 그대로 저장한다. (물리적인 zip 항목 순서는 adm-zip이 저장 시 자체 재정렬하므로
 * 보장되지 않지만, JVM/Spring Boot 등은 central directory로 항목을 찾기 때문에 순서는 동작에
 * 영향을 주지 않는다.)
 */
export function rebuildJarFromFolder(cacheDir: string, jarPath: string): { fileCount: number } {
    const zip = new AdmZip();
    let fileCount = 0;

    const stack: string[] = [cacheDir];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(longPath(dir), { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const rel = path.relative(cacheDir, full).replace(/\\/g, '/');
            if (rel === MANIFEST_DIRNAME || rel.startsWith(`${MANIFEST_DIRNAME}/`)) continue;
            if (rel === VSCODE_DIRNAME || rel.startsWith(`${VSCODE_DIRNAME}/`)) continue;
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
            if (NESTED_ARCHIVE_RE.test(rel)) {
                added.header.method = ZIP_METHOD_STORED;
            }
            fileCount++;
        }
    }

    fs.writeFileSync(longPath(jarPath), zip.toBuffer());
    return { fileCount };
}
