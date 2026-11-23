/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MAVEN_SERVER_GOALS, ServletApi } from './model';

/** What discovery needs to know about one `pom.xml`. */
export interface PomSummary {
	readonly artifactId?: string;
	readonly packaging: string;
	/** Depends on Spring Boot through its parent, a starter or its Maven plugin. */
	readonly springBoot: boolean;
	/** Goal of the first servlet container plugin the build declares, for example `jetty:run`. */
	readonly serverGoal?: string;
	/** Servlet namespace: `jakarta` once the project uses Jakarta Servlet or Spring Framework 6 and later. */
	readonly servletApi: ServletApi;
}

/**
 * Reads a `pom.xml` without a full XML parser.
 * Discovery only needs a handful of well known elements, and a malformed pom still yields a best guess
 * instead of failing the whole scan.
 */
export function parsePom(content: string): PomSummary {
	const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');
	const parent = /<parent>[\s\S]*?<\/parent>/.exec(withoutComments)?.[0] ?? '';
	// The project's own coordinates come before its dependencies and build, once the parent block is gone.
	const header = withoutComments
		.replace(/<parent>[\s\S]*?<\/parent>/, '')
		.split(/<(?:dependencies|dependencyManagement|build|profiles|modules)>/)[0];
	const artifactId = element(header, 'artifactId');
	const packaging = element(header, 'packaging') ?? 'jar';
	const springBoot = /spring-boot-starter-parent|spring-boot-dependencies/.test(parent)
		|| /<artifactId>\s*spring-boot-(?:starter[\w-]*|maven-plugin)\s*<\/artifactId>/.test(withoutComments);
	let serverGoal: string | undefined;
	for (const match of withoutComments.matchAll(/<artifactId>\s*(?<plugin>[\w.-]+)\s*<\/artifactId>/g)) {
		const goal = match.groups && MAVEN_SERVER_GOALS[match.groups.plugin];
		if (goal) {
			serverGoal = goal;
			break;
		}
	}
	return {
		...(artifactId ? { artifactId } : {}),
		packaging,
		springBoot,
		...(serverGoal ? { serverGoal } : {}),
		servletApi: usesJakarta(withoutComments) ? 'jakarta' : 'javax'
	};
}

/** Whether a Java source declares a Spring Boot entry point. */
export function isSpringBootApplicationSource(content: string): boolean {
	return /@SpringBootApplication\b/.test(content) && /\bstatic\s+void\s+main\s*\(/.test(content);
}

function usesJakarta(content: string): boolean {
	if (/<groupId>\s*jakarta\.servlet\s*<\/groupId>/.test(content)) {
		return true;
	}
	// Spring Framework 6 moved to Jakarta EE. Its version sits in a property or next to a spring-* artifact.
	const springVersion = /<spring(?:-framework|framework)?\.version>\s*(?<major>\d+)\./.exec(content)
		?? /<artifactId>\s*spring-(?:webmvc|web|context|core|framework-bom)\s*<\/artifactId>\s*<version>\s*(?<major>\d+)\./.exec(content);
	return Number(springVersion?.groups?.major ?? 0) >= 6;
}

function element(content: string, name: string): string | undefined {
	const match = new RegExp(`<${name}>\\s*(?<value>[^<]+?)\\s*</${name}>`).exec(content);
	return match?.groups?.value;
}
