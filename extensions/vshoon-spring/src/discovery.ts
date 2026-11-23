/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { classNameFromSourcePath, DEFAULT_SERVER_GOALS, goalLabel, SpringRunConfiguration } from './model';
import { isSpringBootApplicationSource, parsePom, PomSummary } from './pom';

const EXCLUDE = '**/{node_modules,target,.git}/**';
const MAX_POMS = 200;
const MAX_SOURCES = 5000;
/** A main class annotation sits near the top of its file; reading further only costs time. */
const SOURCE_PREFIX_BYTES = 64 * 1024;

/** One Maven project inside a workspace folder. */
export interface MavenProject {
	readonly folder: vscode.WorkspaceFolder;
	/** Directory holding the pom, relative to the workspace folder. */
	readonly project: string;
	readonly directory: vscode.Uri;
	readonly pom: PomSummary;
}

/** Finds every Maven project of a workspace folder. */
export async function findMavenProjects(folder: vscode.WorkspaceFolder, token?: vscode.CancellationToken): Promise<MavenProject[]> {
	const poms = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/pom.xml'), EXCLUDE, MAX_POMS, token);
	const projects = await Promise.all(poms.map(async uri => {
		const directory = vscode.Uri.joinPath(uri, '..');
		const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		return {
			folder,
			project: relativePath(folder.uri, directory),
			directory,
			pom: parsePom(content)
		};
	}));
	return projects.sort((a, b) => a.project.localeCompare(b.project));
}

/** Finds the `@SpringBootApplication` main classes of a Maven project. */
export async function findMainClasses(project: MavenProject, token?: vscode.CancellationToken): Promise<string[]> {
	const root = new vscode.RelativePattern(project.directory, 'src/main/java/**/*.java');
	// Spring Initializr names the entry point `*Application`; look there first and fall back to every source.
	const likely = await vscode.workspace.findFiles(new vscode.RelativePattern(project.directory, 'src/main/java/**/*Application.java'), EXCLUDE, MAX_SOURCES, token);
	let found = await mainClassesIn(project, likely);
	if (found.length === 0 && !token?.isCancellationRequested) {
		found = await mainClassesIn(project, await vscode.workspace.findFiles(root, EXCLUDE, MAX_SOURCES, token));
	}
	return found.sort();
}

/**
 * The goal that serves a web application: its own servlet container plugin, else Jetty matching its servlet
 * namespace. `undefined` for projects that are not web applications.
 */
export function serverGoalFor(project: MavenProject): string | undefined {
	if (project.pom.serverGoal) {
		return project.pom.serverGoal;
	}
	if (project.pom.packaging !== 'war') {
		return undefined;
	}
	const configured = vscode.workspace.getConfiguration('vshoon.spring', project.folder)
		.get<string>(project.pom.servletApi === 'jakarta' ? 'maven.jakartaServerGoal' : 'maven.javaxServerGoal', '').trim();
	return configured || DEFAULT_SERVER_GOALS[project.pom.servletApi];
}

/** Builds one run configuration for every Spring Boot main class and every web application (WAR or server plugin). */
export async function discoverConfigurations(folder: vscode.WorkspaceFolder, token?: vscode.CancellationToken): Promise<SpringRunConfiguration[]> {
	const result: SpringRunConfiguration[] = [];
	for (const project of await findMavenProjects(folder, token)) {
		if (token?.isCancellationRequested) {
			break;
		}
		const common = {
			project: project.project,
			...(project.pom.artifactId ? { projectName: project.pom.artifactId } : {}),
			profiles: '',
			vmArgs: '',
			args: '',
			env: {}
		};
		if (project.pom.springBoot) {
			for (const mainClass of await findMainClasses(project, token)) {
				result.push({ ...common, id: randomUUID(), name: mainClass.slice(mainClass.lastIndexOf('.') + 1), kind: 'boot', mainClass });
			}
		} else {
			const goal = serverGoalFor(project);
			if (goal) {
				const name = project.pom.artifactId ?? (project.project || folder.name);
				result.push({ ...common, id: randomUUID(), name: `${name} [${goalLabel(goal)}]`, kind: 'maven', goal });
			}
		}
	}
	return result;
}

/** The directory of a configuration's project. */
export function projectDirectory(folder: vscode.WorkspaceFolder, configuration: SpringRunConfiguration): vscode.Uri {
	return configuration.project ? vscode.Uri.joinPath(folder.uri, ...configuration.project.split('/')) : folder.uri;
}

async function mainClassesIn(project: MavenProject, sources: readonly vscode.Uri[]): Promise<string[]> {
	const result: string[] = [];
	await Promise.all(sources.map(async uri => {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const content = Buffer.from(bytes.subarray(0, SOURCE_PREFIX_BYTES)).toString('utf8');
		const className = classNameFromSourcePath(relativePath(project.directory, uri));
		if (className && isSpringBootApplicationSource(content)) {
			result.push(className);
		}
	}));
	return result;
}

function relativePath(from: vscode.Uri, to: vscode.Uri): string {
	const base = from.path.endsWith('/') ? from.path : `${from.path}/`;
	return to.path.startsWith(base) ? to.path.slice(base.length) : '';
}
