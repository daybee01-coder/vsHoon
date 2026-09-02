/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { isMacintosh } from '../../base/common/platform.js';
import { URI } from '../../base/common/uri.js';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { getNLSLanguage, getNLSMessages } from '../../nls.js';
import { IDialogMainService } from '../../platform/dialogs/electron-main/dialogMainService.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { ILifecycleMainService } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IStateService } from '../../platform/state/node/state.js';
import { IWindowOpenable } from '../../platform/window/common/window.js';
import { IWindowsMainService, OpenContext } from '../../platform/windows/electron-main/windows.js';
import { isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IWorkspacesHistoryMainService } from '../../platform/workspaces/electron-main/workspacesHistoryMainService.js';
import { IVShoonRecentProject, IVShoonRecentProjectInput, prunePinnedProjects, toggleVShoonPinnedProject, toVShoonRecentProjects } from '../common/recentProjects.js';

const START_WINDOW_CHANNEL = 'vscode:vshoonStartWindow';
const PINNED_PROJECTS_KEY = 'vshoon.startWindow.pinnedProjects';

/** The enumerated set of things the renderer may ask for. Anything else is refused. */
type VShoonStartWindowRequest =
	| { readonly type: 'projects' }
	| { readonly type: 'openRecent'; readonly id: string }
	| { readonly type: 'removeRecent'; readonly id: string }
	| { readonly type: 'togglePin'; readonly id: string }
	| { readonly type: 'chooseFolder' }
	| { readonly type: 'chooseWorkspace' }
	| { readonly type: 'openEmpty' }
	| { readonly type: 'quit' }
	| { readonly type: 'configuration' };

export interface IVShoonStartWindowResponse {
	readonly projects?: readonly IVShoonRecentProject[];
	readonly opened?: boolean;
	readonly nls?: IVShoonStartWindowNls;
}

/** The translated messages the renderer needs before it can display any text. */
export interface IVShoonStartWindowNls {
	readonly messages: string[];
	readonly language: string | undefined;
}

export const IVShoonStartWindowMainService = createDecorator<IVShoonStartWindowMainService>('vshoonStartWindowMainService');

export interface IVShoonStartWindowMainService {

	readonly _serviceBrand: undefined;

	/**
	 * Whether the start window is currently the visible owner of the launch. This is `false`
	 * once the user has chosen an action, even while the window is still alive.
	 */
	readonly ownsLaunch: boolean;

	/**
	 * Creates the start window and resolves once it is loaded, not once the user has chosen.
	 *
	 * Startup must be allowed to finish while the launcher waits for input: application storage
	 * only initializes at `LifecycleMainPhase.AfterWindowOpen`, which `CodeApplication` sets after
	 * `openFirstWindow` returns, and the recent list cannot be read before that.
	 */
	show(): Promise<void>;

	/** Brings the start window back to the foreground for a second launch request. */
	focus(): void;

	/** Steps the start window down because another launch request is opening a workbench window. */
	supersede(): void;
}

export class VShoonStartWindowMainService extends Disposable implements IVShoonStartWindowMainService {

	declare readonly _serviceBrand: undefined;

	private readonly windowDisposables = this._register(new DisposableStore());

	private window: BrowserWindow | undefined;
	private state: 'closed' | 'showing' | 'released' = 'closed';
	private releaseHandle: Timeout | undefined;

