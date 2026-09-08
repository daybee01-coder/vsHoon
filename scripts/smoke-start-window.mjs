/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, createSmokeProfile, delay, dispatchKey, evaluate, findFreePort, removeSmokeProfile, retainTail, waitForExit, waitForPageTarget } from './smoke-driver.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = join(repoRoot, '.core');
const product = JSON.parse(readFileSync(join(coreRoot, 'product.json'), 'utf8'));
const packageIndex = process.argv.indexOf('--package');
const packageRoot = packageIndex >= 0 ? resolve(repoRoot, process.argv[packageIndex + 1] ?? '') : undefined;
const executable = process.platform === 'win32'
	? join(packageRoot ?? join(coreRoot, '.build', 'electron'), `${product.nameShort}.exe`)
	: undefined;

if (!executable || !existsSync(executable)) {
	throw new Error(packageRoot
		? `The packaged VShoon executable does not exist at ${executable}.`
		: 'The start-window smoke test currently requires a built Windows development executable. Run `npm run build` first.');
}

const smokePrefix = 'vshoon-start-window-smoke-';
const smokeRoot = createSmokeProfile(smokePrefix);
const debuggingPort = await findFreePort();
const environment = { ...process.env };
if (packageRoot) {
	delete environment.NODE_ENV;
	delete environment.VSCODE_DEV;
} else {
	environment.NODE_ENV = 'development';
	environment.VSCODE_DEV = '1';
}
delete environment.VSCODE_CLI;
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.VSCODE_PORTABLE;
delete environment.VSCODE_PORTABLE_TEMP;

let output = '';
let client;
let child;

try {
	child = spawn(executable, [
		...(packageRoot ? [] : [coreRoot]),
		`--user-data-dir=${smokeRoot}`,

		// Recent projects live in the shared application storage, which is keyed to the home
		// directory rather than the user data directory: without this the launcher would list
		// whatever the developer opened last and the assertions below would depend on it.
		`--shared-data-dir=${join(smokeRoot, 'shared')}`,
		`--remote-debugging-port=${debuggingPort}`,

		// The assertions below name English labels, and VShoon ships a Korean display language by
		// default. `--locale` outranks every other source, so the test reads the same on any
		// machine and in any profile state.
		'--locale=en',
		'--no-cached-data',
		'--log=trace'
	], {
		cwd: packageRoot ?? coreRoot,
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});

	child.stdout.on('data', data => output = retainTail(output, data.toString()));
	child.stderr.on('data', data => output = retainTail(output, data.toString()));

	const target = await waitForPageTarget(debuggingPort, child, candidate => candidate.url.includes('/vs/vshoon/electron-sandbox/startWindow/startWindow.html'), 'VShoon start-window renderer');
	client = await connect(target.webSocketDebuggerUrl);
	await client.send('Runtime.enable');
	await client.send('Accessibility.enable');
	await waitForRendererReady(client);

	const state = await evaluate(client, `(async () => {
		const mark = document.querySelector('.product-mark');
		await mark?.decode().catch(() => undefined);

		return {
			activeId: document.activeElement?.id,
			busy: document.getElementById('recent-list')?.getAttribute('aria-busy'),
			describedBy: document.getElementById('recent-list')?.getAttribute('aria-describedby'),
			emptyVisible: !document.getElementById('empty-state')?.hidden,
			markLoaded: mark?.naturalWidth > 0,
			language: document.documentElement.lang,
			theme: document.documentElement.dataset.vscodeTheme,
			background: getComputedStyle(document.body).backgroundColor,
			customTitleBar: document.body.classList.contains('custom-titlebar'),
			titleBarDisplay: getComputedStyle(document.querySelector('.window-titlebar')).display,
			titleBarBorderBottomWidth: getComputedStyle(document.querySelector('.window-titlebar')).borderBottomWidth,
			actionsNearBottom: window.innerHeight - document.querySelector('.actions').getBoundingClientRect().bottom < 60,
			sectionTitle: document.getElementById('recent-title')?.textContent,
			sectionHeadingDisplay: getComputedStyle(document.querySelector('.section-heading')).display,
			buttons: Array.from(document.querySelectorAll('footer button')).map(button => ({ id: button.id, name: button.textContent }))
		};
	})()`);

	const { language, theme, background, ...stableState } = state;
	assert.match(language, /^[A-Za-z]{2}(?:-|$)/);
	assert.match(theme, /^(?:vs|vs-dark|hc-black|hc-light)$/);
	assert.match(background, /^rgba?\(/);
	assert.deepStrictEqual(stableState, {
		activeId: 'open-folder',
		busy: 'false',
		describedBy: 'recent-navigation-help',
		emptyVisible: true,
		markLoaded: true,
		customTitleBar: true,
		titleBarDisplay: 'flex',
		titleBarBorderBottomWidth: '0px',
		actionsNearBottom: true,
		sectionTitle: 'Recent Projects',
		sectionHeadingDisplay: 'flex',
		buttons: [
			{ id: 'quit', name: 'Quit' },
			{ id: 'open-empty', name: 'New Empty Window' },
			{ id: 'open-workspace', name: 'Open Workspace' },
			{ id: 'open-folder', name: 'Open Folder' }
		]
	});

	await dispatchKey(client, { key: 'Tab', code: 'Tab', modifiers: 8 });
	assert.strictEqual(await evaluate(client, 'document.activeElement?.id'), 'open-workspace');
	await dispatchKey(client, { key: 'Tab', code: 'Tab' });
	assert.strictEqual(await evaluate(client, 'document.activeElement?.id'), 'open-folder');

	const accessibilityTree = await client.send('Accessibility.getFullAXTree');
	const accessibleButtons = accessibilityTree.nodes
		.filter(node => node.role?.value === 'button')
		.map(node => node.name?.value)
		.filter(name => typeof name === 'string');
	assert.deepStrictEqual(accessibleButtons, ['Quit', 'New Empty Window', 'Open Workspace', 'Open Folder']);

	await evaluate(client, "document.getElementById('open-empty')?.click()");
	client.close();
	client = undefined;

	const workbenchTarget = await waitForPageTarget(debuggingPort, child, candidate => candidate.url.includes('workbench/workbench.html') || candidate.url.includes('workbench/workbench-dev.html'), 'VShoon Workbench renderer');
	client = await connect(workbenchTarget.webSocketDebuggerUrl);
	await client.send('Runtime.enable');
	await waitForWorkbenchReady(client);

	const workbenchState = await evaluate(client, `({
		ready: Boolean(document.querySelector('.monaco-workbench')),
		bodyChildren: document.body.childElementCount,
		title: document.title
	})`);
	assert.strictEqual(workbenchState.ready, true, `Workbench did not initialize: ${JSON.stringify(workbenchState)}`);

	await client.send('Page.bringToFront');
	await evaluate(client, 'window.focus()');
	await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'N', code: 'KeyN', modifiers: 10, windowsVirtualKeyCode: 78 });
	await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'N', code: 'KeyN', modifiers: 10, windowsVirtualKeyCode: 78 });
	const newWindowTarget = await waitForPageTarget(debuggingPort, child, candidate => candidate.url.includes('/vs/vshoon/electron-sandbox/startWindow/startWindow.html'), 'start window opened by the Workbench New Window action');
	const newWindowClient = await connect(newWindowTarget.webSocketDebuggerUrl);
	await newWindowClient.send('Runtime.enable');
	await waitForRendererReady(newWindowClient);
	assert.strictEqual(await evaluate(newWindowClient, "document.getElementById('product-name')?.textContent"), 'vs Hoon');
	await evaluate(newWindowClient, "document.getElementById('quit')?.click()").catch(() => undefined);
	newWindowClient.close();
	await delay(250);
	assert.strictEqual(await evaluate(client, "Boolean(document.querySelector('.monaco-workbench'))"), true, 'Closing the secondary start window also closed the existing Workbench.');

	// A workbench that loses a contribution still renders, so the shell being up proves less than
	// it looks like. This has already happened once: removing the Copilot onboarding contribution
	// left `IOnboardingService` unregistered, and the startup page runner — a constructor
	// dependency away — stopped being created, with only this log line to show for it.
	assert.deepStrictEqual(await readContributionHealth(smokeRoot), { logsRead: true, failures: [] });

	console.log('[vshoon] start-window smoke: launcher accessibility, Workbench transition, New Window action and contribution health passed');
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

