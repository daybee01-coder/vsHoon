/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'synchronized']);
const PRIMITIVE_TYPES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);
const TYPE_PATTERN = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?/g;
const METHOD_PATTERN = /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default)\s+)*(?:<[^>{}]+>\s+)?(?:[\w$.[\]<>?,]+\s+)+(?<name>[A-Za-z_$][\w$]*)\s*\((?<parameters>[^)]*)\)\s*(?:throws\s+[^{};]+)?(?:\{|;|$)/;
const CONSTRUCTOR_PATTERN = /^\s*(?:(?:public|protected|private)\s+)?(?<name>[A-Za-z_$][\w$]*)\s*\((?<parameters>[^)]*)\)\s*(?:throws\s+[^{};]+)?(?:\{|;|$)/;

interface TypeRange {
	name: string;
	superName: string | undefined;
	start: number;
	end: number;
}

interface CallSite {
	name: string;
	arguments: string[];
	isConstructor: boolean;
	owner: string | undefined;
}

export interface SourceSymbol {
	name: string;
	kind: 'type' | 'method';
	line: number;
	column: number;
	length: number;
	detail: string;
	owner?: string;
	parameterTypes?: string[];
	variadic?: boolean;
}

export interface NavigationSource {
	uri: string;
	content: string;
}

export interface SourceDefinition {
	uri: string;
	line: number;
	column: number;
	length: number;
}

function maskNonCode(source: string): string {
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

function collectTypeRanges(masked: string): TypeRange[] {
	const result: TypeRange[] = [];
	TYPE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TYPE_PATTERN.exec(masked)) !== null) {
		const opening = masked.indexOf('{', TYPE_PATTERN.lastIndex);
		if (opening < 0) {
			continue;
		}
		const terminator = masked.indexOf(';', TYPE_PATTERN.lastIndex);
		if (terminator >= 0 && terminator < opening) {
			continue;
		}
		const closing = findClosing(masked, opening, '{', '}');
		result.push({
			name: match[1],
			superName: match[2] ? simpleType(match[2]) : undefined,
			start: match.index,
			end: closing < 0 ? masked.length : closing + 1
		});
	}
	return result;
}

function ownerAt(types: readonly TypeRange[], offset: number): TypeRange | undefined {
	return types
		.filter(type => type.start <= offset && offset < type.end)
		.sort((left, right) => right.start - left.start)[0];
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
	const result: SourceSymbol[] = [];
	const masked = maskNonCode(source);
	const types = collectTypeRanges(masked);
	const starts = lineStarts(source);
	for (const type of types) {
		const line = starts.findLastIndex(start => start <= type.start);
		const declaration = source.slice(starts[line], starts[line + 1] ?? source.length);
		const column = declaration.indexOf(type.name);
		result.push({ name: type.name, kind: 'type', line, column, length: type.name.length, detail: '', owner: type.name });
	}
	for (let line = 0; line < starts.length; line++) {
		const start = starts[line];
		const end = starts[line + 1] ?? source.length;
		const text = source.slice(start, end).replace(/[\r\n]+$/, '');
		const maskedLine = masked.slice(start, end).replace(/[\r\n]+$/, '');
		const owner = ownerAt(types, start);
		const method = METHOD_PATTERN.exec(maskedLine);
		const constructor = method ? undefined : CONSTRUCTOR_PATTERN.exec(maskedLine);
		const match = method ?? (constructor?.groups?.name === owner?.name ? constructor : undefined);
		const name = match?.groups?.name;
		if (!name || CONTROL_WORDS.has(name)) {
			continue;
		}
		const column = text.indexOf(name, match!.index);
		const parameters = splitCommaSeparated(text.slice(match!.index).match(/\(([^)]*)\)/)?.[1] ?? '', true).map(parameterType);
		result.push({
			name,
			kind: 'method',
			line,
			column,
			length: name.length,
			detail: `(${match!.groups?.parameters?.trim() ?? ''})`,
			owner: ownerAt(types, start + column)?.name,
			parameterTypes: parameters.map(parameter => parameter.type),
			variadic: parameters.at(-1)?.variadic ?? false
		});
	}
	return result;
}

