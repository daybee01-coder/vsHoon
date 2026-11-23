/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A bounded trigram filter. Collisions can admit extra files, but never remove a matching file. */
export class LiteralIndex {
	readonly bytes = new Uint32Array(256);

	constructor(text: string, bits?: ArrayLike<number>) {
		if (bits) {
			this.bytes.set(bits);
			return;
		}
		if (text.length < 3) {
			return;
		}
		// trigram() 과 같은 값을 앞의 두 글자를 이어 받으며 계산한다. 파일마다 글자를 세 번씩 읽지 않는다.
		let first = foldCase(text.charCodeAt(0));
		let second = foldCase(text.charCodeAt(1));
		for (let offset = 2; offset < text.length; offset++) {
			const third = foldCase(text.charCodeAt(offset));
			const bit = ((first * 31 + second) * 31 + third) & 8191;
			this.bytes[bit >>> 5] |= 1 << (bit & 31);
			first = second;
			second = third;
		}
	}

	mayContain(bits: readonly number[]): boolean {
		return bits.every(bit => (this.bytes[bit >>> 5] & (1 << (bit & 31))) !== 0);
	}
}

/** Non-ASCII and regular expression queries use the full matcher to preserve its case rules. */
export function literalBits(pattern: string, regex: boolean): number[] {
	if (regex || pattern.length < 3 || !/^[\x20-\x7e]+$/.test(pattern)) {
		return [];
	}
	const bits = new Set<number>();
	for (let offset = 0; offset + 2 < pattern.length; offset++) {
		bits.add(trigram(pattern, offset));
	}
	return [...bits];
}

function trigram(text: string, offset: number): number {
	let hash = 0;
	for (let index = offset; index < offset + 3; index++) {
		hash = hash * 31 + foldCase(text.charCodeAt(index));
	}
	return hash & 8191;
}

/** ASCII 대문자만 소문자로 바꾼다. 검색어의 trigram 과 같은 규칙이어야 한다. */
function foldCase(code: number): number {
	return code >= 65 && code <= 90 ? code + 32 : code;
}
