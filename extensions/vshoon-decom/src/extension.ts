/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createDecomApi, DecomApi } from './api';
import { JarFileSystemProvider, JAR_FILE_SYSTEM_SCHEME } from './archiveFileSystem';
import { ClassEditorProvider, CLASS_VIEWER_VIEW_TYPE } from './classEditor';
import { registerClassNavigation } from './classNavigation';
import { ClassSourceService } from './classSourceService';
import { CLASS_SOURCE_SCHEME } from './classSourceUri';
import { viewClassFile } from './classFile';
import { JarEditorProvider, JAR_VIEWER_VIEW_TYPE } from './jarEditor';
import { openJar, prepareJarForExplorer, refreshJar } from './jarProject';
import { log, output } from './output';
import { registerWorkspaceJavaNavigation } from './workspaceJavaNavigation';
import { registerWorkspaceScriptNavigation } from './workspaceScriptNavigation';

export function activate(context: vscode.ExtensionContext): DecomApi {
	log('Decom 읽기 전용 JAR VFS가 활성화되었습니다.');
	const archiveProvider = new JarFileSystemProvider();
	const sourceService = new ClassSourceService(context, archiveProvider);
	const classEditorProvider = new ClassEditorProvider();
	registerClassNavigation(context, sourceService);
	registerWorkspaceJavaNavigation(context, archiveProvider, sourceService);
	registerWorkspaceScriptNavigation(context);

	context.subscriptions.push(
		output,
		archiveProvider,
		sourceService,
		vscode.workspace.registerTextDocumentContentProvider(CLASS_SOURCE_SCHEME, sourceService),
		vscode.workspace.registerFileSystemProvider(JAR_FILE_SYSTEM_SCHEME, archiveProvider, {
			isCaseSensitive: true,
			isReadonly: true
		}),
		vscode.window.registerCustomEditorProvider(JAR_VIEWER_VIEW_TYPE, new JarEditorProvider(archiveProvider)),
		vscode.window.registerCustomEditorProvider(CLASS_VIEWER_VIEW_TYPE, classEditorProvider, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: true
		}),
		vscode.commands.registerCommand('decom.resolveExplorerJar', (uri: vscode.Uri) => prepareJarForExplorer(archiveProvider, uri)),
		vscode.commands.registerCommand('decom.openJar', (uri?: vscode.Uri) => openJar(archiveProvider, uri)),
		vscode.commands.registerCommand('decom.viewClassFile', (uri?: vscode.Uri) => viewClassFile(uri)),
		vscode.commands.registerCommand('decom.refreshJar', (uri?: vscode.Uri) => refreshJar(archiveProvider, uri)),
		vscode.commands.registerCommand('vshoon.decom.clearCache', async () => {
			await sourceService.clearCache();
			void vscode.window.showInformationMessage(vscode.l10n.t('Decom: 디컴파일 캐시를 삭제했습니다.'));
		}),
		vscode.commands.registerCommand('vshoon.decom.cancelPrecompile', () => sourceService.cancelPrecompile())
	);
	return createDecomApi(sourceService);
}

export function deactivate(): void {
	// no-op
}
