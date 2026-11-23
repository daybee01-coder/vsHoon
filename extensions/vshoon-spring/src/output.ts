/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const output = vscode.window.createOutputChannel('Spring', { log: true });

export function log(message: string): void {
	output.info(message);
}
