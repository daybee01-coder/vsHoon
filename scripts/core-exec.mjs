/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { coreDir, fail } from './core-paths.mjs';
import { mirrorOverlay } from './overlay.mjs';

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

const result = spawnSync('npm', args, { cwd: coreDir, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
