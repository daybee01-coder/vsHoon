import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractAllEntries } from './zipUtil';
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
 * 주의: cacheDir에 아직 JAR로 저장(sync)하지 않은 로컬 편집이 있다면 이 함수가 원본 바이트로
 * 덮어써서 사라진다. (같은 jar를 변경 없이 다시 열 때는 크기/수정시각이 일치하면 이 함수를
 * 다시 호출하지 않고 캐시를 그대로 재사용하므로, 명시적인 "새로고침"이 아닌 이상 안전하다.)
 */
export async function extractJarToCache(jarPath: string, cacheDir: string): Promise<DecomManifest> {
    fs.mkdirSync(longPath(cacheDir), { recursive: true });

    log(`JAR 추출 중... (${jarPath})`);
    const extracted = extractAllEntries(jarPath, cacheDir);

    const previous = readManifest(cacheDir);
    const stat = fs.statSync(longPath(jarPath));
    const manifest: DecomManifest = {
        version: 1,
        jarPath: path.resolve(jarPath),
        jarSize: stat.size,
        jarMtimeMs: stat.mtimeMs,
        backupPath: previous?.backupPath ?? null
    };
    writeManifest(cacheDir, manifest);
    log(`추출 완료: ${extracted.length}개 항목 -> ${cacheDir}`);
    return manifest;
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

    if (existing && existing.jarSize === stat.size && existing.jarMtimeMs === stat.mtimeMs) {
        log(`캐시된 결과를 재사용합니다: ${cacheDir}`);
        await mountCacheDir(cacheDir, jarPath);
        return;
    }

    if (existing) {
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
