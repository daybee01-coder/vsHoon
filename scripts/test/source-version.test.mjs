/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getVShoonSourceVersion } from '../source-version.mjs';

test('VShoon source version tracks declared build inputs', t => {
	const root = mkdtempSync(join(tmpdir(), 'vshoon-source-version-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, 'src'), { recursive: true });
	mkdirSync(join(root, 'patches'), { recursive: true });
	const lock = { overlay: ['src'], patches: ['product.patch'] };
	writeFileSync(join(root, 'vshoon.lock.json'), JSON.stringify(lock));
	writeFileSync(join(root, 'src', 'product.ts'), 'first');
	writeFileSync(join(root, 'patches', 'product.patch'), 'patch');
	writeFileSync(join(root, 'README.md'), 'not a build input');

	const first = getVShoonSourceVersion({ root, lock });
	writeFileSync(join(root, 'README.md'), 'changed documentation');
	const afterDocumentationChange = getVShoonSourceVersion({ root, lock });
	writeFileSync(join(root, 'src', 'product.ts'), 'second');
	const afterOverlayChange = getVShoonSourceVersion({ root, lock });

	assert.match(first, /^[0-9a-f]{40}$/);
	assert.equal(afterDocumentationChange, first);
	assert.notEqual(afterOverlayChange, first);
});
