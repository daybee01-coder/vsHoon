/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classNameFromSourcePath, DEFAULT_SERVER_GOALS, goalLabel, parseConfigurationFile, parseEnvironment, serializeConfigurationFile, SpringRunConfiguration } from './model';

describe('parseConfigurationFile', () => {
	it('잘못된 항목, 중복 id, 프로젝트 밖 경로를 걸러낸다', () => {
		const content = JSON.stringify({
			version: 1,
			configurations: [
				{ id: 'a', name: ' Demo ', kind: 'boot', project: 'app\\api', mainClass: 'com.example.Demo', port: 8081, env: { JAVA_OPTS: 1, 'bad key': 'x' } },
				{ id: 'a', name: 'Duplicate', kind: 'boot', mainClass: 'com.example.Other' },
				{ id: 'b', name: 'No goal', kind: 'maven' },
				{ id: 'c', name: 'Legacy', kind: 'maven', project: '../outside', goal: 'jetty:run', port: 70000 },
				'not an object'
			]
		});
		assert.deepEqual(parseConfigurationFile(content), [
			{ id: 'a', name: 'Demo', kind: 'boot', project: 'app/api', mainClass: 'com.example.Demo', profiles: '', vmArgs: '', args: '', env: { JAVA_OPTS: '1' }, port: 8081 },
			{ id: 'c', name: 'Legacy', kind: 'maven', project: '', goal: 'jetty:run', profiles: '', vmArgs: '', args: '', env: {} }
		]);
	});

	it('JSON이 아니면 빈 목록이다', () => {
		assert.deepEqual(parseConfigurationFile('{'), []);
	});

	it('저장한 내용을 그대로 다시 읽는다', () => {
		const configuration: SpringRunConfiguration = { id: 'x', name: 'Api', kind: 'maven', project: 'web', projectName: 'web', goal: 'tomcat7:run', profiles: 'dev', vmArgs: '-Xmx1g', args: '-Pdev', env: { A: 'b' }, port: 9090, javaHome: 'C:\\jdk8' };
		assert.deepEqual(parseConfigurationFile(serializeConfigurationFile([configuration])), [configuration]);
	});
});

describe('parseEnvironment', () => {
	it('KEY=VALUE 줄만 읽고 주석과 잘못된 이름은 버린다', () => {
		assert.deepEqual(parseEnvironment('# comment\nA=1\n\n B = two=2 \n1BAD=x\nnoequals'), { A: '1', B: 'two=2' });
	});
});

describe('goalLabel', () => {
	it('전체 좌표 골을 플러그인 접두사로 줄인다', () => {
		assert.deepEqual(
			[DEFAULT_SERVER_GOALS.javax, DEFAULT_SERVER_GOALS.jakarta, 'org.apache.maven.plugins:maven-jetty-plugin:6.1.26:run', 'tomcat7:run', 'clean jetty:run'].map(goalLabel),
			['jetty:run', 'jetty:run', 'jetty:run', 'tomcat7:run', 'clean jetty:run']
		);
	});
});

describe('classNameFromSourcePath', () => {
	it('src/main/java 아래 경로를 클래스 이름으로 바꾼다', () => {
		assert.deepEqual(
			['api/src/main/java/com/example/Demo.java', 'src\\main\\java\\a\\B.java', 'src/test/java/a/B.java'].map(classNameFromSourcePath),
			['com.example.Demo', 'a.B', undefined]
		);
	});
});
