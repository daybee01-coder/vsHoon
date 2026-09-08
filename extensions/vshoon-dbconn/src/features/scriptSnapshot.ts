/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument } from 'vscode';

/** 초안 복구용 캐시의 기존 문자 수 제한. */
const MAX_CHARS = 1_000_000;

/** 문서가 닫힌 뒤에도 보관할 수 있도록 열려 있는 동안 내용을 한 번만 읽어 확보한다. */
export function readScriptSnapshot(
	document: Pick<TextDocument, 'languageId' | 'isDirty' | 'getText'> & { readonly uri: { readonly scheme: string } },
	enabled: boolean,
): string | undefined {
	if (!enabled || document.languageId !== 'sql' || (document.uri.scheme !== 'untitled' && !document.isDirty)) {
		return undefined;
	}

	const text = document.getText();
	return text.length > 0 && text.length <= MAX_CHARS ? text : undefined;
}
