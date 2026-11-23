/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { coreDir, repoRoot } from './core-paths.mjs';

const require = createRequire(join(coreDir, 'package.json'));
const { ContentCache, search } = require('./extensions/vshoon-vsearch/out/searchWorker.js');
const fixtureRoot = join(repoRoot, '.build');
const directory = mkdtempSync(join(fixtureRoot, 'vsearch-benchmark-'));

/** Same metadata checks and cached text, without the candidate filter. */
class ScanCache extends ContentCache {
	mayContain() { return true; }
}

try {
	const paths = [];
	for (let index = 0; index < 2000; index++) {
		const file = join(directory, `Source${index}.java`);
		writeFileSync(file, `class Source${index} {\n${'  public String value() { return "example text"; }\n'.repeat(200)}${index % 200 === 0 ? '  // uniqueNeedle\n' : ''}}`);
		paths.push(file);
	}
	const scan = new ScanCache(256 * 1024 * 1024);
	const indexed = new ContentCache(256 * 1024 * 1024);
	for (const file of paths) {
		scan.read(file, 1024 * 1024);
		indexed.read(file, 1024 * 1024);
	}
	const request = {
		type: 'search', id: 1, preemptible: true, paths, dirty: {}, pattern: 'uniqueNeedle',
		regex: false, caseSensitive: false, wholeWord: false, maxBytes: 1024 * 1024,
		maxMatchesPerFile: 100, maxResultFiles: 3000
	};
	const run = cache => {
		const files = [];
		const started = performance.now();
		search(request, cache, () => true, message => {
			if (message.type === 'batch') { files.push(...message.files); }
		});
		return { ms: performance.now() - started, files };
	};
	const scanMs = [];
	const indexMs = [];
	for (let attempt = 0; attempt < 5; attempt++) {
		const runs = attempt % 2 === 0 ? [run(scan), run(indexed)] : [run(indexed), run(scan)].reverse();
		assert.deepStrictEqual(runs[0].files, runs[1].files);
		assert.equal(runs[0].files.length, 10);
		scanMs.push(runs[0].ms);
		indexMs.push(runs[1].ms);
	}
	const median = values => values.sort((a, b) => a - b)[2].toFixed(1);
	let sourceReads = 0;
	const readSource = file => { sourceReads++; return readFileSync(file); };
	const prepare = cache => {
		const started = performance.now();
		for (const file of paths) { cache.read(file, 1024 * 1024); }
		cache.prune(true);
		return (performance.now() - started).toFixed(1);
	};
	const persistent = new ContentCache(256 * 1024 * 1024, [directory], readSource);
	const buildAndPersistMs = prepare(persistent);
	assert.equal(sourceReads, paths.length);
	sourceReads = 0;
	const restored = new ContentCache(256 * 1024 * 1024, [directory], readSource);
	const restoreMs = prepare(restored);
	assert.equal(sourceReads, 0, 'A new session reuses unchanged project files without rereading their sources');
	assert.deepStrictEqual(run(restored).files, run(indexed).files);
	console.log(JSON.stringify({ files: paths.length, linesPerFile: 200, matches: 10, scanMedianMs: median(scanMs), indexMedianMs: median(indexMs), buildAndPersistMs, restoreMs, restoredSourceReads: sourceReads }));
} finally {
	assert.ok(directory.startsWith(fixtureRoot + sep));
	rmSync(directory, { recursive: true, force: true });
}