async function waitForRendererReady(connection) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await evaluate(connection, "document.getElementById('recent-list')?.getAttribute('aria-busy') === 'false'")) {
			return;
		}

		await delay(50);
	}

	throw new Error('Timed out waiting for the recent-project model to render.');
}

async function waitForWorkbenchReady(connection) {
	const deadline = Date.now() + 40_000;
	while (Date.now() < deadline) {
		if (connection.exceptions.length > 0) {
			throw new Error(`Workbench renderer exception: ${connection.exceptions.join('\n')}`);
		}

		if (await evaluate(connection, "Boolean(document.querySelector('.monaco-workbench'))")) {
			return;
		}

		await delay(50);
	}

	throw new Error('Timed out waiting for the Workbench to initialize.');
}

/**
 * Reports every workbench contribution the renderer failed to create.
 *
 * Failing to instantiate a contribution is written to the log and nowhere else: no renderer
 * exception, no missing DOM, nothing a smoke test would notice on its own. `logsRead` is part of
 * the result because the renderer writes its log a moment after the DOM appears, and a check that
 * reads no log at all would pass for the wrong reason.
 */

async function readContributionHealth(profileRoot) {
	const deadline = Date.now() + 10_000;
	let logs = [];
	while (Date.now() < deadline) {
		logs = logFiles(join(profileRoot, 'logs')).filter(file => file.endsWith('renderer.log'));
		if (logs.length > 0) {
			break;
		}

		await delay(100);
	}

	const failures = [];
	for (const file of logs) {
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (line.includes('Unable to create workbench contribution')) {
				failures.push(line.trim());
			}
		}
	}

	return { logsRead: logs.length > 0, failures };
}

function logFiles(directory) {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}

	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...logFiles(path));
		} else if (entry.isFile() && statSync(path).size > 0) {
			files.push(path);
		}
	}

	return files;
}
