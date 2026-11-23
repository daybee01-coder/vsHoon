/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { IVShoonModalWebviewLayout, VShoonModalWebviewLayouts } from '../common/modalWebviews.js';
import { vshoonModalWebviewRegistry } from './uiExtensionPoint.js';

// Renderer memory only: closing/reloading the Workbench discards these values.
const layouts = new VShoonModalWebviewLayouts();

// Part of a popup dragged past a window edge that stays visible: enough of the header to grab it.
const minimumVisibleWidth = 160;
const minimumVisibleHeight = 48;

/** Allowed range for the top-left corner of a bundled popup, in window coordinates. */
export interface IVShoonModalWebviewPositionBounds {
	readonly minLeft: number;
	readonly maxLeft: number;
	readonly minTop: number;
	readonly maxTop: number;
}

interface IMutableModalLayout {
	size: IVShoonModalWebviewLayout['size'];
	position: IVShoonModalWebviewLayout['position'];
	readonly maximized: boolean;
	toggleMaximized(): void;
}

/** Owns the layout of the active bundled panel, including switches in a shared modal part. */
export class VShoonModalWebviewLayout implements IDisposable {

	private current: { source: string; viewType: string } | undefined;
	private readonly initial: IVShoonModalWebviewLayout;
	private readonly cleanup: IDisposable;

	constructor(private readonly part: IMutableModalLayout) {
		this.initial = this.snapshot();
		this.cleanup = toDisposable(() => this.save());
	}

	activate(identity: { source: string; viewType: string } | undefined): void {
		const source = identity?.source;
		const viewType = identity?.viewType;
		const declaration = source && viewType ? vshoonModalWebviewRegistry.getModalWebview(source, viewType) : undefined;
		const contribution = declaration?.presentation === 'window' ? undefined : declaration;
		if (this.current?.source === source && this.current?.viewType === viewType) {
			return;
		}
		const previous = this.current;
		this.save();
		this.current = contribution && source && viewType ? { source, viewType } : undefined;
		const layout = this.current ? layouts.get(this.current.source, this.current.viewType) ?? { size: contribution?.size, position: undefined, maximized: false } : previous ? this.initial : undefined;
		if (layout) {
			// Restore from maximized before assigning geometry, so upstream's saved bounds
			// cannot overwrite the next panel's bounds when it is later restored.
			if (this.part.maximized) {
				this.part.toggleMaximized();
			}
			this.part.size = layout.size;
			this.part.position = layout.position;
			if (layout.maximized) {
				this.part.toggleMaximized();
			}
		}
	}

	/**
	 * Bounds for the top-left corner of the active bundled panel. Unlike ordinary modal editors, a
	 * bundled popup may be dragged past the window edges and is clipped there, while enough of its
	 * header stays inside the window to drag it back. Returns `undefined` for other editors.
	 */
	positionBounds(container: { readonly width: number; readonly height: number }, titleBarOffset: number, width: number): IVShoonModalWebviewPositionBounds | undefined {
		if (!this.current) {
			return undefined;
		}
		const visibleWidth = Math.min(width, minimumVisibleWidth);
		return {
			minLeft: visibleWidth - width,
			maxLeft: Math.max(0, container.width - visibleWidth),
			minTop: titleBarOffset,
			maxTop: Math.max(titleBarOffset, container.height - minimumVisibleHeight)
		};
	}

	private snapshot(): IVShoonModalWebviewLayout {
		return { size: this.part.size, position: this.part.position, maximized: this.part.maximized };
	}

	private save(): void {
		if (this.current) {
			layouts.set(this.current.source, this.current.viewType, this.snapshot());
		}
	}

	dispose(): void {
		this.cleanup.dispose();
	}
}
