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

/**
 * Proves that VSH-0010 routes every bundled extension's declared webview into the modal editor.
 *
 * None of these panels asks for anything modal: each calls the stable `createWebviewPanel` with
 * an ordinary view column. So the only way to know the product seam is wired end to end is to run
 * the commands in a real build and look at where the panel landed — a unit test can only prove
 * that the registry accepted the declaration.
 *
 * The negative half of each assertion matters just as much. If the seam stops matching the
 * extension id or the view type, the panel silently opens as an ordinary editor tab, which is
 * exactly the behavior these extensions were merged to be rid of.
 *
 * Each case gets its own instance. Driving all three through one window means closing a modal
 * between them, and the title bar measures 0x0 for a while afterwards, so the next command centre
 * click lands on the window icon behind it. A launch per case costs a few seconds and leaves no
 * state to carry between cases.
 */

/** One case per declared `vshoon.ui.modalWebviews` view type. */
const MODALS = [
	{
		extension: 'vshoon-dbconn',
		command: 'DBConn: 커넥션 추가',
		commandMatch: '커넥션 추가',
		title: '연결 추가'
	},
	{
		extension: 'vshoon-vssh',
		command: '새 세션 추가',
		commandMatch: '새 세션 추가',
		title: 'VSsh: 새 세션'
	},
	{
		extension: 'vshoon-vsearch',
		command: 'VSearch: 전체 검색 열기',
		commandMatch: '전체 검색 열기',
		title: 'VSearch'
	}
];

/**
 * Whether a webview iframe is laid out inside the modal dialog.
 *
 * Webviews are overlays positioned over their editor rather than children of it, so the panel
 * cannot be found by walking the modal's DOM. The Workbench also keeps webviews of its own
 * around — the welcome page has one — which is why containment is the question and a global
 * count is not.
 */
const WEBVIEW_IN_DIALOG = `(() => {
	const dialog = document.querySelector('.monaco-modal-editor-block .modal-editor-part');
	if (!dialog) {
		return false;
	}

	const bounds = dialog.getBoundingClientRect();
	return Array.from(document.querySelectorAll('iframe.webview')).some(frame => {
		const rect = frame.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0
			&& rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
			&& rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
	});
})()`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = join(repoRoot, '.core');
const product = JSON.parse(readFileSync(join(coreRoot, 'product.json'), 'utf8'));
const executable = process.platform === 'win32'
	? join(coreRoot, '.build', 'electron', `${product.nameShort}.exe`)
	: undefined;

if (!executable || !existsSync(executable)) {
	throw new Error('The modal-webview smoke test currently requires a built Windows development executable. Run `npm run build` first.');
}

// Mirroring the overlay removes anything the core copy holds that the sources do not, and the
// compiled extensions live exactly there. So a plain `npm test` between a build and this run
// leaves an extension without an entry point, and its modal would simply never appear.
for (const modal of MODALS) {
	if (!existsSync(join(coreRoot, 'extensions', modal.extension, 'out', 'extension.js'))) {
		throw new Error(`The bundled ${modal.extension} extension is not compiled. Run \`npm run build\` first.`);
	}
}

for (const modal of MODALS) {
	assert.deepStrictEqual(await verifyModal(modal), {
		extension: modal.extension,
		role: 'dialog',
		ariaModal: 'true',
		labelledBy: true,
		title: true,
		webviewInDialog: true,
		panelTabs: 0
	});

	console.log(`[vshoon] ${modal.extension}: opened as an accessible modal, not an editor tab`);
}

console.log(`[vshoon] modal-webview smoke: ${MODALS.length} bundled panels passed`);

async function verifyModal(modal) {
	const smokePrefix = `vshoon-modal-${modal.extension}-smoke-`;
	const smokeRoot = createSmokeProfile(smokePrefix);

	// The overlay a first run puts in front of the Workbench would swallow every click below.
	writeSmokeSettings(smokeRoot, { 'workbench.welcomePage.experimentalOnboarding': false });

	const debuggingPort = await findFreePort();
	const environment = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1' };
	delete environment.VSCODE_CLI;
	delete environment.ELECTRON_RUN_AS_NODE;

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
		await waitForCondition(client, "document.querySelector('.monaco-workbench') !== null", 'Workbench shell', 60_000);
		await client.send('Page.bringToFront');
		await evaluate(client, 'window.focus()');

		const state = await openModal(client, modal);
		assert.deepStrictEqual(client.exceptions, []);

		// Closing the browser tears down the socket the request is waiting on, so its rejection is
		// expected rather than a failure.
		client.send('Browser.close').catch(() => undefined);
		await waitForExit(child, 10_000);

		return state;
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
}

async function openModal(connection, modal) {
	const title = JSON.stringify(modal.title);
	await clickElement(connection, '.command-center-quick-pick');
	await waitForCondition(connection, "document.querySelector('.quick-input-widget')?.style.display === ''", `Quick Access for ${modal.extension}`);
	await connection.send('Input.insertText', { text: `>${modal.command}` });
	await waitForCondition(
		connection,
		`Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).some(row => row.textContent?.includes(${JSON.stringify(modal.commandMatch)}))`,
		`${modal.extension} command result`
	);
	await dispatchKey(connection, { key: 'Enter', code: 'Enter' });

	// The extension host has to activate the extension before the panel exists, so the overlay is
	// what the test waits on rather than the command returning.
	await waitForCondition(connection, "document.querySelector('.monaco-modal-editor-block .modal-editor-part') !== null", `${modal.extension} modal overlay`, 40_000);
	await waitForCondition(connection, WEBVIEW_IN_DIALOG, `${modal.extension} webview`, 20_000);
	await waitForCondition(connection, `document.querySelector('.modal-editor-title')?.textContent?.includes(${title}) === true`, `${modal.extension} modal title`);

	return evaluate(connection, `(() => {
		const modal = document.querySelector('.monaco-modal-editor-block .modal-editor-part');
		return {
			extension: ${JSON.stringify(modal.extension)},
			role: modal?.getAttribute('role'),
			ariaModal: modal?.getAttribute('aria-modal'),
			labelledBy: modal?.getAttribute('aria-labelledby') === document.querySelector('.modal-editor-title')?.id,
			title: document.querySelector('.modal-editor-title')?.textContent?.includes(${title}) === true,
			webviewInDialog: ${WEBVIEW_IN_DIALOG},

			// The empty window still carries its own Welcome tab, so the negative half of the
			// assertion looks for this panel by its title rather than counting tabs.
			panelTabs: Array.from(document.querySelectorAll('.part.editor:not(.modal-editor-part) .tabs-container .tab'))
				.filter(tab => tab.textContent?.includes(${title})).length
		};
	})()`);
}
