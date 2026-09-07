/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, markAsSingleton } from '../../base/common/lifecycle.js';
import { IJSONSchema } from '../../base/common/jsonSchema.js';
import { localize } from '../../nls.js';
import { VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT, VSHOON_MODAL_WEBVIEW_CAPABILITY_VERSION, VShoonModalWebviewRegistry } from '../common/modalWebviews.js';
import { VSHOON_OS_FILE_DROPS_EXTENSION_POINT, VSHOON_OS_FILE_DROP_CAPABILITY_VERSION, VShoonOsFileDropRegistry } from '../common/osFileDrops.js';
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

const modalWebviewSchema: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['version', 'viewType'],
	properties: {
		version: {
			type: 'number',
			const: VSHOON_MODAL_WEBVIEW_CAPABILITY_VERSION,
			description: localize('vshoon.ui.modalWebviews.version', "VShoon modal webview capability version.")
		},
		viewType: {
			type: 'string',
			maxLength: 100,
			pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
			description: localize('vshoon.ui.modalWebviews.viewType', "Webview panel type to open in a modal editor.")
		},
		size: {
			type: 'object',
			additionalProperties: false,
			required: ['width', 'height'],
			description: localize('vshoon.ui.modalWebviews.size', "Initial modal size, kept separate from other declared modal webviews."),
			properties: {
				width: {
					type: 'integer',
					minimum: 400,
					maximum: 2400
				},
				height: {
					type: 'integer',
					minimum: 300,
					maximum: 1600
				}
			}
		}
	}
};

const osFileDropSchema: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['version', 'viewType'],
	properties: {
		version: {
			type: 'number',
			const: VSHOON_OS_FILE_DROP_CAPABILITY_VERSION,
			description: localize('vshoon.ui.osFileDrops.version', "VShoon OS file drop capability version.")
		},
		viewType: {
			type: 'string',
			maxLength: 100,
			pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
			description: localize('vshoon.ui.osFileDrops.viewType', "Webview view that receives files dropped from the operating system.")
		}
	}
};

export const vshoonUIContributionRegistry = markAsSingleton(new VShoonUIContributionRegistry());
export const vshoonModalWebviewRegistry = markAsSingleton(new VShoonModalWebviewRegistry());
export const vshoonOsFileDropRegistry = markAsSingleton(new VShoonOsFileDropRegistry());
const bridge = markAsSingleton(new VShoonUIContributionBridge(vshoonUIContributionRegistry));
const activeSources = new Set<string>();
const activeModalWebviewSources = new Set<string>();
const activeOsFileDropSources = new Set<string>();

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

	const modalWebviewsExtensionPoint = extensionsRegistry.registerExtensionPoint<unknown[]>({
		extensionPoint: VSHOON_MODAL_WEBVIEWS_EXTENSION_POINT,
		jsonSchema: {
			type: 'array',
			maxItems: 10,
			items: modalWebviewSchema,
			description: localize('vshoon.ui.modalWebviews', "Declares bundled webview panels that VShoon opens in the Workbench modal editor.")
		}
	});

	modalWebviewsExtensionPoint.setHandler(extensions => {
		const nextActiveSources = new Set<string>();
		for (const extension of extensions) {
			const sourceId = extension.description.identifier.value;
			nextActiveSources.add(sourceId);

			if (!extension.description.isBuiltin) {
				extension.collector.error(localize('vshoon.ui.modalWebviews.permissionRequired', "VShoon modal webviews are currently available only to bundled extensions."));
				vshoonModalWebviewRegistry.removeSource(sourceId);
				continue;
			}

			const result = vshoonModalWebviewRegistry.update({ id: sourceId, builtin: true }, extension.value);
			for (const error of result.errors) {
				extension.collector.error(error);
			}
		}

		for (const sourceId of activeModalWebviewSources) {
			if (!nextActiveSources.has(sourceId)) {
				vshoonModalWebviewRegistry.removeSource(sourceId);
			}
		}
		activeModalWebviewSources.clear();
		for (const sourceId of nextActiveSources) {
			activeModalWebviewSources.add(sourceId);
		}
	});

	const osFileDropsExtensionPoint = extensionsRegistry.registerExtensionPoint<unknown[]>({
		extensionPoint: VSHOON_OS_FILE_DROPS_EXTENSION_POINT,
		jsonSchema: {
			type: 'array',
			maxItems: 10,
			items: osFileDropSchema,
			description: localize('vshoon.ui.osFileDrops', "Declares bundled webview views that receive files dropped from the operating system.")
		}
	});

	osFileDropsExtensionPoint.setHandler(extensions => {
		const nextActiveSources = new Set<string>();
		for (const extension of extensions) {
			const sourceId = extension.description.identifier.value;
			nextActiveSources.add(sourceId);

			if (!extension.description.isBuiltin) {
				extension.collector.error(localize('vshoon.ui.osFileDrops.permissionRequired', "VShoon OS file drops are currently available only to bundled extensions."));
				vshoonOsFileDropRegistry.removeSource(sourceId);
				continue;
			}

			const result = vshoonOsFileDropRegistry.update({ id: sourceId, builtin: true }, extension.value);
			for (const error of result.errors) {
				extension.collector.error(error);
			}
		}

		for (const sourceId of activeOsFileDropSources) {
			if (!nextActiveSources.has(sourceId)) {
				vshoonOsFileDropRegistry.removeSource(sourceId);
			}
		}
		activeOsFileDropSources.clear();
		for (const sourceId of nextActiveSources) {
			activeOsFileDropSources.add(sourceId);
		}
	});
}
