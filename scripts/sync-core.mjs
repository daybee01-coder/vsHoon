/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
mirrorAgentAssets();

console.log(`\n[vshoon] core is ready. Build from it with \`npm run core -- run <script>\`.`);

/** Creates the core checkout as a shallow, blobless clone so no history or LFS data is pulled. */
function fetchCore() {
	if (!existsSync(join(coreDir, '.git'))) {
		console.log('[vshoon] creating core checkout');
		mkdirSync(coreDir, { recursive: true });
		git(['init', '--quiet']);
		git(['remote', 'add', 'origin', repository]);

		// Git for Windows enables autocrlf system wide. Left on, the core working tree is
		// CRLF and every generated patch carries CRLF, which then fails to apply on an LF
		// checkout. Pinning it here keeps patches identical on every platform.
		git(['config', 'core.autocrlf', 'false']);
		git(['config', 'core.eol', 'lf']);

		// GIT_LFS_SKIP_SMUDGE only covers git run through this script. Disabling the smudge
		// filter in the core's own config makes it stick for any git command anyone runs
		// there, so the ~271 MB of LFS fixtures stay pointer files.
		git(['config', 'filter.lfs.smudge', 'git-lfs smudge --skip -- %f']);
		git(['config', 'filter.lfs.process', 'git-lfs filter-process --skip']);

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
 * Mirrors files the core owns into the paths agent tooling looks for.
 *
 * Both ends are configuration in `vshoon.lock.json`, so relocating the repository or pointing
 * an asset somewhere else never needs a code change.
 */
function mirrorAgentAssets() {
	const assets = lock.agentAssets ?? [];
	if (assets.length === 0) {
		return;
	}

	let mirrored = 0;
	for (const asset of assets) {
		const { from, to, mode = 'copy' } = asset;
		if (!from || !to) {
			fail(`an agentAssets entry is missing "from" or "to": ${JSON.stringify(asset)}`);
		}

		if (mode !== 'copy' && mode !== 'link') {
			fail(`agentAssets entry "${to}" has unknown mode "${mode}". Use "copy" or "link".`);
		}

		const source = join(coreDir, from);
		const destination = join(repoRoot, to);
		if (!existsSync(source)) {
			console.warn(`[vshoon] agent asset ${from} is not part of this core, skipping ${to}`);
			continue;
		}

		remove(destination);
		mkdirSync(dirname(destination), { recursive: true });
		if (mode === 'copy') {
			cpSync(source, destination, { recursive: true });
		} else {
			// A junction records an absolute path, so it dangles if the repository moves and
			// stays broken until the next sync. `copy` is the safer default for small assets.
			symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
		}

		mirrored++;
	}

	ignoreAgentAssets(assets.map(asset => asset.to));
	console.log(`[vshoon] agent assets: ${mirrored} mirrored`);
}

/**
 * Keeps the mirrored paths out of Git through `.git/info/exclude` rather than `.gitignore`,
 * so that relocating an asset stays a change to `vshoon.lock.json` alone.
 */
function ignoreAgentAssets(paths) {
	let excludeFile;
	try {
		const gitDir = git(['rev-parse', '--git-dir'], { cwd: repoRoot, capture: true }).trim();
		excludeFile = join(resolve(repoRoot, gitDir), 'info', 'exclude');
	} catch {
		return; // not a Git checkout, so there is nothing to ignore
	}

	const begin = '# >>> vshoon agent assets';
	const end = '# <<< vshoon agent assets';
	const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
	const beginIndex = current.indexOf(begin);
	const endIndex = current.indexOf(end);
	const withoutBlock = beginIndex !== -1 && endIndex > beginIndex
		? current.slice(0, beginIndex) + current.slice(endIndex + end.length)
		: current;
	const entries = paths.map(path => `/${path.split(sep).join('/')}`);

	mkdirSync(dirname(excludeFile), { recursive: true });
	writeFileSync(excludeFile, `${withoutBlock.trimEnd()}\n\n${[begin, ...entries, end].join('\n')}\n`, 'utf8');
}

/** Removes a path even when it is a link whose target no longer exists. */
function remove(path) {
	try {
		lstatSync(path);
	} catch {
		return;
	}

	rmSync(path, { recursive: true, force: true });
}
