/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getNLSLanguage, localize } from '../../../nls.js';
import { getVShoonProjectFocusAfterRemoval, getVShoonProjectNavigationIndex } from '../../common/startWindowAccessibility.js';

const CHANNEL = 'vscode:vshoonStartWindow';

interface IRecentProject {
	readonly id: string;
	readonly kind: 'folder' | 'workspace';
	readonly name: string;
	readonly location: string;
	readonly remote: boolean;
	readonly pinned: boolean;
}

interface IResponse {
	readonly projects?: readonly IRecentProject[];
	readonly opened?: boolean;
	readonly nls?: { readonly messages: string[]; readonly language: string | undefined };
}

interface IStartWindowGlobals {
	readonly ipcRenderer: {
		invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	};
}

type FocusTarget =
	| { readonly kind: 'initial' }
	| { readonly kind: 'element'; readonly id: string }
	| { readonly kind: 'project'; readonly id: string; readonly action: 'open' | 'pin' | 'remove' };

interface IProjectButtons {
	readonly open: HTMLButtonElement;
	readonly pin: HTMLButtonElement;
	readonly remove: HTMLButtonElement;
}

const globals = (window as unknown as { vscode: IStartWindowGlobals }).vscode;

const list = document.getElementById('recent-list') as HTMLUListElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const count = document.getElementById('recent-count') as HTMLElement;
const statusLine = document.getElementById('status') as HTMLElement;
const projectButtons = new Map<string, IProjectButtons>();

let projects: readonly IRecentProject[] = [];
let pendingRequests = 0;

/**
 * The main process owns every decision. The renderer sends one of the enumerated requests and
 * renders whatever model comes back; it never resolves a path or opens anything itself.
 */
async function request(body: { type: string; id?: string }, focusTarget?: FocusTarget, announcement?: string): Promise<void> {
	pendingRequests++;
	list.setAttribute('aria-busy', 'true');
	statusLine.textContent = '';

	try {
		const response = await globals.ipcRenderer.invoke(CHANNEL, body) as IResponse;
		if (response.projects) {
			projects = response.projects;
			render();
			restoreFocus(focusTarget);
		}

		if (announcement) {
			statusLine.textContent = announcement;
		}
	} catch (error) {
		statusLine.textContent = localize('vshoonStartWindow.requestFailed', "The request could not be completed.");
		if (focusTarget?.kind === 'initial') {
			restoreFocus(focusTarget);
		}
		console.error(error);
	} finally {
		pendingRequests--;
		if (pendingRequests === 0) {
			list.setAttribute('aria-busy', 'false');
		}
	}
}

/**
 * Installs the translated messages before anything is rendered.
 *
 * A bundled build rewrites every `localize` call into an index into the message table that only
 * the main process holds, so a renderer that localizes before this resolves throws instead of
 * rendering. A development build keeps the English fallback in the call and only picks up the
 * display language here.
 */
async function initializeNls(): Promise<void> {
	try {
		const response = await globals.ipcRenderer.invoke(CHANNEL, { type: 'configuration' }) as IResponse;
		if (response.nls) {
			globalThis._VSCODE_NLS_MESSAGES = response.nls.messages;
			globalThis._VSCODE_NLS_LANGUAGE = response.nls.language;
		}
	} catch (error) {
		console.error(error); // the English fallbacks in a development build still render
	}
}

function initializeLabels(): void {
	document.documentElement.lang = getNLSLanguage() ?? navigator.language;
	setText('product-subtitle', localize('vshoonStartWindow.subtitle', "Choose a project to start working."));
	setText('recent-title', localize('vshoonStartWindow.recentProjects', "Recent Projects"));
	setText('recent-navigation-help', localize('vshoonStartWindow.navigationHelp', "Use the Up and Down arrow keys to move between recent projects. Use Tab to reach pin and remove actions."));
	setText('empty-title', localize('vshoonStartWindow.emptyTitle', "No recent projects yet."));
	setText('empty-description', localize('vshoonStartWindow.emptyDescription', "Open a folder or workspace below and it will appear here."));
	setText('quit', localize('vshoonStartWindow.quit', "Quit"));
	setText('open-empty', localize('vshoonStartWindow.openEmpty', "New Empty Window"));
	setText('open-workspace', localize('vshoonStartWindow.openWorkspace', "Open Workspace"));
	setText('open-folder', localize('vshoonStartWindow.openFolder', "Open Folder"));
}

function setText(id: string, value: string): void {
	const element = document.getElementById(id);
	if (element) {
		element.textContent = value;
	}
}

function render(): void {
	list.textContent = '';
	projectButtons.clear();
	count.textContent = projects.length > 0
		? localize('vshoonStartWindow.projectCount', "{0} projects", projects.length)
		: '';
	emptyState.hidden = projects.length > 0;

	for (const project of projects) {
		list.appendChild(renderProject(project));
	}
}

