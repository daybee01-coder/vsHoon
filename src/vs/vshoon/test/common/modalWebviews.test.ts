/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { VShoonModalWebviewLayouts, VShoonModalWebviewRegistry } from '../../common/modalWebviews.js';

suite('VShoon Modal Webviews', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const builtin = { id: 'vshoon.dbconn', builtin: true };

	test('remembers independent panel layouts only within a session', () => {
		const layouts = new VShoonModalWebviewLayouts();
		const layout = { size: { width: 850, height: 640 }, position: { left: 20, top: 40 }, maximized: false };
		layouts.set(builtin.id, 'form', layout);
		layout.size.width = 900;
		layout.position.left = 99;
		assert.deepStrictEqual([
			layouts.get('VSHOON.DBCONN', 'form'),
			layouts.get(builtin.id, 'other'),
			layouts.get('vshoon.vssh', 'form'),
			new VShoonModalWebviewLayouts().get(builtin.id, 'form')
		], [
			{ size: { width: 850, height: 640 }, position: { left: 20, top: 40 }, maximized: false },
			undefined, undefined, undefined
		]);
	});

	test('preserves maximize and reset without retaining mutable geometry', () => {
		const layouts = new VShoonModalWebviewLayouts();
		layouts.set(builtin.id, 'form', { size: undefined, position: undefined, maximized: true });
		assert.deepStrictEqual(layouts.get(builtin.id, 'form'), { size: undefined, position: undefined, maximized: true });
		layouts.set(builtin.id, 'form', { size: { width: 700, height: 500 }, position: undefined, maximized: false });
		assert.notStrictEqual(layouts.get(builtin.id, 'form')?.size, layouts.get(builtin.id, 'form')?.size);
	});

	test('accepts bundled view types and matches source ids case-insensitively', () => {
		const registry = store.add(new VShoonModalWebviewRegistry());
		assert.deepStrictEqual(registry.update(builtin, [{ version: 1, viewType: 'dbconn.connectionForm', size: { width: 760, height: 625 } }]), { accepted: 1, errors: [] });
		assert.strictEqual(registry.isModalWebview('VShoon.DBConn', 'dbconn.connectionForm'), true);
		assert.strictEqual(registry.isModalWebview('vshoon.dbconn', 'dbconn.results'), false);
		assert.deepStrictEqual(registry.getModalWebview('VShoon.DBConn', 'dbconn.connectionForm'), {
			version: 1,
			viewType: 'dbconn.connectionForm',
			size: { width: 760, height: 625 }
		});
		assert.strictEqual(Object.isFrozen(registry.getModalWebview('VShoon.DBConn', 'dbconn.connectionForm')), true);
		assert.strictEqual(Object.isFrozen(registry.getModalWebview('VShoon.DBConn', 'dbconn.connectionForm')?.size), true);
	});

	test('keeps a separate size for each declared view type', () => {
		const registry = store.add(new VShoonModalWebviewRegistry());
		assert.deepStrictEqual(registry.update(builtin, [
			{ version: 1, viewType: 'dbconn.connectionForm', size: { width: 760, height: 625 } },
			{ version: 1, viewType: 'vsshSessionForm', size: { width: 540, height: 560 } },
			{ version: 1, viewType: 'vsearch.panel', size: { width: 1200, height: 700 } }
		]), { accepted: 3, errors: [] });

		assert.deepStrictEqual(registry.getModalWebview(builtin.id, 'dbconn.connectionForm')?.size, { width: 760, height: 625 });
		assert.deepStrictEqual(registry.getModalWebview(builtin.id, 'vsshSessionForm')?.size, { width: 540, height: 560 });
		assert.deepStrictEqual(registry.getModalWebview(builtin.id, 'vsearch.panel')?.size, { width: 1200, height: 700 });
	});

	test('rejects third-party, malformed and duplicate declarations', () => {
		const registry = store.add(new VShoonModalWebviewRegistry());
		assert.match(registry.update({ id: 'publisher.extension', builtin: false }, []).errors[0], /not authorized/);
		assert.match(registry.update(builtin, [{ version: 2, viewType: 'dbconn.connectionForm' }]).errors[0], /invalid version/);
		assert.match(registry.update(builtin, [
			{ version: 1, viewType: 'dbconn.connectionForm' },
			{ version: 1, viewType: 'dbconn.connectionForm' }
		]).errors[0], /Duplicate/);
		assert.match(registry.update(builtin, [{ version: 1, viewType: 'dbconn.connectionForm', size: { width: 399, height: 625 } }]).errors[0], /invalid size/);
		assert.match(registry.update(builtin, [{ version: 1, viewType: 'dbconn.connectionForm', size: { width: 760, height: 625, extra: true } }]).errors[0], /invalid size/);
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
