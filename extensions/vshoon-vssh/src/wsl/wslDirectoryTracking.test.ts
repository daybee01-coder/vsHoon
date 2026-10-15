/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WSL_DIRECTORY_TRACKING_LAUNCHER, wslTerminalShellArgs } from './wslDirectoryTracking';

describe('WSL shell directory tracking', () => {
	it('launches the selected distro through the tracking launcher', () => {
		assert.deepStrictEqual(wslTerminalShellArgs('Ubuntu').slice(0, 7), [
			'-d',
			'Ubuntu',
			'--cd',
			'/',
			'--exec',
			'sh',
			'-c',
		]);
		assert.strictEqual(wslTerminalShellArgs('Ubuntu').at(-1), WSL_DIRECTORY_TRACKING_LAUNCHER);
		assert.deepStrictEqual(wslTerminalShellArgs().slice(0, 5), ['--cd', '/', '--exec', 'sh', '-c']);
	});

	it('supports common WSL shells and emits the standard VS Code cwd sequence', () => {
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /\bbash\)/);
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /\bzsh\)/);
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /\bfish\)/);
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /633;P;Cwd=/);
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /633;P;HasRichCommandDetection=False/);
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /PROMPT_COMMAND/);
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /add-zsh-hook precmd/);
		assert.match(WSL_DIRECTORY_TRACKING_LAUNCHER, /--on-event fish_prompt/);
	});
});
