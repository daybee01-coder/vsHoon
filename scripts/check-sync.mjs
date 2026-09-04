/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Verifies that the pinned core, the recorded patches and the overlay still agree, and reports
 * how far the pinned core has fallen behind upstream.
 *
 * ```
 * npm run sync:check                 # local integrity plus an upstream drift report
 * npm run sync:check -- --offline    # local integrity only
 * npm run sync:check -- --try main   # also test-apply every patch to a candidate upstream ref
 * ```
 *
 * The check never writes to the core working tree, so it is safe to run at any time, including
 * against a checkout that is mid-build.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreDir, fail, git, readLock, repoRoot } from './core-paths.mjs';
import { walk } from './overlay.mjs';
import { patchOwners } from './patch-files.mjs';

const lock = readLock();
const argv = process.argv.slice(2);
const offline = argv.includes('--offline');
const tryIndex = argv.indexOf('--try');
const candidateRef = tryIndex >= 0 ? argv[tryIndex + 1] : undefined;

if (tryIndex >= 0 && !candidateRef) {
	fail('usage: npm run sync:check -- --try <upstream ref>');
}

const problems = [];
const notes = [];

console.log(`[vshoon] core ${lock.upstream.version} @ ${lock.upstream.commit.slice(0, 10)}`);

checkPatchInventory();

if (checkCoreCheckout()) {
	// A patch file that is missing was already reported; reading it would exit before the report.
	const present = lock.patches.filter(name => existsSync(join(repoRoot, 'patches', name)));
	const owners = patchOwners(present, { onConflict: problem });
	checkPatchDrift(owners);
	checkOverlayDrift();
	checkLanguagePacks();
	checkAgentAssets();

	if (candidateRef) {
		checkCandidateRef(candidateRef);
	}
}

if (!offline) {
	reportUpstreamDrift();
}

report();

function problem(message) {
	problems.push(message);
}

function note(message) {
	notes.push(message);
}

/** Every patch on disk must be applied, and every applied patch must exist. */
function checkPatchInventory() {
	const recorded = new Set(lock.patches);
	for (const name of readdirSync(join(repoRoot, 'patches')).filter(entry => entry.endsWith('.patch'))) {
		if (!recorded.has(name)) {
			problem(`patches/${name} is not listed in vshoon.lock.json, so \`npm run sync\` never applies it.`);
		}
	}

	for (const name of recorded) {
		if (!existsSync(join(repoRoot, 'patches', name))) {
			problem(`vshoon.lock.json lists ${name}, but patches/${name} is missing.`);
		}
	}
}

function checkCoreCheckout() {
	if (!existsSync(join(coreDir, '.git'))) {
		problem(`no core checkout at ${coreDir}. Run \`npm run sync\`.`);
		return false;
	}

	const head = git(['rev-parse', 'HEAD'], { capture: true }).trim();
	if (head !== lock.upstream.commit) {
		problem(`the core is at ${head.slice(0, 10)} but vshoon.lock.json pins ${lock.upstream.commit.slice(0, 10)}. Run \`npm run sync\`.`);
		return false;
	}

	return true;
}

/**
 * Compares the recorded patches with what the core working tree actually contains.
 *
 * A core edit that was never saved is invisible until the next sync throws it away, and a patch
 * that no longer matches its files silently ships a different change than the one on disk.
 */
function checkPatchDrift(owners) {
	const { commit } = lock.upstream;

	for (const name of lock.patches) {
		const files = [...owners].filter(([, owner]) => owner === name).map(([file]) => file);
		if (files.length === 0) {
			continue;
		}

		// `core.abbrev` is pinned exactly as `patch:save` pins it, so identical content
		// produces identical bytes.
		const current = git(['-c', 'core.abbrev=12', 'diff', commit, '--', ...files], { capture: true });
		if (current !== readFileSync(join(repoRoot, 'patches', name), 'utf8')) {
			problem(`${name} no longer matches the core working tree. Run \`npm run patch:save\` to record the edit, or \`npm run sync\` to discard it.`);
		}
	}

	const changed = git(['diff', '--name-status', commit], { capture: true })
		.split('\n')
		.map(line => line.split('\t'))
		.filter(([status, file]) => status && file)
		.map(([status, file]) => ({ status: status.trim(), file: file.trim() }));

	for (const { status, file } of changed) {
		// Overlay entries replace core files by design, so they read as modified here.
		if (owners.has(file) || isOverlayPath(file)) {
			continue;
		}

		// A build step can delete core sources it does not need. That is still a tree that no
		// longer matches the pin, but recording it as a patch is never the answer.
		problem(status === 'D'
			? `${file} is missing from the core. Restore it with \`git -C .core checkout -- ${file}\`, or re-run \`npm run sync\`.`
			: `${file} is edited in the core but no patch owns it. Record it with \`npm run patch:save -- --add <patch> ${file}\`, or revert it.`);
	}
}

function isOverlayPath(file) {
	return lock.overlay.some(entry => file === entry || file.startsWith(`${entry}/`));
}

