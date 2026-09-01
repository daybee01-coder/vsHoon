/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface IVShoonStartWindowGlobals {
	readonly ipcRenderer: {
		send(channel: string, ...args: unknown[]): void;
	};
}

const globals = (window as unknown as { vscode: IVShoonStartWindowGlobals }).vscode;

document.getElementById('continue')?.addEventListener('click', () => {
	globals.ipcRenderer.send('vscode:vshoonStartWindowAction', 'continue');
});

document.getElementById('quit')?.addEventListener('click', () => {
	globals.ipcRenderer.send('vscode:vshoonStartWindowAction', 'quit');
});
