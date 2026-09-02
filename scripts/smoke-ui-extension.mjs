/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const smokeRoot = mkdtempSync(join(tmpdir(), smokePrefix));
const debuggingPort = await findFreePort();
const environment = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1' };
delete environment.VSCODE_CLI;
delete environment.ELECTRON_RUN_AS_NODE;

let output = '';
let client;
let child;
const windowsVirtualKeyCodes = new Map([
	['Enter', 0x0D]
]);

try {
	child = spawn(executable, [
		coreRoot,
		`--user-data-dir=${smokeRoot}`,
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

	const target = await waitForWorkbenchTarget(debuggingPort, child);
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

	void client.send('Browser.close');
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
		await removeSmokeRoot(smokeRoot);
	} catch (error) {
		console.error(`[vshoon] unable to remove smoke profile ${smokeRoot}:`, error);
	}
}

async function findFreePort() {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : undefined;
	server.close();
	await once(server, 'close');

	if (!port) {
		throw new Error('Unable to reserve a DevTools port.');
	}

	return port;
}

async function waitForWorkbenchTarget(port, processHandle) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (processHandle.exitCode !== null) {
			throw new Error(`VShoon exited before the Workbench appeared (${processHandle.exitCode}).`);
		}

		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = await response.json();
			const target = targets.find(candidate => candidate.type === 'page' && /\/workbench(?:-dev)?\.html/.test(candidate.url));
			if (target?.webSocketDebuggerUrl) {
				return target;
			}
		} catch {
			// Electron has not opened the DevTools endpoint yet.
		}

		await delay(100);
	}

	throw new Error('Timed out waiting for the VShoon Workbench renderer.');
}

async function connect(url) {
	const socket = new WebSocket(url);
	await new Promise((resolveOpen, rejectOpen) => {
		socket.addEventListener('open', resolveOpen, { once: true });
		socket.addEventListener('error', rejectOpen, { once: true });
	});

	let requestId = 0;
	const pending = new Map();
	socket.addEventListener('close', () => {
		for (const request of pending.values()) {
			request.reject(new Error('The DevTools connection closed.'));
		}
		pending.clear();
	});
	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (!message.id) {
			return;
		}

		const request = pending.get(message.id);
		if (!request) {
			return;
		}

		pending.delete(message.id);
		if (message.error) {
			request.reject(new Error(message.error.message));
		} else {
			request.resolve(message.result);
		}
	});

	return {
		close: () => socket.close(),
		send: (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
			const id = ++requestId;
			pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
			socket.send(JSON.stringify({ id, method, params }));
		})
	};
}

async function evaluate(connection, expression) {
	const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.text);
	}

	return result.result.value;
}

async function clickElement(connection, selector) {
	const point = await evaluate(connection, `(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) {
			return undefined;
		}

		const rect = element.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	})()`);
	if (!point) {
		throw new Error(`Unable to find ${selector}.`);
	}

	await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}

async function dispatchKey(connection, { key, code, modifiers = 0 }) {
	const windowsVirtualKeyCode = windowsVirtualKeyCodes.get(code);
	const event = { key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
	await connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
	await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

async function waitForCondition(connection, expression, label) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (await evaluate(connection, expression)) {
			return;
		}

		await delay(100);
	}

	throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForExit(processHandle, timeout) {
	if (processHandle.exitCode !== null) {
		return;
	}

	await Promise.race([
		once(processHandle, 'exit'),
		delay(timeout).then(() => { throw new Error('Timed out waiting for VShoon to exit.'); })
	]);
}

function delay(milliseconds) {
	return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function retainTail(current, addition) {
	return `${current}${addition}`.slice(-8_000);
}

async function removeSmokeRoot(path) {
	const resolvedPath = resolve(path);
	const resolvedTemp = resolve(tmpdir());
	if (!isAbsolute(resolvedPath) || !resolvedPath.startsWith(`${resolvedTemp}\\`) || !basename(resolvedPath).startsWith(smokePrefix)) {
		throw new Error(`Refusing to remove unexpected smoke path: ${resolvedPath}`);
	}

	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			rmSync(resolvedPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
			return;
		} catch (error) {
			if (attempt === 9) {
				throw error;
			}

			await delay(500);
		}
	}
}