	/** The model the renderer currently shows, and the only ids an action may name. */
	private projects: readonly IVShoonRecentProject[] = [];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IWorkspacesHistoryMainService private readonly workspacesHistoryMainService: IWorkspacesHistoryMainService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@IStateService private readonly stateService: IStateService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService
	) {
		super();
	}

	get ownsLaunch(): boolean {
		return this.state === 'showing';
	}

	async show(): Promise<void> {
		if (this.state !== 'closed') {
			throw new Error('VShoon start window is already open.');
		}

		this.state = 'showing';

		const window = this.window = new BrowserWindow({
			title: 'VShoon',
			width: 860,
			height: 600,
			minWidth: 680,
			minHeight: 460,
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

		const onRequest = async (event: IpcMainInvokeEvent, request: unknown): Promise<IVShoonStartWindowResponse> => {
			if (event.sender.id !== window.webContents.id) {
				throw new Error('Unexpected sender for the VShoon start window channel.');
			}

			return this.handleRequest(request);
		};

		validatedIpcMain.handle(START_WINDOW_CHANNEL, onRequest);
		this.windowDisposables.add(toDisposable(() => validatedIpcMain.removeHandler(START_WINDOW_CHANNEL)));

		window.once('ready-to-show', () => window.show());
		window.once('closed', () => this.onClosed());

		try {
			await window.loadURL(FileAccess.asBrowserUri('vs/vshoon/electron-sandbox/startWindow/startWindow.html').toString(true));
		} catch (error) {

			// Closing the window while it is still loading rejects `loadURL`. The launcher is
			// already gone at that point, so the launch must not fail because of it.
			if (!this.window) {
				return;
			}

			this.logService.error('vshoon#startWindow: failed to load', error);
			this.windowDisposables.clear();
			this.state = 'closed';

			throw error;
		}
	}

	/**
	 * The launcher is the only window at this point, so closing it without choosing anything ends
	 * the session. Once it has handed off, the workbench window owns the lifecycle instead.
	 */
	private onClosed(): void {
		const wasOwningLaunch = this.state === 'showing';
		this.state = 'closed';
		this.windowDisposables.clear();

		if (wasOwningLaunch) {
			this.lifecycleMainService.quit();
		}
	}

	private async handleRequest(request: unknown): Promise<IVShoonStartWindowResponse> {
		const parsed = parseRequest(request);
		if (!parsed) {
			this.logService.warn('vshoon#startWindow: refused an unsupported request');

			throw new Error('Unsupported VShoon start window request.');
		}

		switch (parsed.type) {
			case 'configuration':
				return { nls: { messages: getNLSMessages(), language: getNLSLanguage() } };

			case 'projects':
				return { projects: await this.loadProjects() };

			case 'togglePin':
				return { projects: await this.togglePin(parsed.id) };

			case 'removeRecent':
				return { projects: await this.removeRecent(parsed.id) };

			case 'openRecent':
				return this.openRecent(parsed.id);

			case 'chooseFolder':
				return this.openPicked(await this.dialogMainService.pickFolder({}, this.window), 'folder');

			case 'chooseWorkspace':
				return this.openPicked(await this.dialogMainService.pickWorkspace({}, this.window), 'workspace');

			case 'openEmpty':
				return this.openWindow(() => this.windowsMainService.openEmptyWindow({ context: OpenContext.DESKTOP }));

			case 'quit':
				this.window?.close(); // `onClosed` ends the session

				return {};
		}
	}

	/** Reads the recent list and overlays the VShoon-owned pin state. */
	private async loadProjects(): Promise<readonly IVShoonRecentProject[]> {
		const recent = await this.workspacesHistoryMainService.getRecentlyOpened();
		const inputs: IVShoonRecentProjectInput[] = recent.workspaces.map(entry => isRecentFolder(entry)
			? { kind: 'folder', uri: entry.folderUri, label: entry.label, remoteAuthority: entry.remoteAuthority }
			: { kind: 'workspace', uri: entry.workspace.configPath, label: entry.label, remoteAuthority: entry.remoteAuthority });

		this.projects = toVShoonRecentProjects(inputs, this.readPinned());
		this.logService.trace(`vshoon#startWindow: ${this.projects.length} recent entries`);

		return this.projects;
	}

	private async togglePin(id: string): Promise<readonly IVShoonRecentProject[]> {
		if (!this.resolve(id)) {
			return this.projects;
		}

		this.writePinned(toggleVShoonPinnedProject(this.readPinned(), id));

		return this.loadProjects();
	}

	private async removeRecent(id: string): Promise<readonly IVShoonRecentProject[]> {
		const project = this.resolve(id);
		if (!project) {
			return this.projects;
		}

		await this.workspacesHistoryMainService.removeRecentlyOpened([URI.parse(project.id)]);
		const projects = await this.loadProjects();

		// A removed entry can no longer be shown, so its pin has nothing left to order.
		this.writePinned(prunePinnedProjects(this.readPinned(), projects));

		return projects;
	}

	private async openRecent(id: string): Promise<IVShoonStartWindowResponse> {
		const project = this.resolve(id);
		if (!project) {
			this.logService.warn('vshoon#startWindow: ignored an unknown recent entry');

			return { projects: this.projects };
		}

		return this.openTarget(URI.parse(project.id), project.kind);
	}

	private async openPicked(paths: string[] | undefined, kind: 'folder' | 'workspace'): Promise<IVShoonStartWindowResponse> {
		const path = paths?.at(0);
		if (!path) {
			return { projects: this.projects }; // the dialog was cancelled
		}

		return this.openTarget(URI.file(path), kind);
	}

	private openTarget(uri: URI, kind: 'folder' | 'workspace'): Promise<IVShoonStartWindowResponse> {
		const openable: IWindowOpenable = kind === 'folder' ? { folderUri: uri } : { workspaceUri: uri };

		return this.openWindow(() => this.windowsMainService.open({
			context: OpenContext.DESKTOP,
			cli: this.environmentMainService.args,
			urisToOpen: [openable]
		}));
	}

	/**
	 * Hands the launch over to a workbench window.
	 *
	 * The start window is hidden rather than closed, because it can still be the only window and
	 * closing it here would trigger Electron's window-all-closed lifecycle before the new window
	 * exists. `releaseWhenWorkbenchOpens` disposes it once that window is there.
	 */
	private async openWindow(open: () => Promise<unknown>): Promise<IVShoonStartWindowResponse> {
		this.state = 'released';
		this.window?.hide();
		this.releaseWhenWorkbenchOpens();

		try {
			await open();
		} catch (error) {
			this.logService.error('vshoon#startWindow: failed to open a window', error);

			throw error;
		}

		return { opened: true };
	}

	private resolve(id: string): IVShoonRecentProject | undefined {
		return this.projects.find(project => project.id === id);
	}

	private readPinned(): string[] {
		const stored = this.stateService.getItem<unknown>(PINNED_PROJECTS_KEY);

		return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
	}

	private writePinned(pinnedIds: readonly string[]): void {
		this.stateService.setItem(PINNED_PROJECTS_KEY, [...pinnedIds]);
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
		this.state = 'released';

		// Hide rather than close: the start window can still be the only window and closing
		// it here would trigger Electron's window-all-closed lifecycle before the workbench
		// window of the superseding request exists.
		this.window?.hide();
		this.releaseWhenWorkbenchOpens();
	}

	private releaseWhenWorkbenchOpens(): void {
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
}

/** Narrows an untrusted renderer payload to the enumerated request set. */
function parseRequest(request: unknown): VShoonStartWindowRequest | undefined {
	if (!request || typeof request !== 'object') {
		return undefined;
	}

	const { type, id } = request as { type?: unknown; id?: unknown };
	switch (type) {
		case 'configuration':
		case 'projects':
		case 'chooseFolder':
		case 'chooseWorkspace':
		case 'openEmpty':
		case 'quit':
			return { type };

		case 'openRecent':
		case 'removeRecent':
		case 'togglePin':
			return typeof id === 'string' ? { type, id } : undefined;

		default:
			return undefined;
	}
}
