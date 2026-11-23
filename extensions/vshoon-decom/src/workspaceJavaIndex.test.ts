/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectSourceSymbols, definitionOwners, resolveSourceDefinitions, typeReferenceAt, typeReferenceDefinitions } from './javaSymbols';
import { WorkspaceJavaIndex } from './workspaceJavaIndex';

describe('workspace Java navigation', () => {
	it('finds same-file methods on a single line and ignores method calls as declarations', () => {
		const content = 'class App { void run() { target(); } void target() {} }';
		const current = { uri: 'file:///App.java', content };
		assert.deepStrictEqual(resolveSourceDefinitions(current, content.indexOf('target'), 'target', [current]), [
			{ uri: current.uri, line: 0, column: content.lastIndexOf('target'), length: 6 }
		]);
	});

	it('indexes annotated multiline signatures and overloads', () => {
		const content = `class Service {
	@Override
	public String format(
		String text,
		int count
	) { return text; }
	public String format(int count) { return ""; }
}`;
		assert.deepStrictEqual(collectSourceSymbols(content).filter(symbol => symbol.kind === 'method').map(symbol => ({ name: symbol.name, parameters: symbol.parameterTypes, line: symbol.line })), [
			{ name: 'format', parameters: ['String', 'int'], line: 2 },
			{ name: 'format', parameters: ['int'], line: 6 }
		]);
	});

	it('uses explicit imports to distinguish same-named receivers in different packages', () => {
		const index = new WorkspaceJavaIndex();
		index.update('file:///a/Service.java', 'package a; public class Service { public void save(String text) {} }');
		index.update('file:///b/Service.java', 'package b; public class Service { public void save(String text) {} }');
		const content = 'package app; import b.Service; class App { Service service; void run() { service.save("ok"); } }';
		const definitions = index.resolve({ uri: 'file:///App.java', content }, content.indexOf('save'), 'save');
		assert.deepStrictEqual(definitions.map(definition => definition.uri), ['file:///b/Service.java']);
	});

	it('resolves same-package and wildcard-imported types, constructors and overloads', () => {
		const index = new WorkspaceJavaIndex();
		index.update('file:///a/Service.java', 'package a; class Service { Service() {} void save(String text) {} void save(int count) {} }');
		const content = 'package app; import a.*; class App { Service service; void run() { service.save(1); new Service(); } }';
		assert.deepStrictEqual(['save', 'Service'].map(word => index.resolve({ uri: 'file:///App.java', content }, content.lastIndexOf(word), word).map(definition => definition.uri)), [
			['file:///a/Service.java'], ['file:///a/Service.java']
		]);
	});

	it('updates renamed and deleted types without leaving stale declarations', () => {
		const index = new WorkspaceJavaIndex();
		const uri = 'file:///Service.java';
		const content = 'class App { Service service; void run() { service.save(); } }';
		const resolve = () => index.resolve({ uri: 'file:///App.java', content }, content.indexOf('save'), 'save').length;
		index.update(uri, 'class Service { void save() {} }');
		const counts = [resolve()];
		index.update(uri, 'class Renamed { void save() {} }');
		counts.push(resolve());
		index.update(uri, 'class Service { void save() {} }');
		counts.push(resolve());
		index.delete(uri);
		counts.push(resolve());
		assert.deepStrictEqual(counts, [1, 0, 1, 0]);
	});

	it('uses same-package types without leaking methods from unrelated packages', () => {
		const index = new WorkspaceJavaIndex();
		index.update('file:///example/Service.java', 'package example; class Service { void save() {} }');
		index.update('file:///other/Service.java', 'package other; class Service { void save() {} }');
		const content = 'package example; class App { Service service; void run() { service.save(); } }';
		const current = { uri: 'file:///example/App.java', content };
		const before = index.resolve(current, content.indexOf('save'), 'save');
		index.delete('file:///example/Service.java');
		assert.deepStrictEqual([before.map(definition => definition.uri), index.resolve(current, content.indexOf('save'), 'save')], [
			['file:///example/Service.java'], []
		]);
	});

	it('refreshes declaration positions and removed methods after an edit', () => {
		const index = new WorkspaceJavaIndex();
		const uri = 'file:///Service.java';
		const content = 'class App { Service service; void run() { service.save(); } }';
		const current = { uri: 'file:///App.java', content };
		index.update(uri, 'class Service { void save() {} }');
		const lines = index.resolve(current, content.indexOf('save'), 'save').map(definition => definition.line);
		index.update(uri, '// changed\nclass Service {\n void save() {}\n}');
		lines.push(...index.resolve(current, content.indexOf('save'), 'save').map(definition => definition.line));
		index.update(uri, 'class Service { void renamed() {} }');
		assert.deepStrictEqual([lines, index.resolve(current, content.indexOf('save'), 'save')], [[0, 2], []]);
	});

	it('does not navigate from comments or strings', () => {
		const content = 'class App { void target() {} void run() { /* target() */ String s = "target()"; } }';
		assert.deepStrictEqual([content.indexOf('target', content.indexOf('/*')), content.lastIndexOf('target')].map(offset => definitionOwners(content, offset, 'target')), [[], []]);
	});

	it('follows inherited methods and fields through superclasses and interfaces', () => {
		const index = new WorkspaceJavaIndex();
		const base = 'package app; public class BaseVO implements Named { protected String lang; public String getLang() { return lang; } }';
		const named = 'package app; interface Named { String displayName(); }';
		index.update('file:///BaseVO.java', base);
		index.update('file:///Named.java', named);
		index.update('file:///FormVO.java', 'package app; public class FormVO extends BaseVO { }');
		const content = 'package app; class Controller extends BaseVO { void run(FormVO form) { form.getLang(); form.displayName(); getLang(); this.lang = ""; } }';
		const current = { uri: 'file:///Controller.java', content };
		assert.deepStrictEqual([
			index.resolve(current, content.indexOf('getLang'), 'getLang'),
			index.resolve(current, content.indexOf('displayName'), 'displayName').map(definition => definition.uri),
			index.resolve(current, content.lastIndexOf('getLang'), 'getLang').map(definition => definition.uri),
			index.resolve(current, content.lastIndexOf('lang'), 'lang')
		], [
			[{ uri: 'file:///BaseVO.java', line: 0, column: base.indexOf('getLang'), length: 7 }],
			['file:///Named.java'],
			['file:///BaseVO.java'],
			[{ uri: 'file:///BaseVO.java', line: 0, column: base.indexOf('lang;'), length: 4 }]
		]);
	});

	it('resolves locals, parameters, fields, enum constants and implicit constructors', () => {
		const content = `class App {
	enum Mode { FAST, SLOW; }
	private int count, total = 2;
	Mode mode = Mode.SLOW;
	void run(String name) {
		String copy = name;
		total = count + copy.length();
		new App();
	}
}`;
		const current = { uri: 'file:///App.java', content };
		const at = (word: string, from: string) => {
			const offset = content.indexOf(word, content.indexOf(from));
			return resolveSourceDefinitions(current, offset, word, [current]).map(definition => [definition.line, definition.column]);
		};
		assert.deepStrictEqual([at('name', 'copy ='), at('copy', 'count +'), at('total', 'total ='), at('count', 'count +'), at('SLOW', 'Mode.SLOW'), at('App', 'new App')], [
			[[4, 17]], [[5, 9]], [[2, 20]], [[2, 13]], [[1, 19]], [[0, 6]]
		]);
	});

	it('guesses same-named methods for chained calls only once the whole index is available', () => {
		const index = new WorkspaceJavaIndex();
		index.update('file:///Repository.java', 'class Repository { Entity find(String id) { return null; } }');
		index.update('file:///Entity.java', 'class Entity { void save() {} void save(int count) {} }');
		const content = 'class App { Repository repository; void run() { repository.find("1").save(); } }';
		const current = { uri: 'file:///App.java', content };
		const offset = content.indexOf('save');
		assert.deepStrictEqual([index.resolve(current, offset, 'save', false), index.resolve(current, offset, 'save').map(definition => definition.column)], [
			[], ['class Entity { void '.length]
		]);
	});

	it('describes library references by their declaring type and finds them in decompiled sources', () => {
		const content = 'import org.lib.Key; class App { void run(Key key) { key.getId(1); Key.create(); } }';
		const library = { uri: 'vshoon-decom://source/Key.java', content: 'package org.lib;\npublic class Key {\n  public String getId(int index) { return ""; }\n  public static Key create() { return null; }\n}' };
		const targets = [typeReferenceAt(content, content.indexOf('getId'), 'getId')!, typeReferenceAt(content, content.indexOf('create'), 'create')!, typeReferenceAt(content, content.indexOf('Key key'), 'Key')!];
		assert.deepStrictEqual([targets, targets.map(target => typeReferenceDefinitions(library, target).map(definition => definition.line))], [[
			{ type: 'Key', member: { name: 'getId', kind: 'method', argumentCount: 1 } },
			{ type: 'Key', member: { name: 'create', kind: 'method', argumentCount: 0 } },
			{ type: 'Key' }
		], [[2], [3], [1]]]);
	});

	it('recognizes Spring-style parameter annotations and receiver fields declared after a method', () => {
		const index = new WorkspaceJavaIndex();
		const service = 'class Service { String save(@RequestParam("value") String value) { return value; } }';
		index.update('file:///Service.java', service);
		const content = 'class App { String run() { return service.save("ok"); } Service service; }';
		assert.deepStrictEqual(index.resolve({ uri: 'file:///App.java', content }, content.indexOf('save'), 'save'), [
			{ uri: 'file:///Service.java', line: 0, column: service.indexOf('save'), length: 4 }
		]);
	});
});
