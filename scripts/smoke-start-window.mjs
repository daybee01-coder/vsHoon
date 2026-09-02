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

const smokeRoot = mkdtempSync(join(tmpdir(), 'vshoon-start-window-smoke-'));
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

let output = '';
let client;
let child;

try {
	child = spawn(executable, [
		...(packageRoot ? [] : [coreRoot]),
		`--user-data-dir=${smokeRoot}`,
		`--remote-debugging-port=${debuggingPort}`,
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

	const target = await waitForStartWindowTarget(debuggingPort, child);
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
			buttons: Array.from(document.querySelectorAll('footer button')).map(button => ({ id: button.id, name: button.textContent }))
		};
	})()`);

	const { language, ...stableState } = state;
	assert.match(language, /^[A-Za-z]{2}(?:-|$)/);
	assert.deepStrictEqual(stableState, {
		activeId: 'open-folder',
		busy: 'false',
		describedBy: 'recent-navigation-help',
		emptyVisible: true,
		markLoaded: true,
		buttons: [
			{ id: 'quit', name: 'Quit' },
			{ id: 'open-empty', name: 'New Empty Window' },
			{ id: 'open-workspace', name: 'Open Workspace' },
			{ id: 'open-folder', name: 'Open Folder' }
		]
	});

	await dispatchTab(client, true);
	assert.strictEqual(await evaluate(client, 'document.activeElement?.id'), 'open-workspace');
	await dispatchTab(client, false);
	assert.strictEqual(await evaluate(client, 'document.activeElement?.id'), 'open-folder');

	const accessibilityTree = await client.send('Accessibility.getFullAXTree');
	const accessibleButtons = accessibilityTree.nodes
		.filter(node => node.role?.value === 'button')
		.map(node => node.name?.value)
		.filter(name => typeof name === 'string');
	assert.deepStrictEqual(accessibleButtons, ['Quit', 'New Empty Window', 'Open Workspace', 'Open Folder']);

	await evaluate(client, "document.getElementById('quit')?.click()");
	await waitForExit(child, 10_000);

	console.log('[vshoon] start-window smoke: brand mark, accessibility and keyboard focus passed');
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

async function waitForStartWindowTarget(port, processHandle) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (processHandle.exitCode !== null) {
			throw new Error(`VShoon exited before the start window appeared (${processHandle.exitCode}).`);
		}

		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = await response.json();
			const target = targets.find(candidate => candidate.type === 'page' && candidate.url.includes('/vs/vshoon/electron-sandbox/startWindow/startWindow.html'));
			if (target?.webSocketDebuggerUrl) {
				return target;
			}
		} catch {
			// Electron has not opened the DevTools endpoint yet.
		}

		await delay(100);
	}

	throw new Error('Timed out waiting for the VShoon start-window renderer.');
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

async function dispatchTab(connection, reverse) {
	const modifiers = reverse ? 8 : 0;
	await connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', modifiers });
	await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers });
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
	if (!isAbsolute(resolvedPath) || !resolvedPath.startsWith(`${resolvedTemp}\\`) || !basename(resolvedPath).startsWith('vshoon-start-window-smoke-')) {
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
