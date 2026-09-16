/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { JAR_FILE_SYSTEM_SCHEME } from './archiveFileSystem';

export const CLASS_SOURCE_SCHEME = 'vshoon-decom';

function encodedClassUri(uri: vscode.Uri): string {
	return Buffer.from(uri.toString(), 'utf8').toString('base64url');
}

/**
 * Maps `Foo$Bar.class` onto `Foo.class`. CFR renders a whole outer/inner family into one text, so
 * every member shares a single document, a single cache entry and a single decompiler run.
 */
export function outerClassUri(classUri: vscode.Uri): vscode.Uri {
	const fileName = path.posix.basename(classUri.path);
	const stem = fileName.replace(/\.class$/i, '');
	const outerStem = stem.split('$', 1)[0];
	if (!outerStem || outerStem === stem) {
		return classUri;
	}
	const directory = path.posix.dirname(classUri.path);
	return classUri.with({ path: `${directory === '/' ? '' : directory}/${outerStem}.class` });
}

export function toClassSourceUri(classUri: vscode.Uri): vscode.Uri {
	const outerUri = outerClassUri(classUri);
	const className = path.posix.basename(outerUri.path).replace(/\.class$/i, '.java');
	return vscode.Uri.from({
		scheme: CLASS_SOURCE_SCHEME,
		authority: 'source',
		path: `/${className}`,
		query: `class=${encodedClassUri(outerUri)}`
	});
}

export function fromClassSourceUri(sourceUri: vscode.Uri): vscode.Uri {
	if (sourceUri.scheme !== CLASS_SOURCE_SCHEME) {
		throw new Error(vscode.l10n.t('Decom 소스 URI가 아닙니다.'));
	}
	const value = new URLSearchParams(sourceUri.query).get('class');
	if (!value) {
		throw new Error(vscode.l10n.t('Decom 소스 URI에 원본 Class 정보가 없습니다.'));
	}
	const classUri = vscode.Uri.parse(Buffer.from(value, 'base64url').toString('utf8'), true);
	if ((classUri.scheme !== 'file' && classUri.scheme !== JAR_FILE_SYSTEM_SCHEME) || !classUri.path.toLowerCase().endsWith('.class')) {
		throw new Error(vscode.l10n.t('Decom 소스 URI의 원본 Class 정보가 올바르지 않습니다.'));
	}
	return classUri;
}
