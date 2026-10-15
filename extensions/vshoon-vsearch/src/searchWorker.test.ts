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

	it('keeps text until invalidated, then reads the new content', () => {
		const filePath = write('keep.txt', 'first');
		const cache = new ContentCache(1024 * 1024);
		const reads = [cache.read(filePath, 1024)];
		fs.writeFileSync(filePath, 'second');
		reads.push(cache.read(filePath, 1024));
		cache.invalidate([filePath]);
		reads.push(cache.read(filePath, 1024));
		assert.deepStrictEqual(reads, ['first', 'first', 'second']);
	});

	it('revalidates against the disk once the entry is old', () => {
		let now = 0;
		const filePath = write('stale.txt', 'old');
		const cache = new ContentCache(1024 * 1024, () => now);
		const reads = [cache.read(filePath, 1024)];
		fs.writeFileSync(filePath, 'newer');
		now = 60_000;
		reads.push(cache.read(filePath, 1024));
		assert.deepStrictEqual(reads, ['old', 'newer']);
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

	it('evicts the least recently used content beyond the limit', () => {
		const first = write('a.txt', 'a'.repeat(100));
		const second = write('b.txt', 'b'.repeat(100));
		const cache = new ContentCache(300);
		cache.read(first, 1024);
		cache.read(second, 1024);
		assert.strictEqual(cache.size, 1);
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
