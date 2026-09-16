/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ClassFamilyEntry {
	name: string;
	bytes: Uint8Array;
}

export interface MaterializedClass {
	filePath: string;
	/** The outer/inner class bytes written for CFR, absent when the class is already on disk. */
	family?: readonly ClassFamilyEntry[];
	dispose(): void;
}

/** Materializes only the selected virtual class and its outer/inner class family for CFR. */
export async function materializeClass(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<MaterializedClass> {
	if (uri.scheme === 'file') {
		return { filePath: uri.fsPath, dispose: () => { } };
	}

	const fileName = path.posix.basename(uri.path);
	if (!fileName.toLowerCase().endsWith('.class')) {
		throw new Error(vscode.l10n.t('Decom: Class 파일이 아닙니다.'));
	}
	const classStem = fileName.slice(0, -'.class'.length);
	const outerStem = classStem.split('$', 1)[0];
	const parentUri = uri.with({ path: path.posix.dirname(uri.path) });
	const entries = await vscode.workspace.fs.readDirectory(parentUri);
	const family = entries
		.filter(([name, type]) => type === vscode.FileType.File && (name === `${outerStem}.class` || (name.startsWith(`${outerStem}$`) && name.endsWith('.class'))))
		.map(([name]) => name)
		.sort();
	// An obfuscated archive can carry `a$b.class` without `a.class`; decompile what is really there.
	const target = family.includes(fileName) ? fileName : family[0];
	if (!target) {
		throw new Error(vscode.l10n.t('Decom: Class 파일을 찾을 수 없습니다.'));
	}

	const parent = path.join(context.globalStorageUri.fsPath, 'class-input');
	fs.mkdirSync(parent, { recursive: true });
	const temporaryDirectory = fs.mkdtempSync(path.join(parent, 'decompile-'));
	try {
		const written: ClassFamilyEntry[] = [];
		for (const name of family) {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(parentUri, name));
			fs.writeFileSync(path.join(temporaryDirectory, name), bytes);
			written.push({ name, bytes });
		}
		return {
			filePath: path.join(temporaryDirectory, target),
			family: written,
			dispose: () => fs.rmSync(temporaryDirectory, { recursive: true, force: true })
		};
	} catch (error) {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
		throw error;
	}
}
