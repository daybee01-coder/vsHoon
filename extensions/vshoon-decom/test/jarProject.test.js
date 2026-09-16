/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { beforeEach, afterEach, test } = require('node:test');
const { URI, Utils } = require('vscode-uri');
const AdmZip = require('adm-zip');

class MockEventEmitter {
	constructor() {
		this.listeners = new Set();
		this.event = listener => {
			this.listeners.add(listener);
			return { dispose: () => this.listeners.delete(listener) };
		};
	}
	fire(value) {
		for (const listener of this.listeners) listener(value);
	}
	dispose() {
		this.listeners.clear();
	}
}

class MockFileSystemError extends Error {
	static FileNotFound(value) { return new MockFileSystemError(`FileNotFound: ${value}`); }
	static FileNotADirectory(value) { return new MockFileSystemError(`FileNotADirectory: ${value}`); }
	static FileIsADirectory(value) { return new MockFileSystemError(`FileIsADirectory: ${value}`); }
	static NoPermissions(value) { return new MockFileSystemError(`NoPermissions: ${value}`); }
	static Unavailable(value) { return new MockFileSystemError(`Unavailable: ${value}`); }
}

class MockCancellationTokenSource {
	constructor() {
		this.emitter = new MockEventEmitter();
		this.token = {
			isCancellationRequested: false,
			onCancellationRequested: this.emitter.event
		};
	}
	cancel() {
		this.token.isCancellationRequested = true;
		this.emitter.fire(undefined);
	}
	dispose() {
		this.emitter.dispose();
	}
}

let root;
let provider;
let errors;
let commands;
const testCfrPath = [
	process.env.VSHOON_TEST_CFR_PATH,
	path.resolve(__dirname, '..', '..', '..', '.build', 'tools', 'cfr', 'cfr-0.152.jar'),
	path.resolve(__dirname, '..', '..', '..', '..', '.build', 'tools', 'cfr', 'cfr-0.152.jar')
].find(candidate => candidate && fs.existsSync(candidate));
const vscode = {
	Uri: {
		file: URI.file,
		parse: URI.parse,
		from: URI.from,
		joinPath: Utils.joinPath
	},
	l10n: { t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => args[index]) },
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	FilePermission: { Readonly: 1 },
	FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
	FileSystemError: MockFileSystemError,
	EventEmitter: MockEventEmitter,
	CancellationTokenSource: MockCancellationTokenSource,
	Disposable: class { constructor(dispose) { this.dispose = dispose; } },
	commands: { executeCommand: async (command, ...args) => { commands.push([command, ...args]); } },
	ProgressLocation: { Notification: 15, Window: 10 },
	window: {
		activeTextEditor: undefined,
		createOutputChannel: () => ({ appendLine() { }, dispose() { } }),
		onDidChangeActiveTextEditor: () => ({ dispose() { } }),
		onDidChangeTextEditorSelection: () => ({ dispose() { } }),
		onDidChangeWindowState: () => ({ dispose() { } }),
		showOpenDialog: async () => undefined,
		showInformationMessage: async () => undefined,
		showErrorMessage: async message => { errors.push(message); },
		withProgress: async (options, task) => task({ report() { } }, { isCancellationRequested: false })
	},
	workspace: {
		workspaceFolders: [],
		fs: {
			stat: uri => provider.stat(uri),
			readDirectory: uri => provider.readDirectory(uri),
			readFile: uri => provider.readFile(uri)
		},
		getConfiguration: () => ({ get: (key, fallback) => key === 'cfr.jarPath' ? (testCfrPath ?? '') : fallback }),
		onDidChangeConfiguration: () => ({ dispose() { } })
	}
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscode;
	return originalLoad.call(this, request, parent, isMain);
};
const { JarFileSystemProvider, JAR_FILE_SYSTEM_SCHEME } = require('../out/archiveFileSystem');
const { openJar, prepareJarForExplorer, refreshJar } = require('../out/jarProject');
const { materializeClass } = require('../out/classEditor');
const { collectSourceSymbols, definitionOwners, resolveSourceDefinitions } = require('../out/javaSymbols');
const { ClassSourceService } = require('../out/classSourceService');
const { fromClassSourceUri, toClassSourceUri } = require('../out/classSourceUri');
const { decompileArchive, decompileSingleClass } = require('../out/cfr');
Module._load = originalLoad;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-vfs-test-'));
	provider = new JarFileSystemProvider();
	errors = [];
	commands = [];
	vscode.workspace.workspaceFolders = [{ uri: URI.file(path.join(root, 'workspace')), name: 'workspace' }];
});
afterEach(() => {
	provider.dispose();
	fs.rmSync(root, { recursive: true, force: true });
});

