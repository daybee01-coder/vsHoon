/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { MockContextKeyService } from '../../../platform/keybinding/test/common/mockKeybindingService.js';
import { bindVShoonEditorTabFilter, classifyVShoonEditorTab, IVShoonEditorTab, VShoonEditorTabFilter, VSHOON_EDITOR_TAB_FILTER_CONTEXT } from '../../common/editorTabFilter.js';

suite('VShoon Editor Tab Filter', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const terminal: IVShoonEditorTab = { typeId: 'workbench.editors.terminal', resource: URI.parse('vscode-terminal:/1/1') };
	const javaFile: IVShoonEditorTab = { typeId: 'workbench.editors.files.fileEditorInput', resource: URI.file('/project/App.java') };
	const sqlFile: IVShoonEditorTab = { typeId: 'workbench.editors.files.fileEditorInput', resource: URI.file('/project/Query.SQL') };
	const untitledSql = { typeId: 'workbench.editors.untitledEditorInput', resource: URI.parse('untitled:Untitled-1'), getLanguageId: () => 'sql' };
	const untitledText = { typeId: 'workbench.editors.untitledEditorInput', resource: URI.parse('untitled:Untitled-2'), getLanguageId: () => 'plaintext' };

	test('classifies terminals as SSH, SQL by language or extension, everything else as main', () => {
		assert.deepStrictEqual(
			[terminal, javaFile, sqlFile, untitledSql, untitledText].map(classifyVShoonEditorTab),
			['ssh', 'main', 'sql', 'sql', 'main']
		);
	});

	test('shows only the chosen group and reveals the group of an editor opened elsewhere', () => {
		const filter = store.add(new VShoonEditorTabFilter());
		const contextKeyService = new MockContextKeyService();
		let changes = 0;
		store.add(bindVShoonEditorTabFilter(contextKeyService, () => changes++, filter));

		const visible = () => [terminal, javaFile, untitledSql].map(editor => filter.isVisible(editor));
		const snapshot = [visible()];

		filter.setFilter('sql');
		filter.setFilter('sql');
		snapshot.push(visible());

		filter.reveal(untitledSql);
		filter.reveal(terminal);
		snapshot.push(visible());

		assert.deepStrictEqual({ snapshot, changes, context: contextKeyService.getContextKeyValue(VSHOON_EDITOR_TAB_FILTER_CONTEXT.key) }, {
			snapshot: [[true, true, true], [false, false, true], [true, false, false]],
			changes: 2,
			context: 'ssh'
		});
	});

	test('follows the side bar view container that owns an editor tab group', () => {
		const filter = store.add(new VShoonEditorTabFilter());
		const filters: string[] = [];
		for (const viewContainerId of ['workbench.view.extension.vssh', 'workbench.view.search', 'workbench.view.extension.dbconn', 'workbench.view.explorer']) {
			filter.showForViewContainer(viewContainerId);
			filters.push(filter.filter);
		}

		assert.deepStrictEqual(filters, ['ssh', 'ssh', 'sql', 'main']);
	});
});
