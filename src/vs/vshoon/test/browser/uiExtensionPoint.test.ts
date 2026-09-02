/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IJSONSchema } from '../../../base/common/jsonSchema.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IVShoonExtensionPoint, IVShoonExtensionPointUser, IVShoonExtensionsRegistry, registerVShoonUIExtensionPoint, vshoonUIContributionRegistry } from '../../browser/uiExtensionPoint.js';
import { VSHOON_HEADER_COMMANDS_EXTENSION_POINT } from '../../common/uiContributionBridge.js';
import { VShoonUICapability } from '../../common/uiContributions.js';

class TestExtensionsRegistry implements IVShoonExtensionsRegistry {
	descriptor: { readonly extensionPoint: string; readonly jsonSchema: IJSONSchema } | undefined;
	private handler: ((extensions: readonly IVShoonExtensionPointUser<unknown[]>[]) => void) | undefined;

	registerExtensionPoint<T>(descriptor: { readonly extensionPoint: string; readonly jsonSchema: IJSONSchema }): IVShoonExtensionPoint<T> {
		this.descriptor = descriptor;
		return {
			setHandler: handler => {
				this.handler = extensions => handler(extensions as unknown as readonly IVShoonExtensionPointUser<T>[]);
				return Disposable.None;
			}
		};
	}

	accept(extensions: readonly IVShoonExtensionPointUser<unknown[]>[]): void {
		this.handler?.(extensions);
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

	teardown(() => registry.accept([]));

	test('registers a bounded declarative manifest schema', () => {
		assert.strictEqual(registry.descriptor?.extensionPoint, VSHOON_HEADER_COMMANDS_EXTENSION_POINT);
		assert.strictEqual(registry.descriptor?.jsonSchema.type, 'array');
		assert.strictEqual(registry.descriptor?.jsonSchema.maxItems, 10);
		assert.deepStrictEqual(registry.descriptor?.jsonSchema.items && !Array.isArray(registry.descriptor.jsonSchema.items)
			? registry.descriptor.jsonSchema.items.required
			: undefined, ['version', 'id', 'command', 'title']);
	});

	test('accepts bundled extensions and removes their registrations on unload', () => {
		const errors: string[] = [];
		registry.accept([extension('vshoon.contract-test', true, errors)]);
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(vshoonUIContributionRegistry.getContributions(VShoonUICapability.WorkbenchHeaderCommand)
			.some(entry => entry.source.id === 'vshoon.contract-test'), true);

		registry.accept([]);
		assert.strictEqual(vshoonUIContributionRegistry.getContributions(VShoonUICapability.WorkbenchHeaderCommand)
			.some(entry => entry.source.id === 'vshoon.contract-test'), false);
	});

	test('reports and rejects third-party declarations until permission support exists', () => {
		const errors: string[] = [];
		registry.accept([extension('publisher.contract-test', false, errors)]);

		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /bundled extensions/);
		assert.strictEqual(vshoonUIContributionRegistry.getContributions(VShoonUICapability.WorkbenchHeaderCommand)
			.some(entry => entry.source.id === 'publisher.contract-test'), false);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
