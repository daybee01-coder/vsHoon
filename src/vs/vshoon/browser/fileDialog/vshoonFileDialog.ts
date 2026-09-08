/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, getActiveDocument } from '../../../base/browser/dom.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import * as resources from '../../../base/common/resources.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IOpenDialogOptions, ISaveDialogOptions } from '../../../platform/dialogs/common/dialogs.js';
import { INativeEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILabelService } from '../../../platform/label/common/label.js';
import { IQuickInputButton, IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { FileDialogListing, IFileDialogNode } from '../../common/fileDialogListing.js';
import './vshoonFileDialog.css';

export class VShoonFileDialog extends Disposable {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@ILabelService private readonly labelService: ILabelService
	) { super(); }

	async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		return this.show(options, false) as Promise<URI[] | undefined>;
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		return this.show(options, true) as Promise<URI | undefined>;
	}

	private async show(options: IOpenDialogOptions | ISaveDialogOptions, save: boolean): Promise<URI[] | URI | undefined> {
		const openOptions = save ? undefined : options as IOpenDialogOptions;
		const suggestedName = save && options.defaultUri ? resources.basename(options.defaultUri) : undefined;
		const store = new DisposableStore();
		const widget = store.add(this.quickInputService.createQuickWidget());
		const document = getActiveDocument();
		const title = options.title ?? (save ? localize('vshoon.fileDialog.save', "Save File") : localize('vshoon.fileDialog.open', "Select File or Folder"));
		const root = document.createElement('div');
		root.className = 'vshoon-file-dialog';
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', title);

		const toolbar = document.createElement('div');
		toolbar.className = 'vshoon-file-dialog-toolbar';
		toolbar.setAttribute('role', 'toolbar');
		const pathInput = document.createElement('input');
		pathInput.className = 'vshoon-file-dialog-path';
		pathInput.setAttribute('aria-label', localize('vshoon.fileDialog.path', "Path"));
		const tree = document.createElement('div');
		tree.className = 'vshoon-file-dialog-tree';
		tree.setAttribute('role', 'tree');
		tree.tabIndex = 0;
		const status = document.createElement('div');
		status.className = 'vshoon-file-dialog-status';
		status.setAttribute('role', 'status');
		const footer = document.createElement('div');
		footer.className = 'vshoon-file-dialog-footer';
		const acceptButton = document.createElement('button');
		acceptButton.className = 'vshoon-file-dialog-button primary';
		acceptButton.textContent = typeof openOptions?.openLabel === 'string' ? openOptions.openLabel : openOptions?.openLabel?.withoutMnemonic ?? (save ? localize('vshoon.fileDialog.saveButton', "Save") : localize('vshoon.fileDialog.openButton', "Open"));
		const cancelButton = document.createElement('button');
		cancelButton.className = 'vshoon-file-dialog-button';
		cancelButton.textContent = localize('vshoon.fileDialog.cancel', "Cancel");
		footer.append(acceptButton, cancelButton);
		root.append(toolbar, pathInput, tree, status, footer);

		widget.title = title;
		widget.ignoreFocusOut = true;
		widget.widget = root;
		const closeButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.close), tooltip: localize('vshoon.fileDialog.close', "Close") };
		widget.buttons = [closeButton];

		// A save dialog already knows its folder. Everything else is the caller's guess until the
		// file system confirms it, and that read happens after the dialog is on screen so a slow
		// or unavailable folder cannot hold the whole dialog back.
		const defaultFileUri = options.defaultUri?.scheme === Schemas.file ? options.defaultUri : undefined;
		let current = save && defaultFileUri ? resources.dirname(defaultFileUri) : defaultFileUri ?? this.environmentService.userHome;
		const history: URI[] = [current];
		let historyIndex = 0;
		let selected: IFileDialogNode | undefined;
		let selectedRow: HTMLElement | undefined;

		// Rows live for one folder. Their listeners belong to the render that made them, not to
		// the dialog, so walking through folders does not pile them up until the dialog closes.
		const rowListeners = store.add(new DisposableStore());
		const folderEditor = store.add(new MutableDisposable<DisposableStore>());
		const listing = new FileDialogListing(async uri => (await this.fileService.resolve(uri)).children ?? [], options.filters);

		const iconButton = (icon: ThemeIcon, label: string, action: () => void | Promise<void>): HTMLButtonElement => {
			const button = document.createElement('button');
			button.className = `vshoon-file-dialog-tool ${ThemeIcon.asClassName(icon)}`;
			button.title = label;
			button.setAttribute('aria-label', label);
			store.add(addDisposableListener(button, EventType.CLICK, () => void action()));
			toolbar.append(button);
			return button;
		};

		const navigate = async (uri: URI, record = true): Promise<void> => {
			current = uri;
			selected = undefined;
			selectedRow = undefined;
			if (record) {
				history.splice(historyIndex + 1);
				history.push(uri);
				historyIndex = history.length - 1;
			}
			pathInput.value = this.labelService.getUriLabel(uri);
			await render();
		};

		const back = iconButton(Codicon.arrowLeft, localize('vshoon.fileDialog.back', "Back"), async () => {
			if (historyIndex > 0) { await navigate(history[--historyIndex], false); }
		});
		const forward = iconButton(Codicon.arrowRight, localize('vshoon.fileDialog.forward', "Forward"), async () => {
			if (historyIndex + 1 < history.length) { await navigate(history[++historyIndex], false); }
		});
		iconButton(Codicon.home, localize('vshoon.fileDialog.home', "Home"), async () => navigate(this.environmentService.userHome));
		iconButton(Codicon.arrowUp, localize('vshoon.fileDialog.parent', "Parent Folder"), async () => navigate(resources.dirname(current)));
		iconButton(Codicon.refresh, localize('vshoon.fileDialog.refresh', "Refresh"), async () => render());

		const createFolderEditor = (): void => {
			const editorStore = new DisposableStore();
			folderEditor.value = editorStore;
			const editor = document.createElement('div');
			editor.className = 'vshoon-file-dialog-new-folder';
			const icon = document.createElement('span');
			icon.className = ThemeIcon.asClassName(Codicon.newFolder);
			const input = document.createElement('input');
			input.setAttribute('aria-label', localize('vshoon.fileDialog.newFolderName', "New folder name"));
			input.placeholder = localize('vshoon.fileDialog.newFolderPlaceholder', "New folder");
			editor.append(icon, input);
			tree.prepend(editor);
			input.focus();
			editorStore.add(toDisposable(() => editor.remove()));
			editorStore.add(addDisposableListener(input, EventType.KEY_DOWN, async event => {
				if (event.key === 'Escape') {
					folderEditor.clear();
					tree.focus();
					return;
				}
				if (event.key !== 'Enter') { return; }
				const name = input.value.trim();
				if (!name || name.includes('/') || name.includes('\\')) {
					status.textContent = localize('vshoon.fileDialog.invalidFolderName', "Enter a valid folder name.");
					return;
				}
				try {
					await this.fileService.createFolder(resources.joinPath(current, name));
					await render();
				} catch (error) {
					status.textContent = error instanceof Error ? error.message : localize('vshoon.fileDialog.createFolderFailed', "The folder could not be created.");
				}
			}));
		};
		iconButton(Codicon.newFolder, localize('vshoon.fileDialog.newFolder', "New Folder"), createFolderEditor);

		const createRow = (node: IFileDialogNode, depth: number, generation: number): HTMLDivElement => {
			const branch = document.createElement('div');
			const row = document.createElement('div');
			row.className = 'vshoon-file-dialog-row';
			row.setAttribute('role', 'treeitem');
			row.setAttribute('aria-level', String(depth + 1));
			row.style.paddingLeft = `${8 + depth * 18}px`;
			const twistie = document.createElement('span');
			twistie.className = node.isDirectory ? ThemeIcon.asClassName(Codicon.chevronRight) : 'vshoon-file-dialog-spacer';
			const icon = document.createElement('span');
			icon.className = ThemeIcon.asClassName(node.isDirectory ? Codicon.folder : Codicon.file);
			const label = document.createElement('span');
			label.textContent = node.name;
			row.append(twistie, icon, label);
			branch.append(row);
			let expanded = false;
			rowListeners.add(addDisposableListener(row, EventType.CLICK, async () => {
				selectedRow?.classList.remove('selected');
				row.classList.add('selected');
				selectedRow = row;
				selected = node;
				pathInput.value = this.labelService.getUriLabel(node.uri);
				if (!node.isDirectory) { return; }
				expanded = !expanded;
				twistie.className = ThemeIcon.asClassName(expanded ? Codicon.chevronDown : Codicon.chevronRight);
				if (expanded && branch.childElementCount === 1) {
					const children = document.createElement('div');
					children.setAttribute('role', 'group');
					const outcome = await listing.listWithin(node.uri, generation);
					if (outcome.kind === 'stale') { return; }
					if (outcome.kind === 'listed') {
						outcome.nodes.forEach(child => children.append(createRow(child, depth + 1, generation)));
					}
					branch.append(children);
				} else if (branch.lastElementChild !== row) {
					(branch.lastElementChild as HTMLElement).hidden = !expanded;
				}
			}));
			rowListeners.add(addDisposableListener(row, EventType.DBLCLICK, () => node.isDirectory ? void navigate(node.uri) : complete(node.uri)));
			return branch;
		};

		const render = async (): Promise<void> => {
			back.disabled = historyIndex === 0;
			forward.disabled = historyIndex + 1 >= history.length;
			status.textContent = localize('vshoon.fileDialog.loading', "Loading…");
			folderEditor.clear();
			rowListeners.clear();
			tree.replaceChildren();
			const outcome = await listing.list(current);
			if (outcome.kind === 'stale') {
				return;
			}
			if (outcome.kind === 'failed') {
				status.textContent = outcome.error?.message ?? localize('vshoon.fileDialog.unavailable', "The folder cannot be opened.");
				return;
			}
			const generation = listing.generation;
			outcome.nodes.forEach(node => tree.append(createRow(node, 0, generation)));
			status.textContent = outcome.nodes.length ? '' : localize('vshoon.fileDialog.empty', "This folder is empty.");
		};

		let settled = false;
		let resolveResult!: (value: URI[] | URI | undefined) => void;
		const result = new Promise<URI[] | URI | undefined>(resolve => resolveResult = resolve);
		const complete = (uri?: URI): void => {
			if (settled) { return; }
			settled = true;
			listing.cancel();
			widget.hide();
			resolveResult(uri ? (save ? uri : [uri]) : undefined);
		};
		store.add(widget.onDidHide(() => complete()));
		store.add(widget.onDidTriggerButton(() => complete()));
		store.add(addDisposableListener(cancelButton, EventType.CLICK, () => complete()));
		store.add(addDisposableListener(acceptButton, EventType.CLICK, () => {
			const uri = save ? URI.file(pathInput.value) : selected?.uri ?? URI.file(pathInput.value);
			if (!save && selected?.isDirectory && !openOptions?.canSelectFolders) { void navigate(selected.uri); return; }
			if (!save && selected && !selected.isDirectory && !openOptions?.canSelectFiles) { return; }
			complete(uri);
		}));
		store.add(addDisposableListener(pathInput, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter') {
				if (save) { acceptButton.click(); } else { void navigate(URI.file(pathInput.value)); }
			}
		}));
		store.add(addDisposableListener(root, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') { complete(); }
		}));

		/** Corrects the starting folder once the file system answers, with the dialog already up. */
		const resolveStart = async (): Promise<void> => {
			if (save && defaultFileUri) {
				return;
			}
			try {
				if (!(await this.fileService.stat(current)).isDirectory) {
					current = resources.dirname(current);
				}
			} catch {
				current = this.environmentService.userHome;
			}
			history[0] = current;
			pathInput.value = this.labelService.getUriLabel(suggestedName ? resources.joinPath(current, suggestedName) : current);
		};

		back.disabled = true;
		forward.disabled = true;
		status.textContent = localize('vshoon.fileDialog.loading', "Loading…");
		pathInput.value = this.labelService.getUriLabel(suggestedName ? resources.joinPath(current, suggestedName) : current);
		widget.show();
		pathInput.focus();
		await resolveStart();
		if (!settled) {
			await render();
		}
		const value = await result;
		store.dispose();
		return value;
	}
}
