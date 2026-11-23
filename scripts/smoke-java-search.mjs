/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreDir } from './core-paths.mjs';
import { connect, createSmokeProfile, delay, evaluate, findFreePort, isWorkbenchTarget, removeSmokeProfile, retainTail, waitForCondition, waitForExit, waitForPageTarget, writeSmokeSettings } from './smoke-driver.mjs';

const product = JSON.parse(readFileSync(join(coreDir, 'product.json'), 'utf8'));
const executable = join(coreDir, '.build', 'electron', `${product.nameShort}.exe`);
assert.ok(existsSync(executable), 'Run npm run build first.');
const prefix = 'vshoon-java-search-smoke-';
const profile = createSmokeProfile(prefix);
const project = join(profile, 'project');
const workspace = join(profile, 'smoke.code-workspace');
const resultFile = join(profile, 'result.json');
const runner = join(profile, 'tests.cjs');
const interactionFile = join(profile, 'interaction.json');
const interactionDone = join(profile, 'interaction-done.json');
const dormantJava = join(profile, 'dormant-java');
const debuggingPort = await findFreePort();
let child;
let client;
let output = '';
let passed = false;

try {
	mkdirSync(project);
	writeFileSync(workspace, JSON.stringify({ folders: [{ path: project }] }));
	writeFileSync(join(project, 'App.java'), 'package example; class App { Service service; void run() { local(); service.save("ok"); } void local() {} }');
	writeFileSync(join(project, 'Service.java'), 'package example; class Service { public void save(String value) {} }');
	mkdirSync(dormantJava);
	writeFileSync(join(dormantJava, 'package.json'), JSON.stringify({ name: 'java', publisher: 'redhat', version: '0.0.0', engines: { vscode: '^1.137.0' }, main: './index.js', activationEvents: [] }));
	writeFileSync(join(dormantJava, 'index.js'), 'exports.activate = () => ({});');
	writeSmokeSettings(profile, { 'security.workspace.trust.enabled': false, 'chat.disableAIFeatures': true, 'workbench.welcomePage.experimentalOnboarding': false });
	writeFileSync(runner, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { createHash } = require('node:crypto');
const { SearchEngine, getConfig } = require(${JSON.stringify(join(coreDir, 'extensions', 'vshoon-vsearch', 'out', 'searchEngine.js'))});
exports.run = async () => {
	const until = async (predicate, label) => {
		const deadline = Date.now() + 30000;
		while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); }
		assert.ok(predicate(), label);
	};
	const interact = async (id, kind, predicate) => {
		fs.writeFileSync(${JSON.stringify(interactionFile)}, JSON.stringify({ id, kind }));
		await until(() => {
			try { return JSON.parse(fs.readFileSync(${JSON.stringify(interactionDone)}, 'utf8')).id === id; } catch { return false; }
		}, 'Desktop interaction driver');
		await until(predicate, kind);
	};
	const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const app = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'App.java')));
	await vscode.window.showTextDocument(app);
	await vscode.extensions.getExtension('vshoon.vshoon-decom').activate();
	assert.ok(vscode.extensions.getExtension('redhat.java'), 'A dormant Java server extension must not disable source navigation');
	const appEditor = vscode.window.activeTextEditor;
	const callPosition = app.positionAt(app.getText().indexOf('local'));
	appEditor.selection = new vscode.Selection(callPosition, callPosition);
	await interact(1, 'ctrlClick', () => vscode.window.activeTextEditor?.document.uri.toString() === app.uri.toString()
		&& app.offsetAt(vscode.window.activeTextEditor.selection.start) === app.getText().lastIndexOf('local'));
	const savePosition = app.positionAt(app.getText().indexOf('save'));
	appEditor.selection = new vscode.Selection(savePosition, savePosition);
	await interact(2, 'f12', () => path.basename(vscode.window.activeTextEditor?.document.uri.fsPath || '') === 'Service.java');
	await vscode.window.showTextDocument(app);
	const definitions = async word => {
		const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', app.uri, app.positionAt(app.getText().indexOf(word)));
		return result.map(location => path.basename((location.uri || location.targetUri).fsPath));
	};
	assert.deepStrictEqual(await definitions('local'), ['App.java']);
	assert.deepStrictEqual(await definitions('save'), ['Service.java']);
	const service = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'Service.java')));
	const edit = new vscode.WorkspaceEdit();
	edit.insert(service.uri, new vscode.Position(0, 0), '// unsaved header\\n');
	assert.ok(await vscode.workspace.applyEdit(edit));
	const moved = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', app.uri, app.positionAt(app.getText().indexOf('save')));
	assert.equal(moved[0].range.start.line, 1);
	const localEdit = new vscode.WorkspaceEdit();
	localEdit.insert(app.uri, new vscode.Position(0, 0), '// unsaved header\\n');
	assert.ok(await vscode.workspace.applyEdit(localEdit));
	const localMoved = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', app.uri, app.positionAt(app.getText().indexOf('local')));
	assert.equal(localMoved[0].range.start.line, 1);
	// A type declared in a differently named file requires the background workspace index.
	const extraRoot = path.join(path.dirname(root), 'extra-project');
	fs.mkdirSync(extraRoot);
	fs.writeFileSync(path.join(extraRoot, 'Container.java'), 'package example; class Extra { void execute() {} }');
	const folderChange = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Workspace change timed out')); }, 10000);
		const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			clearTimeout(timeout);
			subscription.dispose();
			resolve();
		});
		if (!vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, { uri: vscode.Uri.file(extraRoot) })) {
			clearTimeout(timeout);
			subscription.dispose();
			reject(new Error('Unable to add smoke workspace folder'));
		}
	});
	await folderChange;
	const callerPath = vscode.Uri.file(path.join(root, 'ExtraCaller.java'));
	fs.writeFileSync(callerPath.fsPath, 'package example; class ExtraCaller { Extra extra; void run() { extra.execute(); } }');
	const caller = await vscode.workspace.openTextDocument(callerPath);
	const addedDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', caller.uri, caller.positionAt(caller.getText().indexOf('execute')));
	assert.deepStrictEqual(addedDefinitions.map(location => path.basename((location.uri || location.targetUri).fsPath)), ['Container.java']);
	// Pages and plain scripts call global functions declared in other script files.
	fs.mkdirSync(path.join(root, 'web', 'js'), { recursive: true });
	fs.writeFileSync(path.join(root, 'web', 'js', 'common.js'), '// shared helpers\\nfunction goPage(url) { location.href = url; }\\n');
	const pagePath = vscode.Uri.file(path.join(root, 'web', 'list.jsp'));
	fs.writeFileSync(pagePath.fsPath, '<%@ page contentType="text/html" %>\\n<script>\\n$(function () { goPage("/list"); });\\n</script>\\n');
	const page = await vscode.workspace.openTextDocument(pagePath);
	const scriptDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', page.uri, page.positionAt(page.getText().indexOf('goPage')));
	assert.deepStrictEqual(scriptDefinitions.map(location => [path.basename((location.uri || location.targetUri).fsPath), (location.range || location.targetSelectionRange).start.line]), [['common.js', 1]]);
	// The extension must index changes before any search panel or explicit warm request.
	await vscode.extensions.getExtension('vshoon.vshoon-vsearch').activate();
	const liveFile = path.join(root, 'live-index.txt');
	const liveCache = path.join(root, '.vshoon', 'cache', 'vsearch-v2', createHash('sha256').update('live-index.txt').digest('hex') + '.bin');
	const cachedText = () => {
		// persistentCache.ts 형식: 48바이트 머리글, flags 4이면 필터 1024바이트, flags 2이면 그 뒤 UTF-8 텍스트.
		try {
			const buffer = fs.readFileSync(liveCache);
			const flags = buffer.readUInt8(4);
			return flags & 2 ? buffer.toString('utf8', 48 + (flags & 4 ? 1024 : 0)) : undefined;
		} catch { return undefined; }
	};
	fs.writeFileSync(liveFile, 'automatic first content');
	await until(() => cachedText() === 'automatic first content', 'Project-open indexing and file creation');
	fs.writeFileSync(liveFile, 'automatic changed content');
	await until(() => cachedText() === 'automatic changed content', 'Immediate index update');
	fs.unlinkSync(liveFile);
	await until(() => !fs.existsSync(liveCache), 'Immediate index deletion');
	const engine = new SearchEngine();
	const source = new vscode.CancellationTokenSource();
	try {
		const config = getConfig();
		const query = { id: 1, query: 'uniqueNeedle', regex: false, caseSensitive: false, wholeWord: false, scopeKind: 'workspace', scopePath: '', recursive: true, fileMask: '*.txt' };
		fs.writeFileSync(path.join(root, 'old.txt'), 'unrelated original');
		await engine.warm(query, config);
		const run = async () => {
			const names = [];
			await engine.runSearch(query, config, source.token, files => names.push(...files.map(file => file.name)));
			return names.sort();
		};
		// Searches reuse the file list and recently verified contents; file events update them.
		const settle = async (expected, label) => {
			const deadline = Date.now() + 5000;
			let names = await run();
			while (JSON.stringify(names) !== JSON.stringify(expected) && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 100));
				names = await run();
			}
			assert.deepStrictEqual(names, expected, label);
		};
		assert.deepStrictEqual(await run(), []);
		fs.writeFileSync(path.join(root, 'old.txt'), 'uniqueNeedle externally changed');
		fs.writeFileSync(path.join(root, 'new.txt'), 'uniqueNeedle newly added');
		await settle(['new.txt', 'old.txt'], 'External change and creation');
		fs.unlinkSync(path.join(root, 'old.txt'));
		const dirty = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'new.txt')));
		const change = new vscode.WorkspaceEdit();
		change.replace(dirty.uri, new vscode.Range(dirty.positionAt(0), dirty.positionAt(dirty.getText().length)), 'unsaved content');
		await vscode.workspace.applyEdit(change);
		await settle([], 'Deletion and unsaved replacement');
		query.query = 'unsaved';
		assert.deepStrictEqual(await run(), ['new.txt']);
		await vscode.commands.executeCommand('vsearch.open');
		await interact(3, 'searchPopup', () => true);
		fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ java: 'real Ctrl+click and F12 with a dormant Java server, same-file, cross-file, unsaved positions, added workspace', script: 'JSP page to global function in another script', search: 'automatic project indexing, immediate create/change/delete, persistent cache, dirty buffer', popup: 'in-window search popup dragged past the window edges with a reachable header' }));
	} finally {
		source.dispose();
		engine.dispose();
	}
};
`);
	const environment = { ...process.env, VSCODE_DEV: '1', NODE_ENV: 'development' };
	for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_CLI', 'VSCODE_PORTABLE', 'VSCODE_PORTABLE_TEMP']) {
		delete environment[key];
	}
	child = spawn(executable, [coreDir, workspace, `--user-data-dir=${profile}`, `--extensions-dir=${join(profile, 'extensions')}`,
		`--shared-data-dir=${join(profile, 'shared')}`, `--extensionDevelopmentPath=${join(coreDir, 'extensions', 'vshoon-decom')}`,
		`--extensionDevelopmentPath=${dormantJava}`, `--remote-debugging-port=${debuggingPort}`,
		`--extensionTestsPath=${runner}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes'], {
		cwd: coreDir, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.on('data', data => output = retainTail(output, data.toString()));
	child.stderr.on('data', data => output = retainTail(output, data.toString()));
	const target = await waitForPageTarget(debuggingPort, child, isWorkbenchTarget, 'Workbench', 60000);
	client = await connect(target.webSocketDebuggerUrl);
	let handledInteraction = 0;
	// Poll without repeatedly subscribing to process exit events.
	const deadline = Date.now() + 240_000;
	while (child.exitCode === null && Date.now() < deadline) {
		let interaction;
		try { interaction = JSON.parse(readFileSync(interactionFile, 'utf8')); } catch { /* Runner has not requested an interaction. */ }
		if (interaction && interaction.id > handledInteraction) {
			if (interaction.kind === 'ctrlClick') {
				await clickJavaReference(client);
			} else if (interaction.kind === 'f12') {
				await client.send('Page.bringToFront');
				await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
				await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
			} else if (interaction.kind === 'searchPopup') {
				await verifySearchPopup(client);
			}
			handledInteraction = interaction.id;
			writeFileSync(interactionDone, JSON.stringify({ id: interaction.id }));
		}
		await delay(100);
	}
	assert.equal(child.exitCode, 0, output);
	assert.ok(existsSync(resultFile), output);
	console.log(`[vshoon] Java/search desktop smoke: ${readFileSync(resultFile, 'utf8')}`);
	passed = true;
} catch (error) {
	console.error(output);
	throw error;
} finally {
	client?.close();
	if (child && child.exitCode === null) {
		child.kill();
		await waitForExit(child, 5000).catch(() => undefined);
	}
	if (passed) {
		await removeSmokeProfile(profile, prefix);
	} else {
		console.error(`[vshoon] retained failed smoke profile: ${profile}`);
	}
}

