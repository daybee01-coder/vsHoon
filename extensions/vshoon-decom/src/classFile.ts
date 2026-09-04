import * as vscode from 'vscode';
import { CLASS_VIEWER_VIEW_TYPE } from './classEditor';

/**
 * 커맨드 팔레트/탐색기에서 명시적으로 호출됐을 때 쓰는 진입점. 실제 열람은 항상
 * decom.classViewer 커스텀 에디터(읽기 전용)가 담당한다 (.class 파일의 기본 에디터이기도 하므로
 * 탐색기에서 더블클릭해도 동일하게 열린다).
 */
export async function viewClassFile(classUri?: vscode.Uri): Promise<void> {
    let uri = classUri;
    if (!uri) {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Class files': ['class'] },
            openLabel: '디컴파일하여 보기'
        });
        uri = picked?.[0];
    }
    if (!uri) return;
    await vscode.commands.executeCommand('vscode.openWith', uri, CLASS_VIEWER_VIEW_TYPE);
}
