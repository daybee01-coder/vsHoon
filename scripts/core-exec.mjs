/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { coreDir, fail, git } from './core-paths.mjs';
import { mirrorOverlay } from './overlay.mjs';
import { getVShoonSourceVersion } from './source-version.mjs';

/**
 * Core files a build step stamps in place, and that the core tree must not keep.
 *
 * `extensions/copilot/.esbuild.mts` rewrites its own `package.json` with a build type, a
 * pre-release flag and a version whenever `BUILD_SOURCEVERSION` is set — which VShoon always sets,
 * to key the product's caches to the fork's sources rather than to the core's Git HEAD. The stamp
 * belongs in the packaged extension, so it is applied before packaging and reverted after: no
 * patch owns that file, and `sync:check` is right to refuse a core edit that none does.
 */
const BUILD_STAMPED_CORE_FILES = ['extensions/copilot/package.json'];

const args = process.argv.slice(2);
if (args.length === 0) {
	fail('usage: npm run core -- <npm arguments>, for example `npm run core -- run compile`');
}

if (!existsSync(join(coreDir, 'package.json'))) {
	fail(`no core checkout at ${coreDir}. Run \`npm run sync\` first.`);
}

// Every route into the core mirrors the overlay first, so a build can never run against
// stale VShoon sources.
mirrorOverlay({ quiet: true });

if (args[0] !== 'install' && args[0] !== 'ci' && !existsSync(join(coreDir, 'node_modules'))) {
	fail('the core has no dependencies installed. Run `npm run core -- install` first.');
}

const result = spawnSync('npm', args, {
	cwd: coreDir,
	stdio: 'inherit',
	shell: process.platform === 'win32',
	env: {
		...process.env,
		BUILD_SOURCEVERSION: getVShoonSourceVersion(),

		// Setting BUILD_SOURCEVERSION is what makes upstream's Copilot bundler take its build
		// pipeline path, and that path insists on a declared quality. `stable` is the value that
		// means "not a pre-release"; the only other place the core build reads it is
		// `build/lib/builtInExtensions.ts`, which compares it against `insider` alone, so it
		// behaves exactly as an unset variable does there.
		VSCODE_QUALITY: process.env.VSCODE_QUALITY ?? 'stable'
	}
});

restoreBuildStampedFiles();
process.exit(result.status ?? 1);

function restoreBuildStampedFiles() {
	for (const file of BUILD_STAMPED_CORE_FILES) {
		if (!existsSync(join(coreDir, file)) || !isStamped(file)) {
			continue;
		}

		try {
			git(['checkout', '--', file], { silent: true });
		} catch (error) {
			console.warn(`[vshoon] could not restore ${file} in the core: ${error.message}`);
		}
	}
}

/** `git diff --quiet` reports a difference through its exit code, so anything else is a failure. */
function isStamped(file) {
	try {
		git(['diff', '--quiet', '--', file], { silent: true });

		return false;
	} catch (error) {
		if (error.status === 1) {
			return true;
		}

		console.warn(`[vshoon] could not check ${file} in the core: ${error.message}`);

		return false;
	}
}
