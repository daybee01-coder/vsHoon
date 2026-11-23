/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

/** 빌드 산출물·의존성 폴더. 직접 순회에서 건너뛰고 감시 이벤트로 다시 읽지 않는다. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	'node_modules',
	'.git',
	'.svn',
	'.hg',
	'out',
	'dist',
	'build',
	'target',
	'.idea',
	'.vscode-test'
]);

/**
 * 워크스페이스 루트 아래에서 건너뛸 폴더 안에 있는지 확인한다.
 * 루트보다 위의 폴더 이름(예: `D:\build\project`)은 보지 않는다. 어느 루트에도 속하지 않으면 false 다.
 */
export function isInSkippedDirectory(filePath: string, roots: readonly string[]): boolean {
	let relative: string | undefined;
	for (const root of roots) {
		const candidate = path.relative(root, filePath);
		if (candidate.length > 0 && candidate !== '..' && !candidate.startsWith(`..${path.sep}`) && !path.isAbsolute(candidate)
			&& (relative === undefined || candidate.length < relative.length)) {
			// 중첩된 루트는 가장 가까운 루트를 기준으로 한다.
			relative = candidate;
		}
	}
	if (relative === undefined) {
		return false;
	}
	const segments = relative.split(path.sep);
	segments.pop();
	return segments.some(segment => SKIPPED_DIRECTORIES.has(segment));
}
