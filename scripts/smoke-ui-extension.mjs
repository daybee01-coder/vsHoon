/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickElement, connect, createSmokeProfile, dispatchKey, evaluate, findFreePort, isWorkbenchTarget, removeSmokeProfile, retainTail, waitForCondition, waitForExit, waitForPageTarget, writeSmokeSettings } from './smoke-driver.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = join(repoRoot, '.core');
const product = JSON.parse(readFileSync(join(coreRoot, 'product.json'), 'utf8'));
const executable = process.platform === 'win32'
	? join(coreRoot, '.build', 'electron', `${product.nameShort}.exe`)
	: undefined;

if (!executable || !existsSync(executable)) {
	throw new Error('The UI-extension smoke test currently requires a built Windows development executable. Run `npm run build` first.');
}

const smokePrefix = 'vshoon-ui-extension-smoke-';
const smokeRoot = createSmokeProfile(smokePrefix);

// The overlay a first run puts in front of the Workbench would swallow every click below.
writeSmokeSettings(smokeRoot, { 'workbench.welcomePage.experimentalOnboarding': false });

const debuggingPort = await findFreePort();
const environment = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1' };
delete environment.VSCODE_CLI;
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VSCODE_PORTABLE;
delete environment.VSCODE_PORTABLE_TEMP;

let output = '';
let client;
let child;

try {
	child = spawn(executable, [
		coreRoot,
		`--user-data-dir=${smokeRoot}`,

		// Shared application storage is keyed to the home directory, not to the user data
		// directory, so an isolated run has to name its own.
		`--shared-data-dir=${join(smokeRoot, 'shared')}`,
		`--remote-debugging-port=${debuggingPort}`,
		'--disable-start-window',
		'--no-cached-data',
		'--log=trace'
	], {
		cwd: coreRoot,
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});

	child.stdout.on('data', data => output = retainTail(output, data.toString()));
	child.stderr.on('data', data => output = retainTail(output, data.toString()));

	const target = await waitForPageTarget(debuggingPort, child, isWorkbenchTarget, 'Workbench renderer');
	client = await connect(target.webSocketDebuggerUrl);
	await client.send('Runtime.enable');
	await waitForCondition(client, "document.querySelector('.monaco-workbench') !== null", 'Workbench shell');
	await client.send('Page.bringToFront');
	await evaluate(client, 'window.focus()');

	await clickElement(client, '.command-center-quick-pick');
	await waitForCondition(client, "document.querySelector('.quick-input-widget')?.style.display === ''", 'Quick Access');
	await client.send('Input.insertText', { text: '>Run VShoon UI Sample' });
	await waitForCondition(client, "Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).some(row => row.textContent?.includes('Run VShoon UI Sample'))", 'sample command result');

	await dispatchKey(client, { key: 'Enter', code: 'Enter' });
	await waitForCondition(client, "Array.from(document.querySelectorAll('.notification-list-item')).some(item => item.textContent?.includes('VShoon UI capability sample command ran.'))", 'sample command notification');

	const state = await evaluate(client, `(() => ({
		workbench: document.querySelector('.monaco-workbench') !== null,
		notification: Array.from(document.querySelectorAll('.notification-list-item')).some(item => item.textContent?.includes('VShoon UI capability sample command ran.'))
	}))()`);
	assert.deepStrictEqual(state, { workbench: true, notification: true });

	// Closing the browser tears down the socket the request is waiting on, so its rejection is
	// expected rather than a failure.
	client.send('Browser.close').catch(() => undefined);
	await waitForExit(child, 10_000);

	console.log('[vshoon] UI-extension smoke: Workbench scan, command fallback and activation passed');
} catch (error) {
	if (output) {
		console.error(output);
	}

	throw error;
} finally {
	client?.close();
	if (child && child.exitCode === null) {
		child.kill();
		await waitForExit(child, 5_000).catch(() => undefined);
	}

	try {
		await removeSmokeProfile(smokeRoot, smokePrefix);
	} catch (error) {
		console.error(`[vshoon] unable to remove smoke profile ${smokeRoot}:`, error);
	}
}
