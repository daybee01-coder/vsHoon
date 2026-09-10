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
import { CancellationLike, extractJarInWorker, rebuildJarInWorker, removeRebuildTemp } from './jarWorkerClient';
import { JarProgress } from './jarWorkerProtocol';

/**
 * 워커를 실제로 띄워, 확장 호스트 쪽 경로가 같은 결과를 돌려주는지 확인한다. `vscode`를
 * 쓰지 않으므로 취소 토큰은 같은 모양의 최소 구현으로 대신한다.
 */

const roots: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-worker-'));
    roots.push(dir);
    return dir;
}

after(() => {
    for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/** `vscode.CancellationToken`과 같은 모양의 최소 토큰. */
function cancellationSource(): { token: CancellationLike; cancel: () => void } {
    const listeners: Array<() => void> = [];
    let requested = false;
    const token: CancellationLike = {
        get isCancellationRequested() {
            return requested;
        },
        onCancellationRequested(listener: () => void) {
            listeners.push(listener);
            return { dispose: () => { } };
        }
    };
    return {
        token,
        cancel: () => {
            requested = true;
            for (const listener of listeners) {
                listener();
            }
        }
    };
}

function sampleJar(jarPath: string): void {
    const nested = new AdmZip();
    nested.addFile('org/lib/Helper.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x01]));

    const zip = new AdmZip();
    zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n', 'utf8'));
    zip.addFile('BOOT-INF/lib/helper.jar', nested.toBuffer());
    zip.addFile('static/index.html', Buffer.from('<h1>hi</h1>', 'utf8'));
    fs.writeFileSync(jarPath, zip.toBuffer());
}

describe('extractJarInWorker', () => {
    it('워커에서 풀어낸 결과가 항목·바이트 그대로다', async () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);
        const phases: JarProgress['phase'][] = [];

        const result = await extractJarInWorker(jarPath, dest, {
            onProgress: (progress) => phases.push(progress.phase)
        });

        assert.deepEqual(
            {
                extracted: result.extracted.sort(),
                skipped: result.skipped,
                html: fs.readFileSync(path.join(dest, 'static', 'index.html'), 'utf8'),
                reportedProgress: phases.includes('extract')
            },
            {
                extracted: ['BOOT-INF/lib/helper.jar', 'META-INF/MANIFEST.MF', 'static/index.html'],
                skipped: [],
                html: '<h1>hi</h1>',
                reportedProgress: true
            }
        );
    });

    it('없는 jar는 오류로 돌아온다', async () => {
        const root = tempDir();
        await assert.rejects(extractJarInWorker(path.join(root, 'missing.jar'), path.join(root, 'cache')), {
            name: 'Error'
        });
    });

    it('이미 취소된 토큰이면 워커를 띄우지 않고 끝낸다', async () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);
        const source = cancellationSource();
        source.cancel();

        await assert.rejects(extractJarInWorker(jarPath, dest, { token: source.token }), {
            name: 'JarOperationCancelledError'
        });
        assert.deepEqual(fs.readdirSync(dest), []);
    });
});

describe('rebuildJarInWorker', () => {
    it('워커에서 다시 빌드해도 왕복 후 항목이 유지된다', async () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);
        await extractJarInWorker(jarPath, dest);
        fs.writeFileSync(path.join(dest, 'static', 'index.html'), 'edited', 'utf8');

        const { fileCount } = await rebuildJarInWorker(dest, jarPath);
        const rebuilt = new AdmZip(fs.readFileSync(jarPath));

        assert.deepEqual(
            {
                fileCount,
                html: rebuilt.getEntry('static/index.html')?.getData().toString('utf8'),
                hasNested: rebuilt.getEntry('BOOT-INF/lib/helper.jar') !== null,
                leftovers: fs.readdirSync(root).filter((name) => name.endsWith('.decom-tmp'))
            },
            { fileCount: 3, html: 'edited', hasNested: true, leftovers: [] }
        );
    });

    it('취소하면 원본 jar가 그대로 남고 임시 파일도 남지 않는다', async () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        const original = fs.readFileSync(jarPath);
        const dest = path.join(root, 'cache');
        fs.mkdirSync(dest);
        await extractJarInWorker(jarPath, dest);
        const source = cancellationSource();
        source.cancel();

        await assert.rejects(rebuildJarInWorker(dest, jarPath, { token: source.token }), {
            name: 'JarOperationCancelledError'
        });
        assert.deepEqual(
            {
                unchanged: fs.readFileSync(jarPath).equals(original),
                leftovers: fs.readdirSync(root).filter((name) => name.endsWith('.decom-tmp'))
            },
            { unchanged: true, leftovers: [] }
        );
    });

    it('남아 있던 임시 파일을 지운다', () => {
        const root = tempDir();
        const jarPath = path.join(root, 'app.jar');
        sampleJar(jarPath);
        fs.writeFileSync(`${jarPath}.decom-tmp`, 'stale');

        removeRebuildTemp(jarPath);

        assert.deepEqual(fs.readdirSync(root), ['app.jar']);
    });
});
