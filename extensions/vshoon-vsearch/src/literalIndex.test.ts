/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LiteralIndex, literalBits } from './literalIndex';

describe('literal candidate index', () => {
	it('never excludes matching ASCII substrings including mixed case and punctuation', () => {
		const text = 'public class Foo { String value = "Hello WORLD, 123"; }\r\n한글';
		const index = new LiteralIndex(text);
		for (let start = 0; start < text.length; start++) {
			for (let end = start + 3; end <= text.length; end++) {
				assert.ok(index.mayContain(literalBits(text.slice(start, end).toUpperCase(), false)));
			}
		}
	});

	it('rejects absent literals and bypasses short, non-ASCII and regex queries', () => {
		const index = new LiteralIndex('public class Foo {}');
		assert.deepStrictEqual({
			absent: index.mayContain(literalBits('unrelated needle', false)),
			bypass: ['한글', 'ab', ''].map(pattern => literalBits(pattern, false)),
			regex: literalBits('foo.*bar', true)
		}, { absent: false, bypass: [[], [], []], regex: [] });
	});
});
