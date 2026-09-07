/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { readOsFileDragRequest, VSHOON_OS_FILE_DRAG_MESSAGE, VShoonOsFileDropRegistry } from '../../common/osFileDrops.js';

suite('VShoon OS File Drops', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const builtin = { id: 'vshoon.vssh', builtin: true };

	test('accepts bundled views and matches source ids case-insensitively', () => {
		const registry = store.add(new VShoonOsFileDropRegistry());
		const accepted = registry.update(builtin, [{ version: 1, viewType: 'vssh.sftp' }]);
		assert.deepStrictEqual([
			accepted,
			registry.isOsFileDropView('VShoon.VSsh', 'vssh.sftp'),
			registry.isOsFileDropView(builtin.id, 'vssh.sessions'),
			registry.isOsFileDropView('vshoon.dbconn', 'vssh.sftp')
		], [
			{ accepted: 1, errors: [] },
			true,
			false,
			false
		]);
	});

	test('forgets a source once its declarations go away', () => {
		const registry = store.add(new VShoonOsFileDropRegistry());
		registry.update(builtin, [{ version: 1, viewType: 'vssh.sftp' }]);
		registry.removeSource('VShoon.VSsh');
		assert.strictEqual(registry.isOsFileDropView(builtin.id, 'vssh.sftp'), false);
	});

	test('rejects unauthorized, malformed and duplicate declarations without registering any of them', () => {
		const registry = store.add(new VShoonOsFileDropRegistry());
		const results = [
			registry.update({ id: 'third.party', builtin: false }, [{ version: 1, viewType: 'vssh.sftp' }]),
			registry.update(builtin, [{ version: 2, viewType: 'vssh.sftp' }]),
			registry.update(builtin, [{ version: 1, viewType: 'vssh.sftp', extra: true }]),
			registry.update(builtin, [{ version: 1, viewType: 'vssh.sftp' }, { version: 1, viewType: 'vssh.sftp' }]),
			registry.update(builtin, 'not-an-array')
		].map(result => result.accepted);

		assert.deepStrictEqual([
			results,
			registry.isOsFileDropView(builtin.id, 'vssh.sftp'),
			registry.isOsFileDropView('third.party', 'vssh.sftp')
		], [
			[0, 0, 0, 0, 0],
			false,
			false
		]);
	});

	test('reads a drag request only from a well formed message', () => {
		const many = Array.from({ length: 101 }, (_, index) => `C:\\a\\${index}.txt`);
		assert.deepStrictEqual([
			readOsFileDragRequest({ type: VSHOON_OS_FILE_DRAG_MESSAGE, paths: ['C:\\a\\one.txt', 'C:\\a\\two.txt'] }),
			readOsFileDragRequest({ type: 'transfer', paths: ['C:\\a\\one.txt'] }),
			readOsFileDragRequest({ type: VSHOON_OS_FILE_DRAG_MESSAGE, paths: [] }),
			readOsFileDragRequest({ type: VSHOON_OS_FILE_DRAG_MESSAGE, paths: ['C:\\a\\one.txt', ''] }),
			readOsFileDragRequest({ type: VSHOON_OS_FILE_DRAG_MESSAGE, paths: many }),
			readOsFileDragRequest({ type: VSHOON_OS_FILE_DRAG_MESSAGE }),
			readOsFileDragRequest(undefined)
		], [
			['C:\\a\\one.txt', 'C:\\a\\two.txt'],
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		]);
	});
});
