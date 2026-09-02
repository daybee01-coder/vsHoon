/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, repoRoot } from './core-paths.mjs';

/** Reads the files a patch owns out of the patch itself, so the mapping never drifts. */
export function filesOf(name) {
	const patch = join(repoRoot, 'patches', name);
	if (!existsSync(patch)) {
		fail(`missing patch ${name}`);
	}

	const files = readFileSync(patch, 'utf8')
		.split('\n')
		.map(line => /^diff --git a\/(?<file>.+?) b\/\k<file>$/.exec(line)?.groups?.file)
		.filter(file => !!file);

	if (files.length === 0) {
		fail(`${name} does not name any file`);
	}

	return files;
}

/**
 * Maps every patched core file to the single patch that owns it.
 *
 * A file may belong to one patch only: two patches over the same file cannot be saved or
 * reapplied independently, which is the whole point of splitting them.
 */
export function patchOwners(patches, { onConflict = fail } = {}) {
	const owners = new Map();
	for (const name of patches) {
		for (const file of filesOf(name)) {
			const existing = owners.get(file);
			if (existing) {
				onConflict(`${file} is claimed by both ${existing} and ${name}. A file may belong to one patch only.`);
				continue;
			}

			owners.set(file, name);
		}
	}

	return owners;
}
