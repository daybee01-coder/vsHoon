/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { localize, localize2 } from '../../nls.js';
import { ILocalizedString } from '../../platform/action/common/action.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { VShoonEditorTabFilterValue, VSHOON_EDITOR_TAB_FILTER_CONTEXT, vshoonEditorTabFilter } from '../common/editorTabFilter.js';

export { bindVShoonEditorTabFilter, vshoonEditorTabFilter } from '../common/editorTabFilter.js';

const editorTabFilterMenu = new MenuId('VShoonEditorTabFilter');
const category = localize2('vshoonEditorTabFilter.category', "Editor Tabs");

// The button keeps its place in the title toolbar; only the icon tells whether tabs are hidden.
const isFiltering = VSHOON_EDITOR_TAB_FILTER_CONTEXT.notEqualsTo('all');
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	submenu: editorTabFilterMenu,
	title: localize('vshoonEditorTabFilter.menu', "Show Editor Tabs"),
	icon: Codicon.filter,
	group: 'navigation',
	order: 1000,
	when: isFiltering.negate()
});
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	submenu: editorTabFilterMenu,
	title: localize('vshoonEditorTabFilter.menuFiltered', "Show Editor Tabs (Filtered)"),
	icon: Codicon.filterFilled,
	group: 'navigation',
	order: 1000,
	when: isFiltering
});

const filterTitles: Record<VShoonEditorTabFilterValue, ILocalizedString> = {
	all: localize2('vshoonEditorTabFilter.all', "All Editors"),
	main: localize2('vshoonEditorTabFilter.main', "Main Editors"),
	ssh: localize2('vshoonEditorTabFilter.ssh', "SSH Terminals"),
	sql: localize2('vshoonEditorTabFilter.sql', "SQL Editors")
};

function registerFilterAction(filter: VShoonEditorTabFilterValue, order: number): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `vshoon.editorTabs.show.${filter}`,
				title: filterTitles[filter],
				category,
				f1: true,
				toggled: VSHOON_EDITOR_TAB_FILTER_CONTEXT.isEqualTo(filter),
				menu: {
					id: editorTabFilterMenu,
					// "All" sits apart from the three groups it combines.
					group: filter === 'all' ? '1_all' : '2_groups',
					order
				}
			});
		}

		run(_accessor: ServicesAccessor): void {
			vshoonEditorTabFilter.setFilter(filter);
		}
	});
}

registerFilterAction('all', 1);
registerFilterAction('main', 1);
registerFilterAction('ssh', 2);
registerFilterAction('sql', 3);
