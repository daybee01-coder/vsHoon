/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';

/** A directory entry as the file system reports it, before the dialog gives it a URI. */
export interface IFileDialogChild {
	readonly name: string;
	readonly isDirectory: boolean;
}

/** An entry the dialog can show and select. */
export interface IFileDialogNode {
	readonly uri: URI;
	readonly name: string;
	readonly isDirectory: boolean;
}

/** The extension list of one entry in the caller's `filters`. */
export interface IFileDialogFilter {
	readonly extensions: readonly string[];
}

export type FileDialogChildReader = (uri: URI) => Promise<readonly IFileDialogChild[]>;

/**
 * What a listing request produced. `stale` means a newer request superseded this one, so the
 * caller must leave the tree it already rendered alone.
 */
export type FileDialogListingOutcome =
	| { readonly kind: 'listed'; readonly nodes: readonly IFileDialogNode[] }
	| { readonly kind: 'failed'; readonly error: Error | undefined }
	| { readonly kind: 'stale' };

/** Whether an entry survives the caller's file type filters. Directories always do. */
export function passesFileDialogFilter(node: IFileDialogChild, filters: readonly IFileDialogFilter[] | undefined): boolean {
	if (node.isDirectory || !filters?.length) {
		return true;
	}
	const name = node.name.toLowerCase();
	return filters.some(filter => filter.extensions.some(extension => extension === '*' || name.endsWith(`.${extension.toLowerCase()}`)));
}

/** Directories first, then by name, so a folder never hides between its files. */
export function sortFileDialogNodes(nodes: IFileDialogNode[]): IFileDialogNode[] {
	return nodes.sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1);
}

/**
 * Owns the lifetime of the dialog's directory reads.
 *
 * A slow folder must not overwrite the list the user has already moved on to, so every read
 * carries the generation it started in and reports `stale` when that generation is gone. The
 * file system reads themselves cannot be aborted; this drops their results instead.
 */
export class FileDialogListing {

	private currentGeneration = 0;

	constructor(
		private readonly readChildren: FileDialogChildReader,
		private readonly filters: readonly IFileDialogFilter[] | undefined
	) { }

	/** The generation a row belongs to. Rows pass it back when they expand. */
	get generation(): number {
		return this.currentGeneration;
	}

	/** Reads a folder as the new list, superseding every request still in flight. */
	async list(uri: URI): Promise<FileDialogListingOutcome> {
		return this.read(uri, ++this.currentGeneration);
	}

	/** Reads a folder inside the list already shown, such as an expanded row. */
	async listWithin(uri: URI, generation: number): Promise<FileDialogListingOutcome> {
		return generation === this.currentGeneration ? this.read(uri, generation) : { kind: 'stale' };
	}

	/** Drops the results of everything in flight, for when the dialog closes. */
	cancel(): void {
		this.currentGeneration++;
	}

	private async read(uri: URI, generation: number): Promise<FileDialogListingOutcome> {
		try {
			const children = await this.readChildren(uri);
			if (generation !== this.currentGeneration) {
				return { kind: 'stale' };
			}
			const nodes = children
				.filter(child => passesFileDialogFilter(child, this.filters))
				.map(child => ({ uri: joinPath(uri, child.name), name: child.name, isDirectory: child.isDirectory }));
			return { kind: 'listed', nodes: sortFileDialogNodes(nodes) };
		} catch (error) {
			if (generation !== this.currentGeneration) {
				return { kind: 'stale' };
			}
			return { kind: 'failed', error: error instanceof Error ? error : undefined };
		}
	}
}
