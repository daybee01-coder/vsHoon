/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IVShoonRecentProjectInput, prunePinnedProjects, toggleVShoonPinnedProject, toVShoonRecentProjects } from '../../common/recentProjects.js';

const folder = (path: string, label?: string): IVShoonRecentProjectInput => ({ kind: 'folder', uri: URI.file(path), label });

// `fsPath` is separator-dependent, so the expectation is derived rather than written out.
const fsPath = (path: string) => URI.file(path).fsPath;

suite('VShoon Recent Projects', () => {

	test('describes folders, workspaces and remote entries for display', () => {
		assert.deepStrictEqual(
			toVShoonRecentProjects([
				folder('/work/api'),
				{ kind: 'workspace', uri: URI.file('/work/all.code-workspace') },
				{ kind: 'folder', uri: URI.parse('vscode-remote://ssh-remote+host/srv/app'), remoteAuthority: 'ssh-remote+host' },
				folder('/work/legacy', 'Legacy name')
			], []),
			[
				{ id: 'file:///work/api', kind: 'folder', name: 'api', location: fsPath('/work/api'), remote: false, pinned: false },
				{ id: 'file:///work/all.code-workspace', kind: 'workspace', name: 'all', location: fsPath('/work/all.code-workspace'), remote: false, pinned: false },
				{ id: 'vscode-remote://ssh-remote%2Bhost/srv/app', kind: 'folder', name: 'app', location: 'vscode-remote://ssh-remote+host/srv/app', remote: true, pinned: false },
				{ id: 'file:///work/legacy', kind: 'folder', name: 'Legacy name', location: fsPath('/work/legacy'), remote: false, pinned: false }
			]
		);
	});

	test('lists pinned entries in pin order, then the rest by recency', () => {
		assert.deepStrictEqual(
			toVShoonRecentProjects([folder('/a'), folder('/b'), folder('/c')], ['file:///c', 'file:///a'])
				.map(project => [project.name, project.pinned]),
			[['c', true], ['a', true], ['b', false]]
		);
	});

	test('ignores a pin for an entry that is no longer recent', () => {
		assert.deepStrictEqual(
			toVShoonRecentProjects([folder('/a')], ['file:///gone', 'file:///a']).map(project => project.name),
			['a']
		);
	});

	test('toggles a pin on and off', () => {
		const pinned = toggleVShoonPinnedProject([], 'file:///a');
		assert.deepStrictEqual([pinned, toggleVShoonPinnedProject(pinned, 'file:///a')], [['file:///a'], []]);
	});

	test('drops pins for entries that are no longer recent', () => {
		const projects = toVShoonRecentProjects([folder('/a')], ['file:///a']);
		assert.deepStrictEqual(prunePinnedProjects(['file:///a', 'file:///gone'], projects), ['file:///a']);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
