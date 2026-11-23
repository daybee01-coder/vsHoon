/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectScriptDeclarations, isScriptCode } from './scriptSymbols';

describe('script declarations', () => {
	it('finds global functions, assigned functions, object and class methods but not calls', () => {
		const content = [
			'function goPage(url) { alertPopup("function fake() {}"); }',
			'var util = {};',
			'util.trim = function (value) { return value; };',
			'const add = (a, b) => a + b;',
			'var options = { onLoad: function () {}, render(row) { return row; } };',
			'class Grid {',
			'  static create(id) { if (id) { return new Grid(); } }',
			'}',
			'// function commented() {}',
			'async function* stream() {}'
		].join('\n');
		assert.deepStrictEqual(collectScriptDeclarations(content).map(declaration => `${declaration.name}@${declaration.line}:${declaration.column}`), [
			'goPage@0:9', 'trim@2:5', 'add@3:6', 'onLoad@4:16', 'render@4:40', 'Grid@5:6', 'create@6:9', 'stream@9:16'
		]);
	});

	it('does not navigate from strings, comments or keywords in a page', () => {
		const content = '<a title="don\'t">x</a>\n<script>\n// goPage()\nif (ok) { goPage("goPage"); }\n</script>';
		const offsets = [content.indexOf('goPage'), content.lastIndexOf('goPage('), content.lastIndexOf('goPage'), content.indexOf('if')];
		assert.deepStrictEqual(offsets.map((offset, index) => isScriptCode(content, offset, index === 3 ? 'if' : 'goPage')), [false, true, false, false]);
	});
});
