/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreDir, fail, git, readLock, repoRoot } from './core-paths.mjs';
import { patchOwners } from './patch-files.mjs';

const lock = readLock();
const { commit } = lock.upstream;
const addIndex = process.argv.indexOf('--add');
const expandedPatch = addIndex >= 0 ? process.argv[addIndex + 1] : undefined;
const expandedFiles = addIndex >= 0 ? process.argv.slice(addIndex + 2) : [];

if (addIndex >= 0 && (!expandedPatch || expandedFiles.length === 0)) {
	fail('usage: npm run patch:save -- --add <patch-name> <core-file>...');
}

if (expandedPatch && !lock.patches.includes(expandedPatch)) {
	fail(`${expandedPatch} is not listed in vshoon.lock.json.`);
}

if (!existsSync(join(coreDir, '.git'))) {
	fail(`no core checkout at ${coreDir}. Run \`npm run sync\` first.`);
}

// A patch that `--add` is creating has no file to read ownership from yet.
const owners = patchOwners(lock.patches.filter(name => name !== expandedPatch || existsSync(join(repoRoot, 'patches', name))));

for (const name of lock.patches) {
	const additions = name === expandedPatch ? expandedFiles : [];
	for (const file of additions) {
		if (file.startsWith('/') || file.startsWith('\\') || file.split(/[\\/]/).includes('..')) {
			fail(`refusing core path outside the checkout: ${file}`);
		}

		const existing = owners.get(file);
		if (existing && existing !== name) {
			fail(`${file} is already claimed by ${existing}.`);
		}

		owners.set(file, name);
	}

	const files = [...owners].filter(([, owner]) => owner === name).map(([file]) => file);
	// `core.abbrev` is pinned so that the same change always produces the same patch bytes,
	// no matter how many objects the core checkout happens to hold.
	const diff = git(['-c', 'core.abbrev=12', 'diff', commit, '--', ...files], { capture: true });
	writeFileSync(join(repoRoot, 'patches', name), diff, 'utf8');
	console.log(`[vshoon] saved ${name} (${files.length} file${files.length === 1 ? '' : 's'})`);
}
