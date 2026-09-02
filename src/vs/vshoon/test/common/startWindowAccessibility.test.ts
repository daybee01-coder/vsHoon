/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getVShoonProjectFocusAfterRemoval, getVShoonProjectNavigationIndex } from '../../common/startWindowAccessibility.js';

suite('VShoon Start Window Accessibility', () => {

	test('moves through recent projects without leaving the list boundaries', () => {
		assert.deepStrictEqual([
			getVShoonProjectNavigationIndex(1, 3, 'ArrowDown'),
			getVShoonProjectNavigationIndex(2, 3, 'ArrowDown'),
			getVShoonProjectNavigationIndex(1, 3, 'ArrowUp'),
			getVShoonProjectNavigationIndex(0, 3, 'ArrowUp'),
			getVShoonProjectNavigationIndex(1, 3, 'Home'),
			getVShoonProjectNavigationIndex(1, 3, 'End')
		], [2, 2, 0, 0, 0, 2]);
	});

	test('leaves unrelated and invalid navigation unchanged', () => {
		assert.deepStrictEqual([
			getVShoonProjectNavigationIndex(0, 2, 'Tab'),
			getVShoonProjectNavigationIndex(-1, 2, 'ArrowDown'),
			getVShoonProjectNavigationIndex(0, 0, 'ArrowDown')
		], [undefined, undefined, undefined]);
	});

	test('focuses the nearest survivor after removal', () => {
		const ids = ['a', 'b', 'c'];
		assert.deepStrictEqual([
			getVShoonProjectFocusAfterRemoval(ids, 'a'),
			getVShoonProjectFocusAfterRemoval(ids, 'b'),
			getVShoonProjectFocusAfterRemoval(ids, 'c'),
			getVShoonProjectFocusAfterRemoval(ids, 'missing'),
			getVShoonProjectFocusAfterRemoval(['a'], 'a')
		], ['b', 'c', 'b', undefined, undefined]);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
