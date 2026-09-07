/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';

export const VSHOON_OS_FILE_DROPS_EXTENSION_POINT = 'vshoon.ui.osFileDrops';
export const VSHOON_OS_FILE_DROP_CAPABILITY_VERSION = 1;

/**
 * Message type the Workbench posts into a declared webview view when files from the operating
 * system are dropped on it. Namespaced because it arrives on the same channel the extension uses
 * for its own messages.
 */
export const VSHOON_OS_FILE_DROP_MESSAGE = 'vshoon.osFileDrop';

export interface IVShoonOsFileDropSource {
	readonly id: string;
	readonly builtin: boolean;
}

export interface IVShoonOsFileDropContribution {
	readonly version: typeof VSHOON_OS_FILE_DROP_CAPABILITY_VERSION;
	readonly viewType: string;
}

export interface IVShoonOsFileDropUpdateResult {
	readonly accepted: number;
	readonly errors: readonly string[];
}

/**
 * What a declared webview view receives for one drop.
 *
 * Paths are resolved by the Workbench from the drop itself, never taken from the extension, and
 * the position is relative to the view's own container so the view can tell which half of a
 * two-pane layout was targeted.
 */
export interface IVShoonOsFileDropPayload {
	readonly type: typeof VSHOON_OS_FILE_DROP_MESSAGE;
	readonly viewType: string;
	readonly paths: readonly string[];
	readonly position: { readonly x: number; readonly y: number };
}

const identifierPattern = /^[a-z0-9][a-z0-9._-]*$/i;
const maximumOsFileDropViewsPerSource = 10;

/**
 * Stores the webview views that bundled extensions may receive operating system file drops in.
 *
 * Upstream hands every such drop to the Workbench rather than to the webview, because a webview
 * cannot resolve a dropped file to a path. The registry records which views asked to be told
 * about those drops; it retains identifiers only, and extensions never gain renderer or DOM
 * access through it.
 */
export class VShoonOsFileDropRegistry extends Disposable {

	private readonly contributions = new Map<string, ReadonlySet<string>>();

	override dispose(): void {
		this.contributions.clear();
		super.dispose();
	}

	update(source: IVShoonOsFileDropSource, rawContributions: unknown): IVShoonOsFileDropUpdateResult {
		if (!source.builtin) {
			return { accepted: 0, errors: [`Extension '${source.id}' is not authorized for OS file drops.`] };
		}
		if (!this.isIdentifier(source.id, 100)) {
			return { accepted: 0, errors: ['VShoon OS file drop source id is invalid.'] };
		}
		if (!Array.isArray(rawContributions)) {
			return { accepted: 0, errors: ['VShoon OS file drop contributions must be an array.'] };
		}
		if (rawContributions.length > maximumOsFileDropViewsPerSource) {
			return { accepted: 0, errors: [`VShoon OS file drop contributions are limited to ${maximumOsFileDropViewsPerSource} per extension.`] };
		}

		const viewTypes = new Set<string>();
		const errors: string[] = [];
		for (let index = 0; index < rawContributions.length; index++) {
			const rawContribution = rawContributions[index];
			if (!this.isRecord(rawContribution)) {
				errors.push(`VShoon OS file drop contribution at index ${index} must be an object.`);
				continue;
			}

			const allowedProperties = new Set(['version', 'viewType']);
			const unexpectedProperty = Object.keys(rawContribution).find(property => !allowedProperties.has(property));
			if (unexpectedProperty) {
				errors.push(`VShoon OS file drop contribution at index ${index} has unsupported property '${unexpectedProperty}'.`);
				continue;
			}
			if (rawContribution.version !== VSHOON_OS_FILE_DROP_CAPABILITY_VERSION || typeof rawContribution.viewType !== 'string' || !this.isIdentifier(rawContribution.viewType, 100)) {
				errors.push(`VShoon OS file drop contribution at index ${index} has an invalid version or view type.`);
				continue;
			}
			if (viewTypes.has(rawContribution.viewType)) {
				errors.push(`Duplicate VShoon OS file drop view '${rawContribution.viewType}' from '${source.id}'.`);
				continue;
			}

			viewTypes.add(rawContribution.viewType);
		}

		if (errors.length > 0) {
			return { accepted: 0, errors };
		}

		this.contributions.set(source.id.toLowerCase(), viewTypes);
		return { accepted: viewTypes.size, errors: [] };
	}

	removeSource(sourceId: string): void {
		this.contributions.delete(sourceId.toLowerCase());
	}

	isOsFileDropView(sourceId: string, viewType: string): boolean {
		return this.contributions.get(sourceId.toLowerCase())?.has(viewType) === true;
	}

	private isIdentifier(value: string, maximumLength: number): boolean {
		return value.length > 0 && value.length <= maximumLength && identifierPattern.test(value);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}
}

/**
 * Message type a declared webview view sends when it wants the operating system to take over a
 * drag of local files it has already produced.
 */
export const VSHOON_OS_FILE_DRAG_MESSAGE = 'vshoon.osFileDrag';

const maximumDraggedPaths = 100;

/**
 * Reads a native drag request out of a webview message.
 *
 * Returns the paths only when the message is one, so the caller cannot mistake ordinary extension
 * traffic for a drag. Whether the paths exist is the operating system's problem, not this check's.
 */
export function readOsFileDragRequest(message: unknown): string[] | undefined {
	if (typeof message !== 'object' || message === null || Array.isArray(message)) {
		return undefined;
	}

	const candidate = message as { type?: unknown; paths?: unknown };
	if (candidate.type !== VSHOON_OS_FILE_DRAG_MESSAGE || !Array.isArray(candidate.paths)) {
		return undefined;
	}
	if (candidate.paths.length === 0 || candidate.paths.length > maximumDraggedPaths) {
		return undefined;
	}
	if (candidate.paths.some(path => typeof path !== 'string' || path.length === 0)) {
		return undefined;
	}

	return candidate.paths as string[];
}

/** Starts a native drag. Implemented only where the platform API lives, which is not the browser layer. */
export interface IVShoonOsFileDragHandler {
	start(paths: readonly string[]): void;
}

/**
 * Lets the Workbench seam ask for a native drag without importing a native service.
 *
 * The seam runs in the browser layer, and the only API that can start an operating system drag is
 * an Electron one. The desktop layer installs the handler; until it does, a drag request is simply
 * ignored, which is what a web build should do.
 */
class VShoonOsFileDragDelegate {

	private handler: IVShoonOsFileDragHandler | undefined;

	setHandler(handler: IVShoonOsFileDragHandler | undefined): void {
		this.handler = handler;
	}

	start(paths: readonly string[]): void {
		this.handler?.start(paths);
	}
}

export const vshoonOsFileDragDelegate = new VShoonOsFileDragDelegate();
