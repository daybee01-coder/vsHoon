/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreDir, repoRoot } from './core-paths.mjs';
import { mirrorOverlay } from './overlay.mjs';
import { connect, createSmokeProfile, delay, evaluate, findFreePort, isWorkbenchTarget, removeSmokeProfile, retainTail, waitForCondition, waitForExit, waitForPageTarget, writeSmokeSettings } from './smoke-driver.mjs';

mirrorOverlay({ quiet: true });
const cfrPath = process.env.VSHOON_TEST_CFR_PATH ?? join(repoRoot, '.build', 'tools', 'cfr', 'cfr-0.152.jar');
assert.ok(existsSync(cfrPath), 'Set VSHOON_TEST_CFR_PATH to a CFR JAR to run the desktop integration test.');
const product = JSON.parse(readFileSync(join(coreDir, 'product.json'), 'utf8'));
const executable = join(coreDir, '.build', 'electron', `${product.nameShort}.exe`);
assert.ok(existsSync(executable), 'Run npm run build first.');
const prefix = 'vshoon-decom-smoke-';
const profile = createSmokeProfile(prefix);
const project = join(profile, 'project');
const debugPort = await findFreePort();
let child;
let output = '';
let passed = false;

function digest(filePath) {
	return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function rowExpression(label) {
	return `Array.from(document.querySelectorAll('.explorer-folders-view .monaco-list-row')).some(row => row.textContent?.includes(${JSON.stringify(label)}))`;
}

async function rowPoint(client, label) {
	return evaluate(client, `(() => {
		const row = Array.from(document.querySelectorAll('.explorer-folders-view .monaco-list-row')).find(candidate => candidate.textContent?.includes(${JSON.stringify(label)}));
		if (!row) { return undefined; }
		const rect = row.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	})()`);
}

async function clickRow(client, label, doubleClick = false) {
	const point = await rowPoint(client, label);
	assert.ok(point, `Unable to locate the Explorer row: ${label}`);
	await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
	await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
	if (doubleClick) {
		await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 2, ...point });
		await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 2, ...point });
	}
}

async function expandRow(client, label) {
	const state = await evaluate(client, `(() => {
		const row = Array.from(document.querySelectorAll('.explorer-folders-view .monaco-list-row')).find(candidate => candidate.textContent?.includes(${JSON.stringify(label)}));
		if (!row) { return undefined; }
		const twistie = row.querySelector('.monaco-tl-twistie');
		if (!twistie) { return { expanded: row.getAttribute('aria-expanded') }; }
		const rect = twistie.getBoundingClientRect();
		return { expanded: row.getAttribute('aria-expanded'), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	})()`);
	assert.ok(state, `Unable to locate the Explorer row: ${label}`);
	if (state.expanded === 'true') {
		return;
	}
	assert.equal(state.expanded, 'false', `Explorer row is not expandable: ${label}`);
	await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: state.x, y: state.y });
	await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: state.x, y: state.y });
	await waitForCondition(client, `Array.from(document.querySelectorAll('.explorer-folders-view .monaco-list-row')).some(row => row.textContent?.includes(${JSON.stringify(label)}) && row.getAttribute('aria-expanded') === 'true')`, `the expanded ${label} row`, 30_000);
}