/** The core copy of the overlay is a mirror; anything else there is about to be overwritten. */
function checkOverlayDrift() {
	const drifted = [];
	let compared = 0;

	for (const entry of lock.overlay) {
		const source = join(repoRoot, entry);
		if (!existsSync(source)) {
			problem(`vshoon.lock.json lists overlay entry ${entry}, which does not exist in this repository.`);
			continue;
		}

		const relativePaths = statSync(source).isFile() ? [''] : [...walk(source)];
		for (const relativePath of relativePaths) {
			compared++;
			const to = join(coreDir, entry, relativePath);
			if (!existsSync(to) || !readFileSync(join(source, relativePath)).equals(readFileSync(to))) {
				drifted.push(join(entry, relativePath));
			}
		}
	}

	if (drifted.length > 0) {
		const listed = drifted.slice(0, 5).join(', ');
		const rest = drifted.length > 5 ? `, and ${drifted.length - 5} more` : '';
		problem(`the core copy of the overlay is stale or edited: ${listed}${rest}. Run \`npm run sync\` after saving anything you changed inside the core.`);
		return;
	}

	console.log(`[vshoon] overlay: ${compared} files in sync`);
}

/** The generated language packs are not committed, so a fresh checkout has to build them. */
function checkLanguagePacks() {
	const config = lock.languagePacks;
	if (!config?.languages?.length) {
		return;
	}

	for (const { id, extension } of config.languages) {
		if (!existsSync(join(repoRoot, extension, 'package.json'))) {
			problem(`the ${id} language pack is missing from ${extension}. Run \`npm run sync:i18n\`.`);
		}
	}

	const cacheDir = join(repoRoot, '.i18n');
	if (!existsSync(join(cacheDir, '.git'))) {
		return;
	}

	const head = git(['rev-parse', 'HEAD'], { cwd: cacheDir, capture: true, silent: true }).trim();
	if (head !== config.commit) {
		problem(`the translation checkout is at ${head.slice(0, 10)} but vshoon.lock.json pins ${config.commit.slice(0, 10)}. Run \`npm run sync:i18n\`.`);
	}
}

function checkAgentAssets() {
	for (const { to } of lock.agentAssets ?? []) {
		if (!existsSync(join(repoRoot, to))) {
			problem(`the agent asset ${to} is missing. Run \`npm run sync\` to mirror it out of the core.`);
		}
	}
}

/**
 * Test-applies every patch to a candidate upstream ref without touching the working tree.
 *
 * The patches are checked against a throwaway index built from the candidate tree, so this
 * answers "will the next core bump conflict?" without checking out a second copy of the core.
 */
function checkCandidateRef(ref) {
	console.log(`[vshoon] fetching ${ref}`);
	try {
		git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', ref]);
	} catch {
		problem(`could not fetch ${ref} from ${lock.upstream.repository}.`);
		return;
	}

	const sha = git(['rev-parse', 'FETCH_HEAD'], { capture: true }).trim();
	const indexFile = join(tmpdir(), `vshoon-sync-check-${process.pid}.index`);
	const env = { GIT_INDEX_FILE: indexFile };

	try {
		git(['read-tree', sha], { env });

		const failed = lock.patches.filter(name => {
			try {
				git(['apply', '--cached', '--check', join(repoRoot, 'patches', name)], { env, capture: true });
				return false;
			} catch {
				return true;
			}
		});

		if (failed.length > 0) {
			problem(`${failed.length} patch(es) do not apply to ${ref} (${sha.slice(0, 10)}): ${failed.join(', ')}. Bump the lock on an \`upstream-sync/<version>\` branch and resolve them there.`);
			return;
		}

		note(`every patch still applies to ${ref} (${sha.slice(0, 10)}).`);
	} finally {
		rmSync(indexFile, { force: true });
	}
}

/** Reports how far the pinned commit is behind upstream without fetching any of it. */
function reportUpstreamDrift() {
	const { repository, commit, version } = lock.upstream;
	let output;
	try {
		output = git(['ls-remote', '--heads', '--tags', repository, 'main', '[0-9]*.[0-9]*.[0-9]*'], { cwd: repoRoot, capture: true });
	} catch {
		note(`could not reach ${repository}; skipped the upstream drift report. Pass --offline to skip it on purpose.`);
		return;
	}

	const refs = output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
		const [sha, ref] = line.split('\t');
		return { sha, ref };
	});

	const main = refs.find(entry => entry.ref === 'refs/heads/main');
	if (main) {
		note(main.sha === commit
			? `upstream main is the pinned commit.`
			: `upstream main is at ${main.sha.slice(0, 10)}; the core is pinned to ${commit.slice(0, 10)} (${version}).`);
	}

	const newest = refs
		.map(entry => /^refs\/tags\/(?<tag>\d+\.\d+\.\d+)$/.exec(entry.ref)?.groups?.tag)
		.filter(tag => !!tag)
		.sort(compareVersions)
		.at(-1);
	if (newest) {
		// The pinned commit comes from main, so it usually reports a version that upstream has
		// not tagged yet. The newest tag is a release marker, not a target to catch up to.
		note(newest === version
			? `the newest release tag is ${newest}, which is the pinned version.`
			: `the newest upstream release tag is ${newest}; the pinned core reports ${version}.`);
	}
}

function compareVersions(one, other) {
	const left = one.split('.').map(Number);
	const right = other.split('.').map(Number);
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) {
			return left[index] - right[index];
		}
	}

	return 0;
}

function report() {
	for (const message of notes) {
		console.log(`[vshoon] ${message}`);
	}

	if (problems.length === 0) {
		console.log('[vshoon] sync check passed');
		return;
	}

	console.error(`\n[vshoon] ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
	for (const message of problems) {
		console.error(`  - ${message}`);
	}

	console.error('');
	process.exit(1);
}
