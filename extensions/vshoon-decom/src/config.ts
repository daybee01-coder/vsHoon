import * as vscode from 'vscode';

export interface DecomConfig {
    cfrJarPath: string;
    javaExecutable: string;
    extraClasspath: string[];
    cfrExtraOptions: string;
}

export function getConfig(): DecomConfig {
    const cfg = vscode.workspace.getConfiguration('decom');
    return {
        cfrJarPath: cfg.get<string>('cfr.jarPath', '').trim(),
        javaExecutable: cfg.get<string>('java.executable', 'java').trim() || 'java',
        extraClasspath: cfg.get<string[]>('classpath.extra', []) ?? [],
        cfrExtraOptions: cfg.get<string>('cfr.options', '').trim()
    };
}
