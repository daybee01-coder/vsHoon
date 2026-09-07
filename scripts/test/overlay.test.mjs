/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mirrorOverlay } from '../overlay.mjs';

test('overlay mirror preserves compiled extension output and removes other stale files', t => {
	const root = mkdtempSync(join(tmpdir(), 'vshoon-overlay-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sourceRoot = join(root, 'source');
	const destinationRoot = join(root, 'destination');
	const entry = 'extensions/vshoon-example';
	const source = join(sourceRoot, entry);
	const destination = join(destinationRoot, entry);

	mkdirSync(source, { recursive: true });
	mkdirSync(join(destination, 'out'), { recursive: true });
	writeFileSync(join(source, 'package.json'), '{"name":"vshoon-example"}');
	writeFileSync(join(destination, 'out', 'extension.js'), 'compiled output');
	writeFileSync(join(destination, 'stale.txt'), 'stale');

	const result = mirrorOverlay({
		quiet: true,
		lock: { overlay: [entry] },
		sourceRoot,
		destinationRoot
	});

	assert.equal(readFileSync(join(destination, 'package.json'), 'utf8'), '{"name":"vshoon-example"}');
	assert.equal(readFileSync(join(destination, 'out', 'extension.js'), 'utf8'), 'compiled output');
	assert.equal(existsSync(join(destination, 'stale.txt')), false);
	assert.deepEqual(result, { copied: 1, removed: 1 });
});

test('overlay mirror does not preserve generated-looking output outside extensions', t => {
	const root = mkdtempSync(join(tmpdir(), 'vshoon-overlay-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sourceRoot = join(root, 'source');
	const destinationRoot = join(root, 'destination');
	const entry = 'src/vs/vshoon';

	mkdirSync(join(sourceRoot, entry), { recursive: true });
	mkdirSync(join(destinationRoot, entry, 'out'), { recursive: true });
	writeFileSync(join(sourceRoot, entry, 'product.ts'), 'export {};');
	writeFileSync(join(destinationRoot, entry, 'out', 'stale.js'), 'stale');

	mirrorOverlay({
		quiet: true,
		lock: { overlay: [entry] },
		sourceRoot,
		destinationRoot
	});

	assert.equal(existsSync(join(destinationRoot, entry, 'out', 'stale.js')), false);
});
