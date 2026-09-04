/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stages the Monaco distribution that VSearch's preview pane loads.
 *
 * The payload is Microsoft's, MIT licensed, released on its own schedule and about 16MB, so it is
 * treated the way the language packs are: pinned as a shared extension dependency, generated on
 * demand, never committed. A webview cannot read `node_modules` because it sits outside every
 * `localResourceRoots` entry, so the files have to be copied under the extension's `media`.
 *
 * The copy is generated on the repository side rather than inside the core on purpose: mirroring
 * the overlay removes whatever the core copy holds that the sources do not, so a payload written
 * straight into the core would disappear on the next build.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coreDir, fail, repoRoot } from './core-paths.mjs';

/** Language services (TypeScript, CSS, HTML and JSON completion) run in web workers the preview never starts. */
const EXCLUDED_DIRECTORIES = new Set(['language']);

const source = join(coreDir, 'extensions', 'node_modules', 'monaco-editor', 'min', 'vs');
const target = join(repoRoot, 'extensions', 'vshoon-vsearch', 'media', 'monaco', 'vs');

if (!existsSync(source)) {
	fail(`monaco-editor is not installed at ${source}. Run \`npm run core -- install\` first.`);
}

const wanted = new Set();
let copied = 0;
for (const relativePath of walk(source)) {
	wanted.add(relativePath);
	const from = join(source, relativePath);
	const to = join(target, relativePath);
	const fromStat = statSync(from);
	const toStat = existsSync(to) ? statSync(to) : undefined;
	if (toStat && toStat.size === fromStat.size && Math.abs(toStat.mtimeMs - fromStat.mtimeMs) < 1) {
		continue;
	}

	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);

	// Copying the timestamp is what lets this script and the overlay mirror skip unchanged files.
	utimesSync(to, fromStat.atime, fromStat.mtime);
	copied++;
}

let removed = 0;
if (existsSync(target)) {
	for (const relativePath of walk(target)) {
		if (!wanted.has(relativePath)) {
			rmSync(join(target, relativePath));
			removed++;
		}
	}
}

console.log(`[vshoon] vsearch monaco: ${wanted.size} files staged (${copied} copied, ${removed} removed)`);

function* walk(directory) {
	const stack = [''];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const child of readdirSync(join(directory, current), { withFileTypes: true })) {
			const relativePath = current ? join(current, child.name) : child.name;
			if (child.isDirectory()) {
				if (!current && EXCLUDED_DIRECTORIES.has(child.name)) {
					continue;
				}

				stack.push(relativePath);
			} else if (child.isFile()) {
				yield relativePath;
			}
		}
	}
}
