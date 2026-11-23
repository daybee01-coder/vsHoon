/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'synchronized']);
/** Words that can precede an identifier without being its declared type. */
const NOT_TYPES = new Set([...CONTROL_WORDS, 'class', 'interface', 'enum', 'record', 'extends', 'implements', 'import', 'package', 'else', 'case', 'throws', 'assert', 'do', 'try', 'finally', 'yield', 'default', 'instanceof', 'goto', 'break', 'continue', 'this', 'super',
	'public', 'protected', 'private', 'static', 'final', 'abstract', 'transient', 'volatile', 'native', 'strictfp', 'void']);
const PRIMITIVE_TYPES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);
const TYPE_PATTERN = /\b(?<keyword>class|interface|enum|record)\s+(?<name>[A-Za-z_$][\w$]*)/g;
const METHOD_PATTERN = /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default)\s+)*(?:<[^>{}]+>\s+)?(?:[\w$.[\]<>?,]+\s+)+(?<name>[A-Za-z_$][\w$]*)\s*\((?<parameters>(?:[^()]|\([^()]*\))*)\)\s*(?:throws\s+[^{};]+)?(?:\{|;|$)/;
const CONSTRUCTOR_PATTERN = /^\s*(?:(?:public|protected|private)\s+)?(?<name>[A-Za-z_$][\w$]*)\s*\((?<parameters>[^)]*)\)\s*(?:throws\s+[^{};]+)?(?:\{|;|$)/;
const FIELD_PATTERN = /^\s*(?:(?:public|protected|private|static|final|transient|volatile)\s+)*(?<type>[A-Za-z_$][\w$.]*(?:\s*<(?:[^<>;{}()]|<[^<>;{}()]*>)*>)?(?:\s*\[\s*\])*)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?:\[\s*\]\s*)*(?=[=;,])/;
/** Unknown receivers fall back to methods with the same name only while the result stays reviewable. */
const MAXIMUM_NAME_FALLBACK = 20;
const MAXIMUM_HIERARCHY_DEPTH = 12;

interface TypeRange {
	name: string;
	keyword: string;
	superName: string | undefined;
	supers: string[];
	start: number;
	end: number;
	opening: number;
	nameStart: number;
}

type Receiver =
	| { kind: 'implicit' | 'this' | 'super' | 'expression' }
	| { kind: 'identifier'; name: string };

interface Reference {
	kind: 'call' | 'constructor' | 'member' | 'name';
	name: string;
	offset: number;
	receiver: Receiver;
	arguments: string[];
}

export interface SourceSymbol {
	name: string;
	kind: 'type' | 'method' | 'field';
	line: number;
	column: number;
	length: number;
	detail: string;
	owner?: string;
	parameterTypes?: string[];
	variadic?: boolean;
	/** Direct supertypes of a type: the superclass and implemented or extended interfaces. */
	supers?: string[];
	/** Declared type of a field, used to follow `field.member` references. */
	valueType?: string;
}

export interface NavigationSource {
	uri: string;
	content: string;
	symbols?: readonly SourceSymbol[];
}

export interface SourceDefinition {
	uri: string;
	line: number;
	column: number;
	length: number;
}

/** Finds the sources a reference may resolve to. Implementations decide which types are visible. */
export interface DefinitionLookup {
	/** Sources visible from `from` that declare a type with this simple name. */
	types(name: string, from: NavigationSource): readonly NavigationSource[];
	/** Sources declaring a method with this name, for receivers whose type cannot be inferred. */
	methods(name: string): readonly NavigationSource[];
	/**
	 * True when every candidate source is available. Name-based guesses for unknown receivers are
	 * made only then, so a partial index cannot hide the precise declaration behind a guess.
	 */
	readonly complete: boolean;
}

/** Remembers the last value per key. Navigation analyses the same document several times per request. */
class LastValue<T> {
	private key: string | undefined;
	private value: T | undefined;

	get(key: string, compute: () => T): T {
		if (this.key !== key || this.value === undefined) {
			this.value = compute();
			this.key = key;
		}
		return this.value;
	}
}

const maskedSources = new LastValue<string>();
const typeRanges = new LastValue<TypeRange[]>();
const braceDepths = new LastValue<Int32Array>();
const symbolCache = new Map<string, SourceSymbol[]>();
const SYMBOL_CACHE_SIZE = 16;

export function maskNonCode(source: string): string {
	return maskedSources.get(source, () => computeMask(source));
}