function makeJar(jarPath, configValue = 'value=original', classBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe]), extraEntries = {}) {
	const inner = new AdmZip();
	inner.addFile('nested/value.txt', Buffer.from('inside'));
	const zip = new AdmZip();
	zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'));
	zip.addFile('BOOT-INF/classes/deep/Deep.class', classBytes);
	zip.addFile('BOOT-INF/classes/deep/Deep$Nested.class', classBytes);
	for (const [entry, bytes] of Object.entries(extraEntries)) {
		zip.addFile(entry, bytes);
	}
	zip.addFile('BOOT-INF/lib/inner.jar', inner.toBuffer());
	zip.addFile('config.properties', Buffer.from(configValue));
	fs.mkdirSync(path.dirname(jarPath), { recursive: true });
	zip.writeZip(jarPath);
}

function fixture() {
	const jarPath = URI.file(path.join(root, 'workspace', 'sample.jar')).fsPath;
	makeJar(jarPath);
	return { context: { globalStorageUri: URI.file(path.join(root, 'storage')) }, jarPath, jarUri: URI.file(jarPath) };
}

async function child(rootUri, ...segments) {
	return Utils.joinPath(rootUri, ...segments);
}

async function waitFor(condition) {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.equal(condition(), true, 'condition was not reached in time');
}

test('opening a JAR builds a virtual tree without extracting files', async () => {
	const { context, jarUri } = fixture();
	const archiveRoot = await prepareJarForExplorer(provider, jarUri);
	const rootEntries = await provider.readDirectory(archiveRoot);
	const bootInf = await child(archiveRoot, 'BOOT-INF');
	const bootEntries = await provider.readDirectory(bootInf);
	const config = await provider.readFile(await child(archiveRoot, 'config.properties'));

	assert.deepEqual({
		scheme: archiveRoot.scheme,
		rootEntries: rootEntries.map(([name]) => name).sort(),
		bootEntries: bootEntries.map(([name]) => name).sort(),
		config: Buffer.from(config).toString(),
		storageExists: fs.existsSync(context.globalStorageUri.fsPath),
		workspaceFolders: vscode.workspace.workspaceFolders.length
	}, {
		scheme: JAR_FILE_SYSTEM_SCHEME,
		rootEntries: ['BOOT-INF', 'META-INF', 'config.properties'],
		bootEntries: ['classes', 'lib'],
		config: 'value=original',
		storageExists: false,
		workspaceFolders: 1
	});
});

test('virtual entries are read-only', async () => {
	const { jarUri } = fixture();
	const archiveRoot = await provider.openArchive(jarUri);
	const config = await child(archiveRoot, 'config.properties');
	const stat = await provider.stat(config);
	assert.equal(stat.permissions, vscode.FilePermission.Readonly);
	assert.throws(() => provider.writeFile(config, Buffer.from('changed')), /NoPermissions/);
	assert.throws(() => provider.delete(config), /NoPermissions/);
});

test('a nested JAR is indexed only when its own node is expanded', async () => {
	const { jarUri } = fixture();
	const archiveRoot = await provider.openArchive(jarUri);
	const nestedUri = await child(archiveRoot, 'BOOT-INF', 'lib', 'inner.jar');
	const nestedRoot = await provider.openArchive(nestedUri);
	const nestedEntries = await provider.readDirectory(nestedRoot);
	const value = await provider.readFile(await child(nestedRoot, 'nested', 'value.txt'));
	assert.deepEqual({
		entries: nestedEntries.map(([name]) => name),
		value: Buffer.from(value).toString()
	}, { entries: ['nested'], value: 'inside' });
});

test('refresh drops the index and reads the changed source JAR', async () => {
	const { jarPath, jarUri } = fixture();
	const archiveRoot = await provider.openArchive(jarUri);
	assert.equal(Buffer.from(await provider.readFile(await child(archiveRoot, 'config.properties'))).toString(), 'value=original');
	makeJar(jarPath, 'value=changed');
	await refreshJar(provider, jarUri);
	assert.equal(Buffer.from(await provider.readFile(await child(archiveRoot, 'config.properties'))).toString(), 'value=changed');
	assert.deepEqual(commands.map(([command]) => command), ['workbench.files.action.refreshFilesExplorer']);
});

