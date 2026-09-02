/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, markAsSingleton } from '../../base/common/lifecycle.js';
import { IJSONSchema } from '../../base/common/jsonSchema.js';
import { localize } from '../../nls.js';
import { VSHOON_HEADER_COMMANDS_EXTENSION_POINT, VShoonUIContributionBridge } from '../common/uiContributionBridge.js';
import { VShoonUIContributionRegistry, VSHOON_UI_CAPABILITY_VERSION } from '../common/uiContributions.js';

export interface IVShoonExtensionPointUser<T> {
	readonly description: {
		readonly identifier: { readonly value: string };
		readonly isBuiltin: boolean;
	};
	readonly value: T;
	readonly collector: { error(message: string): void };
}

export interface IVShoonExtensionPoint<T> {
	setHandler(handler: (extensions: readonly IVShoonExtensionPointUser<T>[]) => void): IDisposable;
}

export interface IVShoonExtensionsRegistry {
	registerExtensionPoint<T>(descriptor: { readonly extensionPoint: string; readonly jsonSchema: IJSONSchema }): IVShoonExtensionPoint<T>;
}

const headerCommandSchema: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['version', 'id', 'command', 'title'],
	properties: {
		version: {
			type: 'number',
			const: VSHOON_UI_CAPABILITY_VERSION,
			description: localize('vshoon.ui.headerCommands.version', "VShoon header command capability version.")
		},
		id: {
			type: 'string',
			maxLength: 100,
			pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
			description: localize('vshoon.ui.headerCommands.id', "Identifier unique within this extension.")
		},
		command: {
			type: 'string',
			maxLength: 100,
			pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
			description: localize('vshoon.ui.headerCommands.command', "Command to run when the header action is selected.")
		},
		title: {
			type: 'string',
			minLength: 1,
			maxLength: 80,
			description: localize('vshoon.ui.headerCommands.title', "Localized accessible title of the header action.")
		},
		tooltip: {
			type: 'string',
			minLength: 1,
			maxLength: 160,
			description: localize('vshoon.ui.headerCommands.tooltip', "Optional localized tooltip for the header action.")
		},
		order: {
			type: 'integer',
			minimum: -1000,
			maximum: 1000,
			description: localize('vshoon.ui.headerCommands.order', "Relative ordering hint within the VShoon-owned header slot.")
		}
	}
};

export const vshoonUIContributionRegistry = markAsSingleton(new VShoonUIContributionRegistry());
const bridge = markAsSingleton(new VShoonUIContributionBridge(vshoonUIContributionRegistry));
const activeSources = new Set<string>();

export function registerVShoonUIExtensionPoint(extensionsRegistry: IVShoonExtensionsRegistry): void {
	const headerCommandsExtensionPoint = extensionsRegistry.registerExtensionPoint<unknown[]>({
		extensionPoint: VSHOON_HEADER_COMMANDS_EXTENSION_POINT,
		jsonSchema: {
			type: 'array',
			maxItems: 10,
			items: headerCommandSchema,
			description: localize('vshoon.ui.headerCommands', "Contributes command actions to the VShoon-owned workbench header slot.")
		}
	});

	headerCommandsExtensionPoint.setHandler(extensions => {
		const nextActiveSources = new Set<string>();
		for (const extension of extensions) {
			const sourceId = extension.description.identifier.value;
			nextActiveSources.add(sourceId);

			if (!extension.description.isBuiltin) {
				extension.collector.error(localize('vshoon.ui.headerCommands.permissionRequired', "VShoon header commands are currently available only to bundled extensions."));
				bridge.removeSource(sourceId);
				continue;
			}

			const result = bridge.updateHeaderCommands({ id: sourceId, builtin: true }, extension.value);
			for (const error of result.errors) {
				extension.collector.error(error);
			}
		}

		for (const sourceId of activeSources) {
			if (!nextActiveSources.has(sourceId)) {
				bridge.removeSource(sourceId);
			}
		}
		activeSources.clear();
		for (const sourceId of nextActiveSources) {
			activeSources.add(sourceId);
		}
	});
}
