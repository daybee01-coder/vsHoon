/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';

export const VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT = 'vshoon.ui.modalWebviews';
export const VSHOON_MODAL_WEBVIEW_CAPABILITY_VERSION = 1;

export interface IVShoonModalWebviewSource {
	readonly id: string;
	readonly builtin: boolean;
}

export interface IVShoonModalWebviewContribution {
	readonly version: typeof VSHOON_MODAL_WEBVIEW_CAPABILITY_VERSION;
	readonly viewType: string;
	readonly size?: IVShoonModalWebviewSize;
}

export interface IVShoonModalWebviewSize {
	readonly width: number;
	readonly height: number;
}

export interface IVShoonModalWebviewLayout {
	readonly size: IVShoonModalWebviewSize | undefined;
	readonly position: { readonly left: number; readonly top: number } | undefined;
	readonly maximized: boolean;
}

/** Session-only snapshots keyed by extension and panel type, never persisted to storage. */
export class VShoonModalWebviewLayouts {
	private readonly layouts = new Map<string, IVShoonModalWebviewLayout>();

	get(source: string, viewType: string): IVShoonModalWebviewLayout | undefined {
		const layout = this.layouts.get(JSON.stringify([source.toLowerCase(), viewType]));
		return layout ? this.copy(layout) : undefined;
	}

	set(source: string, viewType: string, layout: IVShoonModalWebviewLayout): void {
		this.layouts.set(JSON.stringify([source.toLowerCase(), viewType]), this.copy(layout));
	}

	private copy(layout: IVShoonModalWebviewLayout): IVShoonModalWebviewLayout {
		return { size: layout.size ? { ...layout.size } : undefined, position: layout.position ? { ...layout.position } : undefined, maximized: layout.maximized };
	}
}

export interface IVShoonModalWebviewUpdateResult {
	readonly accepted: number;
	readonly errors: readonly string[];
}

const identifierPattern = /^[a-z0-9][a-z0-9._-]*$/i;
const maximumModalWebviewsPerSource = 10;
const minimumModalWidth = 400;
const maximumModalWidth = 2400;
const minimumModalHeight = 300;
const maximumModalHeight = 1600;

/**
 * Stores the webview types that bundled extensions may open in the Workbench modal editor.
 * The registry retains identifiers only: extensions never receive renderer or DOM access.
 */
export class VShoonModalWebviewRegistry extends Disposable {

	private readonly contributions = new Map<string, ReadonlyMap<string, IVShoonModalWebviewContribution>>();

	override dispose(): void {
		this.contributions.clear();
		super.dispose();
	}

	update(source: IVShoonModalWebviewSource, rawContributions: unknown): IVShoonModalWebviewUpdateResult {
		if (!source.builtin) {
			return { accepted: 0, errors: [`Extension '${source.id}' is not authorized for modal webviews.`] };
		}
		if (!this.isIdentifier(source.id, 100)) {
			return { accepted: 0, errors: ['VShoon modal webview source id is invalid.'] };
		}
		if (!Array.isArray(rawContributions)) {
			return { accepted: 0, errors: ['VShoon modal webview contributions must be an array.'] };
		}
		if (rawContributions.length > maximumModalWebviewsPerSource) {
			return { accepted: 0, errors: [`VShoon modal webview contributions are limited to ${maximumModalWebviewsPerSource} per extension.`] };
		}

		const viewTypes = new Map<string, IVShoonModalWebviewContribution>();
		const errors: string[] = [];
		for (let index = 0; index < rawContributions.length; index++) {
			const rawContribution = rawContributions[index];
			if (!this.isRecord(rawContribution)) {
				errors.push(`VShoon modal webview contribution at index ${index} must be an object.`);
				continue;
			}

			const allowedProperties = new Set(['version', 'viewType', 'size']);
			const unexpectedProperty = Object.keys(rawContribution).find(property => !allowedProperties.has(property));
			if (unexpectedProperty) {
				errors.push(`VShoon modal webview contribution at index ${index} has unsupported property '${unexpectedProperty}'.`);
				continue;
			}
			if (rawContribution.version !== VSHOON_MODAL_WEBVIEW_CAPABILITY_VERSION || typeof rawContribution.viewType !== 'string' || !this.isIdentifier(rawContribution.viewType, 100)) {
				errors.push(`VShoon modal webview contribution at index ${index} has an invalid version or view type.`);
				continue;
			}
			if (viewTypes.has(rawContribution.viewType)) {
				errors.push(`Duplicate VShoon modal webview '${rawContribution.viewType}' from '${source.id}'.`);
				continue;
			}
			if (rawContribution.size !== undefined && !this.isSize(rawContribution.size)) {
				errors.push(`VShoon modal webview contribution at index ${index} has an invalid size.`);
				continue;
			}

			const size = rawContribution.size ? Object.freeze({
				width: rawContribution.size.width,
				height: rawContribution.size.height
			}) : undefined;
			viewTypes.set(rawContribution.viewType, Object.freeze({
				version: VSHOON_MODAL_WEBVIEW_CAPABILITY_VERSION,
				viewType: rawContribution.viewType,
				size
			}));
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

	isModalWebview(sourceId: string, viewType: string): boolean {
		return this.getModalWebview(sourceId, viewType) !== undefined;
	}

	getModalWebview(sourceId: string, viewType: string): IVShoonModalWebviewContribution | undefined {
		return this.contributions.get(sourceId.toLowerCase())?.get(viewType);
	}

	private isIdentifier(value: string, maximumLength: number): boolean {
		return value.length > 0 && value.length <= maximumLength && identifierPattern.test(value);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	private isSize(value: unknown): value is IVShoonModalWebviewSize {
		if (!this.isRecord(value) || Object.keys(value).some(property => property !== 'width' && property !== 'height')) {
			return false;
		}

		return typeof value.width === 'number' && Number.isInteger(value.width) && value.width >= minimumModalWidth && value.width <= maximumModalWidth
			&& typeof value.height === 'number' && Number.isInteger(value.height) && value.height >= minimumModalHeight && value.height <= maximumModalHeight;
	}
}
