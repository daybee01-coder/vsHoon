/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Resolves vertical keyboard navigation within the recent-project list.
 * Returning `undefined` leaves the browser's default key behavior unchanged.
 */
export function getVShoonProjectNavigationIndex(currentIndex: number, projectCount: number, key: string): number | undefined {
	if (currentIndex < 0 || currentIndex >= projectCount || projectCount < 1) {
		return undefined;
	}

	switch (key) {
		case 'ArrowDown':
			return Math.min(currentIndex + 1, projectCount - 1);

		case 'ArrowUp':
			return Math.max(currentIndex - 1, 0);

		case 'Home':
			return 0;

		case 'End':
			return projectCount - 1;

		default:
			return undefined;
	}
}

/**
 * Chooses the nearest surviving project after an entry is removed. Prefer the item that moved
 * into the removed row; when the last row was removed, fall back to its previous sibling.
 */
export function getVShoonProjectFocusAfterRemoval(projectIds: readonly string[], removedId: string): string | undefined {
	const removedIndex = projectIds.indexOf(removedId);
	if (removedIndex < 0) {
		return undefined;
	}

	return projectIds[removedIndex + 1] ?? projectIds[removedIndex - 1];
}