async function clickJavaReference(connection) {
	await connection.send('Page.bringToFront');
	const point = await evaluate(connection, `(() => {
		for (const line of document.querySelectorAll('.monaco-editor .view-line')) {
			if (!line.textContent.includes('local')) { continue; }
			const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
			let node;
			while ((node = walker.nextNode())) {
				const start = node.textContent.indexOf('local');
				if (start < 0) { continue; }
				const range = document.createRange();
				range.setStart(node, start);
				range.setEnd(node, start + 5);
				const rect = range.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) { return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }
			}
		}
	})()`);
	assert.ok(point, 'Visible Java method reference');
	await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, modifiers: 2 });
	await delay(400);
	await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point, modifiers: 2 });
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point, modifiers: 2 });
	await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
}

async function verifySearchPopup(connection) {
	await connection.send('Page.bringToFront');
	// Webviews are overlays positioned over their editor, so containment identifies the popup's webview.
	await waitForCondition(connection, `(() => {
		const dialog = document.querySelector('.monaco-modal-editor-block .modal-editor-part')?.getBoundingClientRect();
		return !!dialog && Array.from(document.querySelectorAll('iframe.webview')).some(frame => {
			const rect = frame.getBoundingClientRect();
			return rect.width > 0 && rect.left >= dialog.left - 1 && rect.right <= dialog.right + 1 && rect.top >= dialog.top - 1 && rect.bottom <= dialog.bottom + 1;
		});
	})()`, 'Search popup webview', 40000);
	const geometry = `(() => {
		const popup = document.querySelector('.monaco-modal-editor-block .modal-editor-resizable').getBoundingClientRect();
		const header = document.querySelector('.monaco-modal-editor-block .modal-editor-header').getBoundingClientRect();
		const webviewRight = Math.max(...Array.from(document.querySelectorAll('iframe.webview')).map(frame => frame.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.top >= popup.top - 1).map(rect => rect.right));
		return { width: window.innerWidth, height: window.innerHeight, left: popup.left, top: popup.top, right: popup.right, bottom: popup.bottom, headerY: header.top + header.height / 2, webviewRight };
	})()`;
	const before = await evaluate(connection, geometry);
	// Drag the header so that most of the popup leaves the window to the right and bottom.
	const from = { x: before.left + 80, y: before.headerY };
	const to = { x: before.width - 60, y: before.height - 30 };
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
	await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...from });
	for (let step = 1; step <= 10; step++) {
		await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: from.x + (to.x - from.x) * step / 10, y: from.y + (to.y - from.y) * step / 10 });
		await delay(20);
	}
	await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...to });
	await delay(200);
	const after = await evaluate(connection, geometry);
	assert.ok(after.right > after.width && after.bottom > after.height && after.webviewRight > after.width, `Search popup and its webview pass the window edges: ${JSON.stringify({ before, after })}`);
	assert.ok(after.left < after.width && after.headerY < after.height, `Search popup header stays reachable: ${JSON.stringify(after)}`);
}
