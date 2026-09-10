import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractJarInWorker } from './jarWorkerClient';
import { isCancellation, JarProgress } from './jarWorkerProtocol';
import { cacheDirFor, readManifest, writeManifest, DecomManifest } from './manifest';
import { longPath } from './longpath';
import { log } from './output';

function displayNameForJar(jarPath: string): string {
    return `📦 ${path.basename(jarPath)}`;
}

function findWorkspaceFolderIndex(uri: vscode.Uri): number {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.findIndex((f) => f.uri.toString() === uri.toString());
}

async function mountCacheDir(cacheDir: string, jarPath: string): Promise<void> {
    const uri = vscode.Uri.file(cacheDir);
    if (findWorkspaceFolderIndex(uri) >= 0) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
        uri,
        name: displayNameForJar(jarPath)
    });
    if (!ok) {
        throw new Error('워크스페이스 폴더로 마운트하지 못했습니다.');
    }
}

/**
 * jar의 모든 항목(.class 포함)을 원본 바이트 그대로 cacheDir에 풀어낸다. 디컴파일은 하지 않으며,
 * .class 파일을 열람할 때 커스텀 에디터가 그때그때 디컴파일해서 읽기 전용으로 보여준다.
 * 압축 해제는 워커 스레드에서 돌아 확장 호스트를 막지 않으며, 진행률 알림에서 취소할 수 있다.
 * 주의: cacheDir에 아직 JAR로 저장(sync)하지 않은 로컬 편집이 있다면 이 함수가 원본 바이트로
 * 덮어써서 사라진다. (같은 jar를 변경 없이 다시 열 때는 크기/수정시각이 일치하면 이 함수를
 * 다시 호출하지 않고 캐시를 그대로 재사용하므로, 명시적인 "새로고침"이 아닌 이상 안전하다.)
 *
 * 취소하면 이미 풀어낸 파일은 캐시 폴더에 남는다. 대신 매니페스트를 미완료로 표시해 두어,
 * 그 반쪽 캐시가 다음 열기에서 원본과 같은 것으로 재사용되지 않게 한다.
 */