function computeMask(source: string): string {
	const result = source.split('');
	let state: 'code' | 'lineComment' | 'blockComment' | 'string' | 'character' = 'code';
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		const current = source[index];
		const next = source[index + 1];
		if (state === 'code') {
			if (current === '/' && next === '/') {
				result[index] = result[index + 1] = ' ';
				state = 'lineComment';
				index++;
			} else if (current === '/' && next === '*') {
				result[index] = result[index + 1] = ' ';
				state = 'blockComment';
				index++;
			} else if (current === '"') {
				result[index] = ' ';
				state = 'string';
			} else if (current === '\'') {
				result[index] = ' ';
				state = 'character';
			}
			continue;
		}
		if (current !== '\r' && current !== '\n') {
			result[index] = ' ';
		}
		if (state === 'lineComment' && (current === '\r' || current === '\n')) {
			state = 'code';
		} else if (state === 'blockComment' && current === '*' && next === '/') {
			result[index + 1] = ' ';
			state = 'code';
			index++;
		} else if (state === 'string' || state === 'character') {
			if (escaped) {
				escaped = false;
			} else if (current === '\\') {
				escaped = true;
			} else if ((state === 'string' && current === '"') || (state === 'character' && current === '\'')) {
				state = 'code';
			}
		}
	}
	return result.join('');
}

function findClosing(text: string, openingOffset: number, opening: string, closing: string): number {
	let depth = 0;
	for (let offset = openingOffset; offset < text.length; offset++) {
		if (text[offset] === opening) {
			depth++;
		} else if (text[offset] === closing && --depth === 0) {
			return offset;
		}
	}
	return -1;
}

/** depths[offset] is the curly brace depth before the character at offset. */
function depthsOf(masked: string): Int32Array {
	return braceDepths.get(masked, () => {
		const depths = new Int32Array(masked.length + 1);
		for (let offset = 0; offset < masked.length; offset++) {
			depths[offset + 1] = depths[offset] + (masked[offset] === '{' ? 1 : masked[offset] === '}' ? -1 : 0);
		}
		return depths;
	});
}

function typeList(text: string | undefined): string[] {
	return text ? splitCommaSeparated(text, true).map(simpleType).filter(type => /^[A-Za-z_$][\w$]*$/.test(type)) : [];
}

function collectTypeRanges(masked: string): TypeRange[] {
	return typeRanges.get(masked, () => {
		const result: TypeRange[] = [];
		const pattern = new RegExp(TYPE_PATTERN.source, 'g');
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(masked)) !== null) {
			const opening = masked.indexOf('{', pattern.lastIndex);
			if (opening < 0) {
				continue;
			}
			const terminator = masked.indexOf(';', pattern.lastIndex);
			if (terminator >= 0 && terminator < opening) {
				continue;
			}
			const name = match.groups!.name;
			const keyword = match.groups!.keyword;
			// Type parameters may contain `extends`; erase them before reading the supertypes.
			const header = eraseGenerics(masked.slice(pattern.lastIndex, opening));
			const extended = typeList(/\bextends\s+(?<types>[^{]*?)(?=\bimplements\b|\bpermits\b|$)/.exec(header)?.groups?.types);
			const implemented = typeList(/\bimplements\s+(?<types>[^{]*?)(?=\bpermits\b|$)/.exec(header)?.groups?.types);
			const closing = findClosing(masked, opening, '{', '}');
			result.push({
				name,
				keyword,
				superName: keyword === 'class' ? extended[0] : undefined,
				supers: [...extended, ...implemented],
				start: match.index,
				end: closing < 0 ? masked.length : closing + 1,
				opening,
				nameStart: match.index + match[0].lastIndexOf(name)
			});
		}
		return result;
	});
}

/** Enclosing types at offset, innermost first. */
function typesAt(types: readonly TypeRange[], offset: number): TypeRange[] {
	return types
		.filter(type => type.start <= offset && offset < type.end)
		.sort((left, right) => right.start - left.start);
}

function ownerAt(types: readonly TypeRange[], offset: number): TypeRange | undefined {
	return typesAt(types, offset)[0];
}

function lineStarts(source: string): number[] {
	const result = [0];
	for (let offset = 0; offset < source.length; offset++) {
		if (source[offset] === '\r') {
			if (source[offset + 1] === '\n') {
				offset++;
			}
			result.push(offset + 1);
		} else if (source[offset] === '\n') {
			result.push(offset + 1);
		}
	}
	return result;
}

