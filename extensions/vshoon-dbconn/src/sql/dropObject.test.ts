/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildDropObjectSql } from './dropObject';

test('DROP quotes schema and object names and uses the object-specific keyword', () => {
	assert.deepEqual([
		buildDropObjectSql({ schema: 'app', name: 'two`tables', kind: 'table' }, 'mysql'),
		buildDropObjectSql({ schema: 'a"b', name: 'order', kind: 'materialized-view' }, 'postgres'),
		buildDropObjectSql({ schema: 'APP', name: 'S', kind: 'sequence' }, 'oracle'),
		buildDropObjectSql({ schema: 'app', name: 's', kind: 'sequence' }, 'mariadb'),
	], [
		'DROP TABLE `app`.`two``tables`',
		'DROP MATERIALIZED VIEW "a""b"."order"',
		'DROP SEQUENCE "APP"."S"',
		'DROP SEQUENCE `app`.`s`',
	]);
});

test('DROP addresses the selected PostgreSQL overload, including zero arguments', () => {
	const routine = { schema: 'app', name: 'lookup', kind: 'function' as const, detail: '(ignored)' };
	assert.deepEqual([
		buildDropObjectSql({ ...routine, dropArguments: 'pg_catalog.int4' }, 'postgres'),
		buildDropObjectSql({ ...routine, dropArguments: '"custom types"."Status"' }, 'postgres'),
		buildDropObjectSql({ ...routine, kind: 'procedure', dropArguments: '' }, 'postgres'),
		buildDropObjectSql(routine, 'postgres'),
	], [
		'DROP FUNCTION "app"."lookup"(pg_catalog.int4)',
		'DROP FUNCTION "app"."lookup"("custom types"."Status")',
		'DROP PROCEDURE "app"."lookup"()',
		undefined,
	]);
});

test('DROP rejects unsupported object kinds and unqualified objects', () => {
	assert.deepEqual([
		buildDropObjectSql({ schema: 'app', name: 's', kind: 'sequence' }, 'mysql'),
		buildDropObjectSql({ schema: 'app', name: 'v', kind: 'materialized-view' }, 'mariadb'),
		buildDropObjectSql({ schema: '', name: 't', kind: 'table' }, 'postgres'),
	], [undefined, undefined, undefined]);
});
