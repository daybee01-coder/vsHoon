/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IVShoonUIExtensionSource, VShoonUIContributionBridge } from '../../common/uiContributionBridge.js';
import { VShoonUICapability, VShoonUIContributionRegistry } from '../../common/uiContributions.js';

const builtinSource: IVShoonUIExtensionSource = { id: 'vshoon.builtin', builtin: true };
const extensionSource: IVShoonUIExtensionSource = { id: 'publisher.extension', builtin: false };

function rawContribution(id: string): Record<string, unknown> {
	return { version: 1, id, command: `publisher.extension.${id}`, title: id };
}

suite('VShoon UI Contribution Bridge', () => {
	let disposables: DisposableStore;
	let registry: VShoonUIContributionRegistry;
	let bridge: VShoonUIContributionBridge;

	setup(() => {
		disposables = new DisposableStore();
		registry = disposables.add(new VShoonUIContributionRegistry());
		bridge = disposables.add(new VShoonUIContributionBridge(registry));
	});

	teardown(() => disposables.dispose());

	test('accepts bundled contributions and replaces their lifecycle as a group', () => {
		assert.deepStrictEqual(bridge.updateHeaderCommands(builtinSource, [rawContribution('one'), rawContribution('two')]), { accepted: 2, errors: [] });
		assert.deepStrictEqual(registry.getContributions(VShoonUICapability.WorkbenchHeaderCommand).map(entry => entry.contribution.id), ['one', 'two']);

		assert.deepStrictEqual(bridge.updateHeaderCommands(builtinSource, [rawContribution('replacement')]), { accepted: 1, errors: [] });
		assert.deepStrictEqual(registry.getContributions(VShoonUICapability.WorkbenchHeaderCommand).map(entry => entry.contribution.id), ['replacement']);

		bridge.removeSource(builtinSource.id);
		assert.strictEqual(registry.getContributions(VShoonUICapability.WorkbenchHeaderCommand).length, 0);
	});

	test('requires an explicit capability permission for third-party extensions', () => {
		const blocked = bridge.updateHeaderCommands(extensionSource, [rawContribution('blocked')]);
		assert.strictEqual(blocked.accepted, 0);
		assert.match(blocked.errors[0], /not authorized/);

		const allowed = bridge.updateHeaderCommands({
			...extensionSource,
			allowedCapabilities: [VShoonUICapability.WorkbenchHeaderCommand]
		}, [rawContribution('allowed')]);
		assert.deepStrictEqual(allowed, { accepted: 1, errors: [] });
	});

	test('preserves the previous group when an update is malformed', () => {
		bridge.updateHeaderCommands(builtinSource, [rawContribution('stable')]);
		const malformed = bridge.updateHeaderCommands(builtinSource, [{ ...rawContribution('bad'), html: '<button>bad</button>' }]);

		assert.strictEqual(malformed.accepted, 0);
		assert.match(malformed.errors[0], /unsupported property 'html'/);
		assert.deepStrictEqual(registry.getContributions(VShoonUICapability.WorkbenchHeaderCommand).map(entry => entry.contribution.id), ['stable']);
	});

	test('rejects invalid versions and duplicate contribution ids without partial registration', () => {
		const invalidVersion = bridge.updateHeaderCommands(builtinSource, [{ ...rawContribution('future'), version: 2 }]);
		assert.strictEqual(invalidVersion.accepted, 0);

		const duplicate = bridge.updateHeaderCommands(builtinSource, [rawContribution('same'), rawContribution('same')]);
		assert.strictEqual(duplicate.accepted, 0);
		assert.match(duplicate.errors[0], /Duplicate/);
		assert.strictEqual(registry.getContributions(VShoonUICapability.WorkbenchHeaderCommand).length, 0);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
