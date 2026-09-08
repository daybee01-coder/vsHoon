/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readScriptSnapshot } from './scriptSnapshot';

describe('SQL script snapshot', () => {
	for (const length of [1, 10_000, 100_000, 1_000_000]) {
		it(`reads an eligible ${length}-character document exactly once`, () => {
			const text = 'x'.repeat(length);
			let reads = 0;
			const snapshot = readScriptSnapshot({
				languageId: 'sql', isDirty: true, uri: { scheme: 'file' },
				getText: () => { reads++; return text; },
			}, true);
			assert.deepStrictEqual({ snapshot, reads }, { snapshot: text, reads: 1 });
		});
	}

	for (const length of [0, 1_000_001]) {
		it(`preserves the size policy for ${length} characters`, () => {
			let reads = 0;
			const snapshot = readScriptSnapshot({
				languageId: 'sql', isDirty: true, uri: { scheme: 'untitled' },
				getText: () => { reads++; return 'x'.repeat(length); },
			}, true);
			assert.deepStrictEqual({ snapshot, reads }, { snapshot: undefined, reads: 1 });
		});
	}

	for (const scenario of [
		{ name: 'disabled cache', enabled: false, languageId: 'sql', isDirty: true },
		{ name: 'non-SQL document', enabled: true, languageId: 'plaintext', isDirty: true },
		{ name: 'saved file', enabled: true, languageId: 'sql', isDirty: false },
	]) {
		it(`does not read text for ${scenario.name}`, () => {
			const snapshot = readScriptSnapshot({
				...scenario, uri: { scheme: 'file' },
				getText: () => { throw new Error('Ineligible document was read'); },
			}, scenario.enabled);
			assert.equal(snapshot, undefined);
		});
	}

	it('retains clean untitled documents as before', () => {
		assert.equal(readScriptSnapshot({
			languageId: 'sql', isDirty: false, uri: { scheme: 'untitled' },
			getText: () => 'SELECT 1',
		}, true), 'SELECT 1');
	});

	it('captures each edit immediately and keeps the last snapshot after close', () => {
		let text = 'SELECT 1';
		let closed = false;
		let reads = 0;
		const document = {
			languageId: 'sql', isDirty: true, uri: { scheme: 'untitled' },
			getText: () => {
				assert.equal(closed, false);
				reads++;
				return text;
			},
		};
		const snapshots = [readScriptSnapshot(document, true)];
		text = 'SELECT 2;\r\n-- 붙여넣기';
		snapshots.push(readScriptSnapshot(document, true));
		text = 'SELECT 1'; // undo
		snapshots.push(readScriptSnapshot(document, true));
		closed = true;
		assert.deepStrictEqual({ snapshots, reads }, {
			snapshots: ['SELECT 1', 'SELECT 2;\r\n-- 붙여넣기', 'SELECT 1'], reads: 3,
		});
	});
});