async function shortcut(client, key, code, windowsVirtualKeyCode, modifiers) {
	const event = { key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
	await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
	await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

/**
 * A class that the JAR batch already prepared opens straight from the cache and never writes a
 * temporary input, so the invariant is that nothing is left behind, not that the folder exists.
 */
async function waitForClassCleanup(directory, timeout = 120_000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (!existsSync(directory) || readdirSync(directory).length === 0) {
			return;
		}
		await delay(200);
	}
	throw new Error('Timed out waiting for the temporary CFR class input to be removed.');
}

try {
	mkdirSync(project);
	writeFileSync(join(project, 'App.java'), 'package example; public class App { public static void main(String[] a) { System.out.println("ran"); } }');
	writeFileSync(join(project, 'Deep.java'), 'package deep; public class Deep { public String value() { return "deep"; } }');
	writeFileSync(join(project, 'resource.txt'), 'original');
	writeFileSync(join(project, 'nested-only.txt'), 'inside nested jar');
	writeFileSync(join(project, 'manifest.txt'), ['Main-Class: example.App', 'Custom-Header: keep-me', ''].join('\n'));

	for (const [command, args] of [
		['javac', ['--release', '17', '-d', project, join(project, 'App.java')]],
		['javac', ['--release', '17', '-d', join(project, 'BOOT-INF', 'classes'), join(project, 'Deep.java')]],
		['jar', ['--create', '--file', join(project, 'inner.jar'), '-C', project, 'nested-only.txt']]
	]) {
		const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
		assert.equal(result.status, 0, result.stderr || result.error?.message);
	}
	mkdirSync(join(project, 'BOOT-INF', 'lib'), { recursive: true });
	copyFileSync(join(project, 'inner.jar'), join(project, 'BOOT-INF', 'lib', 'inner.jar'));
	rmSync(join(project, 'inner.jar'));
	rmSync(join(project, 'nested-only.txt'));

	const archive = spawnSync('jar', ['--create', '--file', join(project, 'sample.jar'), '--manifest', join(project, 'manifest.txt'),
		'-C', project, 'example', '-C', project, 'BOOT-INF', '-C', project, 'resource.txt'], { encoding: 'utf8', windowsHide: true });
	assert.equal(archive.status, 0, archive.stderr || archive.error?.message);
	for (const name of ['App.java', 'Deep.java', 'manifest.txt', 'resource.txt', 'example', 'BOOT-INF']) {
		rmSync(join(project, name), { force: true, recursive: true });
	}
	const originalDigest = digest(join(project, 'sample.jar'));

	const workspaceFile = join(profile, 'sample.code-workspace');
	writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: project }] }));
	writeSmokeSettings(profile, {
		'decom.cfr.jarPath': cfrPath,
		'explorer.compactFolders': false,
		'security.workspace.trust.enabled': false,
		'chat.disableAIFeatures': true
	});
	const environment = { ...process.env, VSCODE_DEV: '1', NODE_ENV: 'development' };
	for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_CLI', 'VSCODE_PORTABLE', 'VSCODE_PORTABLE_TEMP']) delete environment[key];
	child = spawn(executable, [coreDir, workspaceFile, `--user-data-dir=${profile}`, `--shared-data-dir=${join(profile, 'shared')}`,
		`--remote-debugging-port=${debugPort}`, `--extensionDevelopmentPath=${join(coreDir, 'extensions', 'vshoon-decom')}`,
		'--disable-extensions', '--skip-welcome', '--skip-release-notes', '--locale=en'], {
		cwd: coreDir, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.on('data', data => output = retainTail(output, data.toString()));
	child.stderr.on('data', data => output = retainTail(output, data.toString()));	const target = await waitForPageTarget(debugPort, child, isWorkbenchTarget, 'Decom Workbench', 90_000);
	const client = await connect(target.webSocketDebuggerUrl);
	try {
		await waitForCondition(client, rowExpression('sample.jar'), 'the sample JAR Explorer row', 90_000);
		await expandRow(client, 'sample.jar');
		await waitForCondition(client, rowExpression('resource.txt'), 'a virtual JAR child', 30_000);
		assert.equal(await evaluate(client, `Array.from(document.querySelectorAll('.tabs-container .tab')).every(tab => !tab.textContent?.includes('sample.jar'))`), true);

		await expandRow(client, 'BOOT-INF');
		await waitForCondition(client, rowExpression('classes'), 'the nested classes folder', 30_000);
		await expandRow(client, 'classes');
		await waitForCondition(client, rowExpression('deep'), 'the nested package folder', 30_000);
		await expandRow(client, 'deep');
		await waitForCondition(client, rowExpression('Deep.class'), 'the virtual class row', 30_000);
		await clickRow(client, 'Deep.class', true);
		await waitForCondition(client, `document.querySelector('.tabs-container .tab.active')?.textContent?.includes('Deep.java') === true`, 'the decompiled Java source editor', 120_000);
		await waitForCondition(client, `Array.from(document.querySelectorAll('.view-lines .view-line')).some(line => line.textContent?.includes('value'))`, 'the decompiled Java source', 30_000);
		assert.equal(await evaluate(client, `document.querySelectorAll('.margin-view-overlays .line-numbers').length > 0`), true, 'The decompiled source editor did not show line numbers.');
		const classInput = join(profile, 'User', 'globalStorage', 'vshoon.vshoon-decom', 'class-input');
		await waitForClassCleanup(classInput);

		await expandRow(client, 'lib');
		await waitForCondition(client, rowExpression('inner.jar'), 'the nested JAR row', 30_000);
		await expandRow(client, 'inner.jar');
		await waitForCondition(client, rowExpression('nested-only.txt'), 'the nested JAR virtual child', 30_000);

		await clickRow(client, 'resource.txt', true);
		await waitForCondition(client, `document.querySelector('.tabs-container .tab.active')?.textContent?.includes('resource.txt') === true`, 'the read-only resource editor', 30_000);
		await shortcut(client, 'a', 'KeyA', 65, 2);
		await client.send('Input.insertText', { text: 'must stay read only' });
		await shortcut(client, 's', 'KeyS', 83, 2);
		await delay(500);
		assert.equal(await evaluate(client, `document.querySelector('.tabs-container .tab.active')?.classList.contains('dirty') === true`), false);
	} finally {
		client.close();
	}

	child.kill();
	await waitForExit(child, 10_000).catch(() => undefined);
	assert.equal(digest(join(project, 'sample.jar')), originalDigest, 'The read-only VFS changed the source JAR.');
	assert.equal(existsSync(join(project, 'sample.jar.decom-bak')), false, 'Read-only browsing created a backup.');
	const extractedCache = join(profile, 'User', 'globalStorage', 'vshoon.vshoon-decom', 'jars');
	assert.equal(existsSync(extractedCache), false, 'Read-only browsing extracted the whole JAR.');
	const sourceCache = join(profile, 'User', 'globalStorage', 'vshoon.vshoon-decom', 'class-sources-v2');
	assert.equal(existsSync(sourceCache), true, 'Background decompilation did not create a persistent source cache.');
	assert.ok(readdirSync(sourceCache).some(name => name.endsWith('.java')), 'The persistent source cache contains no Java source.');
	const classInput = join(profile, 'User', 'globalStorage', 'vshoon.vshoon-decom', 'class-input');
	if (existsSync(classInput)) {
		assert.deepEqual(readdirSync(classInput), [], 'A temporary CFR class input was not removed.');
	}
	console.log('[vshoon] Decom desktop smoke: read-only VFS, cached Java editor with line numbers, nested JAR, no extraction and unchanged source passed');
	passed = true;
} catch (error) {
	console.error(output);
	throw error;
} finally {
	if (child && child.exitCode === null) {
		child.kill();
		await waitForExit(child, 5_000).catch(() => undefined);
	}
	try {
		if (!passed) {
			console.error(`[vshoon] retained failed smoke profile for diagnosis: ${profile}`);
		} else {
			await removeSmokeProfile(profile, prefix);
		}
	} catch (error) {
		console.error(`[vshoon] unable to remove smoke profile ${profile}:`, error);
	}
}
