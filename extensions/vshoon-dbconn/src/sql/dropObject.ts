/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DbObject, DialectId, ObjectKind, TableInfo } from '../types';
import { quoteQualified } from './identifier';

const dropKeywords: Record<ObjectKind, string> = {
	table: 'TABLE',
	view: 'VIEW',
	'materialized-view': 'MATERIALIZED VIEW',
	sequence: 'SEQUENCE',
	function: 'FUNCTION',
	procedure: 'PROCEDURE',
	package: 'PACKAGE',
	synonym: 'SYNONYM',
	type: 'TYPE',
};

/** Builds a restrictive DROP from catalog metadata, including the exact PostgreSQL overload. */
export function buildDropObjectSql(object: Readonly<TableInfo | DbObject>, dialect: DialectId): string | undefined {
	if (!object.schema || !Object.hasOwn(dropKeywords, object.kind)) {
		return undefined;
	}
	if ((object.kind === 'materialized-view' && (dialect === 'mysql' || dialect === 'mariadb')) ||
		(object.kind === 'sequence' && dialect === 'mysql') ||
		((object.kind === 'package' || object.kind === 'synonym') && dialect !== 'oracle') ||
		(object.kind === 'type' && (dialect === 'mysql' || dialect === 'mariadb'))) {
		return undefined;
	}

	let target = quoteQualified(object.schema, object.name, dialect);
	if (dialect === 'postgres' && (object.kind === 'function' || object.kind === 'procedure')) {
		if (object.dropArguments === undefined) {
			return undefined;
		}
		target += `(${object.dropArguments})`;
	}
	return `DROP ${dropKeywords[object.kind]} ${target}`;
}
