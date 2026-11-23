/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { StubCache } from './stubCache';

describe('stub cache', () => {
	it('reuses stored entries only for unchanged stamps and the same parser format', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vshoon-stubs-'));
		try {
			const file = path.join(root, 'index', 'stubs.json');
			const first = new StubCache<string[]>(file, 'format-1');
			await first.load();
			first.set('a', '1:10', ['A']);
			first.set('b', '1:20', ['B']);
			first.set('c', '1:30', ['C']);
			first.retain(new Set(['a', 'b']));
			await first.flush();
			const reopened = new StubCache<string[]>(file, 'format-1');
			await reopened.load();
			const upgraded = new StubCache<string[]>(file, 'format-2');
			await upgraded.load();
			fs.writeFileSync(file, '{ corrupt');
			const corrupt = new StubCache<string[]>(file, 'format-1');
			await corrupt.load();
			assert.deepStrictEqual([reopened.get('a', '1:10'), reopened.get('b', '2:20'), reopened.get('c', '1:30'), upgraded.get('a', '1:10'), corrupt.get('a', '1:10')], [
				['A'], undefined, undefined, undefined, undefined
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