function splitCommaSeparated(text: string, trackAngles: boolean): string[] {
	if (!text.trim()) {
		return [];
	}
	const result: string[] = [];
	let start = 0;
	let round = 0;
	let square = 0;
	let curly = 0;
	let angle = 0;
	let quote: '"' | '\'' | undefined;
	let escaped = false;
	for (let offset = 0; offset < text.length; offset++) {
		const current = text[offset];
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (current === '\\') {
				escaped = true;
			} else if (current === quote) {
				quote = undefined;
			}
			continue;
		}
		if (current === '"' || current === '\'') {
			quote = current;
		} else if (current === '(') {
			round++;
		} else if (current === ')') {
			round--;
		} else if (current === '[') {
			square++;
		} else if (current === ']') {
			square--;
		} else if (current === '{') {
			curly++;
		} else if (current === '}') {
			curly--;
		} else if (trackAngles && current === '<') {
			angle++;
		} else if (trackAngles && current === '>') {
			angle = Math.max(0, angle - 1);
		} else if (current === ',' && round === 0 && square === 0 && curly === 0 && angle === 0) {
			result.push(text.slice(start, offset).trim());
			start = offset + 1;
		}
	}
	result.push(text.slice(start).trim());
	return result;
}

/** Offsets of the commas outside brackets in masked code, up to `end`. */
function topLevelCommas(masked: string, start: number, end: number): number[] {
	const result: number[] = [];
	let depth = 0;
	for (let offset = start; offset < end; offset++) {
		const current = masked[offset];
		if (current === '(' || current === '[' || current === '{') {
			depth++;
		} else if (current === ')' || current === ']' || current === '}') {
			depth--;
		} else if (current === ',' && depth === 0) {
			result.push(offset);
		}
	}
	return result;
}

function eraseGenerics(type: string): string {
	let previous: string;
	do {
		previous = type;
		type = type.replace(/<[^<>]*>/g, '');
	} while (type !== previous);
	return type;
}

function simpleType(type: string): string {
	const array = type.includes('[]') || type.includes('...') ? '[]' : '';
	const normalized = eraseGenerics(type)
		.replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?/g, '')
		.replace(/\b(?:final|volatile|transient|extends|super)\b/g, '')
		.replace(/[?\s]/g, '')
		.replace(/\.\.\./g, '')
		.replace(/\[\]/g, '');
	return `${normalized.split('.').pop() ?? normalized}${array}`;
}

function parameterType(parameter: string): { type: string; variadic: boolean } {
	const variadic = parameter.includes('...');
	const withoutAnnotations = parameter
		.replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, '')
		.replace(/\bfinal\b\s*/g, '')
		.trim();
	const name = /([A-Za-z_$][\w$]*)\s*(\[\s*\])?\s*$/.exec(withoutAnnotations);
	let type = name ? withoutAnnotations.slice(0, name.index).trim() : withoutAnnotations;
	if (name?.[2]) {
		type += '[]';
	}
	return { type: simpleType(type), variadic };
}

export function collectSourceSymbols(source: string): SourceSymbol[] {
	const cached = symbolCache.get(source);
	if (cached) {
		symbolCache.delete(source);
		symbolCache.set(source, cached);
		return cached;
	}
	const result = computeSourceSymbols(source);
	symbolCache.set(source, result);
	if (symbolCache.size > SYMBOL_CACHE_SIZE) {
		symbolCache.delete(symbolCache.keys().next().value!);
	}
	return result;
}

