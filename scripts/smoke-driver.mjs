/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * The Electron and DevTools plumbing that every VShoon smoke test needs.
 *
 * A smoke test drives a real development build over the DevTools protocol, so each one has to
 * reserve a port, find its renderer target, speak CDP and remove its throwaway profile again.
 * Only the assertions differ between them, and those stay in the individual scripts.
 */

/**
 * Keys whose Windows virtual-key code the renderer needs to see.
 *
 * Chromium synthesizes text from `key`, but the Workbench reads the native code for keybindings.
 * A key that is absent here is dispatched without a code, which is what plain navigation keys
 * such as Tab want.
 */
const windowsVirtualKeyCodes = new Map([
	['Enter', 0x0D]
]);

export async function findFreePort() {
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

export function createSmokeProfile(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Seeds a throwaway profile's user settings before the product reads them.
 *
 * A first run is not a quiet one. `workbench.welcomePage.experimentalOnboarding` puts a
 * full-window overlay in front of the Workbench for new users, and every synthesized click then
 * lands on that overlay instead of the thing under test — intermittently, because whether it is
 * up yet depends on how fast the renderer got there.
 */
export function writeSmokeSettings(profileRoot, settings) {
	const userDirectory = join(profileRoot, 'User');
	mkdirSync(userDirectory, { recursive: true });
	writeFileSync(join(userDirectory, 'settings.json'), `${JSON.stringify(settings, undefined, '	')}
`, 'utf8');
}

export async function waitForPageTarget(port, processHandle, predicate, description) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (processHandle.exitCode !== null) {
			throw new Error(`VShoon exited before the ${description} appeared (${processHandle.exitCode}).`);
		}

		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = await response.json();
			const target = targets.find(candidate => candidate.type === 'page' && predicate(candidate));
			if (target?.webSocketDebuggerUrl) {
				return target;
			}
		} catch {
			// Electron has not opened the DevTools endpoint yet.
		}

		await delay(100);
	}

	throw new Error(`Timed out waiting for the ${description}.`);
}

export function isWorkbenchTarget(candidate) {
	return /\/workbench(?:-dev)?\.html/.test(candidate.url);
}

export async function connect(url) {
	const socket = new WebSocket(url);
	await new Promise((resolveOpen, rejectOpen) => {
		socket.addEventListener('open', resolveOpen, { once: true });
		socket.addEventListener('error', rejectOpen, { once: true });
	});

	let requestId = 0;
	const pending = new Map();
	const exceptions = [];
	socket.addEventListener('close', () => {
		for (const request of pending.values()) {
			request.reject(new Error('The DevTools connection closed.'));
		}
		pending.clear();
	});
	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		if (!message.id) {
			if (message.method === 'Runtime.exceptionThrown') {
				const details = message.params?.exceptionDetails;
				exceptions.push(details?.exception?.description ?? details?.text ?? 'Unknown renderer exception');
			}
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
		exceptions,
		close: () => socket.close(),
		send: (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
			const id = ++requestId;
			pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
			socket.send(JSON.stringify({ id, method, params }));
		})
	};
}

export async function evaluate(connection, expression) {
	const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.text);
	}

	return result.result.value;
}

export async function clickElement(connection, selector) {
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

	await clickPoint(connection, point);
}

async function clickPoint(connection, { x, y }) {
	await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
}

export async function dispatchKey(connection, { key, code, modifiers = 0 }) {
	const windowsVirtualKeyCode = windowsVirtualKeyCodes.get(code);
	const event = { key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
	await connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
	await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

export async function waitForCondition(connection, expression, label, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await evaluate(connection, expression)) {
			return;
		}

		await delay(100);
	}

	throw new Error(`Timed out waiting for ${label}.`);
}

export async function waitForExit(processHandle, timeout) {
	if (processHandle.exitCode !== null) {
		return;
	}

	await Promise.race([
		once(processHandle, 'exit'),
		delay(timeout).then(() => { throw new Error('Timed out waiting for VShoon to exit.'); })
	]);
}

export function delay(milliseconds) {
	return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

export function retainTail(current, addition) {
	return `${current}${addition}`.slice(-8_000);
}

/**
 * Removes a throwaway profile, refusing anything that is not one.
 *
 * The path is built from `tmpdir()` and a prefix the caller owns, and a smoke test runs with a
 * live Electron process next to it, so the guard is worth its two lines: a recursive delete of
 * the wrong directory is not recoverable.
 */
export async function removeSmokeProfile(path, prefix) {
	const resolvedPath = resolve(path);
	const resolvedTemp = resolve(tmpdir());
	if (!isAbsolute(resolvedPath) || !resolvedPath.startsWith(`${resolvedTemp}${sep}`) || !basename(resolvedPath).startsWith(prefix)) {
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
