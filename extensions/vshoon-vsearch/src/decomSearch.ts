/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SearchQuery } from './types';

const DECOM_EXTENSION_ID = 'vshoon.vshoon-decom';

export interface DecomCachedSource {
	uri: string;
	displayPath: string;
	rootFilePath: string;
	content: string;
	readonly: true;
}

interface DecomApi {
	readonly version: number;
	listCachedSources(request: {
		scopeKind: 'workspace' | 'directory';
		scopePath: string;
		recursive: boolean;
		workspaceRoots: string[];
		maxFiles: number;
		maxBytes: number;
		maxTotalBytes: number;
	}, token?: vscode.CancellationToken): Promise<{ sources: DecomCachedSource[]; pending: number; truncated: boolean }>;
}

export interface DecomSourceResult {
	sources: DecomCachedSource[];
	pending: number;
	truncated: boolean;
}

export async function getDecomSources(
	query: SearchQuery,
	maxFiles: number,
	maxBytes: number,
	token?: vscode.CancellationToken
): Promise<DecomSourceResult> {
	if (!query.includeArchives || maxFiles <= 0) {
		return { sources: [], pending: 0, truncated: false };
	}
	const extension = vscode.extensions.getExtension<DecomApi>(DECOM_EXTENSION_ID);
	if (!extension) {
		return { sources: [], pending: 0, truncated: false };
	}
	try {
		const api = extension.isActive ? extension.exports : await extension.activate();
		if (!api || api.version !== 1) {
			return { sources: [], pending: 0, truncated: false };
		}
		return api.listCachedSources({
			scopeKind: query.scopeKind,
			scopePath: query.scopePath,
			recursive: query.recursive,
			workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
			maxFiles,
			maxBytes,
			maxTotalBytes: 64 * 1024 * 1024
		}, token);
	} catch {
		return { sources: [], pending: 0, truncated: false };
	}
}
