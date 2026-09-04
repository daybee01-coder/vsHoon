/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The core checkout is the build root. `VSHOON_CORE_DIR` points a session at a shared checkout. */
export const coreDir = process.env['VSHOON_CORE_DIR']
	? resolve(process.env['VSHOON_CORE_DIR'])
	: join(repoRoot, '.core');

export function readLock() {
	return JSON.parse(readFileSync(join(repoRoot, 'vshoon.lock.json'), 'utf8'));
}

/**
 * Runs git with LFS smudging disabled. The core carries ~271 MB of LFS test fixtures that
 * VShoon never builds or runs, and they are only ever needed as pointer files here.
 */
export function git(args, { cwd = coreDir, capture = false, silent = false, env } = {}) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', silent ? 'pipe' : 'inherit'] : ['ignore', silent ? 'pipe' : 'inherit', silent ? 'pipe' : 'inherit'],
		env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', ...env }
	});
}

export function fail(message) {
	console.error(`\n[vshoon] ${message}\n`);
	process.exit(1);
}
