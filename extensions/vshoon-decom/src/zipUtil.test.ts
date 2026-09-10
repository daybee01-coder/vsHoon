/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AdmZip = require('adm-zip');
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, describe, it } from 'node:test';
import { ZIP_METHOD_STORED } from './entryPaths';
import { JarProgress } from './jarWorkerProtocol';
import { extractAllEntries, listJarEntries, rebuildJarFromFolder } from './zipUtil';

/**
 * JAR 왕복(추출 → 다시 빌드)에서 데이터가 보존되는지 확인하는 테스트.
 *
 * P1-C의 worker 격리는 이 동작을 바꾸지 않아야 하므로, 구조를 바꾸기 전에 지금 동작을
 * 기준선으로 고정해 둔다. 실제 파일 시스템을 쓰되 임시 폴더 안에서만 움직인다.
 */

const roots: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-zip-'));
    roots.push(dir);
    return dir;
}

after(() => {
    for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/** 라이브러리 jar 하나를 품은, Spring Boot 배치와 같은 모양의 jar. */
function sampleJar(jarPath: string): { nested: Buffer; classBytes: Buffer } {
    const nestedZip = new AdmZip();
    nestedZip.addFile('org/lib/Helper.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x01]));
    const nested = nestedZip.toBuffer();
    const classBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x34]);

    const zip = new AdmZip();
    zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n', 'utf8'));
    zip.addFile('BOOT-INF/classes/', Buffer.alloc(0));
    zip.addFile('BOOT-INF/classes/com/example/App.class', classBytes);
    zip.addFile('BOOT-INF/lib/', Buffer.alloc(0));
    zip.addFile('BOOT-INF/lib/helper.jar', nested);
    zip.addFile('static/index.html', Buffer.from('<h1>hi</h1>', 'utf8'));
    fs.writeFileSync(jarPath, zip.toBuffer());
    return { nested, classBytes };
}

function entryNames(jarPath: string): string[] {
    return listJarEntries(jarPath).map((entry) => entry.entryName).sort();
}

describe('extractAllEntries', () => {
    it('디렉터리 항목을 뺀 모든 파일을 원본 바이트로 풀어낸다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        const { nested, classBytes } = sampleJar(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);

        const result = extractAllEntries(jarPath, dest);

        assert.deepEqual(
            {
                extracted: [...result.extracted].sort(),
                skipped: result.skipped,
                classBytes: fs.readFileSync(path.join(dest, 'BOOT-INF', 'classes', 'com', 'example', 'App.class')),
                nested: fs.readFileSync(path.join(dest, 'BOOT-INF', 'lib', 'helper.jar')),
                html: fs.readFileSync(path.join(dest, 'static', 'index.html'), 'utf8')
            },
            {
                extracted: [
                    'BOOT-INF/classes/com/example/App.class',
                    'BOOT-INF/lib/helper.jar',
                    'META-INF/MANIFEST.MF',
                    'static/index.html'
                ],
                skipped: [],
                classBytes,
                nested,
                html: '<h1>hi</h1>'
            }
        );
    });

    it('폴더 밖을 가리키는 항목은 쓰지 않고 이름만 돌려준다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'hostile.jar');
        const zip = new AdmZip();
        // adm-zip 은 항목을 **추가**할 때 `../` 를 정리해 버리므로 그 형태로는 위험한 jar 를
        // 만들 수 없다. 드라이브 문자로 시작하는 이름은 그대로 남아, 다른 도구가 만든 jar 가
        // 절대 경로를 담고 있는 경우를 이 경로로 재현할 수 있다.
        zip.addFile('C:/hijacked.txt', Buffer.from('nope', 'utf8'));
        zip.addFile('ok.txt', Buffer.from('yes', 'utf8'));
        fs.writeFileSync(jarPath, zip.toBuffer());
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);

        const result = extractAllEntries(jarPath, dest);

        assert.deepEqual(
            {
                extracted: result.extracted,
                skipped: result.skipped,
                inside: fs.readdirSync(dest)
            },
            { extracted: ['ok.txt'], skipped: ['C:/hijacked.txt'], inside: ['ok.txt'] }
        );
    });
});

