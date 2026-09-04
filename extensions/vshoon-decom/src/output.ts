import * as vscode from 'vscode';

export const output = vscode.window.createOutputChannel('Decom');

export function log(message: string): void {
    const stamp = new Date().toISOString().split('T')[1].replace('Z', '');
    output.appendLine(`[${stamp}] ${message}`);
}
