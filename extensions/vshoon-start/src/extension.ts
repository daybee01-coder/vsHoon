/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
	exposeCommandLine(context.environmentVariableCollection);
}

/**
 * Puts the `vshoon` command line launcher on the integrated terminal's `PATH`. A portable
 * install is never registered on the system `PATH`, so without this `vshoon` cannot be found
 * and `code` silently opens whichever VS Code the system `PATH` points to.
 */
function exposeCommandLine(collection: vscode.GlobalEnvironmentVariableCollection): void {
	collection.clear();

	// A remote terminal runs on another machine, where the server provides its own launcher.
	if (vscode.env.remoteName) {
		return;
	}

	// `appRoot` is `<install>/resources/app`; the launchers live in `<install>/bin`.
	// A build run from sources has no `bin` folder, so nothing is added there.
	const binFolder = path.join(vscode.env.appRoot, '..', '..', 'bin');
	if (!existsSync(binFolder)) {
		return;
	}

	collection.description = vscode.l10n.t('Enables the `vshoon` command line in the terminal');
	collection.prepend('PATH', binFolder + path.delimiter);
}
