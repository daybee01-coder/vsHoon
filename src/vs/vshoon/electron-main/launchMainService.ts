/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment } from '../../base/common/platform.js';
import { NativeParsedArgs } from '../../platform/environment/common/argv.js';
import { ILaunchMainService } from '../../platform/launch/electron-main/launchMainService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { evaluateVShoonSecondInstance } from '../common/startWindowPolicy.js';
import { toVShoonLaunchRequest } from '../node/launchRequest.js';
import { IVShoonStartWindowMainService } from './startWindowMainService.js';

/**
 * Wraps the upstream launch service on the channel that second instances talk to.
 *
 * While the start window owns the launch there is no workbench window yet, so upstream would
 * answer a target-less second instance by creating an empty workbench window next to the start
 * window. VShoon focuses the start window instead and only steps aside for requests that carry
 * a real target.
 */
export class VShoonLaunchMainService implements ILaunchMainService {

	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly launchMainService: ILaunchMainService,
		private readonly startWindowMainService: IVShoonStartWindowMainService,
		private readonly logService: ILogService
	) { }

	async start(args: NativeParsedArgs, userEnv: IProcessEnvironment): Promise<void> {
		const decision = evaluateVShoonSecondInstance({
			...toVShoonLaunchRequest(args),
			startWindowOwnsLaunch: this.startWindowMainService.ownsLaunch
		});

		this.logService.trace('vshoon#secondInstanceDecision', decision);

		if (decision.focusStartWindow) {
			this.startWindowMainService.focus();

			return;
		}

		// Upstream is about to open a workbench window for this request, so the start window
		// steps down first. This must not wait for `start()`, which only settles once the
		// opened window closes when the request carries `--wait`.
		if (decision.reason !== 'noStartWindow') {
			this.startWindowMainService.supersede();
		}

		return this.launchMainService.start(args, userEnv);
	}

	getMainProcessId(): Promise<number> {
		return this.launchMainService.getMainProcessId();
	}
}
