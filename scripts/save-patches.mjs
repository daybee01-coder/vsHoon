/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreDir, fail, git, readLock, repoRoot } from './core-paths.mjs';

const lock = readLock();
const { commit } = lock.upstream;

if (!existsSync(join(coreDir, '.git'))) {
	fail(`no core checkout at ${coreDir}. Run \`npm run sync\` first.`);
}

const owners = new Map();
for (const name of lock.patches) {
	for (const file of filesOf(name)) {
		const existing = owners.get(file);
		if (existing) {
			fail(`${file} is claimed by both ${existing} and ${name}. A file may belong to one patch only.`);
		}

		owners.set(file, name);
	}
}

for (const name of lock.patches) {
	const files = [...owners].filter(([, owner]) => owner === name).map(([file]) => file);
	// `core.abbrev` is pinned so that the same change always produces the same patch bytes,
	// no matter how many objects the core checkout happens to hold.
	const diff = git(['-c', 'core.abbrev=12', 'diff', commit, '--', ...files], { capture: true });
	writeFileSync(join(repoRoot, 'patches', name), diff, 'utf8');
	console.log(`[vshoon] saved ${name} (${files.length} file${files.length === 1 ? '' : 's'})`);
}

/** Reads the files a patch owns out of the patch itself, so the mapping never drifts. */
function filesOf(name) {
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
