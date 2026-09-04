import * as vscode from 'vscode';
import { decompileSingleClass } from './cfr';
import { escapeHtml, highlightJava } from './highlight';
import { log } from './output';

export const CLASS_VIEWER_VIEW_TYPE = 'decom.classViewer';

function baseHtml(title: string, bodyContent: string): string {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escapeHtml(title)}</title>
<style>
  html, body {
    height: 100%;
    margin: 0;
    padding: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
  }
  .decom-header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-editorGroup-border, transparent);
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .decom-badge {
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
  }
  pre.decom-source {
    margin: 0;
    padding: 12px 16px 40px 16px;
    white-space: pre;
    line-height: 1.5;
    tab-size: 4;
  }
  .decom-error {
    padding: 16px;
    color: var(--vscode-errorForeground, #f14c4c);
    white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .tok-keyword { color: #569cd6; }
  .tok-string { color: #ce9178; }
  .tok-comment { color: #6a9955; font-style: italic; }
  .tok-number { color: #b5cea8; }
  .tok-annotation { color: #d4a656; }
  body.vscode-light .tok-keyword { color: #0000ff; }
  body.vscode-light .tok-string { color: #a31515; }
  body.vscode-light .tok-comment { color: #008000; }
  body.vscode-light .tok-number { color: #098658; }
  body.vscode-light .tok-annotation { color: #af8a00; }
</style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

function header(fsPath: string): string {
    return `<div class="decom-header"><span class="decom-badge">읽기 전용 · 디컴파일됨</span><span>${escapeHtml(fsPath)}</span></div>`;
}

function renderLoading(fsPath: string): string {
    return baseHtml('디컴파일 중...', `${header(fsPath)}<pre class="decom-source">디컴파일 중입니다...</pre>`);
}

function renderSource(fsPath: string, source: string): string {
    return baseHtml(fsPath, `${header(fsPath)}<pre class="decom-source">${highlightJava(source)}</pre>`);
}

function renderError(fsPath: string, message: string): string {
    return baseHtml('디컴파일 실패', `${header(fsPath)}<div class="decom-error">디컴파일에 실패했습니다:\n\n${escapeHtml(message)}</div>`);
}

/**
 * .class 파일을 위한 읽기 전용 커스텀 에디터. 디스크에 어떤 파일도 만들지 않고, CFR로 그때그때
 * 디컴파일한 소스를 정적 HTML(스크립트 없음)로 보여준다. 실제 TextDocument가 아니므로 언어
 * 서버(자바 확장 등)가 개입하거나 오탐 오류를 표시하지 않는다.
 */
export class ClassEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        webviewPanel.webview.options = { enableScripts: false };
        webviewPanel.webview.html = renderLoading(document.uri.fsPath);
        try {
            const source = await decompileSingleClass(this.context, document.uri.fsPath);
            webviewPanel.webview.html = renderSource(document.uri.fsPath, source);
        } catch (err: any) {
            const message = err.message ?? String(err);
            webviewPanel.webview.html = renderError(document.uri.fsPath, message);
            log(`class 디컴파일 실패: ${document.uri.fsPath} - ${err.stack ?? err}`);
        }
    }
}
