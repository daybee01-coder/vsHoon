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
}

export interface IVShoonModalWebviewUpdateResult {
	readonly accepted: number;
	readonly errors: readonly string[];
}

const identifierPattern = /^[a-z0-9][a-z0-9._-]*$/i;
const maximumModalWebviewsPerSource = 10;

/**
 * Stores the webview types that bundled extensions may open in the Workbench modal editor.
 * The registry retains identifiers only: extensions never receive renderer or DOM access.
 */
export class VShoonModalWebviewRegistry extends Disposable {

	private readonly contributions = new Map<string, ReadonlySet<string>>();

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

		const viewTypes = new Set<string>();
		const errors: string[] = [];
		for (let index = 0; index < rawContributions.length; index++) {
			const rawContribution = rawContributions[index];
			if (!this.isRecord(rawContribution)) {
				errors.push(`VShoon modal webview contribution at index ${index} must be an object.`);
				continue;
			}

			const allowedProperties = new Set(['version', 'viewType']);
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

	isModalWebview(sourceId: string, viewType: string): boolean {
		return this.contributions.get(sourceId.toLowerCase())?.has(viewType) === true;
	}

	private isIdentifier(value: string, maximumLength: number): boolean {
		return value.length > 0 && value.length <= maximumLength && identifierPattern.test(value);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}
}
