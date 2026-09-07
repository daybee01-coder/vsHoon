/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickElement, connect, createSmokeProfile, delay, dispatchKey, evaluate, findFreePort, isWorkbenchTarget, removeSmokeProfile, retainTail, waitForCondition, waitForExit, waitForPageTarget, writeSmokeSettings } from './smoke-driver.mjs';

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
		title: '연결 추가',
		size: { width: 760, height: 625 }
	},
	{
		extension: 'vshoon-vssh',
		command: '새 세션 추가',
		commandMatch: '새 세션 추가',
		title: 'VSsh: 새 세션',
		size: { width: 540, height: 560 }
	},
	{
		extension: 'vshoon-vsearch',
		command: 'VSearch: 전체 검색 열기',
		commandMatch: '전체 검색 열기',
		title: 'VSearch',
		size: { width: 1200, height: 700 }
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

// A source-only checkout has no extension entry points, and its modals would simply never appear.
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
		sizeMatches: true,
		panelTabs: 0
	});

	console.log(`[vshoon] ${modal.extension}: opened as an accessible modal, not an editor tab`);
}

console.log(`[vshoon] modal-webview smoke: ${MODALS.length} bundled panels passed`);

async function verifyModal(modal) {
	const smokePrefix = `vshoon-modal-${modal.extension}-smoke-`;
	const smokeRoot = createSmokeProfile(smokePrefix);

	// The overlay a first run puts in front of the Workbench would swallow every click below.
	// `chat.agentsControl.enabled` defaults to `compact`, and the moment chat finishes enabling
	// the unified agents bar takes the command centre over and hides its search box for good.
	// Every Quick Access step below goes through that box, so the default turns this run into a
	// race: the first open usually wins it and a later one never does.
	writeSmokeSettings(smokeRoot, {
		'workbench.welcomePage.experimentalOnboarding': false,
		'chat.agentsControl.enabled': 'hidden'
	});

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
		if (process.argv.includes('--remember-layout')) {
			await verifyRememberedLayout(client, modal);
		}
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

async function openModal(connection, modal, activated = false) {
	const title = JSON.stringify(modal.title);
	const size = JSON.stringify(modal.size);
	const overridesShortcut = modal.extension === 'vshoon-vsearch';

	// Nothing activates a bundled extension until one of its commands runs, and the shortcut VSearch
	// takes over only exists once it has. Running the command through Quick Access is how the first
	// open waits for that. A reopen already has the extension running, so going back through Quick
	// Access would only add a step that can fail.
	if (!overridesShortcut || !activated) {
		// The title bar measures 0x0 for a while after a layout, and a click on a zero sized element
		// lands on its top left corner — the window icon, not the search box. Even once it measures,
		// a click that arrives while the window is still taking focus is simply dropped, so this asks
		// again rather than failing the run on the first miss.
		await waitForCondition(
			connection,
			"(() => { const r = document.querySelector('.command-center-quick-pick')?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })()",
			`command centre for ${modal.extension}`
		);
		for (let attempt = 1; ; attempt++) {
			await clickElement(connection, '.command-center-quick-pick');
			try {
				await waitForCondition(connection, "document.querySelector('.quick-input-widget')?.style.display === ''", `Quick Access for ${modal.extension}`, 5_000);
				break;
			} catch (error) {
				if (attempt === 4) {
					throw error;
				}
			}
		}
		await connection.send('Input.insertText', { text: `>${modal.command}` });
		await waitForCondition(
			connection,
			`document.querySelector('.quick-input-widget input')?.value === ${JSON.stringify(`>${modal.command}`)}`,
			`${modal.extension} command text`
		);

		// Quick Access keeps re-filtering after the first matching row lands, and Enter runs whichever
		// row is focused at that instant. Waiting for the match to be the focused row is what makes the
		// keystroke hit this command rather than whatever the previous filter pass left behind. On a
		// cold profile the extension host can still be registering commands, so this waits as long as
		// the panel itself is given.
		await waitForCondition(
			connection,
			`document.querySelector('.quick-input-list .monaco-list-row.focused')?.textContent?.includes(${JSON.stringify(modal.commandMatch)}) === true`,
			`${modal.extension} command result`,
			40_000
		);
	}

	if (overridesShortcut) {
		if (!activated) {
			await dispatchKey(connection, { key: 'Escape', code: 'Escape' });
			await waitForCondition(connection, "document.querySelector('.quick-input-widget')?.style.display === 'none'", 'Quick Access closed');
		}

		// Ctrl+Shift+F is the binding VSearch takes over from the built-in search, so opening the
		// panel this way is what proves the override reaches a real build.
		await connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F', code: 'KeyF', modifiers: 10, windowsVirtualKeyCode: 70 });
		await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F', code: 'KeyF', modifiers: 10, windowsVirtualKeyCode: 70 });
	} else {
		await dispatchKey(connection, { key: 'Enter', code: 'Enter' });
	}

	// The extension host has to activate the extension before the panel exists, so the overlay is
	// what the test waits on rather than the command returning.
	await waitForCondition(connection, "document.querySelector('.monaco-modal-editor-block .modal-editor-part') !== null", `${modal.extension} modal overlay`, 40_000);
	await waitForCondition(connection, WEBVIEW_IN_DIALOG, `${modal.extension} webview`, 20_000);
	await waitForCondition(connection, `document.querySelector('.modal-editor-title')?.textContent?.includes(${title}) === true`, `${modal.extension} modal title`);

	return evaluate(connection, `(() => {
		const modal = document.querySelector('.monaco-modal-editor-block .modal-editor-part');
		const modalBounds = document.querySelector('.monaco-modal-editor-block .modal-editor-resizable')?.getBoundingClientRect();
		const requestedSize = ${size};
		return {
			extension: ${JSON.stringify(modal.extension)},
			role: modal?.getAttribute('role'),
			ariaModal: modal?.getAttribute('aria-modal'),
			labelledBy: modal?.getAttribute('aria-labelledby') === document.querySelector('.modal-editor-title')?.id,
			title: document.querySelector('.modal-editor-title')?.textContent?.includes(${title}) === true,
			webviewInDialog: ${WEBVIEW_IN_DIALOG},
			sizeMatches: !!modalBounds
				&& Math.abs(modalBounds.width - requestedSize.width) <= 1
				&& Math.abs(modalBounds.height - requestedSize.height) <= 1,

			// The empty window still carries its own Welcome tab, so the negative half of the
			// assertion looks for this panel by its title rather than counting tabs.
			panelTabs: Array.from(document.querySelectorAll('.part.editor:not(.modal-editor-part) .tabs-container .tab'))
				.filter(tab => tab.textContent?.includes(${title})).length
		};
	})()`);
}

/**
 * Reads the modal geometry once it stops moving.
 *
 * A drag repositions the modal during the gesture and upstream lays it out again when the pointer
 * goes up, so a read taken straight after the release can catch a position that is still on its way
 * somewhere else — and comparing that against what a reopen restores fails for no good reason.
 */
async function settledBounds(connection) {
	let previous = await modalBounds(connection);
	for (let attempt = 0; attempt < 40; attempt++) {
		await delay(100);
		const current = await modalBounds(connection);
		if (current.left === previous.left && current.top === previous.top && current.width === previous.width && current.height === previous.height) {
			return current;
		}

		previous = current;
	}

	return previous;
}

/**
 * Closes the modal through its header button.
 *
 * The button needs the pointer over it before the press, but the header is also the drag handle:
 * moving with the button already down — which a zero-length drag still does — reads as a drag
 * gesture whose mouseup closes nothing. So move first, then press and release without moving.
 */
async function closeModal(connection) {
	const point = await evaluate(connection, `(() => {
		const r = document.querySelector('.modal-editor-header .codicon-close').getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
	await evaluate(connection, 'new Promise(resolve => requestAnimationFrame(resolve))');
	await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
	await waitForCondition(connection, "!document.querySelector('.monaco-modal-editor-block')", 'modal closed');
}

async function modalBounds(connection) {
	await waitForCondition(connection, "document.querySelector('.modal-editor-resizable') !== null", 'modal geometry');
	return evaluate(connection, `(() => {
		const r = document.querySelector('.modal-editor-resizable').getBoundingClientRect();
		return { left: r.left, top: r.top, width: r.width, height: r.height };
	})()`);
}

async function drag(connection, x, y, dx, dy) {
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
	await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
	await evaluate(connection, 'new Promise(resolve => requestAnimationFrame(resolve))');
	for (let step = 1; step <= 5; step++) {
		await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * step / 5, y: y + dy * step / 5, button: 'left', buttons: 1 });
	}
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1 });
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, buttons: 0 });
	await evaluate(connection, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function verifyRememberedLayout(connection, modal) {
	const before = await settledBounds(connection);

	// A panel as wide as the window is clamped to the viewport, which puts both side edges out of
	// reach and pins it horizontally — VSearch asks for 1200 in a 1200 wide window. Height and
	// vertical position are the two degrees of freedom every declared panel keeps, so the check
	// drives those and stays the same shape for all three.
	await drag(connection, before.left + before.width / 2, before.top + before.height + 1, 0, -70);
	const resized = await settledBounds(connection);

	// Upstream snaps a modal back to centre from within 20px and then deliberately stores no custom
	// position at all, so a small nudge would be remembered as "centred" and prove nothing. Shrinking
	// the panel moves that centre down by half the height it lost, which is enough on its own to pull
	// a modest drag back into the snap. Dragging into the top edge clamps at the title bar offset:
	// far from centre, and the same value every run. Aim at the top of the viewport rather than a
	// fixed distance, because a pointer taken above the window stops having its moves delivered.
	const grabY = resized.top + 15;
	await drag(connection, resized.left + 80, grabY, 0, 5 - grabY);
	const changed = await settledBounds(connection);
	assert.ok(changed.height < before.height - 30, `resize changed modal height: ${JSON.stringify({ before, resized, changed })}`);
	// A panel that already sits near the top can only climb a few pixels before it clamps, so the
	// check is that it moved, not how far. What makes the move count is the distance it puts between
	// the modal and centre: every declared panel ends up well past the 20px snap once it is clamped.
	assert.ok(changed.top < resized.top, `drag changed modal position: ${JSON.stringify({ before, resized, changed })}`);
	await closeModal(connection);
	// Closing restores focus asynchronously after disposing the overlay. Let that finish
	// before opening Quick Access, which otherwise loses focus and dismisses itself.
	await evaluate(connection, 'new Promise(resolve => setTimeout(resolve, 500))');
	await openModal(connection, modal, true);
	assert.deepStrictEqual(await settledBounds(connection), changed, `${modal.extension} restores position and size ${JSON.stringify({ before, resized, changed })}`);
}
