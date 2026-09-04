/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { VShoonModalWebviewRegistry } from '../../common/modalWebviews.js';

suite('VShoon Modal Webviews', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const builtin = { id: 'vshoon.dbconn', builtin: true };

	test('accepts bundled view types and matches source ids case-insensitively', () => {
		const registry = store.add(new VShoonModalWebviewRegistry());
		assert.deepStrictEqual(registry.update(builtin, [{ version: 1, viewType: 'dbconn.connectionForm' }]), { accepted: 1, errors: [] });
		assert.strictEqual(registry.isModalWebview('VShoon.DBConn', 'dbconn.connectionForm'), true);
		assert.strictEqual(registry.isModalWebview('vshoon.dbconn', 'dbconn.results'), false);
	});

	test('rejects third-party, malformed and duplicate declarations', () => {
		const registry = store.add(new VShoonModalWebviewRegistry());
		assert.match(registry.update({ id: 'publisher.extension', builtin: false }, []).errors[0], /not authorized/);
		assert.match(registry.update(builtin, [{ version: 2, viewType: 'dbconn.connectionForm' }]).errors[0], /invalid version/);
		assert.match(registry.update(builtin, [
			{ version: 1, viewType: 'dbconn.connectionForm' },
			{ version: 1, viewType: 'dbconn.connectionForm' }
		]).errors[0], /Duplicate/);
	});

	test('preserves the previous declaration when an update is invalid and removes it on unload', () => {
		const registry = store.add(new VShoonModalWebviewRegistry());
		registry.update(builtin, [{ version: 1, viewType: 'dbconn.connectionForm' }]);
		registry.update(builtin, [{ version: 1, viewType: 'bad view type' }]);
		assert.strictEqual(registry.isModalWebview(builtin.id, 'dbconn.connectionForm'), true);

		registry.removeSource(builtin.id);
		assert.strictEqual(registry.isModalWebview(builtin.id, 'dbconn.connectionForm'), false);
	});
});
