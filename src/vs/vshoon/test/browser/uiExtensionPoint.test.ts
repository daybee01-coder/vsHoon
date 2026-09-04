/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IJSONSchema } from '../../../base/common/jsonSchema.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IVShoonExtensionPoint, IVShoonExtensionPointUser, IVShoonExtensionsRegistry, registerVShoonUIExtensionPoint, vshoonModalWebviewRegistry, vshoonUIContributionRegistry } from '../../browser/uiExtensionPoint.js';
import { VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT } from '../../common/modalWebviews.js';
import { VSHOON_HEADER_COMMANDS_EXTENSION_POINT } from '../../common/uiContributionBridge.js';
import { VShoonUICapability } from '../../common/uiContributions.js';

class TestExtensionsRegistry implements IVShoonExtensionsRegistry {
	readonly descriptors = new Map<string, IJSONSchema>();
	private readonly handlers = new Map<string, (extensions: readonly IVShoonExtensionPointUser<unknown[]>[]) => void>();

	registerExtensionPoint<T>(descriptor: { readonly extensionPoint: string; readonly jsonSchema: IJSONSchema }): IVShoonExtensionPoint<T> {
		this.descriptors.set(descriptor.extensionPoint, descriptor.jsonSchema);
		return {
			setHandler: handler => {
				this.handlers.set(descriptor.extensionPoint, extensions => handler(extensions as unknown as readonly IVShoonExtensionPointUser<T>[]));
				return Disposable.None;
			}
		};
	}

	accept(extensionPoint: string, extensions: readonly IVShoonExtensionPointUser<unknown[]>[]): void {
		this.handlers.get(extensionPoint)?.(extensions);
	}
}

function extension(id: string, isBuiltin: boolean, errors: string[]): IVShoonExtensionPointUser<unknown[]> {
	return {
		description: { identifier: { value: id }, isBuiltin },
		value: [{ version: 1, id: 'sample', command: `${id}.sample`, title: 'Sample' }],
		collector: { error: message => errors.push(message) }
	};
}

suite('VShoon UI Extension Point', () => {
	let registry: TestExtensionsRegistry;

	setup(() => {
		registry = new TestExtensionsRegistry();
		registerVShoonUIExtensionPoint(registry);
	});

	teardown(() => {
		registry.accept(VSHOON_HEADER_COMMANDS_EXTENSION_POINT, []);
		registry.accept(VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT, []);
	});

	test('registers bounded declarative manifest schemas', () => {
		const headerSchema = registry.descriptors.get(VSHOON_HEADER_COMMANDS_EXTENSION_POINT);
		assert.strictEqual(headerSchema?.type, 'array');
		assert.strictEqual(headerSchema?.maxItems, 10);
		assert.deepStrictEqual(headerSchema?.items && !Array.isArray(headerSchema.items)
			? headerSchema.items.required
			: undefined, ['version', 'id', 'command', 'title']);

		const modalSchema = registry.descriptors.get(VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT);
		assert.strictEqual(modalSchema?.type, 'array');
		assert.strictEqual(modalSchema?.maxItems, 10);
		assert.deepStrictEqual(modalSchema?.items && !Array.isArray(modalSchema.items)
			? modalSchema.items.required
			: undefined, ['version', 'viewType']);
	});

	test('accepts bundled extensions and removes their registrations on unload', () => {
		const errors: string[] = [];
		registry.accept(VSHOON_HEADER_COMMANDS_EXTENSION_POINT, [extension('vshoon.contract-test', true, errors)]);
		assert.deepStrictEqual(errors, [] as string[]);
		assert.strictEqual(vshoonUIContributionRegistry.getContributions(VShoonUICapability.WorkbenchHeaderCommand)
			.some(entry => entry.source.id === 'vshoon.contract-test'), true);

		registry.accept(VSHOON_HEADER_COMMANDS_EXTENSION_POINT, []);
		assert.strictEqual(vshoonUIContributionRegistry.getContributions(VShoonUICapability.WorkbenchHeaderCommand)
			.some(entry => entry.source.id === 'vshoon.contract-test'), false);
	});

	test('reports and rejects third-party declarations until permission support exists', () => {
		const errors: string[] = [];
		registry.accept(VSHOON_HEADER_COMMANDS_EXTENSION_POINT, [extension('publisher.contract-test', false, errors)]);

		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /bundled extensions/);
		assert.strictEqual(vshoonUIContributionRegistry.getContributions(VShoonUICapability.WorkbenchHeaderCommand)
			.some(entry => entry.source.id === 'publisher.contract-test'), false);
	});

	test('accepts bundled modal webviews, rejects third-party declarations and cleans up', () => {
		const errors: string[] = [];
		registry.accept(VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT, [{
			description: { identifier: { value: 'vshoon.dbconn-test' }, isBuiltin: true },
			value: [{ version: 1, viewType: 'dbconn.connectionForm' }],
			collector: { error: message => errors.push(message) }
		}]);
		assert.deepStrictEqual(errors, [] as string[]);
		assert.strictEqual(vshoonModalWebviewRegistry.isModalWebview('vshoon.dbconn-test', 'dbconn.connectionForm'), true);

		registry.accept(VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT, [{
			description: { identifier: { value: 'publisher.modal-test' }, isBuiltin: false },
			value: [{ version: 1, viewType: 'publisher.form' }],
			collector: { error: message => errors.push(message) }
		}]);
		assert.match(errors[0], /bundled extensions/);
		assert.strictEqual(vshoonModalWebviewRegistry.isModalWebview('vshoon.dbconn-test', 'dbconn.connectionForm'), false);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