describe('rebuildJarFromFolder', () => {
    it('왕복 후에도 항목·바이트가 유지되고 중첩 jar는 무압축이다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        const { nested, classBytes } = sampleJar(jarPath);
        const before = entryNames(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);
        extractAllEntries(jarPath, dest);

        const { fileCount } = rebuildJarFromFolder(dest, jarPath);
        const rebuilt = new AdmZip(fs.readFileSync(jarPath));
        const after = entryNames(jarPath);
        const methodOf = (name: string) => rebuilt.getEntry(name)?.header.method;

        // 원본에 없던 중간 디렉터리 항목(`BOOT-INF/`, `META-INF/` 등)이 더 생기는 것은 의도된
        // 동작이다 — 캐시 폴더의 모든 폴더에 디렉터리 항목을 쓴다. 잃어버리는 항목이 없어야 한다.
        assert.deepEqual(
            {
                fileCount,
                lost: before.filter((name) => !after.includes(name)),
                added: after.filter((name) => !before.includes(name)),
                classBytes: rebuilt.getEntry('BOOT-INF/classes/com/example/App.class')?.getData(),
                nested: rebuilt.getEntry('BOOT-INF/lib/helper.jar')?.getData(),
                nestedMethod: methodOf('BOOT-INF/lib/helper.jar'),
                htmlStored: methodOf('static/index.html') === ZIP_METHOD_STORED
            },
            {
                fileCount: 4,
                lost: [],
                added: ['BOOT-INF/', 'BOOT-INF/classes/com/', 'BOOT-INF/classes/com/example/', 'META-INF/', 'static/'],
                classBytes,
                nested,
                nestedMethod: ZIP_METHOD_STORED,
                htmlStored: false
            }
        );
    });

    it('메타 폴더는 제외하고 사용자가 추가·수정·삭제한 내용은 반영한다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);
        extractAllEntries(jarPath, dest);

        fs.mkdirSync(path.join(dest, '.decom'), { recursive: true });
        fs.writeFileSync(path.join(dest, '.decom', 'manifest.json'), '{}');
        fs.mkdirSync(path.join(dest, '.vscode'), { recursive: true });
        fs.writeFileSync(path.join(dest, '.vscode', 'settings.json'), '{}');
        fs.writeFileSync(path.join(dest, 'static', 'index.html'), 'edited', 'utf8');
        fs.writeFileSync(path.join(dest, 'static', 'added.css'), 'body{}', 'utf8');
        fs.rmSync(path.join(dest, 'META-INF', 'MANIFEST.MF'));

        rebuildJarFromFolder(dest, jarPath);
        const rebuilt = new AdmZip(fs.readFileSync(jarPath));

        assert.deepEqual(
            {
                entries: entryNames(jarPath),
                html: rebuilt.getEntry('static/index.html')?.getData().toString('utf8')
            },
            {
                entries: [
                    'BOOT-INF/',
                    'BOOT-INF/classes/',
                    'BOOT-INF/classes/com/',
                    'BOOT-INF/classes/com/example/',
                    'BOOT-INF/classes/com/example/App.class',
                    'BOOT-INF/lib/',
                    'BOOT-INF/lib/helper.jar',
                    'META-INF/',
                    'static/',
                    'static/added.css',
                    'static/index.html'
                ],
                html: 'edited'
            }
        );
    });

    it('저장이 실패하면 원본 jar가 그대로 남고 임시 파일도 남지 않는다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        const original = fs.readFileSync(jarPath);
        const missing = path.join(root, 'no-such-cache');

        assert.throws(() => rebuildJarFromFolder(missing, jarPath));
        assert.deepEqual(
            {
                unchanged: fs.readFileSync(jarPath).equals(original),
                leftovers: fs.readdirSync(root).filter((name) => name.endsWith('.decom-tmp'))
            },
            { unchanged: true, leftovers: [] }
        );
    });
});

describe('취소', () => {
    /** 항목 사이의 취소 확인은 일정 간격으로만 일어나므로, 그 간격을 넘기는 크기로 만든다. */
    function manyEntryJar(jarPath: string, count: number): void {
        const zip = new AdmZip();
        for (let i = 0; i < count; i++) {
            zip.addFile(`pkg/file${i}.txt`, Buffer.from(`content ${i}`, 'utf8'));
        }
        fs.writeFileSync(jarPath, zip.toBuffer());
    }

    it('추출을 취소하면 중단되고, 이미 쓴 파일만 캐시에 남는다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'many.jar');
        manyEntryJar(jarPath, 200);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);

        // 첫 확인은 통과시키고 그다음 확인에서 취소한다 — 진행 중에 끊는 경우를 보기 위해서다.
        let checks = 0;
        const run = () => extractAllEntries(jarPath, dest, { shouldCancel: () => ++checks > 1 });

        assert.throws(run, { name: 'JarOperationCancelledError' });
        const written = fs.existsSync(path.join(dest, 'pkg')) ? fs.readdirSync(path.join(dest, 'pkg')).length : 0;
        assert.deepEqual({ stopped: written > 0 && written < 200 }, { stopped: true });
    });

    it('압축이 끝난 뒤 취소해도 원본 jar는 그대로고 임시 파일도 남지 않는다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        const original = fs.readFileSync(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);
        extractAllEntries(jarPath, dest);

        // 압축 자체는 한 덩어리라 끊을 수 없다. 끝난 직후 취소하는 경우가 원본을 지키는지 본다.
        let cancelled = false;
        const phases: JarProgress['phase'][] = [];
        const run = () =>
            rebuildJarFromFolder(dest, jarPath, {
                shouldCancel: () => cancelled,
                onProgress: (progress) => {
                    phases.push(progress.phase);
                    if (progress.phase === 'compress') {
                        cancelled = true;
                    }
                }
            });

        assert.throws(run, { name: 'JarOperationCancelledError' });
        assert.deepEqual(
            {
                unchanged: fs.readFileSync(jarPath).equals(original),
                leftovers: fs.readdirSync(root).filter((name) => name.endsWith('.decom-tmp')),
                reachedWrite: phases.includes('write')
            },
            { unchanged: true, leftovers: [], reachedWrite: false }
        );
    });
});
