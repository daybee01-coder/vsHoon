/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NativeParsedArgs } from '../../platform/environment/common/argv.js';
import { IVShoonLaunchRequest } from '../common/startWindowPolicy.js';

/**
 * Translates parsed CLI arguments into the launch-request shape used by the start-window
 * policies. Callers that know about targets outside the argument list, such as macOS open-file
 * events or resolved protocol URLs, merge those in on top of the result.
 */
export function toVShoonLaunchRequest(args: NativeParsedArgs): IVShoonLaunchRequest {
	return {
		hasExplicitTarget: args._.length > 0 || !!args['folder-uri'] || !!args['file-uri'],
		hasProtocolUrl: !!args['open-url'] && !!args._urls?.length,
		hasSpecialFileMode: !!args.diff || !!args.merge || !!args.wait || !!args.goto,
		hasRemoteAuthority: !!args.remote,
		hasForcedProfile: !!args.profile || !!args['profile-temp'],
		forceNewWindow: !!args['new-window'],
		extensionDevelopment: !!args.extensionDevelopmentPath,
		testMode: !!args.extensionTestsPath || !!args['enable-smoke-test-driver'],
		agentWindow: !!args['agents']
	};
}
