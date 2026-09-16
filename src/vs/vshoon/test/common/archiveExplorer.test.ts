/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { isVShoonExpandableArchive } from '../../common/archiveExplorer.js';

suite('VShoon archive explorer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only expands local and virtual JAR files', () => {
		assert.deepStrictEqual([
			isVShoonExpandableArchive(URI.file('/workspace/app.jar')),
			isVShoonExpandableArchive(URI.file('/workspace/APP.JAR')),
			isVShoonExpandableArchive(URI.parse('vshoon-jar://archive/lib/dependency.jar')),
			isVShoonExpandableArchive(URI.file('/workspace/app.war')),
			isVShoonExpandableArchive(URI.parse('https://example.com/app.jar'))
		], [true, true, true, false, false]);
	});
});
