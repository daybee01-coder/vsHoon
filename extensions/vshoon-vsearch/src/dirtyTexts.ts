/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument } from 'vscode';

type SearchDocument = Pick<TextDocument, 'isDirty' | 'getText'> & {
	readonly uri: { readonly scheme: string; readonly fsPath: string };
};

/** Reads only snapshots that the worker can consume, preserving its exact path-key matching. */
export function collectDirtyTexts(paths: readonly string[], documents: Iterable<SearchDocument>): Record<string, string> {
	const dirty: Record<string, string> = {};
	if (paths.length === 0) {
		return dirty;
	}
	let targets: Set<string> | undefined;
	for (const document of documents) {
		if (!document.isDirty || document.uri.scheme !== 'file') {
			continue;
		}
		// Do not build an index when there are no dirty local documents.
		targets ??= new Set(paths);
		if (targets.has(document.uri.fsPath)) {
			dirty[document.uri.fsPath] = document.getText();
		}
	}
	return dirty;
}
