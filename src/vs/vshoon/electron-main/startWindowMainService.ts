/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, IpcMainEvent } from 'electron';
import { DeferredPromise } from '../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { isMacintosh } from '../../base/common/platform.js';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';

const START_WINDOW_ACTION_CHANNEL = 'vscode:vshoonStartWindowAction';

/**
 * How the start window gave up ownership of the launch.
 *
 * - `continue`: the user asked to open the workbench.
 * - `quit`: the user closed the start window without choosing anything.
 * - `superseded`: another launch request opened a workbench window instead.
 */
export type VShoonStartWindowAction = 'continue' | 'quit' | 'superseded';

export const IVShoonStartWindowMainService = createDecorator<IVShoonStartWindowMainService>('vshoonStartWindowMainService');

export interface IVShoonStartWindowMainService {

	readonly _serviceBrand: undefined;

	/**
	 * Whether the start window is currently the visible owner of the launch. This is `false`
	 * once the user has chosen an action, even while the window is still alive.
	 */
	readonly ownsLaunch: boolean;

	/** Creates the start window and resolves once it gives up ownership of the launch. */
	show(): Promise<VShoonStartWindowAction>;

	/** Brings the start window back to the foreground for a second launch request. */
	focus(): void;

	/** Steps the start window down because another launch request is opening a workbench window. */
	supersede(): void;

	/** Disposes the start window once the workbench window it handed off to exists. */
	releaseWhenWorkbenchOpens(): void;
}

export class VShoonStartWindowMainService extends Disposable implements IVShoonStartWindowMainService {

	declare readonly _serviceBrand: undefined;

	private readonly windowDisposables = this._register(new DisposableStore());

	private window: BrowserWindow | undefined;
	private pendingAction: DeferredPromise<VShoonStartWindowAction> | undefined;
	private state: 'closed' | 'showing' | 'released' = 'closed';
	private releaseHandle: Timeout | undefined;

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	get ownsLaunch(): boolean {
		return this.state === 'showing';
	}

	async show(): Promise<VShoonStartWindowAction> {
		if (this.state !== 'closed') {
			throw new Error('VShoon start window is already open.');
		}

		this.state = 'showing';
		const pendingAction = this.pendingAction = new DeferredPromise<VShoonStartWindowAction>();

		const window = this.window = new BrowserWindow({
			title: 'VShoon',
			width: 760,
			height: 520,
			minWidth: 640,
			minHeight: 440,
			center: true,
			show: false,
			autoHideMenuBar: true,
			backgroundColor: '#181818',
			webPreferences: {
				preload: FileAccess.asFileUri('vs/base/parts/sandbox/electron-browser/preload-aux.js').fsPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				spellcheck: false
			}
		});

		this.windowDisposables.add(toDisposable(() => {
			this.window = undefined;
			if (!window.isDestroyed()) {
				window.destroy();
			}
		}));

		window.setMenuBarVisibility(false);
		window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

		const onAction = (event: IpcMainEvent, action: string) => {
			if (event.sender.id !== window.webContents.id) {
				return;
			}

			if (action !== 'continue' && action !== 'quit') {
				this.logService.warn(`vshoon#startWindow: ignored unknown action '${action}'`);
				return;
			}

			this.complete(action);
			if (action === 'continue') {
				// Keep the BrowserWindow alive until the workbench has opened. Closing the
				// only window here would trigger Electron's window-all-closed lifecycle.
				window.hide();
			} else {
				window.close();
			}
		};

		validatedIpcMain.on(START_WINDOW_ACTION_CHANNEL, onAction);
		this.windowDisposables.add(toDisposable(() => validatedIpcMain.removeListener(START_WINDOW_ACTION_CHANNEL, onAction)));

		window.once('ready-to-show', () => window.show());
		window.once('closed', () => {
			this.complete('quit');
			this.windowDisposables.clear();
		});

		try {
			await window.loadURL(FileAccess.asBrowserUri('vs/vshoon/electron-sandbox/startWindow/startWindow.html').toString(true));
		} catch (error) {

			// Closing the window while it is still loading rejects `loadURL`, but the action
			// is already known at that point and the launch must not fail because of it.
			if (pendingAction.isSettled) {
				return pendingAction.p;
			}

			this.logService.error('vshoon#startWindow: failed to load', error);
			this.windowDisposables.clear();
			this.state = 'closed';

			throw error;
		}

		return pendingAction.p;
	}

	focus(): void {
		const window = this.window;
		if (!window || window.isDestroyed()) {
			return;
		}

		// macOS: a programmatic focus does not raise the application itself, so ask for
		// the foreground explicitly the same way the upstream launch service does.
		if (isMacintosh) {
			app.focus({ steal: true });
		}

		if (window.isMinimized()) {
			window.restore();
		}

		window.show();
		window.focus();
	}

	supersede(): void {
		if (this.state === 'closed') {
			return;
		}

		this.logService.trace('vshoon#startWindow: superseded by another launch request');
		this.complete('superseded');

		// Hide rather than close: the start window can still be the only window and closing
		// it here would trigger Electron's window-all-closed lifecycle before the workbench
		// window of the superseding request exists.
		this.window?.hide();
		this.releaseWhenWorkbenchOpens();
	}

	releaseWhenWorkbenchOpens(): void {
		if (this.releaseHandle) {
			return;
		}

		const handle = this.releaseHandle = setInterval(() => {
			if (BrowserWindow.getAllWindows().some(window => window !== this.window)) {
				clearInterval(handle);
				this.windowDisposables.clear();
			}
		}, 50);

		this._register(toDisposable(() => clearInterval(handle)));
	}

	private complete(action: VShoonStartWindowAction): void {
		if (this.state === 'closed') {
			return;
		}

		this.state = action === 'continue' ? 'released' : 'closed';
		this.pendingAction?.complete(action);
	}
}
