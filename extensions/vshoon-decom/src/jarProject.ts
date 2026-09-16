/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { JarFileSystemProvider } from './archiveFileSystem';
import { JarProgress } from './jarWorkerProtocol';
import { log } from './output';

/** Kept for the dormant edit/rebuild implementation. */
export function progressMessage(progress: JarProgress): string {
	if (progress.phase === 'compress') {
		return `압축 중... (${progress.total}개 파일)`;
	}
	if (progress.phase === 'write') {
		return '파일 쓰는 중...';
	}
	return progress.total > 0 ? `${progress.done}/${progress.total}개 항목` : `${progress.done}개 항목`;
}

/** Resolves a local or nested JAR to the root of the read-only archive file system. */
export function prepareJarForExplorer(provider: JarFileSystemProvider, jarUri: vscode.Uri): Promise<vscode.Uri> {
	return provider.openArchive(jarUri);
}

export async function openJar(provider: JarFileSystemProvider, jarUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
	let selected = jarUri;
	if (!selected) {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { 'JAR files': ['jar'] },
			openLabel: vscode.l10n.t('펼치기')
		});
		selected = picked?.[0];
	}
	if (!selected) {
		return undefined;
	}

	try {
		const root = await prepareJarForExplorer(provider, selected);
		await vscode.commands.executeCommand('revealInExplorer', selected);
		return root;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await vscode.window.showErrorMessage(vscode.l10n.t('Decom: JAR 열기 실패 — {0}', message));
		log(`JAR VFS 열기 실패: ${selected.toString()} - ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		return undefined;
	}
}

export async function refreshJar(provider: JarFileSystemProvider, resource?: vscode.Uri): Promise<void> {
	provider.refresh();
	await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
	const label = resource ? path.posix.basename(resource.path) || path.basename(resource.fsPath) : vscode.l10n.t('JAR');
	void vscode.window.showInformationMessage(vscode.l10n.t('Decom: "{0}"의 가상 파일 인덱스를 새로고침했습니다.', label));
}
