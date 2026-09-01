/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coreDir, fail, git, readLock, repoRoot } from './core-paths.mjs';
import { mirrorOverlay } from './overlay.mjs';

const lock = readLock();
const { repository, commit, version } = lock.upstream;

console.log(`[vshoon] core ${version} @ ${commit.slice(0, 10)}`);
console.log(`[vshoon] path ${coreDir}`);

fetchCore();
resetToPinnedCommit();
applyPatches();
mirrorOverlay();
linkAgentAssets();

console.log(`\n[vshoon] core is ready. Build from it with \`npm run core -- run <script>\`.`);

/** Creates the core checkout as a shallow, blobless clone so no history or LFS data is pulled. */
function fetchCore() {
	if (!existsSync(join(coreDir, '.git'))) {
		console.log('[vshoon] creating core checkout');
		mkdirSync(coreDir, { recursive: true });
		git(['init', '--quiet']);
		git(['remote', 'add', 'origin', repository]);

		// The overlay and installed dependencies live inside the core but are not part of it.
		const excludes = [...lock.overlay, 'node_modules', 'out', '.build'].map(entry => `/${entry}`);
		appendFileSync(join(coreDir, '.git', 'info', 'exclude'), `\n# VShoon\n${excludes.join('\n')}\n`);
	}

	git(['remote', 'set-url', 'origin', repository]);

	if (isPinnedCommitPresent()) {
		console.log('[vshoon] pinned commit already fetched');
		return;
	}

	console.log('[vshoon] fetching pinned commit (depth 1, blobless, no LFS)');
	git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', commit]);
}

function isPinnedCommitPresent() {
	try {
		return git(['cat-file', '-t', commit], { capture: true }).trim() === 'commit';
	} catch {
		return false;
	}
}

/** Discards any previously applied patch so that patches always apply to a pristine tree. */
function resetToPinnedCommit() {
	console.log('[vshoon] resetting core to the pinned commit');
	git(['checkout', '--force', '--detach', commit]);
}

function applyPatches() {
	for (const name of lock.patches) {
		const file = join(repoRoot, 'patches', name);
		if (!existsSync(file)) {
			fail(`missing patch ${name}. The core cannot be built without it.`);
		}

		console.log(`[vshoon] applying ${name}`);
		try {
			git(['apply', '--3way', file]);
		} catch {
			fail(`${name} did not apply to ${commit.slice(0, 10)}.\n` +
				`Resolve it in ${coreDir}, then run \`npm run patch:save\` to rewrite the patch.`);
		}
	}
}

/**
 * Mirrors the agent instructions and skills that the core owns. They are gitignored here
 * because they are upstream content, not VShoon content.
 */
function linkAgentAssets() {
	const instructions = join(coreDir, '.github', 'copilot-instructions.md');
	if (existsSync(instructions)) {
		mkdirSync(join(repoRoot, '.claude'), { recursive: true });
		copyFileSync(instructions, join(repoRoot, '.claude', 'CLAUDE.md'));
	}

	const skills = join(coreDir, '.agents', 'skills');
	if (existsSync(skills)) {
		replaceLink(join(repoRoot, '.claude', 'skills'), skills);
	}
}

function replaceLink(link, target) {
	if (existsSync(link) || isBrokenLink(link)) {
		rmSync(link, { recursive: true, force: true });
	}

	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function isBrokenLink(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
