/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument } from 'vscode';

type SearchDocument = Pick<TextDocument, 'isDirty' | 'getText' | 'version'> & {
	readonly uri: { readonly scheme: string; readonly fsPath: string };
};

/** 워커에 보낼 미저장 내용의 변경분 */
export interface DirtyTextChanges {
	/** 새로 바뀐 내용 (경로 → 텍스트) */
	readonly set: Record<string, string>;
	/** 저장했거나 닫아서 더는 쓰지 않는 경로 */
	readonly clear: string[];
}

/**
 * 워커가 보관한 미저장 내용과 편집기 문서를 맞춘다. 검색마다 모든 미저장 문서를 복사하지 않고
 * 버전이 바뀐 로컬 문서의 내용만 읽어 보낸다. 경로는 워커와 같은 `fsPath` 키를 대소문자 그대로 쓴다.
 */
export class DirtyTextTracker {
	private readonly sent = new Map<string, number>();

	/** 마지막 호출 뒤 바뀐 내용을 돌려준다. 바뀐 것이 없으면 undefined. */
	changes(documents: Iterable<SearchDocument>): DirtyTextChanges | undefined {
		const set: Record<string, string> = {};
		const current = new Set<string>();
		let changed = false;
		for (const document of documents) {
			if (!document.isDirty || document.uri.scheme !== 'file') {
				continue;
			}
			const key = document.uri.fsPath;
			current.add(key);
			if (this.sent.get(key) !== document.version) {
				set[key] = document.getText();
				this.sent.set(key, document.version);
				changed = true;
			}
		}
		const clear: string[] = [];
		for (const key of this.sent.keys()) {
			if (!current.has(key)) {
				clear.push(key);
				this.sent.delete(key);
			}
		}
		return changed || clear.length > 0 ? { set, clear } : undefined;
	}

	/** 워커를 새로 만들어 보관한 내용이 사라졌을 때 호출한다. 다음 changes() 가 전부 다시 보낸다. */
	reset(): void {
		this.sent.clear();
	}
}
