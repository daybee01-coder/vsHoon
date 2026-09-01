/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
}

interface IStartWindowGlobals {
	readonly ipcRenderer: {
		invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	};
}

const globals = (window as unknown as { vscode: IStartWindowGlobals }).vscode;

const list = document.getElementById('recent-list') as HTMLUListElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const count = document.getElementById('recent-count') as HTMLElement;
const statusLine = document.getElementById('status') as HTMLElement;

let projects: readonly IRecentProject[] = [];

/**
 * The main process owns every decision. The renderer sends one of the enumerated requests and
 * renders whatever model comes back; it never resolves a path or opens anything itself.
 */
async function request(body: { type: string; id?: string }): Promise<void> {
	try {
		const response = await globals.ipcRenderer.invoke(CHANNEL, body) as IResponse;
		if (response.projects) {
			projects = response.projects;
			render();
		}
	} catch (error) {
		statusLine.textContent = '요청을 처리하지 못했습니다.';
		console.error(error);
	}
}

function render(): void {
	list.textContent = '';
	count.textContent = projects.length > 0 ? `${projects.length}개` : '';
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
	open.addEventListener('click', () => request({ type: 'openRecent', id: project.id }));

	const name = document.createElement('span');
	name.className = 'recent-name';
	name.textContent = project.name;

	const locationLabel = document.createElement('span');
	locationLabel.className = 'recent-location';
	locationLabel.textContent = project.location;

	open.append(name, locationLabel);
	open.setAttribute('aria-label', describeProject(project));

	item.append(open, renderIconButton(
		project.pinned ? 'unpin' : 'pin',
		project.pinned ? `${project.name} 고정 해제` : `${project.name} 고정`,
		project.pinned ? '★' : '☆',
		() => request({ type: 'togglePin', id: project.id })
	), renderIconButton(
		'remove',
		`${project.name} 목록에서 제거`,
		'✕',
		() => request({ type: 'removeRecent', id: project.id })
	));

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
	const kind = project.kind === 'workspace' ? '워크스페이스' : '폴더';
	const pinned = project.pinned ? ', 고정됨' : '';
	const remote = project.remote ? ', 원격' : '';

	return `${project.name} ${kind} 열기, ${project.location}${remote}${pinned}`;
}

document.getElementById('open-folder')?.addEventListener('click', () => request({ type: 'chooseFolder' }));
document.getElementById('open-workspace')?.addEventListener('click', () => request({ type: 'chooseWorkspace' }));
document.getElementById('open-empty')?.addEventListener('click', () => request({ type: 'openEmpty' }));
document.getElementById('quit')?.addEventListener('click', () => request({ type: 'quit' }));

request({ type: 'projects' });
