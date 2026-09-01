/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';

export type VShoonRecentProjectKind = 'folder' | 'workspace';

/** A recent entry as the upstream history service describes it. */
export interface IVShoonRecentProjectInput {
	readonly kind: VShoonRecentProjectKind;
	readonly uri: URI;
	readonly label?: string;
	readonly remoteAuthority?: string;
}

/**
 * A recent entry as the start window renders it.
 *
 * This is display-only and crosses the IPC boundary. `id` is what the renderer sends back, and
 * the main process resolves it against the current list rather than treating it as a path.
 */
export interface IVShoonRecentProject {
	readonly id: string;
	readonly kind: VShoonRecentProjectKind;
	readonly name: string;
	readonly location: string;
	readonly remote: boolean;
	readonly pinned: boolean;
}

const WORKSPACE_SUFFIX = '.code-workspace';

/**
 * Builds the display model.
 *
 * Pinned entries come first in the order they were pinned, so the shortlist a user arranges
 * stays put instead of reshuffling every time one of them is opened. Everything else follows in
 * the order the history service returned, which is most recent first.
 */
export function toVShoonRecentProjects(inputs: readonly IVShoonRecentProjectInput[], pinnedIds: readonly string[]): IVShoonRecentProject[] {
	const pinned = new Set(pinnedIds);
	const projects = inputs.map(input => toRecentProject(input, pinned));
	const byId = new Map(projects.map(project => [project.id, project]));

	return [
		...pinnedIds.map(id => byId.get(id)).filter((project): project is IVShoonRecentProject => !!project),
		...projects.filter(project => !project.pinned)
	];
}

export function toVShoonRecentProjectId(uri: URI): string {
	return uri.toString();
}

/** Adds or removes a pin, keeping the order in which entries were pinned. */
export function toggleVShoonPinnedProject(pinnedIds: readonly string[], id: string): string[] {
	return pinnedIds.includes(id) ? pinnedIds.filter(pinned => pinned !== id) : [...pinnedIds, id];
}

/** Drops pins for entries that are no longer in the recent list, so the store cannot grow forever. */
export function prunePinnedProjects(pinnedIds: readonly string[], projects: readonly IVShoonRecentProject[]): string[] {
	const known = new Set(projects.map(project => project.id));

	return pinnedIds.filter(id => known.has(id));
}

function toRecentProject(input: IVShoonRecentProjectInput, pinned: ReadonlySet<string>): IVShoonRecentProject {
	const id = toVShoonRecentProjectId(input.uri);

	return {
		id,
		kind: input.kind,
		name: input.label || toName(input),
		location: toLocation(input.uri),
		remote: !!input.remoteAuthority,
		pinned: pinned.has(id)
	};
}

function toName(input: IVShoonRecentProjectInput): string {
	const name = basename(input.uri);
	if (input.kind === 'workspace' && name.endsWith(WORKSPACE_SUFFIX)) {
		return name.slice(0, -WORKSPACE_SUFFIX.length);
	}

	// A drive root such as `file:///d:/` has no basename to show.
	return name || input.uri.path;
}

function toLocation(uri: URI): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}
