/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { cacheDirFor, DecomManifest, readManifest } from './manifest';

export interface CachedJar {
	cacheDir: string;
	manifest: DecomManifest;
}

function isEqualOrInside(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Finds the cache and source JAR represented by either a JAR node or one of its visible entries. */
export function resolveCachedJar(context: vscode.ExtensionContext, resource?: vscode.Uri): CachedJar | undefined {
	const selected = resource ?? vscode.window.activeTextEditor?.document.uri;
	if (!selected || selected.scheme !== 'file') {
		return undefined;
	}

	if (path.extname(selected.fsPath).toLowerCase() === '.jar') {
		const cacheDir = cacheDirFor(context, selected.fsPath);
		const manifest = readManifest(cacheDir);
		return manifest ? { cacheDir, manifest } : undefined;
	}

	const cacheRoot = path.join(context.globalStorageUri.fsPath, 'jars');
	let candidate = path.resolve(selected.fsPath);

	while (isEqualOrInside(candidate, cacheRoot)) {
		const manifest = readManifest(candidate);
		if (manifest) {
			return { cacheDir: candidate, manifest };
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) {
			break;
		}
		candidate = parent;
	}
	return undefined;
}
