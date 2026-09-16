/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CachedSourceListRequest, CachedSourceListResult, ClassSourceService } from './classSourceService';

export interface DecomApi {
	readonly version: 1;
	listCachedSources(request: CachedSourceListRequest, token?: vscode.CancellationToken): Promise<CachedSourceListResult>;
}

export function createDecomApi(sourceService: ClassSourceService): DecomApi {
	return {
		version: 1,
		listCachedSources: (request, token) => sourceService.listCachedSources(request, token)
	};
}
