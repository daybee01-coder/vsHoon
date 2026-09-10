import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readManifest, writeManifest } from './manifest';
import { rebuildJarInWorker } from './jarWorkerClient';
import { isCancellation } from './jarWorkerProtocol';
import { ensureBackup } from './backup';
import { progressMessage, resolveMountedFolder } from './jarProject';
import { longPath } from './longpath';
import { log } from './output';

/**
 * 마운트된 캐시 폴더의 현재 상태(리소스 파일 수정, 라이브러리 jar 교체/추가/삭제 등)를
 * 원본 JAR에 그대로 반영한다. .class 파일은 열람 전용이라 보통 그대로지만, 사용자가 직접
 * 다른 파일로 교체했다면 그 내용도 함께 반영된다.
 *
 * 압축은 워커 스레드에서 돌아 확장 호스트를 막지 않으며, 진행률 알림에서 취소할 수 있다.
 * 취소해도 원본 jar는 손대지 않은 채로 남는다.
 */
export async function saveFolderToJar(folderUri?: vscode.Uri): Promise<void> {
    const folder = resolveMountedFolder(folderUri);
    if (!folder) {
        vscode.window.showWarningMessage('Decom: 마운트된 JAR 폴더를 찾을 수 없습니다.');
        return;
    }
    const cacheDir = folder.uri.fsPath;
    const manifest = readManifest(cacheDir);
    if (!manifest) {
        vscode.window.showWarningMessage('Decom: 이 폴더는 Decom으로 마운트된 JAR가 아닙니다.');
        return;
    }

    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.fsPath.startsWith(cacheDir) && doc.isDirty) {
            await doc.save();
        }
    }

    const jarName = path.basename(manifest.jarPath);
    const confirm = await vscode.window.showWarningMessage(
        `캐시 폴더의 현재 상태(수정/추가/삭제된 파일 전부)를 "${jarName}"에 반영합니다. 원본은 최초 1회 "${jarName}.decom-bak"으로 백업됩니다. 계속할까요?`,
        { modal: true },
        '계속'
    );
    if (confirm !== '계속') return;

    try {
        ensureBackup(manifest, cacheDir);
        const { fileCount } = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Decom: "${jarName}"에 저장 중...`,
                cancellable: true
            },
            (progress, token) =>
                rebuildJarInWorker(cacheDir, manifest.jarPath, {
                    token,
                    onProgress: (value) => progress.report({ message: progressMessage(value) })
                })
        );

        const stat = fs.statSync(longPath(manifest.jarPath));
        manifest.jarSize = stat.size;
        manifest.jarMtimeMs = stat.mtimeMs;
        writeManifest(cacheDir, manifest);

        log(`JAR 저장 완료: ${manifest.jarPath} (${fileCount}개 파일)`);
        vscode.window.showInformationMessage(`Decom: "${jarName}"에 저장했습니다. (${fileCount}개 파일)`);
    } catch (err: any) {
        if (isCancellation(err)) {
            // 취소는 원본 자리로 옮기기 전에만 멈추므로 원본 jar는 그대로다.
            log(`저장을 취소했습니다: ${manifest.jarPath}`);
            vscode.window.showInformationMessage(`Decom: 저장을 취소했습니다. "${jarName}"은 그대로입니다.`);
            return;
        }
        vscode.window.showErrorMessage(`Decom: JAR 저장 실패 - ${err.message ?? err}`);
        log(`오류: ${err.stack ?? err}`);
    }
}
