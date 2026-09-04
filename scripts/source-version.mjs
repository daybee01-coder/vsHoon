/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readLock, repoRoot } from './core-paths.mjs';

/**
 * Returns the stable source identity passed to the Code - OSS build as BUILD_SOURCEVERSION.
 * It deliberately includes uncommitted overlay changes because product.commit keys caches whose
 * contents depend on localize() call order.
 */
export function getVShoonSourceVersion({ root = repoRoot, lock = readLock() } = {}) {
	const inputs = [
		join(root, 'vshoon.lock.json'),
		...lock.overlay.map(entry => join(root, entry)),
		...lock.patches.map(patch => join(root, 'patches', patch))
	];
	const files = inputs.flatMap(input => listFiles(input)).sort((a, b) => a.localeCompare(b, 'en'));
	const hash = createHash('sha1');

	for (const file of files) {
		const path = relative(root, file).split(sep).join('/');
		const contents = readFileSync(file);
		hash.update(`${Buffer.byteLength(path)}:${path}${contents.byteLength}:`);
		hash.update(contents);
	}

	return hash.digest('hex');
}

function listFiles(path) {
	if (statSync(path).isFile()) {
		return [path];
	}

	return readdirSync(path, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name, 'en'))
		.flatMap(entry => entry.isDirectory() || entry.isFile() ? listFiles(join(path, entry.name)) : []);
}
