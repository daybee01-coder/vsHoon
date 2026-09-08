/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeHostMainService } from '../../platform/native/electron-main/nativeHostMainService.js';
import { IOpenEmptyWindowOptions, IOpenWindowOptions, IWindowOpenable } from '../../platform/window/common/window.js';
import { ILogService } from '../../platform/log/common/log.js';
import { evaluateVShoonNewWindow } from '../common/startWindowPolicy.js';
import { IVShoonStartWindowMainService } from './startWindowMainService.js';

/**
 * Intercepts the one empty-window request that the Workbench marks as a request for VShoon's
 * project chooser. Every other native-host method and open request remains owned by upstream.
 */
export function wrapVShoonNativeHostMainService(
	nativeHostMainService: INativeHostMainService,
	startWindowMainService: IVShoonStartWindowMainService,
	isStartWindowEnabled: () => boolean,
	logService: ILogService
): INativeHostMainService {
	const openEmptyWindow = nativeHostMainService.openWindow.bind(nativeHostMainService) as (windowId: number | undefined, options?: IOpenEmptyWindowOptions) => Promise<void>;
	const openWindow = async (
		windowId: number | undefined,
		arg1?: IOpenEmptyWindowOptions | IWindowOpenable[],
		arg2?: IOpenWindowOptions
	): Promise<void> => {
		const decision = evaluateVShoonNewWindow(!Array.isArray(arg1) && arg1?.vshoonStartWindow === true, isStartWindowEnabled());
		logService.trace('vshoon#newWindowDecision', decision);
		if (decision.show) {
			if (await startWindowMainService.show({ quitWhenClosed: false })) {
				return;
			}
		}

		if (Array.isArray(arg1)) {
			return nativeHostMainService.openWindow(windowId, arg1, arg2);
		}

		return openEmptyWindow(windowId, arg1);
	};

	return new Proxy(nativeHostMainService, {
		get: (target, property, receiver) => {
			if (property === 'openWindow') {
				return openWindow;
			}

			const value = Reflect.get(target, property, receiver);

			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}