function computeSourceSymbols(source: string): SourceSymbol[] {
	const result: SourceSymbol[] = [];
	const masked = maskNonCode(source);
	const types = collectTypeRanges(masked);
	const starts = lineStarts(source);
	const position = (offset: number) => {
		const line = starts.findLastIndex(start => start <= offset);
		return { line, column: offset - starts[line] };
	};
	const depths = depthsOf(masked);
	const addField = (name: string, offset: number, owner: TypeRange, valueType: string | undefined) => {
		result.push({ name, kind: 'field', ...position(offset), length: name.length, detail: valueType ?? '', owner: owner.name, valueType });
	};
	for (const type of types) {
		result.push({ name: type.name, kind: 'type', ...position(type.nameStart), length: type.name.length, detail: '', owner: type.name, supers: type.supers });
		if (type.keyword === 'enum') {
			// Enum constants come first in the body and end at the first `;` of the body.
			const bodyDepth = depths[type.opening] + 1;
			let end = type.opening + 1;
			while (end < type.end - 1 && !(masked[end] === ';' && depths[end] === bodyDepth) && !(masked[end] === '}' && depths[end] === bodyDepth)) {
				end++;
			}
			let segmentStart = type.opening + 1;
			for (const comma of [...topLevelCommas(masked, type.opening + 1, end), end]) {
				const segment = masked.slice(segmentStart, comma).replace(/^(?:\s*@[\w$.]+(?:\s*\([^)]*\))?)+/, match => ' '.repeat(match.length));
				const constant = /^\s*(?<name>[A-Za-z_$][\w$]*)/.exec(segment);
				if (constant) {
					addField(constant.groups!.name, segmentStart + constant[0].length - constant.groups!.name.length, type, type.name);
				}
				segmentStart = comma + 1;
			}
		}
	}
	// A member starts at a type-body delimiter. This also handles annotations, multiline
	// signatures and several members on one line without mistaking calls inside methods for declarations.
	const boundaries = /(?:^|[;{}])/g;
	let boundary: RegExpExecArray | null;
	while ((boundary = boundaries.exec(masked)) !== null) {
		const start = boundary.index + boundary[0].length;
		if (boundary[0].length === 0) {
			boundaries.lastIndex++;
		}
		const owner = ownerAt(types, start);
		if (!owner || depths[start] !== depths[owner.opening] + 1) {
			continue;
		}
		const declaration = masked.slice(start, owner.end).replace(/^(?:\s*@[\w$.]+(?:\s*\([^)]*\))?)+/, match => ' '.repeat(match.length));
		const method = METHOD_PATTERN.exec(declaration);
		const constructor = method ? undefined : CONSTRUCTOR_PATTERN.exec(declaration);
		const match = method ?? (constructor?.groups?.name === owner.name ? constructor : undefined);
		const name = match?.groups?.name;
		if (!match || !name) {
			const field = FIELD_PATTERN.exec(declaration);
			const fieldType = field?.groups?.type;
			if (field && fieldType && !NOT_TYPES.has(fieldType)) {
				const nameOffset = start + field[0].length - field.groups!.name.length;
				const valueType = simpleType(fieldType).replace(/\[\]$/, '');
				addField(field.groups!.name, nameOffset, owner, valueType);
				// Further declarators of the same statement: `int first, second = 2;`
				const semicolon = masked.indexOf(';', nameOffset);
				for (const comma of topLevelCommas(masked, nameOffset, semicolon < 0 ? owner.end : semicolon)) {
					const next = /^\s*(?<name>[A-Za-z_$][\w$]*)/.exec(masked.slice(comma + 1, comma + 200));
					if (next) {
						addField(next.groups!.name, comma + 1 + next[0].length - next.groups!.name.length, owner, valueType);
					}
				}
			}
			continue;
		}
		if (CONTROL_WORDS.has(name)) {
			continue;
		}
		const nameInMatch = match[0].lastIndexOf(name, match[0].indexOf('('));
		const offset = start + match.index + nameInMatch;
		const parameters = splitCommaSeparated(match.groups?.parameters ?? '', true).map(parameterType);
		result.push({
			name,
			kind: 'method',
			...position(offset),
			length: name.length,
			detail: `(${match.groups?.parameters?.trim() ?? ''})`,
			owner: owner.name,
			parameterTypes: parameters.map(parameter => parameter.type),
			variadic: parameters.at(-1)?.variadic ?? false
		});
	}
	return result;
}

