/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../base/common/lifecycle.js';

export const enum VShoonUICapability {
	WorkbenchHeaderCommand = 'workbench.header.command'
}

export const VSHOON_UI_CAPABILITY_VERSION = 1;

export type VShoonUIContributionSourceKind = 'product' | 'builtinExtension' | 'extension';

export interface IVShoonUIContributionSource {
	readonly id: string;
	readonly kind: VShoonUIContributionSourceKind;
	/**
	 * The bridge sets this only after it has established that the source may use
	 * the requested capability. Workspace trust by itself is not sufficient.
	 */
	readonly trusted: boolean;
}

export interface IVShoonWorkbenchHeaderCommandContribution {
	readonly capability: VShoonUICapability.WorkbenchHeaderCommand;
	readonly version: typeof VSHOON_UI_CAPABILITY_VERSION;
	readonly id: string;
	readonly command: string;
	readonly title: string;
	readonly tooltip?: string;
	readonly order?: number;
}

export interface IVShoonRegisteredUIContribution {
	readonly source: IVShoonUIContributionSource;
	readonly contribution: IVShoonWorkbenchHeaderCommandContribution;
}

export interface IVShoonUIContributionsChangeEvent {
	readonly added: readonly IVShoonRegisteredUIContribution[];
	readonly removed: readonly IVShoonRegisteredUIContribution[];
}

export interface IVShoonUIContributionRegistry {
	readonly onDidChange: Event<IVShoonUIContributionsChangeEvent>;

	supports(capability: VShoonUICapability, version: number): boolean;
	register(source: IVShoonUIContributionSource, contribution: IVShoonWorkbenchHeaderCommandContribution): IDisposable;
	getContributions(capability: VShoonUICapability): readonly IVShoonRegisteredUIContribution[];
}

const identifierPattern = /^[a-z0-9][a-z0-9._-]*$/i;
const maximumContributionsPerSource = 10;

export class VShoonUIContributionRegistry extends Disposable implements IVShoonUIContributionRegistry {

	private readonly contributions = new Map<string, IVShoonRegisteredUIContribution>();
	private isDisposed = false;

	private readonly _onDidChange = this._register(new Emitter<IVShoonUIContributionsChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	supports(capability: VShoonUICapability, version: number): boolean {
		return capability === VShoonUICapability.WorkbenchHeaderCommand && version === VSHOON_UI_CAPABILITY_VERSION;
	}

	register(source: IVShoonUIContributionSource, contribution: IVShoonWorkbenchHeaderCommandContribution): IDisposable {
		if (this.isDisposed) {
			throw new Error('The VShoon UI contribution registry has been disposed.');
		}

		const normalized = this.validateAndNormalize(source, contribution);
		const key = this.toKey(normalized);
		if (this.contributions.has(key)) {
			throw new Error(`Duplicate VShoon UI contribution '${contribution.id}' from '${source.id}'.`);
		}

		const sourceContributionCount = [...this.contributions.values()].filter(candidate => candidate.source.id === source.id).length;
		if (sourceContributionCount >= maximumContributionsPerSource) {
			throw new Error(`VShoon UI contribution source '${source.id}' exceeds the limit of ${maximumContributionsPerSource}.`);
		}

		this.contributions.set(key, normalized);
		this._onDidChange.fire({ added: [normalized], removed: [] });

		return toDisposable(() => {
			if (this.contributions.get(key) !== normalized) {
				return;
			}

			this.contributions.delete(key);
			this._onDidChange.fire({ added: [], removed: [normalized] });
		});
	}

	getContributions(capability: VShoonUICapability): readonly IVShoonRegisteredUIContribution[] {
		return [...this.contributions.values()]
			.filter(candidate => candidate.contribution.capability === capability)
			.sort((left, right) => (left.contribution.order ?? 0) - (right.contribution.order ?? 0) || left.contribution.id.localeCompare(right.contribution.id));
	}

	override dispose(): void {
		this.isDisposed = true;
		this.contributions.clear();
		super.dispose();
	}

	private validateAndNormalize(source: IVShoonUIContributionSource, contribution: IVShoonWorkbenchHeaderCommandContribution): IVShoonRegisteredUIContribution {
		this.validateIdentifier('source id', source.id, 100);
		if (source.kind !== 'product' && source.kind !== 'builtinExtension' && source.kind !== 'extension') {
			throw new Error(`Unsupported VShoon UI contribution source kind '${source.kind}'.`);
		}
		if (!source.trusted) {
			throw new Error(`VShoon UI contribution source '${source.id}' is not authorized.`);
		}
		if (!this.supports(contribution.capability, contribution.version)) {
			throw new Error(`Unsupported VShoon UI capability '${contribution.capability}' version '${contribution.version}'.`);
		}

		this.validateIdentifier('contribution id', contribution.id, 100);
		this.validateIdentifier('command id', contribution.command, 100);
		const title = this.validateText('title', contribution.title, 80);
		const tooltip = contribution.tooltip === undefined ? undefined : this.validateText('tooltip', contribution.tooltip, 160);
		const order = contribution.order ?? 0;
		if (!Number.isInteger(order) || order < -1000 || order > 1000) {
			throw new Error('VShoon UI contribution order must be an integer between -1000 and 1000.');
		}

		return Object.freeze({
			source: Object.freeze({ ...source }),
			contribution: Object.freeze({ ...contribution, title, tooltip, order })
		});
	}

	private validateIdentifier(label: string, value: string, maximumLength: number): void {
		if (value.length === 0 || value.length > maximumLength || !identifierPattern.test(value)) {
			throw new Error(`VShoon UI contribution ${label} is invalid.`);
		}
	}

	private validateText(label: string, value: string, maximumLength: number): string {
		const normalized = value.trim();
		if (normalized.length === 0 || normalized.length > maximumLength || /[\u0000-\u001F\u007F]/.test(normalized)) {
			throw new Error(`VShoon UI contribution ${label} is invalid.`);
		}

		return normalized;
	}

	private toKey(entry: IVShoonRegisteredUIContribution): string {
		return `${entry.source.id}/${entry.contribution.capability}/${entry.contribution.id}`;
	}
}
