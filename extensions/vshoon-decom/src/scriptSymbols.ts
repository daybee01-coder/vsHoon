/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'typeof', 'new', 'delete', 'void',
	'do', 'else', 'try', 'finally', 'throw', 'in', 'of', 'instanceof', 'var', 'let', 'const', 'class', 'super', 'this', 'import', 'export', 'await', 'yield']);

/**
 * Declarations whose name ends the match; the rest of the declaration is a lookahead. A plain
 * script page declares functions as globals that other pages call, which a module-based
 * JavaScript service cannot connect without a project configuration.
 */
const DECLARATIONS = [
	// function name(), async function name(), function* name()
	/\b(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*(?=\s*\()/g,
	// name = function, obj.name = function, name = (...) =>, name = arg =>
	/(?<![\w$])[A-Za-z_$][\w$]*(?=\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g,
	// name: function, name: (...) =>
	/(?<![\w$])[A-Za-z_$][\w$]*(?=\s*:\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>))/g,
	// Class and object-literal method shorthand at the start of a line or after `{` or `,`.
	/(?:^|[{,])[ \t]*(?:(?:static|async|get|set)\s+)*[A-Za-z_$][\w$]*(?=\s*\([^()]*\)\s*\{)/gm,
	/\bclass\s+[A-Za-z_$][\w$]*/g
];

export interface ScriptDeclaration {
	name: string;
	line: number;
	column: number;
}

/** Blanks comments and string or template literals, keeping offsets and line breaks. */
export function maskScript(source: string): string {
	const result = source.split('');
	let quote: string | undefined;
	let comment: 'line' | 'block' | undefined;
	for (let index = 0; index < source.length; index++) {
		const current = source[index];
		const next = source[index + 1];
		if (comment === 'line') {
			if (current === '\n' || current === '\r') {
				comment = undefined;
			} else {
				result[index] = ' ';
			}
		} else if (comment === 'block') {
			if (current === '*' && next === '/') {
				result[index] = result[index + 1] = ' ';
				comment = undefined;
				index++;
			} else if (current !== '\n' && current !== '\r') {
				result[index] = ' ';
			}
		} else if (quote) {
			if (current === '\\') {
				result[index] = ' ';
				if (source[index + 1] !== '\n') {
					result[index + 1] = ' ';
				}
				index++;
			} else if (current === quote || ((current === '\n' || current === '\r') && quote !== '`')) {
				result[index] = current === quote ? ' ' : current;
				quote = undefined;
			} else if (current !== '\n' && current !== '\r') {
				result[index] = ' ';
			}
		} else if (current === '/' && next === '/') {
			result[index] = result[index + 1] = ' ';
			comment = 'line';
			index++;
		} else if (current === '/' && next === '*') {
			result[index] = result[index + 1] = ' ';
			comment = 'block';
			index++;
		} else if (current === '"' || current === '\'' || current === '`') {
			result[index] = ' ';
			quote = current;
		}
	}
	return result.join('');
}

/** Function, method and class declarations of a script or of the script blocks of a page. */
export function collectScriptDeclarations(source: string): ScriptDeclaration[] {
	const masked = maskScript(source);
	const starts = [0];
	for (let offset = 0; offset < source.length; offset++) {
		if (source[offset] === '\n') {
			starts.push(offset + 1);
		}
	}
	const seen = new Set<number>();
	const result: ScriptDeclaration[] = [];
	for (const pattern of DECLARATIONS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(masked)) !== null) {
			const name = /[A-Za-z_$][\w$]*$/.exec(match[0])![0];
			const offset = match.index + match[0].length - name.length;
			if (KEYWORDS.has(name) || seen.has(offset) || /[\w$]/.test(masked[offset - 1] ?? '')) {
				continue;
			}
			seen.add(offset);
			let low = 0;
			let high = starts.length - 1;
			while (low < high) {
				const middle = (low + high + 1) >> 1;
				if (starts[middle] <= offset) {
					low = middle;
				} else {
					high = middle - 1;
				}
			}
			const line = low;
			result.push({ name, line, column: offset - starts[line] });
		}
	}
	return result.sort((left, right) => left.line - right.line || left.column - right.column);
}

/** Whether offset starts an identifier in code rather than in a comment or string. */
export function isScriptCode(source: string, offset: number, word: string): boolean {
	return maskScript(source).slice(offset, offset + word.length) === word && !KEYWORDS.has(word);
}
