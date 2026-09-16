/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MaterializedClass, materializeClass } from './classMaterializer';
import { toClassSourceUri } from './classSourceUri';
import { escapeHtml } from './highlight';

export { MaterializedClass, materializeClass };

export const CLASS_VIEWER_VIEW_TYPE = 'decom.classViewer';

export async function openClassSource(classUri: vscode.Uri): Promise<void> {
	const sourceUri = toClassSourceUri(classUri);
	let document = await vscode.workspace.openTextDocument(sourceUri);
	if (document.languageId !== 'java') {
		document = await vscode.languages.setTextDocumentLanguage(document, 'java');
	}
	await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
}

/** Redirects the legacy `.class` custom editor entry point to a read-only Java text document. */
export class ClassEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => { } };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		webviewPanel.webview.options = { enableScripts: false };
		webviewPanel.webview.html = `<!DOCTYPE html><html><body>${escapeHtml(vscode.l10n.t('Decom: 디컴파일 중...'))}</body></html>`;
		try {
			await openClassSource(document.uri);
		} finally {
			webviewPanel.dispose();
		}
	}
}