function renderProject(project: IRecentProject): HTMLLIElement {
	const item = document.createElement('li');
	item.className = 'recent-item';

	const open = document.createElement('button');
	open.type = 'button';
	open.className = 'recent-open';
	open.dataset.projectId = project.id;
	open.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
	open.addEventListener('click', () => request({ type: 'openRecent', id: project.id }));

	const name = document.createElement('span');
	name.className = 'recent-name';
	name.textContent = project.name;

	const locationLabel = document.createElement('span');
	locationLabel.className = 'recent-location';
	locationLabel.textContent = project.location;

	open.append(name, locationLabel);
	open.setAttribute('aria-label', describeProject(project));

	const pin = renderIconButton(
		project.pinned ? 'unpin' : 'pin',
		project.pinned
			? localize('vshoonStartWindow.unpinProject', "Unpin {0}", project.name)
			: localize('vshoonStartWindow.pinProject', "Pin {0}", project.name),
		project.pinned ? '★' : '☆',
		() => request(
			{ type: 'togglePin', id: project.id },
			{ kind: 'project', id: project.id, action: 'pin' },
			project.pinned
				? localize('vshoonStartWindow.projectUnpinned', "{0} was unpinned.", project.name)
				: localize('vshoonStartWindow.projectPinned', "{0} was pinned.", project.name)
		)
	);

	const focusAfterRemoval = getVShoonProjectFocusAfterRemoval(projects.map(candidate => candidate.id), project.id);
	const remove = renderIconButton(
		'remove',
		localize('vshoonStartWindow.removeProject', "Remove {0} from Recent Projects", project.name),
		'✕',
		() => request(
			{ type: 'removeRecent', id: project.id },
			focusAfterRemoval
				? { kind: 'project', id: focusAfterRemoval, action: 'open' }
				: { kind: 'element', id: 'open-folder' },
			localize('vshoonStartWindow.projectRemoved', "{0} was removed from Recent Projects.", project.name)
		)
	);

	item.append(open, pin, remove);
	projectButtons.set(project.id, { open, pin, remove });

	if (project.pinned) {
		item.classList.add('pinned');
	}

	return item;
}

function renderIconButton(kind: string, label: string, glyph: string, onClick: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = `recent-icon ${kind}`;
	button.textContent = glyph;
	button.title = label;
	button.setAttribute('aria-label', label);
	button.addEventListener('click', onClick);

	return button;
}

function describeProject(project: IRecentProject): string {
	const kind = project.kind === 'workspace'
		? localize('vshoonStartWindow.workspace', "workspace")
		: localize('vshoonStartWindow.folder', "folder");
	const pinned = project.pinned ? localize('vshoonStartWindow.pinnedDescription', ", pinned") : '';
	const remote = project.remote ? localize('vshoonStartWindow.remoteDescription', ", remote") : '';

	return localize('vshoonStartWindow.openProjectDescription', "Open {0} {1}, {2}{3}{4}", project.name, kind, project.location, remote, pinned);
}

function restoreFocus(target: FocusTarget | undefined): void {
	if (!target) {
		return;
	}

	if (target.kind === 'initial') {
		if (document.activeElement !== document.body && document.activeElement !== document.documentElement) {
			return;
		}

		(projects[0] ? projectButtons.get(projects[0].id)?.open : document.getElementById('open-folder'))?.focus();
		return;
	}

	if (target.kind === 'element') {
		document.getElementById(target.id)?.focus();
		return;
	}

	projectButtons.get(target.id)?.[target.action].focus();
}

list.addEventListener('keydown', event => {
	const target = event.target;
	if (!(target instanceof HTMLButtonElement) || !target.classList.contains('recent-open')) {
		return;
	}

	const currentIndex = projects.findIndex(project => project.id === target.dataset.projectId);
	const nextIndex = getVShoonProjectNavigationIndex(currentIndex, projects.length, event.key);
	if (nextIndex === undefined) {
		return;
	}

	event.preventDefault();
	projectButtons.get(projects[nextIndex].id)?.open.focus();
});

document.getElementById('open-folder')?.addEventListener('click', () => request({ type: 'chooseFolder' }, { kind: 'element', id: 'open-folder' }));
document.getElementById('open-workspace')?.addEventListener('click', () => request({ type: 'chooseWorkspace' }, { kind: 'element', id: 'open-workspace' }));
document.getElementById('open-empty')?.addEventListener('click', () => request({ type: 'openEmpty' }));
document.getElementById('quit')?.addEventListener('click', () => request({ type: 'quit' }));

start();

async function start(): Promise<void> {
	await initializeNls();
	initializeLabels();
	await request({ type: 'projects' }, { kind: 'initial' });
}
