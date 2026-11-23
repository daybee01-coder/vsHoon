/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { collectSourceSymbols, DefinitionLookup, maskNonCode, NavigationSource, resolveDefinitions, SourceDefinition, SourceSymbol } from './javaSymbols';

/** Package and imports of one Java source. */
export interface JavaImports {
	packageName: string;
	/** Simple name to fully qualified name of single-type imports. */
	explicit: ReadonlyMap<string, string>;
	wildcards: readonly string[];
}

interface IndexedSource extends NavigationSource, JavaImports { }

/** What the index keeps of one source, in a form that can be stored between sessions. */
export interface JavaStub {
	symbols: SourceSymbol[];
	packageName: string;
	explicit: [string, string][];
	wildcards: string[];
}

/** Parses the declarations and imports of a source; the body is not kept. */
export function javaStub(content: string): JavaStub {
	const imports = javaImports(content);
	return { symbols: collectSourceSymbols(content), packageName: imports.packageName, explicit: [...imports.explicit], wildcards: [...imports.wildcards] };
}

/** A source-only fallback index. Bodies are discarded after parsing; no JVM or classpath is needed. */
export class WorkspaceJavaIndex {
	private readonly sources = new Map<string, IndexedSource>();
	private readonly types = new Map<string, Set<string>>();
	private readonly methods = new Map<string, Set<string>>();

	update(uri: string, content: string): void {
		this.updateStub(uri, javaStub(content));
	}

	/** Adds a source from its parsed or stored declarations. */
	updateStub(uri: string, stub: JavaStub): void {
		this.delete(uri);
		const symbols = stub.symbols;
		this.sources.set(uri, { uri, content: '', symbols, packageName: stub.packageName, explicit: new Map(stub.explicit), wildcards: stub.wildcards });
		for (const symbol of symbols) {
			if (symbol.kind === 'type' || symbol.kind === 'method') {
				add(symbol.kind === 'type' ? this.types : this.methods, symbol.name, uri);
			}
		}
	}

	delete(uri: string): void {
		for (const symbol of this.sources.get(uri)?.symbols ?? []) {
			if (symbol.kind === 'type' || symbol.kind === 'method') {
				remove(symbol.kind === 'type' ? this.types : this.methods, symbol.name, uri);
			}
		}
		this.sources.delete(uri);
	}

	clear(): void {
		this.sources.clear();
		this.types.clear();
		this.methods.clear();
	}

	/**
	 * Resolves a reference in `current`, which takes precedence over its indexed copy.
	 * With `complete`, a receiver of unknown type may fall back to methods of the same name.
	 */
	resolve(current: NavigationSource, offset: number, word: string, complete = true): SourceDefinition[] {
		const currentImports = javaImports(current.content);
		const sourceOf = (uri: string): NavigationSource => uri === current.uri ? current : this.sources.get(uri)!;
		const lookup: DefinitionLookup = {
			complete,
			types: (name, from) => {
				const imports = from.uri === current.uri ? currentImports : this.sources.get(from.uri) ?? javaImports(from.content);
				const candidates = [...(this.types.get(name) ?? [])].map(uri => this.sources.get(uri)!);
				const explicit = imports.explicit.get(name);
				const samePackage = candidates.filter(source => source.packageName === imports.packageName);
				const visible = explicit
					? candidates.filter(source => `${source.packageName}.${name}` === explicit)
					: samePackage.length > 0 ? samePackage : candidates.filter(source => imports.wildcards.includes(source.packageName));
				const declaresHere = from.uri === current.uri && current.content.length > 0
					&& collectSourceSymbols(current.content).some(symbol => symbol.kind === 'type' && symbol.name === name);
				const uris = new Set(visible.map(source => source.uri));
				if (declaresHere) {
					uris.add(current.uri);
				}
				return [...uris].map(sourceOf);
			},
			methods: name => {
				const uris = new Set(this.methods.get(name) ?? []);
				if (collectSourceSymbols(current.content).some(symbol => symbol.kind === 'method' && symbol.name === name)) {
					uris.add(current.uri);
				}
				return [...uris].map(sourceOf);
			}
		};
		return resolveDefinitions(current, offset, word, lookup);
	}
}

function add(map: Map<string, Set<string>>, name: string, uri: string): void {
	let uris = map.get(name);
	if (!uris) {
		uris = new Set();
		map.set(name, uris);
	}
	uris.add(uri);
}

function remove(map: Map<string, Set<string>>, name: string, uri: string): void {
	const uris = map.get(name);
	uris?.delete(uri);
	if (uris?.size === 0) {
		map.delete(name);
	}
}

export function javaImports(content: string): JavaImports {
	const masked = maskNonCode(content);
	const explicit = new Map<string, string>();
	const wildcards: string[] = [];
	for (const match of masked.matchAll(/\bimport\s+(?!static\b)(?<name>[\w$]+(?:\s*\.\s*[\w$]+)*)(?<wildcard>\s*\.\s*\*)?\s*;/g)) {
		const name = match.groups!.name.replace(/\s+/g, '');
		if (match.groups!.wildcard) {
			wildcards.push(name);
		} else {
			explicit.set(name.slice(name.lastIndexOf('.') + 1), name);
		}
	}
	return { packageName: /\bpackage\s+(?<name>[\w.]+)\s*;/.exec(masked)?.groups?.name ?? '', explicit, wildcards };
}
