/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NativeParsedArgs } from '../../../platform/environment/common/argv.js';
import { toVShoonLaunchRequest } from '../../node/launchRequest.js';

suite('VShoon Launch Request', () => {

	test('reports no target for a bare launch', () => {
		assert.deepStrictEqual(toVShoonLaunchRequest({ _: [] }), {
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
		});
	});

	test('maps every argument that takes the launch away from the start window', () => {
		const args: NativeParsedArgs = {
			_: ['project'],
			'disable-start-window': true,
			'open-url': true,
			_urls: ['vshoon://open'],
			goto: true,
			remote: 'ssh-remote+host',
			'profile-temp': true,
			'new-window': true,
			extensionDevelopmentPath: ['ext'],
			'enable-smoke-test-driver': true,
			agents: true
		};

		assert.deepStrictEqual(toVShoonLaunchRequest(args), {
			disableStartWindow: true,
			hasExplicitTarget: true,
			hasProtocolUrl: true,
			hasSpecialFileMode: true,
			hasRemoteAuthority: true,
			hasForcedProfile: true,
			forceNewWindow: true,
			extensionDevelopment: true,
			testMode: true,
			agentWindow: true
		});
	});

	test('does not treat an --open-url without urls as a protocol launch', () => {
		assert.deepStrictEqual(toVShoonLaunchRequest({ _: [], 'open-url': true }).hasProtocolUrl, false);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
