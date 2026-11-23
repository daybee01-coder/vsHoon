/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How a configuration is started.
 * - `boot`: the `@SpringBootApplication` main class is launched by the Java debugger.
 * - `maven`: a Maven goal such as `jetty:run` hosts the web application inside the Maven JVM.
 */
export type SpringConfigurationKind = 'boot' | 'maven';

/** A run configuration, as stored in `.vscode/vshoon-spring.json`. */
export interface SpringRunConfiguration {
	readonly id: string;
	readonly name: string;
	readonly kind: SpringConfigurationKind;
	/** Folder holding the `pom.xml`, relative to the workspace folder with `/` separators. `''` is the folder itself. */
	readonly project: string;
	/** Maven artifactId; the Java language server names its project after it. */
	readonly projectName?: string;
	/** Fully qualified main class. Boot only. */
	readonly mainClass?: string;
	/** Maven goals, for example `jetty:run`. Maven only. */
	readonly goal?: string;
	/** Comma separated Spring profiles. */
	readonly profiles: string;
	/** JVM options. For Maven they go to `MAVEN_OPTS`, because the server runs inside the Maven JVM. */
	readonly vmArgs: string;
	/** Program arguments for Boot, extra Maven arguments (for example `-Pdev`) for Maven. */
	readonly args: string;
	readonly env: Readonly<Record<string, string>>;
	/** HTTP port override. */
	readonly port?: number;
	/** JDK home. Empty uses the Java extension's or Maven's default. */
	readonly javaHome?: string;
}

/** The file format of `.vscode/vshoon-spring.json`. */
export interface SpringConfigurationFile {
	readonly version: 1;
	readonly configurations: readonly SpringRunConfiguration[];
}

export const CONFIGURATION_FILE_VERSION = 1;

/** Maven goals offered for web applications, keyed by the plugin artifactId that provides them. */
export const MAVEN_SERVER_GOALS: Readonly<Record<string, string>> = {
	'jetty-maven-plugin': 'jetty:run',
	'maven-jetty-plugin': 'jetty:run',
	'tomcat7-maven-plugin': 'tomcat7:run',
	'tomcat-maven-plugin': 'tomcat:run',
	'cargo-maven3-plugin': 'cargo:run',
	'cargo-maven2-plugin': 'cargo:run'
};

/**
 * Goals for a WAR whose pom declares no servlet container plugin. A fully qualified goal needs no plugin
 * entry and no plugin group in `settings.xml`, so the project runs as it is.
 * - javax (Spring 5 and earlier): Jetty 9.4, Servlet 3.1, runs on Java 8 and later.
 * - jakarta (Spring 6): Jetty 12 EE10, Servlet 6.0, needs Java 17 like Spring 6 itself.
 */
export const DEFAULT_SERVER_GOALS: Readonly<Record<ServletApi, string>> = {
	javax: 'org.eclipse.jetty:jetty-maven-plugin:9.4.57.v20241219:run',
	jakarta: 'org.eclipse.jetty.ee10:jetty-ee10-maven-plugin:12.0.25:run'
};

/** The servlet API namespace a web application is written against. */
export type ServletApi = 'javax' | 'jakarta';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const MAX_TEXT_LENGTH = 8192;

/**
 * Validates one configuration read from disk or sent by the configuration form.
 * The file is checked into repositories and edited by hand, so nothing about its shape is trusted.
 */
export function normalizeConfiguration(raw: unknown): SpringRunConfiguration | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const id = text(value.id);
	const name = text(value.name).trim();
	const kind = value.kind === 'boot' || value.kind === 'maven' ? value.kind : undefined;
	if (!id || !name || !kind) {
		return undefined;
	}
	const mainClass = text(value.mainClass).trim();
	const goal = text(value.goal).trim();
	if (kind === 'boot' && !mainClass) {
		return undefined;
	}
	if (kind === 'maven' && !goal) {
		return undefined;
	}
	const port = typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port < 65536 ? value.port : undefined;
	const projectName = text(value.projectName).trim();
	const javaHome = text(value.javaHome).trim();
	return {
		id,
		name,
		kind,
		project: normalizeProjectPath(text(value.project)),
		...(projectName ? { projectName } : {}),
		...(kind === 'boot' ? { mainClass } : { goal }),
		profiles: text(value.profiles).trim(),
		vmArgs: text(value.vmArgs).trim(),
		args: text(value.args).trim(),
		env: normalizeEnvironment(value.env),
		...(port ? { port } : {}),
		...(javaHome ? { javaHome } : {})
	};
}

/** Reads the configuration file contents, dropping entries that are malformed or reuse an id. */
export function parseConfigurationFile(content: string): SpringRunConfiguration[] {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return [];
	}
	const list = raw && typeof raw === 'object' ? (raw as { configurations?: unknown }).configurations : undefined;
	if (!Array.isArray(list)) {
		return [];
	}
	const seen = new Set<string>();
	const result: SpringRunConfiguration[] = [];
	for (const entry of list) {
		const configuration = normalizeConfiguration(entry);
		if (configuration && !seen.has(configuration.id)) {
			seen.add(configuration.id);
			result.push(configuration);
		}
	}
	return result;
}

export function serializeConfigurationFile(configurations: readonly SpringRunConfiguration[]): string {
	const file: SpringConfigurationFile = { version: CONFIGURATION_FILE_VERSION, configurations };
	return JSON.stringify(file, undefined, '\t') + '\n';
}

/** Parses `KEY=VALUE` lines. Blank lines and `#` comments are ignored. */
export function parseEnvironment(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const separator = trimmed.indexOf('=');
		if (separator <= 0) {
			continue;
		}
		const key = trimmed.slice(0, separator).trim();
		if (ENVIRONMENT_NAME.test(key)) {
			result[key] = trimmed.slice(separator + 1).trim();
		}
	}
	return result;
}

export function formatEnvironment(env: Readonly<Record<string, string>>): string {
	return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
}

/**
 * A short name for a Maven goal: `org.eclipse.jetty:jetty-maven-plugin:9.4.57:run` reads as `jetty:run`,
 * the way Maven's own plugin prefixes are written.
 */
export function goalLabel(goal: string): string {
	return goal.split(/\s+/).filter(part => part).map(part => {
		const segments = part.split(':');
		if (segments.length < 3) {
			return part;
		}
		const prefix = segments[1].replace(/^maven-(?<name>.+)-plugin$/, '$<name>').replace(/-maven-plugin$/, '').replace(/^jetty-ee\d+$/, 'jetty');
		return `${prefix}:${segments[segments.length - 1]}`;
	}).join(' ');
}

/** Turns a `src/main/java` file path into its class name, or `undefined` when it is outside a source root. */
export function classNameFromSourcePath(relativePath: string): string | undefined {
	const match = /(?:^|\/)src\/main\/java\/(?<path>.+)\.java$/.exec(relativePath.replace(/\\/g, '/'));
	return match?.groups ? match.groups.path.split('/').join('.') : undefined;
}

function normalizeEnvironment(raw: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (ENVIRONMENT_NAME.test(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
				result[key] = String(value).slice(0, MAX_TEXT_LENGTH);
			}
		}
	}
	return result;
}

function normalizeProjectPath(value: string): string {
	const parts = value.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
	// The project must stay inside its workspace folder.
	return parts.includes('..') ? '' : parts.join('/');
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : '';
}
