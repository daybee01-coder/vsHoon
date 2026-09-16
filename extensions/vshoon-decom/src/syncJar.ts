/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { writeManifest } from './manifest';
import { rebuildJarInWorker } from './jarWorkerClient';
import { isCancellation } from './jarWorkerProtocol';
import { ensureBackup } from './backup';
import { resolveCachedJar } from './archiveCache';
import { progressMessage } from './jarProject';
import { longPath } from './longpath';
import { log } from './output';

/** Rebuilds the source JAR from the editable cache displayed below its Explorer node. */
export async function saveFolderToJar(context: vscode.ExtensionContext, resource?: vscode.Uri): Promise<void> {
	const cached = resolveCachedJar(context, resource);
	if (!cached) {
		await vscode.window.showWarningMessage(vscode.l10n.t('Decom: 먼저 Explorer에서 JAR 파일을 펼쳐 주세요.'));
		return;
	}
	const { cacheDir, manifest } = cached;

	for (const document of vscode.workspace.textDocuments) {
		if (document.uri.scheme === 'file' && document.uri.fsPath.startsWith(cacheDir) && document.isDirty) {
			await document.save();
		}
	}

	const jarName = path.basename(manifest.jarPath);
	if (getConfig().confirmSave) {
		const continueLabel = vscode.l10n.t('계속');
		const confirm = await vscode.window.showWarningMessage(
			vscode.l10n.t('수정·추가·삭제된 내부 파일을 "{0}"에 반영합니다. 원본은 최초 한 번 "{1}.decom-bak"으로 백업됩니다.', jarName, jarName),
			{ modal: true },
			continueLabel
		);
		if (confirm !== continueLabel) {
			return;
		}
	}

	try {
		ensureBackup(manifest, cacheDir);
		const { fileCount } = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Decom: "{0}"에 저장 중...', jarName),
				cancellable: true
			},
			(progress, token) =>
				rebuildJarInWorker(cacheDir, manifest.jarPath, {
					token,
					onProgress: value => progress.report({ message: progressMessage(value) })
				})
		);

		const stat = fs.statSync(longPath(manifest.jarPath));
		manifest.jarSize = stat.size;
		manifest.jarMtimeMs = stat.mtimeMs;
		writeManifest(cacheDir, manifest);

		log(`JAR 저장 완료: ${manifest.jarPath} (${fileCount}개 파일)`);
		await vscode.window.showInformationMessage(vscode.l10n.t('Decom: "{0}"에 저장했습니다. ({1}개 파일)', jarName, fileCount));
		await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
	} catch (error) {
		if (isCancellation(error)) {
			log(`저장을 취소했습니다: ${manifest.jarPath}`);
			await vscode.window.showInformationMessage(vscode.l10n.t('Decom: 저장을 취소했습니다. "{0}"은 그대로입니다.', jarName));
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		await vscode.window.showErrorMessage(vscode.l10n.t('Decom: JAR 저장 실패 - {0}', message));
		log(`오류: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	}
}
