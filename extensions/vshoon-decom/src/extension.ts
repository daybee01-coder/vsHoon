import * as vscode from 'vscode';
import { openJar, refreshJar, closeJar } from './jarProject';
import { viewClassFile } from './classFile';
import { ClassEditorProvider, CLASS_VIEWER_VIEW_TYPE } from './classEditor';
import { saveFolderToJar } from './syncJar';
import { readManifest } from './manifest';
import { output, log } from './output';

function updateContextKeys(): void {
    const anyMounted = (vscode.workspace.workspaceFolders ?? []).some((f) => readManifest(f.uri.fsPath) !== undefined);
    vscode.commands.executeCommand('setContext', 'decom.activeFolderMounted', anyMounted);
}

export function activate(context: vscode.ExtensionContext): void {
    log('Decom 확장이 활성화되었습니다.');

    context.subscriptions.push(
        output,
        vscode.window.registerCustomEditorProvider(CLASS_VIEWER_VIEW_TYPE, new ClassEditorProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true
        }),

        vscode.commands.registerCommand('decom.openJar', (uri?: vscode.Uri) => openJar(context, uri)),
        vscode.commands.registerCommand('decom.viewClassFile', (uri?: vscode.Uri) => viewClassFile(uri)),
        vscode.commands.registerCommand('decom.refreshJar', (uri?: vscode.Uri) => refreshJar(uri)),
        vscode.commands.registerCommand('decom.closeJar', (uri?: vscode.Uri) => closeJar(uri)),
        vscode.commands.registerCommand('decom.saveToJar', (uri?: vscode.Uri) => saveFolderToJar(uri)),

        vscode.workspace.onDidChangeWorkspaceFolders(updateContextKeys)
    );

    updateContextKeys();
}

export function deactivate(): void {
    // no-op
}
