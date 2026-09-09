/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { collectDirtyTexts } from './dirtyTexts';
import type { WorkerInput, WorkerMessage } from './searchWorker';

describe('search dirty snapshots', () => {
	it('reads only selected dirty file documents', () => {
		const reads: string[] = [];
		const documents = [
			{ fsPath: '/selected.sql', scheme: 'file', isDirty: true },
			{ fsPath: '/excluded.sql', scheme: 'file', isDirty: true },
			{ fsPath: '/saved.sql', scheme: 'file', isDirty: false },
			{ fsPath: '/remote.sql', scheme: 'vscode-remote', isDirty: true },
			{ fsPath: '/untitled.sql', scheme: 'untitled', isDirty: true },
		].map(item => ({
			uri: item, isDirty: item.isDirty,
			getText: () => { reads.push(item.fsPath); return 'latest'; },
		}));
		const dirty = collectDirtyTexts(['/selected.sql', '/saved.sql', '/remote.sql', '/untitled.sql'], documents);
		assert.deepStrictEqual({ dirty, reads }, { dirty: { '/selected.sql': 'latest' }, reads: ['/selected.sql'] });
	});

	it('does not read any text when the search has no paths', () => {
		assert.deepStrictEqual(collectDirtyTexts([], [{
			uri: { scheme: 'file', fsPath: '/file.sql' }, isDirty: true,
			getText: () => { throw new Error('Unexpected snapshot'); },
		}]), {});
	});

	it('preserves empty and large selected snapshots without a new size limit', () => {
		const large = 'x'.repeat(6 * 1024 * 1024);
		const dirty = collectDirtyTexts(['/empty', '/large'], [
			{ uri: { scheme: 'file', fsPath: '/empty' }, isDirty: true, getText: () => '' },
			{ uri: { scheme: 'file', fsPath: '/large' }, isDirty: true, getText: () => large },
		]);
		assert.deepStrictEqual({ keys: Object.keys(dirty), empty: dirty['/empty'], length: dirty['/large'].length }, {
			keys: ['/empty', '/large'], empty: '', length: large.length,
		});
	});

	it('keeps exact path matching, including case and Unicode', () => {
		const selected = 'C:\\프로젝트\\Query.sql';
		assert.deepStrictEqual(collectDirtyTexts([selected, selected], [{
			uri: { scheme: 'file', fsPath: selected.toLowerCase() }, isDirty: true,
			getText: () => { throw new Error('Worker would not consume this differently cased key'); },
		}]), {});
	});

	it('reduces 100 eligible document snapshots to the two search targets', () => {
		let reads = 0;
		const documents = Array.from({ length: 100 }, (_, index) => ({
			uri: { scheme: 'file', fsPath: `/file-${index}.sql` }, isDirty: true,
			getText: () => { reads++; return 'x'.repeat(10_000); },
		}));
		const dirty = collectDirtyTexts(['/file-1.sql', '/file-99.sql'], documents);
		assert.deepStrictEqual({ reads, characters: Object.values(dirty).reduce((sum, text) => sum + text.length, 0) }, {
			reads: 2, characters: 20_000,
		});
	});

	it('produces identical worker results after dropping unrelated snapshots', { timeout: 10_000 }, async () => {
		const snapshots = { '/selected.sql': 'SELECT latest', '/empty.sql': '', '/outside.sql': 'latest' };
		const input: WorkerInput = {
			paths: ['/selected.sql', '/empty.sql'], dirty: snapshots,
			pattern: 'latest', regex: false, caseSensitive: true, wholeWord: false,
			maxBytes: 1, maxMatchesPerFile: 100, maxResultFiles: 100,
		};
		const filtered = collectDirtyTexts(input.paths, Object.entries(snapshots).map(([fsPath, text]) => ({
			uri: { scheme: 'file', fsPath }, isDirty: true, getText: () => text,
		})));
		const before = await runWorker(input);
		const after = await runWorker({ ...input, dirty: filtered });
		assert.deepStrictEqual(after, before);
		assert.deepStrictEqual(after.at(-1), { type: 'done', fileCount: 1, matchCount: 1, truncated: false });
	});
});

/** Runs the real worker without an editor or access to user documents. */
async function runWorker(input: WorkerInput): Promise<WorkerMessage[]> {
	const worker = new Worker(path.join(__dirname, 'searchWorker.js'), { workerData: input });
	try {
		return await new Promise<WorkerMessage[]>((resolve, reject) => {
			const messages: WorkerMessage[] = [];
			worker.on('error', reject);
			worker.on('exit', code => reject(new Error(`Worker exited before completion: ${code}`)));
			worker.on('message', (message: WorkerMessage) => {
				messages.push(message);
				if (message.type === 'done') {
					resolve(messages);
				} else if (message.type === 'error') {
					reject(new Error(message.message));
				}
			});
		});
	} finally {
		await worker.terminate();
	}
}
