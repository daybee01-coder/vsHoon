/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, watch } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreDir, readLock, repoRoot } from './core-paths.mjs';

/**
 * Mirrors the VShoon sources into the core checkout.
 *
 * The overlay is copied rather than linked on purpose. Several upstream build steps walk the
 * tree with `readdirSync(..., { withFileTypes: true })` and skip anything whose `isDirectory()`
 * is false, which is exactly how a Windows junction reports itself. A copied tree is
 * indistinguishable from core sources to every tool.
 */
export function mirrorOverlay({ quiet = false } = {}) {
	const lock = readLock();
	let copied = 0;
	let removed = 0;
	const stale = [];

	for (const entry of lock.overlay) {
		const source = join(repoRoot, entry);
		const destination = join(coreDir, entry);
		const sourceStat = statSync(source);

		if (sourceStat.isFile()) {
			const destinationStat = existsSync(destination) ? statSync(destination) : undefined;
			if (destinationStat && destinationStat.size === sourceStat.size && Math.abs(destinationStat.mtimeMs - sourceStat.mtimeMs) < 1) {
				continue;
			}

			if (destinationStat && destinationStat.mtimeMs > sourceStat.mtimeMs) {
				stale.push(entry);
			}

			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(source, destination);
			utimesSync(destination, sourceStat.atime, sourceStat.mtime);
			copied++;
			continue;
		}

		const wanted = new Set();

		for (const relativePath of walk(source)) {
			wanted.add(relativePath);
			const from = join(source, relativePath);
			const to = join(destination, relativePath);
			const fromStat = statSync(from);
			const toStat = existsSync(to) ? statSync(to) : undefined;

			if (toStat && toStat.size === fromStat.size && Math.abs(toStat.mtimeMs - fromStat.mtimeMs) < 1) {
				continue;
			}

			if (toStat && toStat.mtimeMs > fromStat.mtimeMs) {
				stale.push(join(entry, relativePath));
			}

			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
			utimesSync(to, fromStat.atime, fromStat.mtime);
			copied++;
		}

		for (const relativePath of walk(destination)) {
			if (!wanted.has(relativePath)) {
				rmSync(join(destination, relativePath), { force: true });
				removed++;
			}
		}
	}

	if (stale.length > 0) {
		console.warn(`\n[vshoon] overwrote newer files in the core. Edit them in the VShoon repo, not in .core:`);
		for (const file of stale) {
			console.warn(`  ${file}`);
		}
		console.warn('');
	}

	if (!quiet && (copied > 0 || removed > 0)) {
		console.log(`[vshoon] overlay: ${copied} copied, ${removed} removed`);
	}

	return { copied, removed };
}

export function watchOverlay() {
	const lock = readLock();
	mirrorOverlay();
	console.log('[vshoon] watching the overlay for changes');

	let pending;
	for (const entry of lock.overlay) {
		const source = join(repoRoot, entry);
		watch(source, { recursive: statSync(source).isDirectory() }, () => {
			clearTimeout(pending);
			pending = setTimeout(() => mirrorOverlay(), 50);
		});
	}
}

export function* walk(directory) {
	if (!existsSync(directory)) {
		return;
	}

	const stack = [''];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const child of readdirSync(join(directory, current), { withFileTypes: true })) {
			const relativePath = current ? `${current}${sep}${child.name}` : child.name;
			if (child.isDirectory()) {
				stack.push(relativePath);
			} else if (child.isFile()) {
				yield relativePath;
			}
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	if (process.argv.includes('--watch')) {
		watchOverlay();
	} else {
		mirrorOverlay();
	}
}
