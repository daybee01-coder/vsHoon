/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ClassSourceService } from './classSourceService';
import { CLASS_SOURCE_SCHEME } from './classSourceUri';
import { collectSourceSymbols, CONTROL_WORDS, definitionOwners, NavigationSource, resolveSourceDefinitions } from './javaSymbols';

class ClassDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
		return collectSourceSymbols(document.getText()).map(symbol => {
			const range = new vscode.Range(symbol.line, symbol.column, symbol.line, symbol.column + symbol.length);
			return new vscode.DocumentSymbol(
				symbol.name,
				symbol.detail,
				symbol.kind === 'type' ? vscode.SymbolKind.Class : symbol.kind === 'field' ? vscode.SymbolKind.Field : vscode.SymbolKind.Method,
				range,
				range
			);
		});
	}
}

class ClassDefinitionProvider implements vscode.DefinitionProvider {
	constructor(private readonly sourceService: ClassSourceService) { }

	async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[]> {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
		if (!range) {
			return [];
		}
		const word = document.getText(range);
		if (CONTROL_WORDS.has(word)) {
			return [];
		}
		const current: NavigationSource = { uri: document.uri.toString(), content: document.getText() };
		const offset = document.offsetAt(range.start);
		const owners = definitionOwners(current.content, offset, word);
		if (owners.length === 0) {
			return [];
		}
		const cached = await this.sourceService.getNavigationSources(document.uri, owners);
		const sources = [current, ...cached
			.filter(source => source.uri !== current.uri)
			.map(source => ({ uri: source.uri, content: source.content }))];
		return resolveSourceDefinitions(current, offset, word, sources).map(definition => new vscode.Location(
			vscode.Uri.parse(definition.uri),
			new vscode.Range(definition.line, definition.column, definition.line, definition.column + definition.length)
		));
	}
}

export function registerClassNavigation(context: vscode.ExtensionContext, sourceService: ClassSourceService): void {
	const selector: vscode.DocumentSelector = { scheme: CLASS_SOURCE_SCHEME, language: 'java' };
	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(selector, new ClassDocumentSymbolProvider()),
		vscode.languages.registerDefinitionProvider(selector, new ClassDefinitionProvider(sourceService))
	);
}