test('an unreadable JAR reports the failure and leaves the workspace unchanged', async () => {
	const broken = URI.file(path.join(root, 'workspace', 'broken.jar'));
	fs.mkdirSync(path.dirname(broken.fsPath), { recursive: true });
	fs.writeFileSync(broken.fsPath, 'not a zip');
	await openJar(provider, broken);
	assert.deepEqual({ errors: errors.length, folders: vscode.workspace.workspaceFolders.length }, { errors: 1, folders: 1 });
});

test('a virtual class materializes only its class family and is removed afterwards', async () => {
	const { context, jarUri } = fixture();
	const archiveRoot = await provider.openArchive(jarUri);
	const classUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
	const materialized = await materializeClass(context, classUri);
	const directory = path.dirname(materialized.filePath);
	assert.deepEqual(fs.readdirSync(directory).sort(), ['Deep$Nested.class', 'Deep.class']);
	materialized.dispose();
	assert.equal(fs.existsSync(directory), false);
});

test('archive class listing and source URI preserve the original virtual class', async () => {
	const { jarPath, jarUri } = fixture();
	const archiveRoot = await provider.openArchive(jarUri);
	const classes = provider.listClassFiles(archiveRoot);
	const sourceUri = toClassSourceUri(classes[0]);
	const location = provider.getArchiveLocation(classes[0]);
	assert.deepEqual({
		classes: classes.map(uri => uri.path).sort(),
		sourceScheme: sourceUri.scheme,
		roundTrip: fromClassSourceUri(sourceUri).toString(),
		displayPath: location.displayPath,
		rootFilePath: location.rootFilePath
	}, {
		classes: ['/BOOT-INF/classes/deep/Deep$Nested.class', '/BOOT-INF/classes/deep/Deep.class'],
		sourceScheme: 'vshoon-decom',
		roundTrip: classes[0].toString(),
		displayPath: `${jarPath}!${classes[0].path}`,
		rootFilePath: jarPath
	});
});

test('decompiled source symbols retain overloaded method declarations', () => {
	const symbols = collectSourceSymbols([
		'public class Demo {',
		'    public Demo() { }',
		'    public int value(int input) { return input; }',
		'    public String value(String input) { return input; }',
		'}'
	].join('\n'));
	assert.deepEqual(symbols.map(symbol => [symbol.kind, symbol.name, symbol.line, symbol.detail]), [
		['type', 'Demo', 0, ''],
		['method', 'Demo', 1, '()'],
		['method', 'value', 2, '(int input)'],
		['method', 'value', 3, '(String input)']
	]);
});

test('definition resolution uses receiver, arity and inferred argument types', () => {
	const demo = [
		'public class Demo {',
		'    public int value(int input) { return input; }',
		'    public String value(String input) { return input; }',
		'    public void run(Helper helper) {',
		'        value(1);',
		'        value("text");',
		'        value(result());',
		'        helper.work(true);',
		'    }',
		'}'
	].join('\n');
	const helper = [
		'public class Helper {',
		'    public Helper() { }',
		'    public void work(boolean enabled) { }',
		'}'
	].join('\n');
	const sources = [
		{ uri: 'vshoon-decom:/Demo.java', content: demo },
		{ uri: 'vshoon-decom:/Helper.java', content: helper }
	];
	const resolve = marker => resolveSourceDefinitions(sources[0], demo.indexOf(marker), marker.split('(', 1)[0].split('.').pop(), sources);

	assert.deepEqual(resolve('value(1)').map(target => [target.uri, target.line]), [['vshoon-decom:/Demo.java', 1]]);
	assert.deepEqual(resolve('value("text")').map(target => [target.uri, target.line]), [['vshoon-decom:/Demo.java', 2]]);
	assert.deepEqual(resolve('value(result())').map(target => [target.uri, target.line]), [
		['vshoon-decom:/Demo.java', 1],
		['vshoon-decom:/Demo.java', 2]
	]);
	const workOffset = demo.indexOf('helper.work') + 'helper.'.length;
	assert.deepEqual(resolveSourceDefinitions(sources[0], workOffset, 'work', sources).map(target => [target.uri, target.line]), [
		['vshoon-decom:/Helper.java', 2]
	]);
});

