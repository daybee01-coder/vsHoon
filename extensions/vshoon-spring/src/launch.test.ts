/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBootLaunchConfiguration, createMavenAttachConfiguration, createMavenInvocation, splitArguments } from './launch';
import { SpringRunConfiguration } from './model';

const boot: SpringRunConfiguration = {
	id: 'boot',
	name: 'Demo',
	kind: 'boot',
	project: 'api',
	projectName: 'demo-api',
	mainClass: 'com.example.DemoApplication',
	profiles: 'local,dev',
	vmArgs: '-Xmx1g',
	args: '--debug',
	env: { DB_URL: 'jdbc:h2:mem:test' },
	port: 8081,
	javaHome: 'C:\\Program Files\\Java\\jdk-17'
};

const maven: SpringRunConfiguration = {
	id: 'legacy',
	name: 'Legacy',
	kind: 'maven',
	project: '',
	goal: 'jetty:run',
	profiles: 'dev',
	vmArgs: '-Dfile.encoding=UTF-8',
	args: '-Pdev "-Dname=a b"',
	env: {},
	port: 9090
};

describe('createBootLaunchConfiguration', () => {
	it('프로파일과 포트를 Spring 인자로 넘긴다', () => {
		assert.deepEqual(createBootLaunchConfiguration(boot, 'D:\\work\\api', 'internalConsole', 'win32'), {
			type: 'java',
			request: 'launch',
			name: 'Demo',
			mainClass: 'com.example.DemoApplication',
			projectName: 'demo-api',
			cwd: 'D:\\work\\api',
			vmArgs: '-Xmx1g',
			args: '--debug --spring.profiles.active=local,dev --server.port=8081',
			env: { DB_URL: 'jdbc:h2:mem:test' },
			javaExec: 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
			console: 'internalConsole',
			vshoonSpringConfigurationId: 'boot'
		});
	});
});

describe('createMavenInvocation', () => {
	it('JVM 옵션은 MAVEN_OPTS로, 골과 Maven 인자는 명령줄로', () => {
		assert.deepEqual(createMavenInvocation(maven, '-Xss1m', 5005), {
			args: ['jetty:run', '-Pdev', '-Dname=a b'],
			env: {
				MAVEN_OPTS: '-Xss1m -Dfile.encoding=UTF-8 -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005 -Dspring.profiles.active=dev -Djetty.http.port=9090 -Djetty.port=9090'
			}
		});
	});

	it('실행 모드에는 JDWP가 없고 JAVA_HOME을 지정한다', () => {
		const invocation = createMavenInvocation({ ...maven, goal: 'tomcat7:run', profiles: '', vmArgs: '', args: '', javaHome: 'C:\\jdk8', env: { A: '1' } }, undefined, undefined);
		assert.deepEqual(invocation, {
			args: ['tomcat7:run'],
			env: { A: '1', MAVEN_OPTS: '-Dmaven.tomcat.port=9090', JAVA_HOME: 'C:\\jdk8' }
		});
	});
});

describe('createMavenInvocation — 전체 좌표 골', () => {
	it('Jetty 12 골에도 Jetty 포트 속성을 넘긴다', () => {
		const invocation = createMavenInvocation({ ...maven, goal: 'org.eclipse.jetty.ee10:jetty-ee10-maven-plugin:12.0.25:run', profiles: '', vmArgs: '', args: '' }, undefined, undefined);
		assert.deepEqual(invocation, {
			args: ['org.eclipse.jetty.ee10:jetty-ee10-maven-plugin:12.0.25:run'],
			env: { MAVEN_OPTS: '-Djetty.http.port=9090 -Djetty.port=9090' }
		});
	});
});

describe('createMavenAttachConfiguration', () => {
	it('JDWP 포트에 붙고 서버가 뜰 때까지 재시도한다', () => {
		assert.deepEqual(createMavenAttachConfiguration(maven, 5005), {
			type: 'java',
			request: 'attach',
			name: 'Legacy',
			hostName: '127.0.0.1',
			port: 5005,
			timeout: 120000,
			vshoonSpringConfigurationId: 'legacy'
		});
	});
});

describe('splitArguments', () => {
	it('큰따옴표 묶음을 지키고 역슬래시는 그대로 둔다', () => {
		assert.deepEqual(splitArguments(' -Pdev  "-Dpath=C:\\a b" x"y z" '), ['-Pdev', '-Dpath=C:\\a b', 'xy z']);
	});
});
