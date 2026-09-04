import * as vscode from 'vscode';

export interface VsshSettings {
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalEncoding: string;
  hostkeyStrictChecking: boolean;
}

export function getSettings(): VsshSettings {
  const config = vscode.workspace.getConfiguration('vssh');
  return {
    terminalFontFamily: config.get<string>('terminal.fontFamily', ''),
    terminalFontSize: config.get<number>('terminal.fontSize', 14),
    terminalEncoding: config.get<string>('terminal.encoding', 'UTF-8'),
    hostkeyStrictChecking: config.get<boolean>('hostkey.strictChecking', true),
  };
}
