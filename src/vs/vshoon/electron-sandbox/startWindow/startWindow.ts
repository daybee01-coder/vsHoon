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
	readonly theme?: { readonly baseTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'; readonly background: string; readonly foreground: string; readonly customTitleBar: boolean };
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

interface IStartWindowIcon {
	readonly size: 12 | 16;
	readonly path: string;
}

// These paths are the matching VS Code Codicons. Keeping the small set local lets this standalone
// renderer use the Workbench icon language without adding a font resource to its package seam.
const icons = {
	folder: { size: 16, path: 'M2 4.5V6H5.58579C5.71839 6 5.84557 5.94732 5.93934 5.85355L7.29289 4.5L5.93934 3.14645C5.84557 3.05268 5.71839 3 5.58579 3H3.5C2.67157 3 2 3.67157 2 4.5ZM1 4.5C1 3.11929 2.11929 2 3.5 2H5.58579C5.98361 2 6.36514 2.15804 6.64645 2.43934L8.20711 4H12.5C13.8807 4 15 5.11929 15 6.5V11.5C15 12.8807 13.8807 14 12.5 14H3.5C2.11929 14 1 12.8807 1 11.5V4.5ZM2 7V11.5C2 12.3284 2.67157 13 3.5 13H12.5C13.3284 13 14 12.3284 14 11.5V6.5C14 5.67157 13.3284 5 12.5 5H8.20711L6.64645 6.56066C6.36514 6.84197 5.98361 7 5.58579 7H2Z' },
	window: { size: 16, path: 'M4 1C2.34315 1 1 2.34315 1 4V12C1 13.6569 2.34315 15 4 15H12C13.6569 15 15 13.6569 15 12V4C15 2.34315 13.6569 1 12 1H4ZM2 4C2 2.89543 2.89543 2 4 2H12C13.1046 2 14 2.89543 14 4H2ZM2 5H14V12C14 13.1046 13.1046 14 12 14H4C2.89543 14 2 13.1046 2 12V5Z' },
	pin: { size: 16, path: 'M13.5 3C13.303 3 13.109 3.038 12.923 3.114L8.481 4.967L5.659 4.026C5.505 3.976 5.339 4.001 5.209 4.095C5.078 4.189 5.001 4.339 5.001 4.5V7H1.257L0.5 7.5L1.257 8H5V10.5C5 10.661 5.077 10.812 5.208 10.905C5.338 11 5.504 11.023 5.658 10.974L8.48 10.033L12.925 11.887C13.109 11.962 13.302 12 13.499 12C14.326 12 14.999 11.327 14.999 10.5V4.5C14.999 3.673 14.326 3 13.499 3H13.5ZM14 10.5C14 10.843 13.615 11.09 13.308 10.962L8.693 9.038C8.631 9.013 8.566 9 8.501 9C8.447 9 8.395 9.009 8.343 9.025L6.001 9.806V5.193L8.343 5.974C8.457 6.011 8.581 6.007 8.694 5.961L13.306 4.038C13.629 3.902 14.001 4.156 14.001 4.499V10.499L14 10.5Z' },
	pinned: { size: 16, path: 'M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z' },
	closeCompact: { size: 12, path: 'M10.1499 1.14013C10.3498 0.940199 10.6598 0.940342 10.8599 1.14013C11.0599 1.34013 11.0599 1.65009 10.8599 1.85009L6.71239 5.99267L10.8599 10.1401C11.0599 10.3401 11.0599 10.6501 10.8599 10.8501C10.7599 10.95 10.6302 11.0004 10.5102 11.0005H10.5005C10.3705 11.0005 10.2399 10.9501 10.1499 10.8501L6.00146 6.70165L1.85009 10.8501C1.7502 10.95 1.62037 11.0004 1.50048 11.0005C1.37048 11.0005 1.23989 10.9501 1.14989 10.8501C0.950107 10.6501 0.949965 10.3401 1.14989 10.1401L5.29442 5.99462L1.14989 1.85009C0.950107 1.65008 0.949964 1.34006 1.14989 1.14013C1.34982 0.940199 1.65985 0.940342 1.85985 1.14013L6.00438 5.28466L10.1499 1.14013Z' }
} satisfies Record<string, IStartWindowIcon>;

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

		if (response.theme) {
			applyTheme(response.theme);
		}
	} catch (error) {
		console.error(error); // the English fallbacks in a development build still render
	}
}

function applyTheme(theme: NonNullable<IResponse['theme']>): void {
	document.documentElement.dataset.vscodeTheme = theme.baseTheme;
	document.body.classList.toggle('custom-titlebar', theme.customTitleBar);
	const styleSheet = Array.from(document.styleSheets).find(sheet => sheet.href?.endsWith('/startWindow.css'));
	if (!styleSheet) {
		return;
	}

	const index = styleSheet.insertRule(':root[data-vscode-theme] {}', styleSheet.cssRules.length);
	const themeRule = styleSheet.cssRules.item(index);
	if (!(themeRule instanceof CSSStyleRule)) {
		return;
	}

	themeRule.style.setProperty('--vscode-editor-background', theme.background);
	themeRule.style.setProperty('--vscode-foreground', theme.foreground);
}

function initializeLabels(): void {
	document.documentElement.lang = getNLSLanguage() ?? navigator.language;
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

	const projectIcon = document.createElement('span');
	projectIcon.className = 'project-icon';
	projectIcon.appendChild(renderIcon(project.kind === 'folder' ? icons.folder : icons.window));
	projectIcon.setAttribute('aria-hidden', 'true');

	const projectText = document.createElement('span');
	projectText.className = 'recent-text';

	const name = document.createElement('span');
	name.className = 'recent-name';
	name.textContent = project.name;

	const locationLabel = document.createElement('span');
	locationLabel.className = 'recent-location';
	locationLabel.textContent = project.location;

	projectText.append(name, locationLabel);
	open.append(projectIcon, projectText);
	open.setAttribute('aria-label', describeProject(project));

	const pin = renderIconButton(
		project.pinned ? 'unpin' : 'pin',
		project.pinned
			? localize('vshoonStartWindow.unpinProject', "Unpin {0}", project.name)
			: localize('vshoonStartWindow.pinProject', "Pin {0}", project.name),
		project.pinned ? icons.pinned : icons.pin,
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
		icons.closeCompact,
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

function renderIconButton(kind: string, label: string, icon: IStartWindowIcon, onClick: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = `recent-icon ${kind}`;
	button.appendChild(renderIcon(icon));
	button.title = label;
	button.setAttribute('aria-label', label);
	button.addEventListener('click', onClick);

	return button;
}

function renderIcon(icon: IStartWindowIcon): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('codicon');
	svg.setAttribute('viewBox', `0 0 ${icon.size} ${icon.size}`);
	svg.setAttribute('aria-hidden', 'true');

	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', icon.path);
	svg.appendChild(path);

	return svg;
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