function inferVariableType(source: string, variable: string, beforeOffset: number): string | undefined {
	if (variable === 'this') {
		return undefined;
	}
	const prefix = maskNonCode(source.slice(0, beforeOffset));
	const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`\\b([A-Za-z_$][\\w$.]*(?:\\s*<[^;={}()]+>)?(?:\\s*\\[\\s*\\])?)\\s+${escaped}\\b`, 'g');
	let match: RegExpExecArray | null;
	let type: string | undefined;
	while ((match = pattern.exec(prefix)) !== null) {
		type = simpleType(match[1]);
	}
	return type;
}

function callSiteAt(source: string, nameOffset: number, name: string): CallSite | undefined {
	const masked = maskNonCode(source);
	let opening = nameOffset + name.length;
	while (/\s/.test(masked[opening] ?? '')) {
		opening++;
	}
	if (masked[opening] !== '(') {
		return undefined;
	}
	const closing = findClosing(masked, opening, '(', ')');
	if (closing < 0) {
		return undefined;
	}
	const prefix = masked.slice(0, nameOffset);
	const receiver = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(prefix)?.[1];
	const isConstructor = /\bnew\s*$/.test(prefix);
	const types = collectTypeRanges(masked);
	const currentType = ownerAt(types, nameOffset);
	let owner: string | undefined;
	if (isConstructor) {
		owner = name;
	} else if (!receiver || receiver === 'this') {
		owner = currentType?.name;
	} else if (receiver === 'super') {
		owner = currentType?.superName;
	} else if (/^[A-Z_$]/.test(receiver)) {
		owner = receiver;
	} else {
		owner = inferVariableType(source, receiver, nameOffset);
	}
	return {
		name,
		arguments: splitCommaSeparated(source.slice(opening + 1, closing), false),
		isConstructor,
		owner
	};
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
	return widening[argument]?.includes(parameter) ? 2 : -1;
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

export function resolveSourceDefinitions(
	current: NavigationSource,
	nameOffset: number,
	name: string,
	sources: readonly NavigationSource[]
): SourceDefinition[] {
	const call = callSiteAt(current.content, nameOffset, name);
	if (!call) {
		return sources.flatMap(source => collectSourceSymbols(source.content)
			.filter(symbol => symbol.kind === 'type' && symbol.name === name)
			.map(symbol => ({ uri: source.uri, line: symbol.line, column: symbol.column, length: symbol.length })));
	}
	if (!call.owner) {
		return [];
	}
	const argumentTypes = call.arguments.map(argument => inferExpressionType(argument, current.content, nameOffset));
	const candidates = sources.flatMap(source => collectSourceSymbols(source.content)
		.filter(symbol => symbol.kind === 'method'
			&& symbol.name === call.name
			&& symbol.owner === call.owner
			&& (!call.isConstructor || symbol.name === symbol.owner))
		.map(symbol => ({ source, symbol, score: candidateScore(symbol, argumentTypes, call.arguments.length) })))
		.filter(candidate => candidate.score >= 0);
	if (candidates.length === 0) {
		return [];
	}
	const bestScore = Math.max(...candidates.map(candidate => candidate.score));
	return candidates
		.filter(candidate => candidate.score === bestScore)
		.map(candidate => ({
			uri: candidate.source.uri,
			line: candidate.symbol.line,
			column: candidate.symbol.column,
			length: candidate.symbol.length
		}));
}

/** Names of every type declared in one decompiled source, used to index it for navigation. */
export function collectTypeNames(source: string): string[] {
	return [...new Set(collectSourceSymbols(source).filter(symbol => symbol.kind === 'type').map(symbol => symbol.name))];
}

/**
 * Types whose declaring source can hold the definition of a reference. Navigation reads only the
 * sources indexed under these names instead of every prepared class of the same JAR.
 */
export function definitionOwners(content: string, nameOffset: number, name: string): string[] {
	const call = callSiteAt(content, nameOffset, name);
	if (!call) {
		return [name];
	}
	return call.owner ? [call.owner] : [];
}
