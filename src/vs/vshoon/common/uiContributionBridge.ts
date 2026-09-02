/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { IVShoonUIContributionRegistry, IVShoonUIContributionSource, IVShoonWorkbenchHeaderCommandContribution, VShoonUICapability, VShoonUIContributionRegistry, VSHOON_UI_CAPABILITY_VERSION } from './uiContributions.js';

export const VSHOON_HEADER_COMMANDS_EXTENSION_POINT = 'vshoon.ui.headerCommands';

export interface IVShoonUIExtensionSource {
	readonly id: string;
	readonly builtin: boolean;
	readonly allowedCapabilities?: readonly VShoonUICapability[];
}

export interface IVShoonUIContributionBridgeResult {
	readonly accepted: number;
	readonly errors: readonly string[];
}

export class VShoonUIContributionBridge extends Disposable {

	private readonly sourceRegistrations = new Map<string, DisposableStore>();

	constructor(private readonly registry: IVShoonUIContributionRegistry) {
		super();
	}

	updateHeaderCommands(source: IVShoonUIExtensionSource, rawContributions: unknown): IVShoonUIContributionBridgeResult {
		if (!this.isAuthorized(source, VShoonUICapability.WorkbenchHeaderCommand)) {
			return { accepted: 0, errors: [`Extension '${source.id}' is not authorized for '${VShoonUICapability.WorkbenchHeaderCommand}'.`] };
		}

		const parsed = this.parseHeaderCommands(rawContributions);
		if (parsed.errors.length > 0) {
			return { accepted: 0, errors: parsed.errors };
		}

		const registrySource: IVShoonUIContributionSource = {
			id: source.id,
			kind: source.builtin ? 'builtinExtension' : 'extension',
			trusted: true
		};
		const validation = this.validateAsGroup(registrySource, parsed.contributions);
		if (validation.length > 0) {
			return { accepted: 0, errors: validation };
		}

		const previousEntries = this.registry.getContributions(VShoonUICapability.WorkbenchHeaderCommand)
			.filter(candidate => candidate.source.id === source.id);
		this.sourceRegistrations.get(source.id)?.dispose();

		const nextRegistrations = new DisposableStore();
		try {
			for (const contribution of parsed.contributions) {
				nextRegistrations.add(this.registry.register(registrySource, contribution));
			}
		} catch (error) {
			nextRegistrations.dispose();
			this.restorePrevious(source.id, previousEntries);
			return { accepted: 0, errors: [error instanceof Error ? error.message : String(error)] };
		}

		this.sourceRegistrations.set(source.id, nextRegistrations);
		return { accepted: parsed.contributions.length, errors: [] };
	}

	removeSource(sourceId: string): void {
		this.sourceRegistrations.get(sourceId)?.dispose();
		this.sourceRegistrations.delete(sourceId);
	}

	override dispose(): void {
		for (const registrations of this.sourceRegistrations.values()) {
			registrations.dispose();
		}
		this.sourceRegistrations.clear();
		super.dispose();
	}

	private isAuthorized(source: IVShoonUIExtensionSource, capability: VShoonUICapability): boolean {
		return source.builtin || source.allowedCapabilities?.includes(capability) === true;
	}

	private parseHeaderCommands(rawContributions: unknown): { contributions: IVShoonWorkbenchHeaderCommandContribution[]; errors: string[] } {
		if (!Array.isArray(rawContributions)) {
			return { contributions: [], errors: ['VShoon header command contributions must be an array.'] };
		}
		if (rawContributions.length > 10) {
			return { contributions: [], errors: ['VShoon header command contributions are limited to 10 per extension.'] };
		}

		const contributions: IVShoonWorkbenchHeaderCommandContribution[] = [];
		const errors: string[] = [];
		for (let index = 0; index < rawContributions.length; index++) {
			const rawContribution = rawContributions[index];
			if (!this.isRecord(rawContribution)) {
				errors.push(`VShoon header command contribution at index ${index} must be an object.`);
				continue;
			}

			const allowedProperties = new Set(['version', 'id', 'command', 'title', 'tooltip', 'order']);
			const unexpectedProperty = Object.keys(rawContribution).find(property => !allowedProperties.has(property));
			if (unexpectedProperty) {
				errors.push(`VShoon header command contribution at index ${index} has unsupported property '${unexpectedProperty}'.`);
				continue;
			}
			if (rawContribution.version !== VSHOON_UI_CAPABILITY_VERSION || typeof rawContribution.id !== 'string' || typeof rawContribution.command !== 'string' || typeof rawContribution.title !== 'string') {
				errors.push(`VShoon header command contribution at index ${index} is missing a valid version, id, command, or title.`);
				continue;
			}
			if (rawContribution.tooltip !== undefined && typeof rawContribution.tooltip !== 'string') {
				errors.push(`VShoon header command contribution at index ${index} has an invalid tooltip.`);
				continue;
			}
			if (rawContribution.order !== undefined && typeof rawContribution.order !== 'number') {
				errors.push(`VShoon header command contribution at index ${index} has an invalid order.`);
				continue;
			}

			contributions.push({
				capability: VShoonUICapability.WorkbenchHeaderCommand,
				version: VSHOON_UI_CAPABILITY_VERSION,
				id: rawContribution.id,
				command: rawContribution.command,
				title: rawContribution.title,
				tooltip: rawContribution.tooltip,
				order: rawContribution.order
			});
		}

		return { contributions, errors };
	}

	private validateAsGroup(source: IVShoonUIContributionSource, contributions: readonly IVShoonWorkbenchHeaderCommandContribution[]): string[] {
		const disposables = new DisposableStore();
		const validationRegistry = disposables.add(new VShoonUIContributionRegistry());
		try {
			for (const contribution of contributions) {
				disposables.add(validationRegistry.register(source, contribution));
			}
			return [];
		} catch (error) {
			return [error instanceof Error ? error.message : String(error)];
		} finally {
			disposables.dispose();
		}
	}

	private restorePrevious(sourceId: string, previousEntries: readonly { readonly source: IVShoonUIContributionSource; readonly contribution: IVShoonWorkbenchHeaderCommandContribution }[]): void {
		const restoredRegistrations = new DisposableStore();
		for (const previous of previousEntries) {
			restoredRegistrations.add(this.registry.register(previous.source, previous.contribution));
		}
		this.sourceRegistrations.set(sourceId, restoredRegistrations);
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}
}
