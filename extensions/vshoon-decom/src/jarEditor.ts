/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { JarFileSystemProvider } from './archiveFileSystem';
import { openJar } from './jarProject';

export const JAR_VIEWER_VIEW_TYPE = 'decom.jarExplorer';

/**
 * Turns opening a JAR from the Explorer into a read-only virtual tree instead of an editor.
 *
 * A custom editor is the only hook VS Code offers for a double-click on a file, but a JAR has
 * nothing to show in an editor group: the archive belongs in the Explorer as ordinary folders.
 * So the panel is closed again and the archive is revealed as a virtual tree.
 */
export class JarEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
	constructor(private readonly provider: JarFileSystemProvider) { }

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => { } };
	}

	resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		panel.webview.options = { enableScripts: false };
		// Disposing while `resolveCustomEditor` is still running strands the upstream `openWith`
		// request, so hand the panel back first and close it on the next turn.
		setTimeout(() => panel.dispose(), 0);
		void openJar(this.provider, document.uri);
	}
}
