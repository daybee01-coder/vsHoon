/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSpringBootApplicationSource, parsePom } from './pom';

describe('parsePom', () => {
	it('Spring Boot 부모를 쓰는 프로젝트', () => {
		const pom = `<project>
			<parent>
				<groupId>org.springframework.boot</groupId>
				<artifactId>spring-boot-starter-parent</artifactId>
			</parent>
			<artifactId>demo</artifactId>
			<dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
		</project>`;
		assert.deepEqual(parsePom(pom), { artifactId: 'demo', packaging: 'jar', springBoot: true, servletApi: 'javax' });
	});

	it('Jetty 플러그인이 있는 레거시 WAR. 주석 안의 플러그인은 무시한다', () => {
		const pom = `<project>
			<groupId>com.example</groupId>
			<artifactId>legacy-web</artifactId>
			<packaging>war</packaging>
			<dependencies><dependency><artifactId>spring-webmvc</artifactId></dependency></dependencies>
			<build><plugins>
				<!-- <plugin><artifactId>tomcat7-maven-plugin</artifactId></plugin> -->
				<plugin><artifactId>jetty-maven-plugin</artifactId></plugin>
			</plugins></build>
		</project>`;
		assert.deepEqual(parsePom(pom), { artifactId: 'legacy-web', packaging: 'war', springBoot: false, serverGoal: 'jetty:run', servletApi: 'javax' });
	});

	it('Tomcat 7 플러그인', () => {
		const pom = '<project><artifactId>web</artifactId><packaging>war</packaging><build><plugins><plugin><artifactId>tomcat7-maven-plugin</artifactId></plugin></plugins></build></project>';
		assert.deepEqual(parsePom(pom), { artifactId: 'web', packaging: 'war', springBoot: false, serverGoal: 'tomcat7:run', servletApi: 'javax' });
	});

	it('서블릿 네임스페이스: jakarta 의존성이나 Spring 6 이상이면 jakarta', () => {
		const poms = [
			'<project><artifactId>a</artifactId><packaging>war</packaging><properties><spring.version>5.3.39</spring.version></properties></project>',
			'<project><artifactId>b</artifactId><packaging>war</packaging><properties><spring.version>6.1.14</spring.version></properties></project>',
			'<project><artifactId>c</artifactId><dependencies><dependency><artifactId>spring-webmvc</artifactId><version>6.0.0</version></dependency></dependencies></project>',
			'<project><artifactId>d</artifactId><dependencies><dependency><groupId>jakarta.servlet</groupId><artifactId>jakarta.servlet-api</artifactId></dependency></dependencies></project>',
			'<project><artifactId>e</artifactId><dependencies><dependency><groupId>javax.servlet</groupId><artifactId>javax.servlet-api</artifactId></dependency></dependencies></project>'
		];
		assert.deepEqual(poms.map(pom => parsePom(pom).servletApi), ['javax', 'jakarta', 'jakarta', 'jakarta', 'javax']);
	});
});

describe('isSpringBootApplicationSource', () => {
	it('어노테이션과 main 메서드가 모두 있어야 한다', () => {
		const sources = [
			'@SpringBootApplication public class A { public static void main(String[] args) {} }',
			'@SpringBootApplication public class B { }',
			'public class C { public static void main(String[] args) {} }'
		];
		assert.deepEqual(sources.map(isSpringBootApplicationSource), [true, false, false]);
	});
});
