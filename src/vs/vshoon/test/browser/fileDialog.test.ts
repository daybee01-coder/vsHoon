/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { upcastPartial } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IFileService, IFileStatWithMetadata } from '../../../platform/files/common/files.js';
import { IQuickInputHideEvent, IQuickWidget, QuickInputHideReason } from '../../../platform/quickinput/common/quickInput.js';
import { VShoonFileDialog } from '../../browser/fileDialog/vshoonFileDialog.js';

suite('VShoon File Dialog UI lifetime', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Uses a real DOM with injected file reads and a minimal quick-widget host. */
	function createDialog(stat: (uri: URI) => Promise<boolean>, resolve: (uri: URI) => Promise<string[]> = async () => []) {
		const hidden = store.add(new Emitter<IQuickInputHideEvent>());
		let disposed = false;
		const widget = upcastPartial<IQuickWidget>({
			onDidHide: hidden.event,
			onDidTriggerButton: Event.None,
			show: () => { if (widget.widget instanceof HTMLElement) { document.body.append(widget.widget); } },
			hide: () => hidden.fire({ reason: QuickInputHideReason.Other }),
			dispose: () => {
				disposed = true;
				if (widget.widget instanceof HTMLElement) { widget.widget.remove(); }
			}
		});
		const dialog = store.add(new VShoonFileDialog(
			upcastPartial<IFileService>({
				stat: async uri => upcastPartial<IFileStatWithMetadata>({ isDirectory: await stat(uri) }),
				resolve: async uri => upcastPartial<IFileStatWithMetadata>({
					children: (await resolve(uri)).map(name => upcastPartial<IFileStatWithMetadata>({ name, isDirectory: false }))
				})
			}),
			upcastPartial<ConstructorParameters<typeof VShoonFileDialog>[1]>({ createQuickWidget: () => widget }),
			upcastPartial<ConstructorParameters<typeof VShoonFileDialog>[2]>({ userHome: URI.file('/home') }),
			upcastPartial<ConstructorParameters<typeof VShoonFileDialog>[3]>({ getUriLabel: uri => uri.path })
		));
		return {
			dialog,
			root: () => { assert.ok(widget.widget instanceof HTMLElement); return widget.widget; },
			cancel: () => hidden.fire({ reason: QuickInputHideReason.Gesture }),
			isDisposed: () => disposed
		};
	}

	for (const stage of ['stat', 'listing'] as const) {
		test(`cancel resolves and disposes without waiting for ${stage}`, async () => {
			const pending = new DeferredPromise<void>();
			const ui = createDialog(async () => {
				if (stage === 'stat') { await pending.p; }
				return true;
			}, async () => {
				if (stage === 'listing') { await pending.p; }
				return ['late.txt'];
			});
			let resolved = false;
			const result = ui.dialog.showOpenDialog({ defaultUri: URI.file('/slow'), canSelectFiles: true }).then(value => {
				resolved = true;
				return value;
			});
			try {
				await timeout(0);
				assert.equal(ui.root().getAttribute('role'), 'dialog');
				ui.cancel();
				await timeout(0);
				assert.deepStrictEqual({ resolved, disposed: ui.isDisposed() }, { resolved: true, disposed: true });
			} finally {
				await pending.complete();
				assert.equal(await result, undefined);
			}
		});
	}

	for (const failure of [false, true]) {
		test(`initial ${failure ? 'failure' : 'file stat'} cannot overwrite later navigation`, async () => {
			const pending = new DeferredPromise<boolean>();
			const reads: string[] = [];
			const ui = createDialog(() => pending.p, async uri => { reads.push(uri.path); return ['current.txt']; });
			const result = ui.dialog.showOpenDialog({ defaultUri: URI.file('/initial/file.txt'), canSelectFiles: true });
			try {
				const input = ui.root().querySelector<HTMLInputElement>('.vshoon-file-dialog-path');
				assert.ok(input);
				input.value = '/chosen';
				input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
				await timeout(0);
				if (failure) { await pending.error(new Error('Unavailable')); } else { await pending.complete(false); }
				await timeout(0);
				assert.deepStrictEqual({ path: input.value, reads }, { path: '/chosen', reads: ['/chosen'] });
			} finally {
				ui.cancel();
				await pending.complete(true);
				await result;
			}
		});
	}
});
