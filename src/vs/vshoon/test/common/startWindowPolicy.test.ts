/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { evaluateVShoonSecondInstance, evaluateVShoonStartWindow, IVShoonLaunchRequest, IVShoonSecondInstanceContext, IVShoonStartWindowLaunchContext } from '../../common/startWindowPolicy.js';

const defaultRequest: IVShoonLaunchRequest = {
	disableStartWindow: false,
	hasExplicitTarget: false,
	hasProtocolUrl: false,
	hasSpecialFileMode: false,
	hasRemoteAuthority: false,
	hasForcedProfile: false,
	forceNewWindow: false,
	extensionDevelopment: false,
	testMode: false,
	agentWindow: false
};

const bypassKeys: ReadonlyArray<keyof IVShoonLaunchRequest> = [
	'disableStartWindow',
	'hasExplicitTarget',
	'hasProtocolUrl',
	'hasSpecialFileMode',
	'hasRemoteAuthority',
	'hasForcedProfile',
	'forceNewWindow',
	'extensionDevelopment',
	'testMode',
	'agentWindow'
];

const bypassReasons = [
	'disabledByCli',
	'explicitTarget',
	'protocolUrl',
	'specialFileMode',
	'remoteAuthority',
	'forcedProfile',
	'forcedNewWindow',
	'extensionDevelopment',
	'testMode',
	'agentWindow'
];

suite('VShoon Start Window Policy', () => {

	const defaultContext: IVShoonStartWindowLaunchContext = {
		...defaultRequest,
		enabled: true,
		initialStartup: true,
		desktopLaunch: true
	};

	test('shows for an ordinary desktop launch', () => {
		assert.deepStrictEqual(evaluateVShoonStartWindow(defaultContext), { show: true });
	});

	test('returns a stable reason for each bypass condition', () => {
		const cases: ReadonlyArray<readonly [keyof IVShoonStartWindowLaunchContext, boolean]> = [
			['enabled', false],
			['initialStartup', false],
			['desktopLaunch', false],
			...bypassKeys.map(key => [key, true] as const)
		];

		assert.deepStrictEqual(
			cases.map(([key, value]) => evaluateVShoonStartWindow({ ...defaultContext, [key]: value })),
			['disabled', 'notInitialStartup', 'notDesktopLaunch', ...bypassReasons].map(reason => ({ show: false, reason }))
		);
	});

	test('uses a stable priority when multiple bypass conditions apply', () => {
		assert.deepStrictEqual(
			evaluateVShoonStartWindow({
				...defaultContext,
				hasExplicitTarget: true,
				hasRemoteAuthority: true,
				agentWindow: true
			}),
			{ show: false, reason: 'explicitTarget' }
		);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});

suite('VShoon Second Instance Policy', () => {

	const defaultContext: IVShoonSecondInstanceContext = {
		...defaultRequest,
		startWindowOwnsLaunch: true
	};

	test('focuses the start window for a target-less second instance', () => {
		assert.deepStrictEqual(evaluateVShoonSecondInstance(defaultContext), { focusStartWindow: true });
	});

	test('defers to upstream when the start window does not own the launch', () => {
		assert.deepStrictEqual(
			evaluateVShoonSecondInstance({ ...defaultContext, startWindowOwnsLaunch: false }),
			{ focusStartWindow: false, reason: 'noStartWindow' }
		);
	});

	test('defers to upstream for every request that carries a target or mode', () => {
		assert.deepStrictEqual(
			bypassKeys.map(key => evaluateVShoonSecondInstance({ ...defaultContext, [key]: true })),
			bypassReasons.map(reason => ({ focusStartWindow: false, reason }))
		);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
