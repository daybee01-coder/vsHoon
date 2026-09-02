/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IVShoonUIContributionSource, IVShoonWorkbenchHeaderCommandContribution, VShoonUICapability, VShoonUIContributionRegistry } from '../../common/uiContributions.js';

const source: IVShoonUIContributionSource = { id: 'vshoon.test', kind: 'builtinExtension', trusted: true };

function contribution(id: string, order?: number): IVShoonWorkbenchHeaderCommandContribution {
	return {
		capability: VShoonUICapability.WorkbenchHeaderCommand,
		version: 1,
		id,
		command: `vshoon.test.${id}`,
		title: ` ${id} `,
		order
	};
}

suite('VShoon UI Contributions', () => {
	let disposables: DisposableStore;
	let registry: VShoonUIContributionRegistry;

	setup(() => {
		disposables = new DisposableStore();
		registry = disposables.add(new VShoonUIContributionRegistry());
	});

	teardown(() => disposables.dispose());

	test('reports capability support by exact version', () => {
		assert.strictEqual(registry.supports(VShoonUICapability.WorkbenchHeaderCommand, 1), true);
		assert.strictEqual(registry.supports(VShoonUICapability.WorkbenchHeaderCommand, 2), false);
	});

	test('normalizes, freezes and sorts contributions', () => {
		disposables.add(registry.register(source, contribution('later', 20)));
		disposables.add(registry.register(source, contribution('first', -10)));

		const registered = registry.getContributions(VShoonUICapability.WorkbenchHeaderCommand);
		assert.deepStrictEqual(registered.map(candidate => candidate.contribution.id), ['first', 'later']);
		assert.strictEqual(registered[0].contribution.title, 'first');
		assert.strictEqual(Object.isFrozen(registered[0]), true);
		assert.strictEqual(Object.isFrozen(registered[0].contribution), true);
	});

	test('emits additions and disposable removals', () => {
		const events: string[] = [];
		disposables.add(registry.onDidChange(event => {
			events.push(event.added[0]?.contribution.id ?? `-${event.removed[0].contribution.id}`);
		}));

		const registration = registry.register(source, contribution('temporary'));
		registration.dispose();

		assert.deepStrictEqual(events, ['temporary', '-temporary']);
	});

	test('rejects unauthorized and unsupported contributions', () => {
		assert.throws(() => registry.register({ ...source, trusted: false }, contribution('blocked')), /not authorized/);
		assert.throws(() => registry.register(source, { ...contribution('future'), version: 2 as 1 }), /Unsupported.*version/);
	});

	test('rejects invalid input and duplicate ids', () => {
		assert.throws(() => registry.register(source, { ...contribution('bad'), command: 'bad command' }), /command id is invalid/);
		assert.throws(() => registry.register(source, { ...contribution('blank'), title: '  ' }), /title is invalid/);

		disposables.add(registry.register(source, contribution('duplicate')));
		assert.throws(() => registry.register(source, contribution('duplicate')), /Duplicate/);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
