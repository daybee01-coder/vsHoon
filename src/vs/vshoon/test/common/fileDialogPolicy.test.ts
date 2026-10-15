/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { shouldUseVShoonFileDialog } from '../../common/fileDialogPolicy.js';

suite('VShoon File Dialog Policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the VShoon dialog for an explicitly local request', () => {
		assert.strictEqual(shouldUseVShoonFileDialog({ availableFileSystems: [Schemas.file] }, Schemas.vscodeRemote), true);
	});

	test('resolves an extension-host empty scheme list from its local default URI', () => {
		assert.strictEqual(shouldUseVShoonFileDialog({ availableFileSystems: [], defaultUri: URI.file('/project') }, Schemas.vscodeRemote), true);
	});

	test('resolves an empty scheme list from the local window scheme when no default URI exists', () => {
		assert.strictEqual(shouldUseVShoonFileDialog({ availableFileSystems: [] }, Schemas.file), true);
	});

	test('keeps remote, mixed-scheme and multi-selection requests on the upstream dialog', () => {
		assert.strictEqual(shouldUseVShoonFileDialog({ availableFileSystems: [], defaultUri: URI.from({ scheme: Schemas.vscodeRemote, path: '/project' }) }, Schemas.file), false);
		assert.strictEqual(shouldUseVShoonFileDialog({ availableFileSystems: [Schemas.vscodeRemote, Schemas.file] }, Schemas.file), false);
		assert.strictEqual(shouldUseVShoonFileDialog({ availableFileSystems: [Schemas.file], canSelectMany: true }, Schemas.file), false);
	});
});
