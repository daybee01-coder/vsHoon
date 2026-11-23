/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/**
 * Run configuration form. The extension owns validation and storage; this script only shows the fields
 * that apply to the chosen kind and offers the projects and main classes discovery found.
 */
(function () {
	// @ts-ignore acquireVsCodeApi is injected by the webview host.
	const vscode = acquireVsCodeApi();
	// @ts-ignore set by the inline script of the page.
	const text = window.SPRING_FORM_TEXT;

	const $ = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
	const fields = ['name', 'project', 'mainClass', 'goal', 'profiles', 'port', 'vmArgs', 'args', 'env', 'javaHome'];

	/** @type {{ project: string, label: string, projectName?: string, springBoot: boolean, serverGoal?: string, mainClasses: string[] }[]} */
	let projects = [];
	let initialProject = '';
	let initialProjectName = '';

	function kind() {
		const checked = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="kind"]:checked'));
		return checked ? checked.value : 'boot';
	}

	function selectedProject() {
		const value = $('project').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		return projects.find(project => project.project === value);
	}

	function update() {
		const boot = kind() === 'boot';
		$('row-main').hidden = !boot;
		$('row-goal').hidden = boot;
		$('args-label').textContent = boot ? text.bootArgs : text.mavenArgs;
		$('port-hint').textContent = boot ? text.bootPort : text.mavenPort;

		const list = /** @type {HTMLDataListElement} */ (document.getElementById('main-list'));
		list.replaceChildren();
		const project = selectedProject();
		const classes = project ? project.mainClasses : projects.flatMap(candidate => candidate.mainClasses);
		for (const mainClass of classes) {
			const option = document.createElement('option');
			option.value = mainClass;
			list.appendChild(option);
		}
	}

	function fillProjects() {
		const list = /** @type {HTMLDataListElement} */ (document.getElementById('project-list'));
		list.replaceChildren();
		for (const project of projects) {
			const option = document.createElement('option');
			option.value = project.project;
			option.label = project.projectName ? `${project.label} (${project.projectName})` : project.label;
			list.appendChild(option);
		}
		update();
	}

	function values() {
		/** @type {Record<string, string>} */
		const result = { kind: kind() };
		for (const field of fields) {
			result[field] = $(field).value;
		}
		const project = selectedProject();
		result.projectName = project && project.projectName
			? project.projectName
			: result.project.trim() === initialProject ? initialProjectName : '';
		return result;
	}

	/** Picks sensible defaults when the user switches the project of a fresh configuration. */
	function onProjectChanged() {
		const project = selectedProject();
		if (project) {
			if (kind() === 'boot' && !$('mainClass').value && project.mainClasses.length === 1) {
				$('mainClass').value = project.mainClasses[0];
			}
			if (kind() === 'maven' && !$('goal').value && project.serverGoal) {
				$('goal').value = project.serverGoal;
			}
		}
		update();
	}

	function setStatus(/** @type {string} */ message) {
		$('status').textContent = message;
		$('status').classList.toggle('error', !!message);
	}

	window.addEventListener('message', event => {
		const message = event.data;
		switch (message.type) {
			case 'init':
				for (const field of fields) {
					$(field).value = message.values[field] || '';
				}
				for (const radio of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="kind"]'))) {
					radio.checked = radio.value === message.values.kind;
				}
				initialProject = message.values.project || '';
				initialProjectName = message.values.projectName || '';
				update();
				$('name').focus();
				$('name').select();
				break;
			case 'projects':
				projects = message.projects;
				fillProjects();
				break;
			case 'javaHome':
				$('javaHome').value = message.path;
				break;
			case 'status':
				setStatus(message.message);
				break;
		}
	});

	for (const radio of document.querySelectorAll('input[name="kind"]')) {
		radio.addEventListener('change', onProjectChanged);
	}
	$('project').addEventListener('change', onProjectChanged);
	$('browse').addEventListener('click', () => vscode.postMessage({ type: 'browseJavaHome' }));
	$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
	document.getElementById('form')?.addEventListener('submit', event => {
		event.preventDefault();
		setStatus('');
		vscode.postMessage({ type: 'save', values: values() });
	});
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			vscode.postMessage({ type: 'cancel' });
		}
	});

	vscode.postMessage({ type: 'ready' });
}());