function declarationPattern(variable: string): RegExp {
	const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\b([A-Za-z_$][\\w$.]*(?:\\s*<[^;={}()]+>)?(?:\\s*\\[\\s*\\])?)\\s+${escaped}\\b(?!\\s*\\()`, 'g');
}

function inferVariableType(source: string, variable: string, beforeOffset: number): string | undefined {
	if (variable === 'this') {
		return undefined;
	}
	const masked = maskNonCode(source);
	const prefix = masked.slice(0, beforeOffset);
	const pattern = declarationPattern(variable);
	let match: RegExpExecArray | null;
	let type: string | undefined;
	while ((match = pattern.exec(prefix)) !== null) {
		if (!NOT_TYPES.has(match[1])) {
			type = simpleType(match[1]);
		}
	}
	if (!type) {
		// Fields can be declared after the method that uses them. Only consider direct
		// members of the enclosing type, never a later method's local variables.
		const owner = ownerAt(collectTypeRanges(masked), beforeOffset);
		const depths = depthsOf(masked);
		pattern.lastIndex = 0;
		while (owner && (match = pattern.exec(masked)) !== null) {
			if (match.index <= beforeOffset || match.index >= owner.end || NOT_TYPES.has(match[1])) {
				continue;
			}
			if (depths[match.index] === depths[owner.opening] + 1) {
				type = simpleType(match[1]);
				break;
			}
		}
	}
	return type?.replace(/\[\]$/, '');
}

/**
 * Declaration of a local variable or parameter named `name` in the member that contains offset.
 * Blocks inside the member are not scoped individually; the last declaration before offset wins.
 */
function localDeclaration(source: string, offset: number, name: string): number | undefined {
	const masked = maskNonCode(source);
	const owner = ownerAt(collectTypeRanges(masked), offset);
	if (!owner) {
		return undefined;
	}
	const depths = depthsOf(masked);
	const bodyDepth = depths[owner.opening] + 1;
	let memberStart = offset;
	while (memberStart > owner.opening && !(/[;{}]/.test(masked[memberStart - 1]) && depths[memberStart] === bodyDepth)) {
		memberStart--;
	}
	const pattern = declarationPattern(name);
	const region = masked.slice(memberStart, offset + name.length);
	let match: RegExpExecArray | null;
	let declaration: number | undefined;
	while ((match = pattern.exec(region)) !== null) {
		if (!NOT_TYPES.has(match[1]) && !/^\d/.test(match[1])) {
			declaration = memberStart + match.index + match[0].length - name.length;
		}
	}
	return declaration;
}

function referenceAt(source: string, offset: number, name: string): Reference | undefined {
	const masked = maskNonCode(source);
	if (masked.slice(offset, offset + name.length) !== name || /[\w$]/.test(masked[offset - 1] ?? '') || /[\w$]/.test(masked[offset + name.length] ?? '')) {
		return undefined;
	}
	const prefix = masked.slice(Math.max(0, offset - 400), offset);
	let receiver: Receiver = { kind: 'implicit' };
	const dotted = /(?<identifier>[A-Za-z_$][\w$]*)?\s*\.\s*$/.exec(prefix);
	if (dotted) {
		const identifier = dotted.groups?.identifier;
		receiver = !identifier ? { kind: 'expression' }
			: identifier === 'this' ? { kind: 'this' }
				: identifier === 'super' ? { kind: 'super' }
					: { kind: 'identifier', name: identifier };
	}
	let opening = offset + name.length;
	while (/\s/.test(masked[opening] ?? '')) {
		opening++;
	}
	if (masked[opening] === '(') {
		const closing = findClosing(masked, opening, '(', ')');
		const isConstructor = /\bnew\s+$/.test(prefix);
		return {
			kind: isConstructor ? 'constructor' : 'call',
			name,
			offset,
			receiver,
			arguments: closing < 0 ? [] : splitCommaSeparated(source.slice(opening + 1, closing), false)
		};
	}
	return { kind: receiver.kind === 'implicit' ? 'name' : 'member', name, offset, receiver, arguments: [] };
}

function inferExpressionType(expression: string, source: string, beforeOffset: number): string | undefined {
	const text = expression.trim();
	if (!text) {
		return undefined;
	}
	if (/^"(?:[^"\\]|\\.)*"$/.test(text)) {
		return 'String';
	}
	if (/^'(?:[^'\\]|\\.)*'$/.test(text)) {
		return 'char';
	}
	if (/^(?:true|false)$/.test(text)) {
		return 'boolean';
	}
	if (/^[+-]?(?:\d+[lL])$/.test(text)) {
		return 'long';
	}
	if (/^[+-]?(?:(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)[fF]$/.test(text)) {
		return 'float';
	}
	if (/^[+-]?(?:(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)(?:[dD])?$/.test(text)) {
		return 'double';
	}
	if (/^[+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|\d+)$/.test(text)) {
		return 'int';
	}
	if (text === 'null') {
		return 'null';
	}
	const constructed = /^new\s+([A-Za-z_$][\w$.]*)/.exec(text)?.[1];
	if (constructed) {
		return simpleType(constructed);
	}
	const cast = /^\(\s*([A-Za-z_$][\w$.]*(?:\s*\[\s*\])?)\s*\)/.exec(text)?.[1];
	if (cast) {
		return simpleType(cast);
	}
	return /^[A-Za-z_$][\w$]*$/.test(text) ? inferVariableType(source, text, beforeOffset) : undefined;
}

function isCompatible(argumentType: string, parameterType: string): number {
	const argument = simpleType(argumentType);
	const parameter = simpleType(parameterType);
	if (argument === parameter) {
		return 4;
	}
	if (argument === 'null') {
		return PRIMITIVE_TYPES.has(parameter) ? -1 : 1;
	}
	const widening: Record<string, readonly string[]> = {
		byte: ['short', 'int', 'long', 'float', 'double'],
		short: ['int', 'long', 'float', 'double'],
		char: ['int', 'long', 'float', 'double'],
		int: ['long', 'float', 'double'],
		long: ['float', 'double'],
		float: ['double']
	};
	if (widening[argument]?.includes(parameter)) {
		return 2;
	}
	// Without a classpath a reference argument may be a subtype of the parameter; prefer, but keep it.
	return PRIMITIVE_TYPES.has(argument) || PRIMITIVE_TYPES.has(parameter) ? -1 : 0;
}

function candidateScore(symbol: SourceSymbol, argumentTypes: readonly (string | undefined)[], argumentCount: number): number {
	const parameters = symbol.parameterTypes ?? [];
	const minimum = symbol.variadic ? Math.max(0, parameters.length - 1) : parameters.length;
	if (argumentCount < minimum || (!symbol.variadic && argumentCount !== parameters.length)) {
		return -1;
	}
	let score = symbol.variadic ? 0 : 1;
	for (let index = 0; index < argumentTypes.length; index++) {
		const argument = argumentTypes[index];
		if (!argument) {
			continue;
		}
		let parameter = parameters[Math.min(index, parameters.length - 1)];
		if (!parameter) {
			return -1;
		}
		if (symbol.variadic && index >= parameters.length - 1) {
			parameter = parameter.replace(/\[\]$/, '');
		}
		const compatibility = isCompatible(argument, parameter);
		if (compatibility < 0) {
			return -1;
		}
		score += compatibility;
	}
	return score;
}

function symbolsOf(source: NavigationSource): readonly SourceSymbol[] {
	return source.symbols ?? collectSourceSymbols(source.content);
}

function definitionOf(source: NavigationSource, symbol: SourceSymbol): SourceDefinition {
	return { uri: source.uri, line: symbol.line, column: symbol.column, length: symbol.length };
}

/** Each type of the hierarchy of `name`, nearest first, with the sources that declare it. */
function* hierarchy(name: string, from: NavigationSource, lookup: DefinitionLookup): Generator<{ name: string; sources: readonly NavigationSource[] }> {
	const visited = new Set<string>();
	let level: { name: string; from: NavigationSource }[] = [{ name, from }];
	for (let depth = 0; depth < MAXIMUM_HIERARCHY_DEPTH && level.length > 0; depth++) {
		const next: { name: string; from: NavigationSource }[] = [];
		for (const type of level) {
			if (visited.has(type.name)) {
				continue;
			}
			visited.add(type.name);
			const sources = lookup.types(type.name, type.from);
			yield { name: type.name, sources };
			for (const source of sources) {
				for (const symbol of symbolsOf(source)) {
					if (symbol.kind === 'type' && symbol.name === type.name) {
						next.push(...(symbol.supers ?? []).map(superName => ({ name: superName, from: source })));
					}
				}
			}
		}
		level = next;
	}
}

function typeDefinitions(name: string, from: NavigationSource, lookup: DefinitionLookup): SourceDefinition[] {
	return lookup.types(name, from).flatMap(source => symbolsOf(source)
		.filter(symbol => symbol.kind === 'type' && symbol.name === name)
		.map(symbol => definitionOf(source, symbol)));
}

/** Fields named `name` declared by `owner` or the nearest supertype that declares one. */
function fieldDefinitions(owner: string, name: string, from: NavigationSource, lookup: DefinitionLookup): { definitions: SourceDefinition[]; valueType: string | undefined } {
	for (const type of hierarchy(owner, from, lookup)) {
		for (const source of type.sources) {
			const fields = symbolsOf(source).filter(symbol => symbol.kind === 'field' && symbol.name === name && symbol.owner === type.name);
			if (fields.length > 0) {
				return { definitions: fields.map(symbol => definitionOf(source, symbol)), valueType: fields[0].valueType };
			}
		}
	}
	return { definitions: [], valueType: undefined };
}

function bestMethods(candidates: readonly { source: NavigationSource; symbol: SourceSymbol }[], reference: Reference, current: NavigationSource): SourceDefinition[] {
	const argumentTypes = reference.arguments.map(argument => inferExpressionType(argument, current.content, reference.offset));
	const scored = candidates
		.map(candidate => ({ ...candidate, score: candidateScore(candidate.symbol, argumentTypes, reference.arguments.length) }))
		.filter(candidate => candidate.score >= 0);
	if (scored.length === 0) {
		return [];
	}
	const bestScore = Math.max(...scored.map(candidate => candidate.score));
	return scored.filter(candidate => candidate.score === bestScore).map(candidate => definitionOf(candidate.source, candidate.symbol));
}

function methodDefinitions(owner: string, reference: Reference, current: NavigationSource, lookup: DefinitionLookup): SourceDefinition[] {
	for (const type of hierarchy(owner, current, lookup)) {
		const candidates = type.sources.flatMap(source => symbolsOf(source)
			.filter(symbol => symbol.kind === 'method' && symbol.name === reference.name && symbol.owner === type.name)
			.map(symbol => ({ source, symbol })));
		const definitions = bestMethods(candidates, reference, current);
		if (definitions.length > 0) {
			return definitions;
		}
	}
	return [];
}

/** Static type of a receiver, or undefined when it cannot be inferred from source alone. */
function receiverType(reference: Reference, current: NavigationSource, lookup: DefinitionLookup): string[] {
	const masked = maskNonCode(current.content);
	const enclosing = typesAt(collectTypeRanges(masked), reference.offset);
	const receiver = reference.receiver;
	switch (receiver.kind) {
		case 'implicit':
		case 'this':
			// An unqualified call may also target a member of an enclosing type.
			return receiver.kind === 'this' ? enclosing.slice(0, 1).map(type => type.name) : enclosing.map(type => type.name);
		case 'super':
			return enclosing[0]?.superName ? [enclosing[0].superName] : [];
		case 'expression':
			return [];
		case 'identifier': {
			const declared = inferVariableType(current.content, receiver.name, reference.offset);
			if (declared) {
				return [declared];
			}
			for (const type of enclosing) {
				const inherited = fieldDefinitions(type.name, receiver.name, current, lookup).valueType;
				if (inherited) {
					return [inherited];
				}
			}
			return /^[A-Z]/.test(receiver.name) ? [receiver.name] : [];
		}
	}
}

/**
 * Resolves the declaration of the identifier at `offset` from Java source alone: types, methods
 * (including inherited ones and overloads), fields, enum constants, locals and parameters.
 */
export function resolveDefinitions(current: NavigationSource, offset: number, name: string, lookup: DefinitionLookup): SourceDefinition[] {
	const reference = referenceAt(current.content, offset, name);
	if (!reference || CONTROL_WORDS.has(name)) {
		return [];
	}
	if (reference.kind === 'constructor') {
		const constructors = methodDefinitionsOfType(name, reference, current, lookup);
		return constructors.length > 0 ? constructors : typeDefinitions(name, current, lookup);
	}
	if (reference.kind === 'call') {
		const owners = receiverType(reference, current, lookup);
		for (const owner of owners) {
			const definitions = methodDefinitions(owner, reference, current, lookup);
			if (definitions.length > 0) {
				return definitions;
			}
		}
		if (owners.length === 0 && reference.receiver.kind === 'expression' && lookup.complete) {
			// Chained calls such as `find().save()`: the return type is unknown without a compiler.
			const candidates = lookup.methods(name).flatMap(source => symbolsOf(source)
				.filter(symbol => symbol.kind === 'method' && symbol.name === name && symbol.name !== symbol.owner)
				.map(symbol => ({ source, symbol })));
			const definitions = bestMethods(candidates, reference, current);
			return definitions.length <= MAXIMUM_NAME_FALLBACK ? definitions : [];
		}
		return [];
	}
	if (reference.kind === 'member') {
		for (const owner of receiverType(reference, current, lookup)) {
			const fields = fieldDefinitions(owner, name, current, lookup).definitions;
			if (fields.length > 0) {
				return fields;
			}
		}
		// Nested or qualified types: `Outer.Inner`, `com.example.Type`.
		return /^[A-Z]/.test(name) ? typeDefinitions(name, current, lookup) : [];
	}
	const local = localDeclaration(current.content, offset, name);
	if (local !== undefined) {
		const starts = lineStarts(current.content);
		const line = starts.findLastIndex(start => start <= local);
		return [{ uri: current.uri, line, column: local - starts[line], length: name.length }];
	}
	for (const owner of receiverType(reference, current, lookup)) {
		const fields = fieldDefinitions(owner, name, current, lookup).definitions;
		if (fields.length > 0) {
			return fields;
		}
	}
	return typeDefinitions(name, current, lookup);
}

function methodDefinitionsOfType(name: string, reference: Reference, current: NavigationSource, lookup: DefinitionLookup): SourceDefinition[] {
	const candidates = lookup.types(name, current).flatMap(source => symbolsOf(source)
		.filter(symbol => symbol.kind === 'method' && symbol.name === name && symbol.owner === name)
		.map(symbol => ({ source, symbol })));
	return bestMethods(candidates, reference, current);
}

/** A lookup over a fixed list of sources, without package visibility rules. */
export function sourceListLookup(sources: readonly NavigationSource[], complete = false): DefinitionLookup {
	const declaring = (kind: SourceSymbol['kind'], name: string) => sources.filter(source => symbolsOf(source).some(symbol => symbol.kind === kind && symbol.name === name));
	return {
		types: name => declaring('type', name),
		methods: name => declaring('method', name),
		complete
	};
}

export function resolveSourceDefinitions(
	current: NavigationSource,
	nameOffset: number,
	name: string,
	sources: readonly NavigationSource[]
): SourceDefinition[] {
	return resolveDefinitions(current, nameOffset, name, sourceListLookup(sources));
}

/** A reference whose declaring type may live outside the sources, for example in a library JAR. */
export interface TypeReference {
	/** Simple name of the type that declares the target. */
	type: string;
	/** Method or field of `type`; undefined for the type itself. */
	member?: { name: string; kind: 'method' | 'field'; argumentCount: number };
}

/** The declaring type of the reference at offset as far as the current source tells. */
export function typeReferenceAt(content: string, offset: number, name: string): TypeReference | undefined {
	const reference = referenceAt(content, offset, name);
	if (!reference || CONTROL_WORDS.has(name)) {
		return undefined;
	}
	if (reference.kind === 'constructor' || reference.kind === 'name') {
		return /^[A-Z]/.test(name) ? { type: name } : undefined;
	}
	if (reference.receiver.kind === 'implicit' || reference.receiver.kind === 'this') {
		return undefined;
	}
	const owner = receiverType(reference, { uri: '', content }, sourceListLookup([]))[0];
	return owner ? { type: owner, member: { name, kind: reference.kind === 'call' ? 'method' : 'field', argumentCount: reference.arguments.length } } : undefined;
}

/** Declaration of a type reference within one source, falling back to the type when the member is inherited. */
export function typeReferenceDefinitions(source: NavigationSource, target: TypeReference): SourceDefinition[] {
	const symbols = symbolsOf(source);
	const member = target.member;
	if (member) {
		const named = symbols.filter(symbol => symbol.kind === member.kind && symbol.name === member.name && symbol.owner === target.type);
		const arity = named.filter(symbol => symbol.kind !== 'method' || (symbol.variadic
			? member.argumentCount >= (symbol.parameterTypes?.length ?? 1) - 1
			: member.argumentCount === (symbol.parameterTypes?.length ?? 0)));
		const matches = arity.length > 0 ? arity : named;
		if (matches.length > 0) {
			return matches.map(symbol => definitionOf(source, symbol));
		}
	}
	return symbols.filter(symbol => symbol.kind === 'type' && symbol.name === target.type).map(symbol => definitionOf(source, symbol));
}

/** Names of every type declared in one decompiled source, used to index it for navigation. */
export function collectTypeNames(source: string): string[] {
	return [...new Set(collectSourceSymbols(source).filter(symbol => symbol.kind === 'type').map(symbol => symbol.name))];
}

/**
 * Types whose declaring source can hold the definition of a reference. Navigation reads only the
 * sources indexed under these names first, instead of every source of the project or JAR.
 * An empty result means the offset is not a navigable identifier in code.
 */
export function definitionOwners(content: string, nameOffset: number, name: string): string[] {
	const reference = referenceAt(content, nameOffset, name);
	if (!reference) {
		return [];
	}
	if (reference.kind === 'constructor' || reference.kind === 'name') {
		const enclosing = reference.kind === 'name' ? typesAt(collectTypeRanges(maskNonCode(content)), nameOffset).map(type => type.name) : [];
		return [...new Set([name, ...enclosing])];
	}
	const owners = receiverType(reference, { uri: '', content }, sourceListLookup([]));
	return reference.kind === 'member' ? [...new Set([...owners, name])] : owners;
}
