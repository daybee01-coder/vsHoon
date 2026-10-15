/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../base/common/network.js';

export interface IVShoonFileDialogRequest {
	readonly availableFileSystems?: readonly string[];
	readonly defaultUri?: { readonly scheme: string };
	readonly canSelectMany?: boolean;
}

/**
 * VShoon's tree dialog currently owns local, single-selection requests. Extension-host dialog
 * requests use an empty available-file-systems array, so their resolved scheme must come from the
 * default URI (or the window) instead of treating the empty array as a non-local request.
 */
export function shouldUseVShoonFileDialog(options: IVShoonFileDialogRequest, windowScheme: string): boolean {
	if (options.canSelectMany) {
		return false;
	}

	const availableFileSystems = options.availableFileSystems;
	if (availableFileSystems?.length) {
		return availableFileSystems.length === 1 && availableFileSystems[0] === Schemas.file;
	}

	return (options.defaultUri?.scheme ?? windowScheme) === Schemas.file;
}
