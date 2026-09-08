/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { URI } from '../../../base/common/uri.js';
import { FileDialogChildReader, FileDialogListing, FileDialogListingOutcome, IFileDialogChild } from '../../common/fileDialogListing.js';

interface ISummary {
	readonly kind: string;
	readonly names?: readonly string[];
	readonly paths?: readonly string[];
	readonly message?: string;
}

function summarize(outcome: FileDialogListingOutcome): ISummary {
	switch (outcome.kind) {
		case 'listed': return { kind: 'listed', names: outcome.nodes.map(node => node.name), paths: outcome.nodes.map(node => node.uri.path) };
		case 'failed': return { kind: 'failed', message: outcome.error?.message };
		case 'stale': return { kind: 'stale' };
	}
}

/** A reader whose folders only answer once the test releases them. */
class SlowFolders {

	private readonly pending = new Map<string, (result: readonly IFileDialogChild[] | Error) => void>();

	readonly read: FileDialogChildReader = uri => new Promise((resolve, reject) => {
		this.pending.set(uri.path, result => result instanceof Error ? reject(result) : resolve(result));
	});

	/** Answers one folder and lets the listing's continuation run. */
	async release(path: string, result: readonly IFileDialogChild[] | Error): Promise<void> {
		const settle = this.pending.get(path);
		assert.ok(settle, `no pending read for ${path}`);
		this.pending.delete(path);
		settle(result);
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

const file = (name: string): IFileDialogChild => ({ name, isDirectory: false });
const folder = (name: string): IFileDialogChild => ({ name, isDirectory: true });

suite('VShoon File Dialog Listing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sorts directories first and applies the file type filters', async () => {
		const listing = new FileDialogListing(async () => [file('b.txt'), folder('zeta'), file('a.sql'), folder('alpha'), file('c.SQL')], [{ extensions: ['sql'] }]);

		assert.deepStrictEqual(summarize(await listing.list(URI.file('/root'))), {
			kind: 'listed',
			names: ['alpha', 'zeta', 'a.sql', 'c.SQL'],
			paths: ['/root/alpha', '/root/zeta', '/root/a.sql', '/root/c.SQL']
		});
	});

	test('keeps every entry when a filter accepts all extensions', async () => {
		const listing = new FileDialogListing(async () => [file('notes.md'), file('query.sql')], [{ extensions: ['*'] }]);

		assert.deepStrictEqual(summarize(await listing.list(URI.file('/root'))), {
			kind: 'listed',
			names: ['notes.md', 'query.sql'],
			paths: ['/root/notes.md', '/root/query.sql']
		});
	});

	test('a slow folder cannot overwrite the folder navigated to after it', async () => {
		const folders = new SlowFolders();
		const listing = new FileDialogListing(folders.read, undefined);

		const slow = listing.list(URI.file('/slow'));
		const quick = listing.list(URI.file('/quick'));
		await folders.release('/quick', [file('quick.txt')]);
		await folders.release('/slow', [file('slow.txt')]);

		assert.deepStrictEqual([summarize(await slow), summarize(await quick)], [
			{ kind: 'stale' },
			{ kind: 'listed', names: ['quick.txt'], paths: ['/quick/quick.txt'] }
		]);
	});

	test('a slow folder that fails after the user moved on reports stale, not an error', async () => {
		const folders = new SlowFolders();
		const listing = new FileDialogListing(folders.read, undefined);

		const slow = listing.list(URI.file('/slow'));
		const quick = listing.list(URI.file('/quick'));
		await folders.release('/quick', []);
		await folders.release('/slow', new Error('EACCES'));

		assert.deepStrictEqual([summarize(await slow), summarize(await quick)], [
			{ kind: 'stale' },
			{ kind: 'listed', names: [], paths: [] }
		]);
	});

	test('reports the failure of the folder still being shown', async () => {
		const denied = new FileDialogListing(async () => { throw new Error('Permission denied'); }, undefined);
		const broken = new FileDialogListing(() => Promise.reject('the provider rejected without an error'), undefined);

		assert.deepStrictEqual([summarize(await denied.list(URI.file('/root'))), summarize(await broken.list(URI.file('/root')))], [
			{ kind: 'failed', message: 'Permission denied' },
			{ kind: 'failed', message: undefined }
		]);
	});

	test('an expanded row loads within its own listing and is dropped once the folder changes', async () => {
		const folders = new SlowFolders();
		const listing = new FileDialogListing(folders.read, undefined);

		const first = listing.list(URI.file('/root'));
		await folders.release('/root', [folder('child')]);
		await first;

		const generation = listing.generation;
		const expanded = listing.listWithin(URI.file('/root/child'), generation);
		const slowExpansion = listing.listWithin(URI.file('/root/other'), generation);
		await folders.release('/root/child', [file('inner.txt')]);

		const navigated = listing.list(URI.file('/elsewhere'));
		await folders.release('/root/other', [file('late.txt')]);
		await folders.release('/elsewhere', [file('there.txt')]);

		assert.deepStrictEqual([summarize(await expanded), summarize(await slowExpansion), summarize(await navigated), summarize(await listing.listWithin(URI.file('/root/child'), generation))], [
			{ kind: 'listed', names: ['inner.txt'], paths: ['/root/child/inner.txt'] },
			{ kind: 'stale' },
			{ kind: 'listed', names: ['there.txt'], paths: ['/elsewhere/there.txt'] },
			{ kind: 'stale' }
		]);
	});

	test('cancelling drops the folder still loading when the dialog closes', async () => {
		const folders = new SlowFolders();
		const listing = new FileDialogListing(folders.read, undefined);

		const pending = listing.list(URI.file('/slow'));
		listing.cancel();
		await folders.release('/slow', [file('late.txt')]);

		assert.deepStrictEqual(summarize(await pending), { kind: 'stale' });
	});
});
