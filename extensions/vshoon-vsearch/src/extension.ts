import * as vscode from 'vscode';
import { SEARCH_PANEL_VIEW_TYPE, SearchPanel } from './searchPanel';

/** 현재 에디터에서 선택한 텍스트를 초기 검색어로 사용한다. */
function selectionAsQuery(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection);
  return text.includes('\n') ? undefined : text;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Shift 두 번
    vscode.commands.registerCommand('vsearch.open', () => {
      SearchPanel.createOrShow(context, { focus: 'search', query: selectionAsQuery() });
    }),

    vscode.commands.registerCommand('vsearch.openReplace', () => {
      SearchPanel.createOrShow(context, { focus: 'replace', query: selectionAsQuery() });
    }),

    vscode.commands.registerCommand('vsearch.searchInFolder', (uri?: vscode.Uri) => {
      SearchPanel.createOrShow(context, {
        focus: 'search',
        scopePath: uri?.fsPath,
        query: selectionAsQuery()
      });
    }),

    // 창을 다시 열었을 때 패널을 복원한다.
    vscode.window.registerWebviewPanelSerializer(SEARCH_PANEL_VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        };
        SearchPanel.revive(panel, context);
      }
    })
  );
}

export function deactivate(): void {
  // 정리할 전역 리소스 없음
}
