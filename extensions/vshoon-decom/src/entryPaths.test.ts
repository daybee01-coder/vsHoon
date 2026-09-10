/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as path from 'path';
import { describe, it } from 'node:test';
import { isMetaEntry, isNestedArchive, normalizeEntryName, safeEntryTarget } from './entryPaths';

describe('normalizeEntryName', () => {
    it('구분자를 / 로 맞춘다', () => {
        assert.equal(normalizeEntryName('a\\b\\C.class'), 'a/b/C.class');
    });
});

describe('isNestedArchive', () => {
    it('jar/war 만, 대소문자는 가리지 않는다', () => {
        const names = ['BOOT-INF/lib/a.jar', 'b.WAR', 'c.class', 'd.jar.txt', 'META-INF/MANIFEST.MF'];
        assert.deepEqual(names.filter(isNestedArchive), ['BOOT-INF/lib/a.jar', 'b.WAR']);
    });
});

describe('isMetaEntry', () => {
    it('메타 폴더와 그 아래만 제외한다', () => {
        const names = [
            '.decom',
            '.decom/manifest.json',
            '.vscode/settings.json',
            '.decomposed/x.txt',
            '.vscoderc',
            'com/example/A.class'
        ];
        assert.deepEqual(names.filter(isMetaEntry), ['.decom', '.decom/manifest.json', '.vscode/settings.json']);
    });
});

describe('safeEntryTarget', () => {
    const dest = path.resolve(path.join('cache', 'jar'));

    it('평범한 항목은 폴더 아래 경로가 된다', () => {
        assert.equal(safeEntryTarget(dest, 'com/example/A.class'), path.join(dest, 'com', 'example', 'A.class'));
        assert.equal(safeEntryTarget(dest, 'a\\b.txt'), path.join(dest, 'a', 'b.txt'));
    });

    it('폴더 밖을 가리키는 항목은 거부한다', () => {
        const hostile = [
            '../evil.txt',
            'a/../../evil.txt',
            'a/../b.txt',
            '/etc/passwd',
            'C:/Windows/win.ini',
            '',
            './'
        ];
        assert.deepEqual(hostile.map((name) => safeEntryTarget(dest, name)), hostile.map(() => undefined));
    });
});
