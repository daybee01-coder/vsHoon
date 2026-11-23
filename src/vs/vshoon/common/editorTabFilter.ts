/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, IDisposable, markAsSingleton } from '../../base/common/lifecycle.js';
import { extname } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { IContextKeyService, RawContextKey } from '../../platform/contextkey/common/contextkey.js';

/** The editor tab group an editor belongs to. */
export type VShoonEditorTabKind = 'main' | 'ssh' | 'sql';

/** Which editor tabs the tab bar shows. */
export type VShoonEditorTabFilterValue = VShoonEditorTabKind | 'all';

export const VSHOON_EDITOR_TAB_FILTERS: readonly VShoonEditorTabFilterValue[] = ['all', 'main', 'ssh', 'sql'];

/** `TerminalEditorInput.ID`: VSsh and WSL sessions open as terminals in the editor area. */
const TERMINAL_EDITOR_TYPE_ID = 'workbench.editors.terminal';
const SQL_LANGUAGE_ID = 'sql';

/**
 * Side bar view containers that bring their editor tab group with them: the Explorer works on
 * main editors, VSsh on SSH terminals and DBConn on SQL editors. Other containers leave the
 * filter alone.
 */
const VIEW_CONTAINER_TAB_KINDS: ReadonlyMap<string, VShoonEditorTabKind> = new Map([
	['workbench.view.explorer', 'main'],
	['workbench.view.extension.vssh', 'ssh'],
	['workbench.view.extension.dbconn', 'sql']
]);

/** Holds the active filter for every editor group's tab bar and editor title toolbar. */
export const VSHOON_EDITOR_TAB_FILTER_CONTEXT = new RawContextKey<VShoonEditorTabFilterValue>('vshoonEditorTabFilter', 'all');

/** The part of an editor input the tab filter looks at. */
export interface IVShoonEditorTab {
	readonly typeId: string;
	readonly resource: URI | undefined;
}

interface ILanguageAwareEditorTab {
	getLanguageId(): string | undefined;
}

function isLanguageAware(editor: IVShoonEditorTab): editor is IVShoonEditorTab & ILanguageAwareEditorTab {
	return typeof (editor as Partial<ILanguageAwareEditorTab>).getLanguageId === 'function';
}

/**
 * Text editors report their language (an untitled DBConn script has no `.sql` path),
 * other editors are recognised by their resource.
 */
export function classifyVShoonEditorTab(editor: IVShoonEditorTab): VShoonEditorTabKind {
	if (editor.typeId === TERMINAL_EDITOR_TYPE_ID) {
		return 'ssh';
	}

	const languageId = isLanguageAware(editor) ? editor.getLanguageId() : undefined;
	if (languageId === SQL_LANGUAGE_ID || (editor.resource && extname(editor.resource).toLowerCase() === '.sql')) {
		return 'sql';
	}

	return 'main';
}

/** Window-wide editor tab filter. Renderer memory only: a reload shows all tabs again. */
export class VShoonEditorTabFilter extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _filter: VShoonEditorTabFilterValue = 'all';

	get filter(): VShoonEditorTabFilterValue {
		return this._filter;
	}

	setFilter(filter: VShoonEditorTabFilterValue): void {
		if (this._filter !== filter) {
			this._filter = filter;
			this._onDidChange.fire();
		}
	}

	isVisible(editor: IVShoonEditorTab): boolean {
		return this._filter === 'all' || classifyVShoonEditorTab(editor) === this._filter;
	}

	/** Switches to the editor's group when it would otherwise be hidden, e.g. after Quick Open. */
	reveal(editor: IVShoonEditorTab): void {
		if (!this.isVisible(editor)) {
			this.setFilter(classifyVShoonEditorTab(editor));
		}
	}

	/** Shows the editor tab group that goes with a side bar view container, if it has one. */
	showForViewContainer(viewContainerId: string): void {
		const kind = VIEW_CONTAINER_TAB_KINDS.get(viewContainerId);
		if (kind) {
			this.setFilter(kind);
		}
	}
}

export const vshoonEditorTabFilter = markAsSingleton(new VShoonEditorTabFilter());

/**
 * Mirrors the filter into an editor group's context so its title toolbar shows the
 * current choice, and calls back when the filter changes.
 */
export function bindVShoonEditorTabFilter(contextKeyService: IContextKeyService, onDidChange: () => void, filter = vshoonEditorTabFilter): IDisposable {
	const key = VSHOON_EDITOR_TAB_FILTER_CONTEXT.bindTo(contextKeyService);
	key.set(filter.filter);

	return filter.onDidChange(() => {
		key.set(filter.filter);
		onDidChange();
	});
}
