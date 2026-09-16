/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extname } from '../../base/common/resources.js';
import { Schemas } from '../../base/common/network.js';
import { URI } from '../../base/common/uri.js';

export const VSHOON_RESOLVE_ARCHIVE_EXPLORER_COMMAND = 'decom.resolveExplorerJar';
export const VSHOON_JAR_FILE_SYSTEM_SCHEME = 'vshoon-jar';

/**
 * JAR files remain ordinary files on disk, but VShoon lets the Explorer request their children
 * from the bundled Decom extension.
 */
export function isVShoonExpandableArchive(resource: URI): boolean {
	return (resource.scheme === Schemas.file || resource.scheme === VSHOON_JAR_FILE_SYSTEM_SCHEME) && extname(resource).toLowerCase() === '.jar';
}
