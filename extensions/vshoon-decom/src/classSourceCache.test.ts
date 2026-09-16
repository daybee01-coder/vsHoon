/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { ClassSourceCache } from './classSourceCache';

const roots: string[] = [];

function createCache(): ClassSourceCache {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-source-cache-'));
	roots.push(root);
	const context = { globalStorageUri: { fsPath: root } } as vscode.ExtensionContext;
	return new ClassSourceCache(context);
}

/** The directory the cache created last, so a test can inspect what it published. */
function currentCacheRoot(): string {
	return path.join(roots[roots.length - 1], 'class-sources-v2');
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

describe('ClassSourceCache', () => {
	it('publishes source and metadata together and reuses them', async () => {
		const cache = createCache();
		await cache.write({
			key: 'one',
			classUri: 'vshoon-jar://one/pkg/App.class',
			sourceUri: 'vshoon-decom://source/App.java?class=one',
			displayPath: 'app.jar!/pkg/App.class',
			rootFilePath: 'app.jar',
			rootMtime: 1,
			rootSize: 2
		}, 'class App {}');

		const cached = await cache.read('one');
		assert.deepStrictEqual({
			source: cached?.source,
			key: cached?.metadata.key,
			version: cached?.metadata.version,
			entries: (await cache.entries()).map(entry => path.basename(entry.sourcePath))
		}, {
			source: 'class App {}',
			key: 'one',
			version: 2,
			entries: ['one.java']
		});
	});

	it('resolves a source URI through the index and rebuilds a removed index', async () => {
		const cache = createCache();
		const cacheRoot = currentCacheRoot();
		const metadata = {
			classUri: 'vshoon-jar://one/pkg/App.class',
			sourceUri: 'vshoon-decom://source/App.java?class=one',
			displayPath: 'app.jar!/pkg/App.class',
			rootFilePath: 'app.jar',
			rootMtime: 1,
			rootSize: 2
		};
		const indexNames = () => fs.readdirSync(cacheRoot).filter(name => name.endsWith('.ref'));
		await cache.write({ ...metadata, key: 'first' }, 'class App { }');
		await new Promise(resolve => setTimeout(resolve, 5));
		await cache.write({ ...metadata, key: 'second' }, 'class App { int value; }');
		const indexed = await cache.metadataBySourceUri(metadata.sourceUri);
		for (const name of indexNames()) {
			fs.rmSync(path.join(cacheRoot, name));
		}
		const healed = await cache.metadataBySourceUri(metadata.sourceUri);

		assert.deepStrictEqual({
			indexed: indexed?.key,
			healed: healed?.key,
			indexes: indexNames().length,
			missing: await cache.metadataBySourceUri('vshoon-decom://source/Other.java?class=two')
		}, { indexed: 'second', healed: 'second', indexes: 1, missing: undefined });
	});

	it('removes older entries when the size limit is exceeded', async () => {
		const cache = createCache();
		const metadata = {
			classUri: 'file:///App.class',
			sourceUri: 'vshoon-decom://source/App.java?class=one',
			displayPath: 'App.class',
			rootFilePath: 'App.class',
			rootMtime: 1,
			rootSize: 2
		};
		await cache.write({ ...metadata, key: 'old' }, 'a'.repeat(20));
		await new Promise(resolve => setTimeout(resolve, 5));
		await cache.write({ ...metadata, key: 'new' }, 'b'.repeat(20));
		await cache.trim(20);
		assert.deepStrictEqual({ old: await cache.read('old'), source: (await cache.read('new'))?.source }, {
			old: undefined,
			source: 'b'.repeat(20)
		});
	});
});
