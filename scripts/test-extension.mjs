/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs a bundled extension's own tests against its compiled output in the core.
 *
 * The tests are the extension author's, not the core's, so they are plain `node --test` files
 * rather than part of the Workbench suite. They have to run from the core because that is where
 * the compiled `out` they import lives — the repository side carries only sources.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coreDir, fail } from './core-paths.mjs';

/** Compiled suites land in `out`; hand-written JavaScript suites stay in `test`. */
const TEST_DIRECTORIES = ['out', 'test'];

const name = process.argv[2];
if (!name) {
	fail('usage: node scripts/test-extension.mjs <extension name>, for example `vshoon-dbconn`');
}

const extensionDirectory = join(coreDir, 'extensions', name);
if (!existsSync(extensionDirectory)) {
	fail(`no extension at ${extensionDirectory}. Run \`npm run sync\` first.`);
}

const tests = TEST_DIRECTORIES
	.map(directory => join(extensionDirectory, directory))
	.filter(directory => existsSync(directory))
	.flatMap(directory => collectTests(directory))
	.sort();
if (tests.length === 0) {
	fail(`no tests found under ${extensionDirectory}. Compile the extension first.`);
}

console.log(`[vshoon] ${name}: ${tests.length} test ${tests.length === 1 ? 'file' : 'files'}`);
const result = spawnSync(process.execPath, ['--test', ...tests.map(test => relative(coreDir, test))], {
	cwd: coreDir,
	stdio: 'inherit'
});
if (result.error) {
	throw result.error;
}
process.exitCode = result.status ?? 1;

function collectTests(directory) {
	const tests = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			tests.push(...collectTests(path));
		} else if (entry.isFile() && entry.name.endsWith('.test.js')) {
			tests.push(path);
		}
	}
	return tests;
}
