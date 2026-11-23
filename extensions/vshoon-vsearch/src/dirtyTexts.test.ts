/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DirtyTextTracker } from './dirtyTexts';
import type { WorkerMessage, WorkerOptions, WorkerRequest } from './searchWorker';

interface FakeDocument {
	uri: { scheme: string; fsPath: string };
	isDirty: boolean;
	version: number;
	getText(): string;
}

function document(fsPath: string, text: string, version = 1, isDirty = true, scheme = 'file', reads?: string[]): FakeDocument {
	return { uri: { scheme, fsPath }, isDirty, version, getText: () => { reads?.push(fsPath); return text; } };
}

describe('search dirty snapshots', () => {
	it('sends only changed local snapshots and clears saved or closed documents', () => {
		const reads: string[] = [];
		const tracker = new DirtyTextTracker();
		const first = tracker.changes([
			document('/edited.sql', 'v1', 1, true, 'file', reads),
			document('/saved.sql', 'saved', 1, false, 'file', reads),
			document('/remote.sql', 'remote', 1, true, 'vscode-remote', reads),
			document('/closed.sql', 'closed', 1, true, 'file', reads)
		]);
		const unchanged = tracker.changes([document('/edited.sql', 'v1', 1, true, 'file', reads), document('/closed.sql', 'closed', 1, true, 'file', reads)]);
		const edited = tracker.changes([document('/edited.sql', 'v2', 2, true, 'file', reads)]);
		tracker.reset();
		const afterReset = tracker.changes([document('/edited.sql', 'v2', 2, true, 'file', reads)]);
		assert.deepStrictEqual({ first, unchanged, edited, afterReset, reads }, {
			first: { set: { '/edited.sql': 'v1', '/closed.sql': 'closed' }, clear: [] },
			unchanged: undefined,
			edited: { set: { '/edited.sql': 'v2' }, clear: ['/closed.sql'] },
			afterReset: { set: { '/edited.sql': 'v2' }, clear: [] },
			reads: ['/edited.sql', '/closed.sql', '/edited.sql', '/edited.sql']
		});
	});

	it('searches the worker file list with stored snapshots, scope and list updates', { timeout: 10_000 }, async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsearch-dirty-'));
		try {
			const write = (name: string, text: string) => {
				const filePath = path.join(directory, name);
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, text);
				return filePath;
			};
			const saved = write('Saved.java', 'needle on disk');
			const edited = write('Edited.java', 'nothing on disk');
			const nested = write(path.join('nested', 'Nested.java'), 'needle nested');
			const added = write('Added.txt', 'needle added');
			const search = { type: 'search', preemptible: false, pattern: 'needle', regex: false, caseSensitive: true, wholeWord: false, maxBytes: 1024, maxMatchesPerFile: 10, maxResultFiles: 10 } as const;
			const results = await runWorker([
				{ type: 'files', paths: [saved, edited, nested] },
				{ type: 'dirty', set: { [edited]: 'needle unsaved' }, clear: [] },
				{ ...search, id: 1, scope: { recursive: true, fileMask: '' } },
				{ ...search, id: 2, scope: { directory, recursive: false, fileMask: '*.java' } },
				{ type: 'filesAdd', paths: [added] },
				{ type: 'invalidate', paths: [saved] },
				{ type: 'dirty', set: {}, clear: [edited] },
				{ ...search, id: 3, scope: { recursive: true, fileMask: '' } }
			]);
			assert.deepStrictEqual(results, [
				['Saved.java', 'Edited.java', 'Nested.java'],
				['Saved.java', 'Edited.java'],
				['Nested.java', 'Added.txt']
			]);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

/** Runs the real worker without an editor or access to user documents and returns the file names each search reports. */
async function runWorker(requests: WorkerRequest[]): Promise<string[][]> {
	const currentSearch = new SharedArrayBuffer(4);
	const options: WorkerOptions = { currentSearch, cacheBytes: 1024 * 1024 };
	const worker = new Worker(path.join(__dirname, 'searchWorker.js'), { workerData: options });
	const searches = requests.filter(request => request.type === 'search').length;
	try {
		return await new Promise<string[][]>((resolve, reject) => {
			const results = new Map<number, string[]>();
			let done = 0;
			worker.on('error', reject);
			worker.on('exit', code => reject(new Error(`Worker exited before completion: ${code}`)));
			worker.on('message', (message: WorkerMessage) => {
				if (message.type === 'batch') {
					results.set(message.id, [...results.get(message.id) ?? [], ...message.files.map(file => path.basename(file.fsPath))]);
				} else if (message.type === 'done' && ++done === searches) {
					resolve([...results.keys()].sort((a, b) => a - b).map(id => results.get(id)!));
				} else if (message.type === 'error') {
					reject(new Error(message.message));
				}
			});
			for (const request of requests) {
				worker.postMessage(request);
			}
		});
	} finally {
		await worker.terminate();
	}
}
