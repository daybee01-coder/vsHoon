import * as vscode from 'vscode';

export interface VsshSettings {
  closeSidebarOnConnect: boolean;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalEncoding: string;
  terminalMouseReporting: boolean;
  hostkeyStrictChecking: boolean;
}

export function getSettings(): VsshSettings {
  const config = vscode.workspace.getConfiguration('vssh');
  return {
    closeSidebarOnConnect: config.get<boolean>('closeSidebarOnConnect', false),
    terminalFontFamily: config.get<string>('terminal.fontFamily', ''),
    terminalFontSize: config.get<number>('terminal.fontSize', 14),
    terminalEncoding: config.get<string>('terminal.encoding', 'UTF-8'),
    terminalMouseReporting: config.get<boolean>('terminal.mouseReporting', false),
    hostkeyStrictChecking: config.get<boolean>('hostkey.strictChecking', true),
  };
}
