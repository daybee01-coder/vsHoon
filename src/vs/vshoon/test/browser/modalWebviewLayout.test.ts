/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { VShoonModalWebviewLayout } from '../../browser/modalWebviewLayout.js';
import { vshoonModalWebviewRegistry } from '../../browser/uiExtensionPoint.js';
import { IVShoonModalWebviewSize } from '../../common/modalWebviews.js';

suite('VShoon Modal Webview Layout', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const source = 'vshoon.layout-test';

	setup(() => {
		vshoonModalWebviewRegistry.update({ id: source, builtin: true }, [
			{ version: 1, viewType: 'first', size: { width: 760, height: 625 } },
			{ version: 1, viewType: 'second', size: { width: 540, height: 560 } },
			{ version: 1, viewType: 'native', presentation: 'window', size: { width: 1200, height: 700 } }
		]);
	});
	teardown(() => vshoonModalWebviewRegistry.removeSource(source));

	function createPart() {
		return {
			size: undefined as IVShoonModalWebviewSize | undefined,
			position: undefined as { left: number; top: number } | undefined,
			maximized: false,
			toggleMaximized(): void { this.maximized = !this.maximized; }
		};
	}

	test('does not apply modal geometry to a separate desktop window', () => {
		const part = createPart();
		const controller = store.add(new VShoonModalWebviewLayout(part));
		controller.activate({ source, viewType: 'native' });
		assert.deepStrictEqual([part.size, part.position, part.maximized], [undefined, undefined, false]);
	});

	test('lets a bundled popup pass the window edges while keeping its header reachable', () => {
		const container = { width: 1000, height: 800 };
		const controller = store.add(new VShoonModalWebviewLayout(createPart()));
		controller.activate({ source, viewType: 'native' });
		const ordinary = controller.positionBounds(container, 30, 700);
		controller.activate({ source, viewType: 'first' });
		assert.deepStrictEqual([ordinary, controller.positionBounds(container, 30, 700)], [undefined, { minLeft: -540, maxLeft: 840, minTop: 30, maxTop: 752 }]);
	});

	test('switching panels and reopening restores each panel without changing ordinary editors', () => {
		const part = createPart();
		const controller = store.add(new VShoonModalWebviewLayout(part));
		controller.activate({ source, viewType: 'first' });
		part.size = { width: 830, height: 650 };
		part.position = { left: 31, top: 62 };
		controller.activate({ source, viewType: 'second' });
		assert.deepStrictEqual(part.size, { width: 540, height: 560 });
		part.size = { width: 600, height: 580 };
		controller.activate({ source, viewType: 'first' });
		assert.deepStrictEqual([part.size, part.position], [{ width: 830, height: 650 }, { left: 31, top: 62 }]);
		controller.activate(undefined);
		assert.deepStrictEqual([part.size, part.position], [undefined, undefined]);
		controller.dispose();

		const reopened = createPart();
		const next = store.add(new VShoonModalWebviewLayout(reopened));
		next.activate({ source, viewType: 'second' });
		assert.deepStrictEqual(reopened.size, { width: 600, height: 580 });
		reopened.maximized = true;
		next.dispose();
		const finalPart = createPart();
		const finalController = store.add(new VShoonModalWebviewLayout(finalPart));
		finalController.activate({ source, viewType: 'second' });
		assert.strictEqual(finalPart.maximized, true);
	});
});
