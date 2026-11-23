/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { SpringRunConfiguration } from './model';

/** Debug configuration property that ties a debug session back to its run configuration. */
export const CONFIGURATION_ID_PROPERTY = 'vshoonSpringConfigurationId';

/** How long the debugger keeps retrying to attach to a Maven-hosted server, in milliseconds. */
export const ATTACH_TIMEOUT_MS = 120_000;

/** The `java` debug configuration that launches a Spring Boot main class. */
export interface BootLaunchConfiguration {
	readonly type: 'java';
	readonly request: 'launch';
	readonly name: string;
	readonly mainClass: string;
	readonly projectName?: string;
	readonly cwd: string;
	readonly vmArgs: string;
	readonly args: string;
	readonly env: Readonly<Record<string, string>>;
	readonly javaExec?: string;
	readonly console: string;
	readonly [CONFIGURATION_ID_PROPERTY]: string;
}

/** The `java` debug configuration that attaches to the JDWP agent of a Maven-hosted server. */
export interface MavenAttachConfiguration {
	readonly type: 'java';
	readonly request: 'attach';
	readonly name: string;
	readonly hostName: string;
	readonly port: number;
	readonly timeout: number;
	readonly projectName?: string;
	readonly [CONFIGURATION_ID_PROPERTY]: string;
}

/** A Maven command line and the environment it needs. */
export interface MavenInvocation {
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export function createBootLaunchConfiguration(configuration: SpringRunConfiguration, projectDirectory: string, console: string, platform: NodeJS.Platform): BootLaunchConfiguration {
	const args = [configuration.args];
	if (configuration.profiles) {
		args.push(`--spring.profiles.active=${configuration.profiles}`);
	}
	if (configuration.port) {
		args.push(`--server.port=${configuration.port}`);
	}
	return {
		type: 'java',
		request: 'launch',
		name: configuration.name,
		mainClass: configuration.mainClass ?? '',
		...(configuration.projectName ? { projectName: configuration.projectName } : {}),
		cwd: projectDirectory,
		vmArgs: configuration.vmArgs,
		args: joinArguments(args),
		env: configuration.env,
		...(configuration.javaHome ? { javaExec: javaExecutable(configuration.javaHome, platform) } : {}),
		console,
		[CONFIGURATION_ID_PROPERTY]: configuration.id
	};
}

export function createMavenAttachConfiguration(configuration: SpringRunConfiguration, port: number): MavenAttachConfiguration {
	return {
		type: 'java',
		request: 'attach',
		name: configuration.name,
		hostName: '127.0.0.1',
		port,
		timeout: ATTACH_TIMEOUT_MS,
		...(configuration.projectName ? { projectName: configuration.projectName } : {}),
		[CONFIGURATION_ID_PROPERTY]: configuration.id
	};
}

/**
 * Builds the Maven command for a web application goal.
 *
 * Every JVM option goes into `MAVEN_OPTS` rather than onto the command line: the servlet container runs
 * inside the Maven JVM, so system properties reach it from there, and an environment variable is not
 * re-split by whichever shell runs the task. The port is offered under the user property names that the
 * common plugins read; a port written literally into the pom's plugin configuration still wins.
 */
export function createMavenInvocation(configuration: SpringRunConfiguration, inheritedMavenOptions: string | undefined, debugPort: number | undefined): MavenInvocation {
	const options = [inheritedMavenOptions ?? '', configuration.vmArgs];
	if (debugPort) {
		options.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${debugPort}`);
	}
	if (configuration.profiles) {
		options.push(`-Dspring.profiles.active=${configuration.profiles}`);
	}
	if (configuration.port) {
		options.push(...portProperties(configuration.goal ?? '').map(property => `-D${property}=${configuration.port}`));
	}
	const env: Record<string, string> = { ...configuration.env, MAVEN_OPTS: joinArguments(options) };
	if (configuration.javaHome) {
		env.JAVA_HOME = configuration.javaHome;
	}
	return {
		args: [...splitArguments(configuration.goal ?? ''), ...splitArguments(configuration.args)],
		env
	};
}

/**
 * Splits a command line the way users type it: on whitespace, keeping double quoted runs together.
 * Quotes are removed; there is no escape character, so Windows paths keep their backslashes.
 */
export function splitArguments(commandLine: string): string[] {
	const result: string[] = [];
	for (const match of commandLine.matchAll(/(?:"[^"]*"|[^\s"]+)+/g)) {
		result.push(match[0].replace(/"/g, ''));
	}
	return result;
}

/** The `java` launcher inside a JDK home. */
export function javaExecutable(javaHome: string, platform: NodeJS.Platform): string {
	return platform === 'win32' ? path.win32.join(javaHome, 'bin', 'java.exe') : path.posix.join(javaHome, 'bin', 'java');
}

function portProperties(goal: string): string[] {
	if (goal.includes('jetty')) {
		// `jetty.http.port` for Jetty 9 and later, `jetty.port` for the older plugins.
		return ['jetty.http.port', 'jetty.port'];
	}
	if (goal.includes('tomcat')) {
		return ['maven.tomcat.port'];
	}
	if (goal.includes('cargo')) {
		return ['cargo.servlet.port'];
	}
	return [];
}

function joinArguments(parts: readonly string[]): string {
	return parts.map(part => part.trim()).filter(part => part).join(' ');
}
