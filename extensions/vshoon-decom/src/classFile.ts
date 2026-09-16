/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { openClassSource } from './classEditor';

/**
 * 커맨드 팔레트/탐색기에서 명시적으로 호출됐을 때 쓰는 진입점. 실제 열람은 줄 번호와 탐색을
 * 제공하는 vshoon-decom 읽기 전용 Java 문서가 담당한다.
 */
export async function viewClassFile(classUri?: vscode.Uri): Promise<void> {
	let uri = classUri;
	if (!uri) {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { [vscode.l10n.t('Class files')]: ['class'] },
			openLabel: vscode.l10n.t('디컴파일하여 보기')
		});
		uri = picked?.[0];
	}
	if (!uri) {
		return;
	}
	await openClassSource(uri);
}
