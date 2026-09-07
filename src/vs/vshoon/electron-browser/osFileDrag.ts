/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { INativeHostService } from '../../platform/native/common/native.js';
import { vshoonOsFileDragDelegate } from '../common/osFileDrops.js';

/**
 * Gives the Workbench seam a way to hand a drag of local files to the operating system.
 *
 * Only Electron can start such a drag, and the seam that receives the request runs in the browser
 * layer, which may not reach a native service. So the desktop layer installs the implementation
 * here and the seam calls through the shared delegate. A build without this registration ignores
 * drag requests rather than failing them.
 */
export function registerVShoonOsFileDrag(nativeHostService: INativeHostService): IDisposable {
	vshoonOsFileDragDelegate.setHandler({
		start: paths => {
			// The gesture is already under way, so nothing here may wait: the drag has to reach the
			// shell while the pointer is still down.
			nativeHostService.startFileDrag([...paths]).catch(() => undefined);
		}
	});

	return toDisposable(() => vshoonOsFileDragDelegate.setHandler(undefined));
}
