/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { coreDir, fail, readLock } from './core-paths.mjs';

/**
 * Moves installed dependencies and generated build output from an existing Code - OSS checkout
 * into the core. A fresh core is the same commit resolved from the same lock file, so the
 * installed tree is already correct and a full `npm install` can be skipped.
 */
const source = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!source) {
	fail('usage: node scripts/adopt-core-deps.mjs <path to an existing Code - OSS checkout>');
}

if (!existsSync(join(source, 'package.json'))) {
	fail(`${source} does not look like a Code - OSS checkout`);
}

if (!existsSync(join(coreDir, 'package.json'))) {
	fail(`no core checkout at ${coreDir}. Run \`npm run sync\` first.`);
}

assertSameCore();

const moved = [];
for (const entry of collectEntries()) {
	const from = join(source, entry);
	const to = join(coreDir, entry);
	if (!existsSync(from) || existsSync(to)) {
		continue;
	}

	renameSync(from, to);
	moved.push(entry);
}

console.log(`[vshoon] adopted ${moved.length} directories from ${source}`);
for (const entry of moved) {
	console.log(`  ${entry}`);
}

/** Refuses to mix trees that were installed from a different core version. */
function assertSameCore() {
	const lock = readLock();
	const sourceVersion = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
	if (sourceVersion !== lock.upstream.version) {
		fail(`${source} is Code - OSS ${sourceVersion} but the core is pinned to ${lock.upstream.version}. ` +
			'Run `npm run core -- install` instead of adopting a mismatched tree.');
	}
}

function collectEntries() {
	const entries = ['node_modules', 'build/node_modules', 'remote/node_modules', '.build'];
	const extensions = join(source, 'extensions');
	if (existsSync(extensions)) {
		for (const name of readdirSync(extensions)) {
			const candidate = join(extensions, name, 'node_modules');
			if (existsSync(candidate) && statSync(candidate).isDirectory()) {
				entries.push(`extensions/${name}/node_modules`);
			}
		}
	}

	return entries;
}
