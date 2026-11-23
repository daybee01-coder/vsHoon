/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentCache, search, WorkerMessage, WorkerSearchRequest } from './searchWorker';
import { CACHE_DIRECTORY } from './persistentCache';

describe('search worker cache', () => {
	let directory: string;

	before(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsearch-worker-'));
	});

	after(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	function write(name: string, content: string | Buffer): string {
		const filePath = path.join(directory, name);
		fs.writeFileSync(filePath, content);
		return filePath;
	}

	it('searches updated, new and dirty files after indexing, without watcher invalidation', () => {
		const changed = write('changed.txt', 'unrelated original');
		const removed = write('removed.txt', 'needle');
		const dirty = write('dirty.txt', 'not saved yet');
		const cache = new ContentCache(1024 * 1024);
		for (const filePath of [changed, removed, dirty]) {
			cache.read(filePath, 1024);
		}
		fs.writeFileSync(changed, 'needle added by an external editor');
		fs.unlinkSync(removed);
		const added = write('added.txt', 'needle in new file');
		const messages: WorkerMessage[] = [];
		search({
			type: 'search', id: 1, preemptible: true, paths: [changed, removed, dirty, added],
			dirty: { [dirty]: 'unsaved needle' }, pattern: 'needle', regex: false, caseSensitive: false,
			wholeWord: false, maxBytes: 1024, maxMatchesPerFile: 10, maxResultFiles: 10
		}, cache, () => true, message => messages.push(message));
		assert.deepStrictEqual(messages.flatMap(message => message.type === 'batch' ? message.files.map(file => path.basename(file.fsPath)) : []), ['changed.txt', 'dirty.txt', 'added.txt']);
	});

	it('skips disk checks for recently verified content but verifies every reported file', () => {
		const unchecked = write('unchecked.txt', 'plain text');
		const reported = write('reported.txt', 'needle at first');
		const cache = new ContentCache(1024 * 1024);
		cache.read(unchecked, 1024);
		cache.read(reported, 1024);
		fs.writeFileSync(unchecked, 'needle appears later');
		fs.writeFileSync(reported, 'later text, then needle and needle');
		const messages: WorkerMessage[] = [];
		search({
			type: 'search', id: 2, preemptible: true, paths: [unchecked, reported], dirty: {}, pattern: 'needle',
			regex: false, caseSensitive: false, wholeWord: false, maxBytes: 1024, maxMatchesPerFile: 10, maxResultFiles: 10, freshMs: 60_000
		}, cache, () => true, message => messages.push(message));
		assert.deepStrictEqual(
			messages.flatMap(message => message.type === 'batch' ? message.files.map(file => [path.basename(file.fsPath), file.matches.map(match => match.column)]) : []),
			[['reported.txt', [17, 28]]]
		);
	});

	it('reindexes changed content immediately without a watcher event', () => {
		const filePath = write('keep.txt', 'first');
		const cache = new ContentCache(1024 * 1024);
		const reads = [cache.read(filePath, 1024)];
		fs.writeFileSync(filePath, 'second');
		reads.push(cache.read(filePath, 1024));
		cache.invalidate([filePath]);
		reads.push(cache.read(filePath, 1024));
		assert.deepStrictEqual(reads, ['first', 'second', 'second']);
	});

	it('reuses the project index across sessions without reading unchanged source files', () => {
		const project = fs.mkdtempSync(path.join(directory, 'persistent-'));
		const filePath = path.join(project, 'Source.java');
		fs.writeFileSync(filePath, 'class Source { String value = "needle"; }');
		let reads = 0;
		const readSource = (file: string) => { reads++; return fs.readFileSync(file); };
		const first = new ContentCache(1024 * 1024, [project], readSource);
		const texts = [first.read(filePath, 1024)];
		const second = new ContentCache(1024 * 1024, [project], readSource);
		texts.push(second.read(filePath, 1024));
		const reusedReads = reads;
		fs.writeFileSync(filePath, 'class Source { String value = "changed needle"; }');
		texts.push(second.read(filePath, 1024));
		assert.deepStrictEqual({ texts, reusedReads, reads }, {
			texts: ['class Source { String value = "needle"; }', 'class Source { String value = "needle"; }', 'class Source { String value = "changed needle"; }'], reusedReads: 1, reads: 2
		});
	});

	it('recovers from a corrupt project cache and removes deleted cached files', () => {
		const project = fs.mkdtempSync(path.join(directory, 'corrupt-'));
		const filePath = path.join(project, 'source.txt');
		fs.writeFileSync(filePath, 'needle');
		new ContentCache(1024 * 1024, [project]).read(filePath, 1024);
		const cacheDirectory = path.join(project, '.vshoon', 'cache', CACHE_DIRECTORY);
		const cacheFile = path.join(cacheDirectory, fs.readdirSync(cacheDirectory).find(name => name.endsWith('.bin'))!);
		// 내용 한 바이트만 바뀌어도 checksum 으로 걸러낸다.
		const corrupt = fs.readFileSync(cacheFile);
		corrupt[corrupt.length - 1] ^= 1;
		fs.writeFileSync(cacheFile, corrupt);
		const cache = new ContentCache(1024 * 1024, [project]);
		const text = cache.read(filePath, 1024);
		fs.unlinkSync(filePath);
		assert.deepStrictEqual([text, cache.read(filePath, 1024), fs.existsSync(cacheFile)], ['needle', null, false]);
	});

	it('removes deleted content without a watcher event', () => {
		const filePath = write('stale.txt', 'old');
		const cache = new ContentCache(1024 * 1024);
		const reads = [cache.read(filePath, 1024)];
		fs.unlinkSync(filePath);
		reads.push(cache.read(filePath, 1024));
		assert.deepStrictEqual(reads, ['old', null]);
	});

	it('skips binary and oversized files and rereads when the limit grows', () => {
		const binary = write('image.bin', Buffer.from([1, 0, 2]));
		const large = write('large.txt', 'x'.repeat(100));
		const cache = new ContentCache(1024 * 1024);
		assert.deepStrictEqual(
			[cache.read(binary, 1024), cache.read(large, 10), cache.read(large, 1024)?.length],
			[null, null, 100]
		);
	});

	it('treats archives and large files with a binary head as binary without reading them whole', () => {
		const archive = write('library.jar', 'readable text in a jar name');
		const large = write('large.dat', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), Buffer.alloc(128 * 1024, 0x41)]));
		const text = write('large.txt', 'needle '.repeat(20 * 1024));
		const reads: string[] = [];
		const cache = new ContentCache(1024 * 1024, [], file => { reads.push(path.basename(file)); return fs.readFileSync(file); });
		assert.deepStrictEqual({
			results: [cache.read(archive, 1024 * 1024), cache.read(large, 1024 * 1024), cache.read(text, 1024 * 1024)?.length],
			reads
		}, { results: [null, null, 7 * 20 * 1024], reads: ['large.txt'] });
	});

	it('evicts the least recently used content beyond the limit', () => {
		const first = write('a.txt', 'a'.repeat(100));
		const second = write('b.txt', 'b'.repeat(100));
		const cache = new ContentCache(300);
		cache.read(first, 1024);
		cache.read(second, 1024);
		assert.strictEqual(cache.size, 1);
	});

	it('stops at the total match limit and leaves unlimited searches complete', () => {
		const paths = ['first', 'second', 'third'].map(name => write(`${name}-limit.txt`, 'needle and needle'));
		const run = (maxTotalMatches: number) => {
			const messages: WorkerMessage[] = [];
			search({
				type: 'search', id: 9, preemptible: true, paths, dirty: {}, pattern: 'needle', regex: false, caseSensitive: false,
				wholeWord: false, maxBytes: 1024, maxMatchesPerFile: 10, maxResultFiles: 10, maxTotalMatches
			}, new ContentCache(1024 * 1024), () => true, message => messages.push(message));
			return messages.flatMap(message => message.type === 'batch'
				? message.files.map(file => [path.basename(file.fsPath), file.matches.length, file.truncated])
				: message.type === 'done' ? [[message.matchCount, message.truncated]] : []);
		};
		assert.deepStrictEqual({ limited: run(3), unlimited: run(0) }, {
			limited: [['first-limit.txt', 2, false], ['second-limit.txt', 1, true], [3, true]],
			unlimited: [['first-limit.txt', 2, false], ['second-limit.txt', 2, false], ['third-limit.txt', 2, false], [6, false]]
		});
	});

	it('stops a search as soon as it is no longer current', () => {
		const paths = ['one', 'two', 'three'].map(name => write(`${name}.txt`, 'needle'));
		const request: WorkerSearchRequest = {
			type: 'search', id: 7, preemptible: true, paths, dirty: {},
			pattern: 'needle', regex: false, caseSensitive: true, wholeWord: false,
			maxBytes: 1024, maxMatchesPerFile: 10, maxResultFiles: 10,
		};
		let checks = 0;
		const messages: WorkerMessage[] = [];
		search(request, new ContentCache(1024 * 1024), () => ++checks <= 1, message => messages.push(message));
		assert.deepStrictEqual(messages.map(message => message.type === 'batch' ? message.files.length : message), [
			1,
			{ type: 'done', id: 7, fileCount: 1, matchCount: 1, truncated: false, cancelled: true },
		]);
	});
});
