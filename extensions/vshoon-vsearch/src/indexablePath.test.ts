/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { isInSkippedDirectory } from './indexablePath';

describe('indexable paths', () => {
	it('checks only the folders below the closest workspace root', () => {
		const root = path.resolve('/work/build/project');
		const nested = path.join(root, 'modules', 'web');
		const roots = [root, nested];
		assert.deepStrictEqual([
			path.join(root, 'src', 'Main.java'),
			path.join(root, 'build.gradle'),
			path.join(root, 'target', 'classes', 'Main.class'),
			path.join(root, 'src', 'com', 'example', 'out', 'Report.java'),
			path.join(nested, 'node_modules', 'lib', 'index.js'),
			path.resolve('/elsewhere/target/Other.java')
		].map(filePath => isInSkippedDirectory(filePath, roots)), [false, false, true, true, true, false]);
	});
});
