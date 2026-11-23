/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { escapeRegExp } from './matcher';
import { SearchQuery } from './types';

/** 워커가 보관한 워크스페이스 파일 목록에서 검색 대상을 고르는 조건. */
export interface WorkspaceScope {
	/** 없으면 워크스페이스 전체 */
	directory?: string;
	recursive: boolean;
	fileMask: string;
}

export function splitMask(mask: string): string[] {
	return mask
		.split(/[,;]/)
		.map(part => part.trim())
		.filter(part => part.length > 0);
}

/** `*.java, *.xml` 같은 파일 이름 마스크를 대소문자 무시 정규식으로 바꾼다. */
export function maskToRegExp(mask: string): RegExp {
	const body = splitMask(mask)
		.map(part => '^' + escapeRegExp(part).replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$')
		.join('|');
	return new RegExp(body || '.*', 'i');
}

export function scopeOf(query: SearchQuery): WorkspaceScope {
	const useDirectory = query.scopeKind === 'directory' && query.scopePath.trim().length > 0;
	return { directory: useDirectory ? query.scopePath : undefined, recursive: query.recursive, fileMask: query.fileMask };
}

/** 메모리에 보관한 워크스페이스 목록을 검색 범위와 마스크로 거른다. findFiles 와 같은 대상을 고른다. */
export function filterWorkspacePaths(paths: readonly string[], scope: WorkspaceScope): readonly string[] {
	const maskRe = scope.fileMask.trim() ? maskToRegExp(scope.fileMask) : undefined;
	const base = scope.directory !== undefined ? path.resolve(scope.directory).toLowerCase() : undefined;
	if (!maskRe && base === undefined) {
		// 전체 범위는 복사하지 않는다.
		return paths;
	}
	return paths.filter(filePath => {
		if (maskRe && !maskRe.test(path.basename(filePath))) {
			return false;
		}
		if (base === undefined) {
			return true;
		}
		const directory = path.dirname(filePath).toLowerCase();
		return scope.recursive ? directory === base || directory.startsWith(base + path.sep) : directory === base;
	});
}