test('decompiled source is reused from persistent cache without running CFR again', async () => {
	const { context, jarUri } = fixture();
	const archiveRoot = await provider.openArchive(jarUri);
	const classUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
	let decompileCount = 0;
	const first = new ClassSourceService(context, provider, {
		cfrIdentity: async () => 'test-cfr',
		decompile: async () => {
			decompileCount++;
			return 'package deep; public class Deep { public int value() { return 42; } }';
		}
	});
	const source = await first.getSource(classUri);
	first.dispose();

	let identityCount = 0;
	const second = new ClassSourceService(context, provider, {
		cfrIdentity: async () => {
			identityCount++;
			return 'test-cfr';
		},
		decompile: async () => {
			throw new Error('persistent cache was not reused');
		}
	});
	try {
		assert.deepEqual({ source, second: await second.getSource(classUri), decompileCount, identityCount }, {
			source: 'package deep; public class Deep { public int value() { return 42; } }',
			second: source,
			decompileCount: 1,
			identityCount: 0
		});
	} finally {
		second.dispose();
	}
});

test('an archive is precompiled in one run and its completion marker survives a provider restart', async () => {
	const { context, jarUri } = fixture();
	let archiveRuns = 0;
	const options = {
		backgroundDelayMs: 0,
		cfrIdentity: async () => 'test-cfr',
		decompileArchive: async (_context, archivePath, outputDirectory) => {
			archiveRuns++;
			assert.equal(path.resolve(archivePath), path.resolve(jarUri.fsPath));
			fs.mkdirSync(path.join(outputDirectory, 'deep'), { recursive: true });
			fs.writeFileSync(path.join(outputDirectory, 'deep', 'Deep.java'), 'package deep; public class Deep { public int value() { return 42; } }');
		}
	};
	const first = new ClassSourceService(context, provider, options);
	const firstRoot = await provider.openArchive(jarUri);
	const cacheRoot = path.join(context.globalStorageUri.fsPath, 'class-sources-v2');
	await waitFor(() => fs.existsSync(cacheRoot) && fs.readdirSync(cacheRoot).some(name => name.endsWith('.archive')));
	const firstClass = await child(firstRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
	const firstSource = await first.getSource(firstClass);
	first.dispose();
	provider.dispose();

	provider = new JarFileSystemProvider();
	const second = new ClassSourceService(context, provider, options);
	try {
		const secondRoot = await provider.openArchive(jarUri);
		const secondClass = await child(secondRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
		const secondSource = await second.getSource(secondClass);
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.deepEqual({ archiveRuns, firstSource, secondSource }, {
			archiveRuns: 1,
			firstSource: 'package deep; public class Deep { public int value() { return 42; } }',
			secondSource: firstSource
		});
	} finally {
		second.dispose();
	}
});

test('a nested class shares the document and the decompiler run of its outer class', async () => {
	const { context, jarUri } = fixture();
	const archiveRoot = await provider.openArchive(jarUri);
	const outerUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
	const nestedUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep$Nested.class');
	let runs = 0;
	const service = new ClassSourceService(context, provider, {
		cfrIdentity: async () => 'test-cfr',
		decompile: async (_context, classFilePath) => {
			runs++;
			return `source of ${path.basename(classFilePath)}`;
		}
	});
	try {
		assert.deepEqual({
			nested: await service.getSource(nestedUri),
			outer: await service.getSource(outerUri),
			runs,
			sameDocument: toClassSourceUri(nestedUri).toString() === toClassSourceUri(outerUri).toString()
		}, {
			nested: 'source of Deep.class',
			outer: 'source of Deep.class',
			runs: 1,
			sameDocument: true
		});
	} finally {
		service.dispose();
	}
});

test('a class the user opens preempts the running background job', async () => {
	const jarPath = URI.file(path.join(root, 'workspace', 'preempt.jar')).fsPath;
	makeJar(jarPath, 'value=original', Buffer.from([0xca, 0xfe, 0xba, 0xbe]), {
		'BOOT-INF/classes/deep/Other.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x01])
	});
	const context = { globalStorageUri: URI.file(path.join(root, 'storage')) };
	const archiveRoot = await provider.openArchive(URI.file(jarPath));
	const backgroundUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Other.class');
	const userUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
	const started = [];
	const completed = [];
	let releaseBackground = () => { };
	const service = new ClassSourceService(context, provider, {
		cfrIdentity: async () => 'test-cfr',
		decompile: async (_context, classFilePath, token) => {
			const name = path.basename(classFilePath);
			started.push(name);
			if (name === 'Other.class' && started.filter(entry => entry === 'Other.class').length === 1) {
				await new Promise(resolve => {
					releaseBackground = resolve;
					token.onCancellationRequested(resolve);
				});
				if (token.isCancellationRequested) {
					throw new Error('cancelled');
				}
			}
			completed.push(name);
			return `source of ${name}`;
		}
	});
	try {
		const background = service.getSource(backgroundUri, 'background');
		await waitFor(() => started.length === 1);
		const user = await service.getSource(userUri);
		releaseBackground();
		assert.deepEqual({ user, background: await background, completed }, {
			user: 'source of Deep.class',
			background: 'source of Other.class',
			completed: ['Deep.class', 'Other.class']
		});
	} finally {
		service.dispose();
	}
});

test('navigation reads only the prepared sources that can declare the looked up type', async () => {
	const jarPath = URI.file(path.join(root, 'workspace', 'navigate.jar')).fsPath;
	makeJar(jarPath, 'value=original', Buffer.from([0xca, 0xfe, 0xba, 0xbe]), {
		'BOOT-INF/classes/deep/Helper.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x02]),
		'BOOT-INF/classes/deep/Unrelated.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x03])
	});
	const deep = [
		'package deep;',
		'public class Deep {',
		'    public void run(Helper helper) {',
		'        helper.work(true);',
		'    }',
		'}'
	].join('\n');
	const helper = [
		'package deep;',
		'public class Helper {',
		'    public void work(boolean enabled) { }',
		'}'
	].join('\n');
	const context = { globalStorageUri: URI.file(path.join(root, 'storage')) };
	const options = {
		backgroundDelayMs: 0,
		cfrIdentity: async () => 'test-cfr',
		decompileArchive: async (_context, _archivePath, outputDirectory) => {
			fs.mkdirSync(path.join(outputDirectory, 'deep'), { recursive: true });
			fs.writeFileSync(path.join(outputDirectory, 'deep', 'Deep.java'), deep);
			fs.writeFileSync(path.join(outputDirectory, 'deep', 'Helper.java'), helper);
			fs.writeFileSync(path.join(outputDirectory, 'deep', 'Unrelated.java'), 'package deep; public class Unrelated { }');
		}
	};
	const cacheRoot = path.join(context.globalStorageUri.fsPath, 'class-sources-v2');
	const typeIndexFiles = () => fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).filter(name => name.endsWith('.types')) : [];
	const service = new ClassSourceService(context, provider, options);
	let rebuilt;
	try {
		const archiveRoot = await provider.openArchive(URI.file(jarPath));
		await waitFor(() => fs.existsSync(cacheRoot) && fs.readdirSync(cacheRoot).some(name => name.endsWith('.archive')));
		const deepSourceUri = toClassSourceUri(await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class'));
		const helperSourceUri = toClassSourceUri(await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Helper.class')).toString();
		const callOffset = deep.indexOf('helper.work') + 'helper.'.length;
		const owners = definitionOwners(deep, callOffset, 'work');
		const narrowed = await service.getNavigationSources(deepSourceUri, owners);
		const indexed = typeIndexFiles().length;

		for (const name of typeIndexFiles()) {
			fs.rmSync(path.join(cacheRoot, name));
		}
		rebuilt = new ClassSourceService(context, provider, options);
		const afterRebuild = await rebuilt.getNavigationSources(deepSourceUri, owners);
		const current = { uri: deepSourceUri.toString(), content: deep };
		const definitions = resolveSourceDefinitions(current, callOffset, 'work', [current, ...narrowed]);

		assert.deepEqual({
			owners,
			indexed,
			narrowed: narrowed.map(source => source.uri),
			afterRebuild: afterRebuild.map(source => source.uri),
			reindexed: typeIndexFiles().length,
			definitions: definitions.map(definition => [definition.uri, definition.line])
		}, {
			owners: ['Helper'],
			indexed: 1,
			narrowed: [helperSourceUri],
			afterRebuild: [helperSourceUri],
			reindexed: 1,
			definitions: [[helperSourceUri, 2]]
		});
	} finally {
		rebuilt?.dispose();
		service.dispose();
	}
});

test('a class decompilation that stops making progress fails and frees the queue', async () => {
	const jarPath = URI.file(path.join(root, 'workspace', 'stuck.jar')).fsPath;
	makeJar(jarPath, 'value=original', Buffer.from([0xca, 0xfe, 0xba, 0xbe]), {
		'BOOT-INF/classes/deep/Other.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x01])
	});
	const context = { globalStorageUri: URI.file(path.join(root, 'storage')) };
	const archiveRoot = await provider.openArchive(URI.file(jarPath));
	const stuckUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
	const nextUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Other.class');
	const service = new ClassSourceService(context, provider, {
		cfrIdentity: async () => 'test-cfr',
		decompileTimeoutMs: 1000,
		decompile: async (_context, classFilePath) => path.basename(classFilePath) === 'Deep.class'
			? new Promise(() => { })
			: 'package deep; public class Other { }'
	});
	try {
		const stuck = await service.getSource(stuckUri).then(() => 'resolved', error => error.message);
		assert.deepEqual({ stuck, next: await service.getSource(nextUri) }, {
			stuck: 'Decom: 디컴파일이 1초 안에 끝나지 않아 중단했습니다.',
			next: 'package deep; public class Other { }'
		});
	} finally {
		service.dispose();
	}
});

test('a batch run that writes no source is stopped and not started again', async () => {
	const { context, jarUri } = fixture();
	let runs = 0;
	const service = new ClassSourceService(context, provider, {
		backgroundDelayMs: 0,
		decompileTimeoutMs: 300,
		cfrIdentity: async () => 'test-cfr',
		decompileArchive: async () => {
			runs++;
			return new Promise(() => { });
		}
	});
	try {
		await provider.openArchive(jarUri);
		await waitFor(() => runs === 1);
		await new Promise(resolve => setTimeout(resolve, 900));
		const cacheRoot = path.join(context.globalStorageUri.fsPath, 'class-sources-v2');
		const markers = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).filter(name => name.endsWith('.archive')) : [];
		assert.deepEqual({ runs, markers }, { runs: 1, markers: [] });
	} finally {
		service.dispose();
	}
});

test('real CFR decompiles a class read lazily from the virtual JAR', { skip: !testCfrPath }, async () => {
	const context = { globalStorageUri: URI.file(path.join(root, 'storage')) };
	const javaPath = path.join(root, 'Deep.java');
	fs.writeFileSync(javaPath, 'package deep; public class Deep { public int value() { return 42; } public static class Nested { } }');
	const compile = spawnSync('javac', ['--release', '17', '-d', root, javaPath], { windowsHide: true, encoding: 'utf8' });
	assert.equal(compile.status, 0, compile.stderr);
	const classPath = path.join(root, 'deep', 'Deep.class');
	const jarPath = URI.file(path.join(root, 'workspace', 'compiled.jar')).fsPath;
	makeJar(jarPath, 'value=original', fs.readFileSync(classPath));
	const zip = new AdmZip(jarPath);
	zip.updateFile('BOOT-INF/classes/deep/Deep$Nested.class', fs.readFileSync(path.join(root, 'deep', 'Deep$Nested.class')));
	zip.writeZip(jarPath);

	const archiveRoot = await provider.openArchive(URI.file(jarPath));
	const classUri = await child(archiveRoot, 'BOOT-INF', 'classes', 'deep', 'Deep.class');
	const outputDirectory = path.join(root, 'batch-output');
	fs.mkdirSync(outputDirectory);
	await decompileArchive(context, jarPath, outputDirectory);
	assert.match(fs.readFileSync(path.join(outputDirectory, 'deep', 'Deep.java'), 'utf8'), /return 42/);
	const materialized = await materializeClass(context, classUri);
	try {
		const source = await decompileSingleClass(context, materialized.filePath);
		assert.match(source, /return 42/);
		assert.match(source, /class Nested/);
	} finally {
		materialized.dispose();
	}
	assert.equal(fs.existsSync(path.join(context.globalStorageUri.fsPath, 'class-input')), true);
	assert.deepEqual(fs.readdirSync(path.join(context.globalStorageUri.fsPath, 'class-input')), []);
});