export async function extractJarToCache(jarPath: string, cacheDir: string): Promise<DecomManifest> {
    fs.mkdirSync(longPath(cacheDir), { recursive: true });

    const previous = readManifest(cacheDir);
    const stat = fs.statSync(longPath(jarPath));
    const manifest: DecomManifest = {
        version: 1,
        jarPath: path.resolve(jarPath),
        jarSize: stat.size,
        jarMtimeMs: stat.mtimeMs,
        backupPath: previous?.backupPath ?? null,
        incomplete: true
    };
    writeManifest(cacheDir, manifest);

    log(`JAR 추출 중... (${jarPath})`);
    const jarName = path.basename(jarPath);
    const { extracted, skipped } = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Decom: "${jarName}" 추출 중...`,
            cancellable: true
        },
        (progress, token) =>
            extractJarInWorker(jarPath, cacheDir, {
                token,
                onProgress: (value) => progress.report({ message: progressMessage(value) })
            })
    );
    if (skipped.length > 0) {
        // 캐시 폴더 밖을 가리키는 항목은 쓰지 않는다. 정상 jar에는 없는 형태이므로 남겨서 알린다.
        log(`캐시 폴더 밖을 가리켜 건너뛴 항목 ${skipped.length}개: ${skipped.join(', ')}`);
    }

    manifest.incomplete = false;
    writeManifest(cacheDir, manifest);
    log(`추출 완료: ${extracted.length}개 항목 -> ${cacheDir}`);
    return manifest;
}

/** 진행률 알림에 쓸 한 줄. 전체 개수를 아직 모르는 단계에서는 처리한 개수만 보여준다. */
export function progressMessage(progress: JarProgress): string {
    if (progress.phase === 'compress') {
        return `압축 중... (${progress.total}개 파일)`;
    }
    if (progress.phase === 'write') {
        return '파일 쓰는 중...';
    }
    if (progress.total > 0) {
        return `${progress.done}/${progress.total}개 항목`;
    }
    return `${progress.done}개 항목`;
}

export async function openJar(context: vscode.ExtensionContext, jarUri?: vscode.Uri): Promise<void> {
    let jarPath: string | undefined = jarUri?.fsPath;
    if (!jarPath) {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'JAR files': ['jar'] },
            openLabel: '열기'
        });
        jarPath = picked?.[0]?.fsPath;
    }
    if (!jarPath) return;

    const cacheDir = cacheDirFor(context, jarPath);
    const stat = fs.statSync(longPath(jarPath));
    const existing = readManifest(cacheDir);

    if (existing?.incomplete) {
        // 지난 추출이 취소되거나 실패해 반쪽으로 남은 캐시다. 사용자에게 되물어도 고를 것이
        // 없으므로 그대로 다시 추출한다.
        log(`이전 추출이 끝나지 않아 다시 추출합니다: ${cacheDir}`);
    } else if (existing && existing.jarSize === stat.size && existing.jarMtimeMs === stat.mtimeMs) {
        log(`캐시된 결과를 재사용합니다: ${cacheDir}`);
        await mountCacheDir(cacheDir, jarPath);
        return;
    } else if (existing) {
        const choice = await vscode.window.showWarningMessage(
            `"${path.basename(jarPath)}" 파일이 이전에 열었던 시점과 달라졌습니다. 다시 추출할까요? (아직 JAR에 저장하지 않은 캐시 폴더 내 로컬 편집 내용은 원본 바이트로 덮어써서 사라집니다.)`,
            { modal: true },
            '다시 추출',
            '캐시 그대로 열기'
        );
        if (choice === undefined) return;
        if (choice === '캐시 그대로 열기') {
            await mountCacheDir(cacheDir, jarPath);
            return;
        }
    }

    try {
        await extractJarToCache(jarPath, cacheDir);
        await mountCacheDir(cacheDir, jarPath);
        vscode.window.showInformationMessage(`Decom: "${path.basename(jarPath)}" 마운트했습니다.`);
    } catch (err: any) {
        if (isCancellation(err)) {
            log(`추출을 취소했습니다: ${jarPath}`);
            vscode.window.showInformationMessage('Decom: JAR 추출을 취소했습니다.');
            return;
        }
        vscode.window.showErrorMessage(`Decom: JAR 열기 실패 - ${err.message ?? err}`);
        log(`오류: ${err.stack ?? err}`);
    }
}

export async function refreshJar(folderUri?: vscode.Uri): Promise<void> {
    const folder = resolveMountedFolder(folderUri);
    if (!folder) {
        vscode.window.showWarningMessage('Decom: 마운트된 JAR 폴더를 찾을 수 없습니다.');
        return;
    }
    const manifest = readManifest(folder.uri.fsPath);
    if (!manifest) {
        vscode.window.showWarningMessage('Decom: 이 폴더는 Decom으로 마운트된 JAR가 아닙니다.');
        return;
    }
    try {
        await extractJarToCache(manifest.jarPath, folder.uri.fsPath);
        vscode.window.showInformationMessage(`Decom: "${path.basename(manifest.jarPath)}" 다시 추출했습니다.`);
    } catch (err: any) {
        if (isCancellation(err)) {
            log(`새로고침을 취소했습니다: ${manifest.jarPath}`);
            vscode.window.showInformationMessage('Decom: JAR 새로고침을 취소했습니다.');
            return;
        }
        vscode.window.showErrorMessage(`Decom: 새로고침 실패 - ${err.message ?? err}`);
    }
}

export function resolveMountedFolder(folderUri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (folderUri) {
        return vscode.workspace.getWorkspaceFolder(folderUri);
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
        return vscode.workspace.getWorkspaceFolder(activeUri);
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.find((f) => readManifest(f.uri.fsPath) !== undefined);
}

export async function closeJar(folderUri?: vscode.Uri): Promise<void> {
    const folder = resolveMountedFolder(folderUri);
    if (!folder) {
        vscode.window.showWarningMessage('Decom: 마운트된 JAR 폴더를 찾을 수 없습니다.');
        return;
    }
    const idx = findWorkspaceFolderIndex(folder.uri);
    if (idx >= 0) {
        vscode.workspace.updateWorkspaceFolders(idx, 1);
    }
}
