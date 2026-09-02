/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The subset of a launch request that decides whether VShoon may own it.
 * Both the initial startup and a second instance are described by these flags.
 */
export interface IVShoonLaunchRequest {
	readonly disableStartWindow: boolean;
	readonly hasExplicitTarget: boolean;
	readonly hasProtocolUrl: boolean;
	readonly hasSpecialFileMode: boolean;
	readonly hasRemoteAuthority: boolean;
	readonly hasForcedProfile: boolean;
	readonly forceNewWindow: boolean;
	readonly extensionDevelopment: boolean;
	readonly testMode: boolean;
	readonly agentWindow: boolean;
}

export interface IVShoonStartWindowLaunchContext extends IVShoonLaunchRequest {
	readonly enabled: boolean;
	readonly initialStartup: boolean;
	readonly desktopLaunch: boolean;
}

export interface IVShoonSecondInstanceContext extends IVShoonLaunchRequest {

	/** Whether the start window currently owns the launch of the running instance. */
	readonly startWindowOwnsLaunch: boolean;
}

export type VShoonStartWindowBypassReason =
	| 'disabled'
	| 'disabledByCli'
	| 'notInitialStartup'
	| 'notDesktopLaunch'
	| 'explicitTarget'
	| 'protocolUrl'
	| 'specialFileMode'
	| 'remoteAuthority'
	| 'forcedProfile'
	| 'forcedNewWindow'
	| 'extensionDevelopment'
	| 'testMode'
	| 'agentWindow';

export type VShoonSecondInstanceBypassReason = 'noStartWindow' | VShoonStartWindowBypassReason;

export type VShoonStartWindowDecision =
	| { readonly show: true }
	| { readonly show: false; readonly reason: VShoonStartWindowBypassReason };

export type VShoonSecondInstanceDecision =
	| { readonly focusStartWindow: true }
	| { readonly focusStartWindow: false; readonly reason: VShoonSecondInstanceBypassReason };

/**
 * Finds the first condition that forces a launch request onto the upstream path.
 * The order is part of the contract so that logs and tests stay stable.
 */
function findBypassReason(request: IVShoonLaunchRequest): VShoonStartWindowBypassReason | undefined {
	if (request.disableStartWindow) {
		return 'disabledByCli';
	}

	if (request.hasExplicitTarget) {
		return 'explicitTarget';
	}

	if (request.hasProtocolUrl) {
		return 'protocolUrl';
	}

	if (request.hasSpecialFileMode) {
		return 'specialFileMode';
	}

	if (request.hasRemoteAuthority) {
		return 'remoteAuthority';
	}

	if (request.hasForcedProfile) {
		return 'forcedProfile';
	}

	if (request.forceNewWindow) {
		return 'forcedNewWindow';
	}

	if (request.extensionDevelopment) {
		return 'extensionDevelopment';
	}

	if (request.testMode) {
		return 'testMode';
	}

	if (request.agentWindow) {
		return 'agentWindow';
	}

	return undefined;
}

export const VSHOON_START_WINDOW_ENABLED_SETTING = 'vshoon.startWindow.enabled';

/**
 * Evaluates whether the compact start window should own the initial launch.
 * The caller is responsible for translating product configuration and CLI arguments.
 */
export function evaluateVShoonStartWindow(context: IVShoonStartWindowLaunchContext): VShoonStartWindowDecision {
	if (!context.enabled) {
		return { show: false, reason: 'disabled' };
	}

	if (!context.initialStartup) {
		return { show: false, reason: 'notInitialStartup' };
	}

	if (!context.desktopLaunch) {
		return { show: false, reason: 'notDesktopLaunch' };
	}

	const reason = findBypassReason(context);

	return reason ? { show: false, reason } : { show: true };
}

/**
 * Evaluates what a second instance should do while the start window owns the running
 * instance. A request that carries no target is answered by focusing the start window
 * instead of letting upstream create an empty workbench window next to it.
 */
export function evaluateVShoonSecondInstance(context: IVShoonSecondInstanceContext): VShoonSecondInstanceDecision {
	if (!context.startWindowOwnsLaunch) {
		return { focusStartWindow: false, reason: 'noStartWindow' };
	}

	const reason = findBypassReason(context);

	return reason ? { focusStartWindow: false, reason } : { focusStartWindow: true };
}
