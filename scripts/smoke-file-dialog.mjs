/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickElement, connect, createSmokeProfile, delay, dispatchKey, evaluate, findFreePort, isWorkbenchTarget, removeSmokeProfile, retainTail, waitForCondition, waitForExit, waitForPageTarget, writeSmokeSettings } from './smoke-driver.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = join(repoRoot, '.core');
const product = JSON.parse(readFileSync(join(coreRoot, 'product.json'), 'utf8'));
const executable = join(coreRoot, '.build', 'electron', `${product.nameShort}.exe`);
assert.ok(process.platform === 'win32' && existsSync(executable), 'Run npm run build on Windows first.');
// An unexpected portable directory overrides --user-data-dir and breaks profile isolation.
assert.ok(!existsSync(join(coreRoot, 'data')), 'Move the development portable data directory before running this isolated smoke test.');

const prefix = 'vshoon-file-dialog-smoke-';
const profile = createSmokeProfile(prefix);
const fixture = join(profile, 'fixture');
mkdirSync(fixture);
const sourceFile = join(fixture, 'original.txt');
const savedFile = join(fixture, 'saved.txt');
writeFileSync(sourceFile, 'VShoon file dialog smoke\n');
writeSmokeSettings(profile, {
	'files.simpleDialog.enable': true,
	'workbench.welcomePage.experimentalOnboarding': false,
	'workbench.startupEditor': 'none',
	'chat.agentsControl.enabled': 'hidden'
});

let child;
let client;
let output = '';
try {
	const port = await findFreePort();
	const environment = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1' };
	for (const key of ['VSCODE_CLI', 'ELECTRON_RUN_AS_NODE', 'VSCODE_PORTABLE', 'VSCODE_PORTABLE_TEMP']) {
		delete environment[key];
	}
	child = spawn(executable, [coreRoot, sourceFile, `--user-data-dir=${profile}`, `--shared-data-dir=${join(profile, 'shared')}`,
		`--extensions-dir=${join(profile, 'extensions')}`, `--remote-debugging-port=${port}`, '--disable-start-window', '--locale=en', '--no-cached-data'], {
		cwd: coreRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
	});
	child.stdout.on('data', data => output = retainTail(output, data.toString()));
	child.stderr.on('data', data => output = retainTail(output, data.toString()));
	const target = await waitForPageTarget(port, child, isWorkbenchTarget, 'Workbench renderer');
	client = await connect(target.webSocketDebuggerUrl);
	await client.send('Runtime.enable');
	await waitForCondition(client, "!!document.querySelector('.monaco-workbench .monaco-editor')", 'text editor', 60_000);
	await client.send('Page.bringToFront');
	await evaluate(client, 'window.focus()');

	for (const action of ['escape', 'cancel', 'save']) {
		await clickElement(client, '.monaco-editor textarea');
		await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'S', code: 'KeyS', modifiers: 10, windowsVirtualKeyCode: 83 });
		await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'S', code: 'KeyS', modifiers: 10, windowsVirtualKeyCode: 83 });
		await waitForCondition(client, "(document.querySelector('.vshoon-file-dialog')?.getClientRects().length ?? 0) > 0", 'VShoon Save As dialog');
		assert.deepStrictEqual(await evaluate(client, `(() => {
			const root = document.querySelector('.vshoon-file-dialog');
			return { role: root.getAttribute('role'), modal: root.getAttribute('aria-modal'), focused: document.activeElement === root.querySelector('input') };
		})()`), { role: 'dialog', modal: 'true', focused: true });

		if (action === 'escape') {
			await dispatchKey(client, { key: 'Escape', code: 'Escape' });
		} else if (action === 'cancel') {
			await clickElement(client, '.vshoon-file-dialog-footer button:not(.primary)');
		} else {
			await evaluate(client, `document.querySelector('.vshoon-file-dialog-path').value = ${JSON.stringify(savedFile)}`);
			await dispatchKey(client, { key: 'Enter', code: 'Enter' });
		}
		// QuickInput keeps its hidden widget DOM until another input replaces it.
		await waitForCondition(client, "(document.querySelector('.vshoon-file-dialog')?.getClientRects().length ?? 0) === 0", 'dialog dismissed');
		await waitForCondition(client, "!!document.activeElement?.closest('.monaco-editor')", 'editor focus restored');
		if (action !== 'save') {
			assert.equal(existsSync(savedFile), false, 'cancel must not save a file');
		}
		console.log(`[vshoon] file dialog: ${action}, dismissal and focus restoration passed`);
	}
	for (let attempt = 0; attempt < 50 && !existsSync(savedFile); attempt++) {
		await delay(100);
	}
	assert.equal(readFileSync(sourceFile, 'utf8'), 'VShoon file dialog smoke\n');
	assert.equal(readFileSync(savedFile, 'utf8'), 'VShoon file dialog smoke\n');
	assert.deepStrictEqual(client.exceptions, []);
	client.send('Browser.close').catch(() => undefined);
	await waitForExit(child, 10_000);
	console.log('[vshoon] file dialog smoke passed; only the temporary fixture was written');
} catch (error) {
	console.error(output);
	throw error;
} finally {
	client?.close();
	if (child && child.exitCode === null) {
		child.kill();
		await waitForExit(child, 5_000).catch(() => undefined);
	}
	await removeSmokeProfile(profile, prefix);
}
