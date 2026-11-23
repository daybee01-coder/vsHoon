/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { crc32 } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

export interface CachedContent {
	text?: string;
	binary: boolean;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	/** trigram 필터 (LiteralIndex.bytes) */
	bits?: Uint32Array;
}

/** 캐시 형식이 바뀌면 폴더 이름을 바꾼다. 이전 폴더는 지운다. */
export const CACHE_DIRECTORY = 'vsearch-v2';
const OBSOLETE_DIRECTORIES = ['vsearch-v1'];
const CACHE_FILE = /^[a-f0-9]{64}\.bin$/;

/*
 * 파일 하나의 형식 (little endian):
 *   0  'VSC2'
 *   4  u8  flags (1 binary, 2 text, 4 bits)
 *   8  f64 size, f64 mtimeMs, f64 ctimeMs, f64 ino
 *  40  u32 text 바이트 길이
 *  44  u32 crc32(필터 + 텍스트)
 *  48  필터 1024바이트 (flags & 4), 그 뒤 UTF-8 텍스트 (flags & 2)
 * JSON 으로 두 번 감싸고 SHA-256 으로 검사하던 v1 보다 읽기·쓰기가 빠르고 크기도 원본과 비슷하다.
 */
const MAGIC = 0x32435356; // 'VSC2'
const HEADER_BYTES = 48;
const BITS_BYTES = 1024;
const FLAG_BINARY = 1;
const FLAG_TEXT = 2;
const FLAG_BITS = 4;

/** Disposable project data. A corrupt, stale or unwritable cache always falls back to the source. */
export class PersistentCache {
	private roots: string[] = [];
	private readonly directories = new Set<string>();
	/** 마지막 정리 뒤 기록한 바이트 */
	private unprunedBytes = 0;

	constructor(roots: readonly string[], private readonly limitBytes: number) {
		this.setRoots(roots);
	}

	setRoots(roots: readonly string[]): void {
		const previous = new Set(this.roots);
		this.roots = roots.filter(root => path.isAbsolute(root)).map(root => path.resolve(root)).sort((a, b) => b.length - a.length);
		for (const root of this.roots) {
			if (!previous.has(root)) {
				for (const obsolete of OBSOLETE_DIRECTORIES) {
					// 예전 형식은 다시 쓰지 않으므로 백그라운드에서 지운다. 실패해도 검색에는 영향이 없다.
					fs.rm(path.join(root, '.vshoon', 'cache', obsolete), { recursive: true, force: true }, () => undefined);
				}
			}
		}
	}

	read(filePath: string, stat: fs.Stats, maxBytes: number): CachedContent | undefined {
		const cachePath = this.location(filePath);
		if (!cachePath) {
			return undefined;
		}
		try {
			// UTF-8 로 다시 쓴 텍스트는 원본 크기의 3배를 넘지 않는다.
			if (fs.statSync(cachePath).size > Math.min(this.limitBytes, HEADER_BYTES + BITS_BYTES + Math.min(stat.size, maxBytes) * 3)) {
				return undefined;
			}
			const buffer = fs.readFileSync(cachePath);
			if (buffer.length < HEADER_BYTES || buffer.readUInt32LE(0) !== MAGIC) {
				return undefined;
			}
			const flags = buffer.readUInt8(4);
			const textBytes = buffer.readUInt32LE(40);
			const bitsBytes = flags & FLAG_BITS ? BITS_BYTES : 0;
			if (buffer.length !== HEADER_BYTES + bitsBytes + textBytes || (!(flags & FLAG_TEXT) && textBytes !== 0)
				|| crc32(buffer.subarray(HEADER_BYTES)) !== buffer.readUInt32LE(44)) {
				return undefined;
			}
			const entry: CachedContent = {
				binary: (flags & FLAG_BINARY) !== 0,
				size: buffer.readDoubleLE(8),
				mtimeMs: buffer.readDoubleLE(16),
				ctimeMs: buffer.readDoubleLE(24),
				ino: buffer.readDoubleLE(32)
			};
			if (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs || entry.ctimeMs !== stat.ctimeMs || entry.ino !== stat.ino) {
				return undefined;
			}
			if (flags & FLAG_TEXT) {
				if (!bitsBytes) {
					return undefined;
				}
				entry.text = buffer.toString('utf8', HEADER_BYTES + bitsBytes);
			}
			if (bitsBytes) {
				// 읽은 버퍼 전체를 붙잡지 않도록 필터만 복사한다.
				entry.bits = new Uint32Array(BITS_BYTES / 4);
				Buffer.from(entry.bits.buffer).set(buffer.subarray(HEADER_BYTES, HEADER_BYTES + BITS_BYTES));
			}
			return entry;
		} catch {
			return undefined;
		}
	}

	write(filePath: string, entry: CachedContent): void {
		const cachePath = this.location(filePath);
		if (!cachePath) {
			return;
		}
		const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const bits = entry.bits?.byteLength === BITS_BYTES ? Buffer.from(entry.bits.buffer, entry.bits.byteOffset, BITS_BYTES) : undefined;
			// 텍스트는 필터와 함께일 때만 저장한다. 필터 없이 복원하면 후보 거르기를 할 수 없다.
			const text = entry.text !== undefined && bits ? Buffer.from(entry.text, 'utf8') : undefined;
			const bytes = HEADER_BYTES + (bits?.length ?? 0) + (text?.length ?? 0);
			if (bytes > this.limitBytes) {
				return;
			}
			const directory = path.dirname(cachePath);
			if (!this.directories.has(directory)) {
				fs.mkdirSync(directory, { recursive: true });
				fs.writeFileSync(path.join(directory, '.gitignore'), '*\n');
				this.directories.add(directory);
			}
			const header = Buffer.alloc(HEADER_BYTES);
			header.writeUInt32LE(MAGIC, 0);
			header.writeUInt8((entry.binary ? FLAG_BINARY : 0) | (text ? FLAG_TEXT : 0) | (bits ? FLAG_BITS : 0), 4);
			header.writeDoubleLE(entry.size, 8);
			header.writeDoubleLE(entry.mtimeMs, 16);
			header.writeDoubleLE(entry.ctimeMs, 24);
			header.writeDoubleLE(entry.ino, 32);
			header.writeUInt32LE(text?.length ?? 0, 40);
			const parts: Buffer[] = [header];
			let checksum = 0;
			if (bits) {
				parts.push(bits);
				checksum = crc32(bits);
			}
			if (text) {
				parts.push(text);
				checksum = crc32(text, checksum);
			}
			header.writeUInt32LE(checksum, 44);
			fs.writeFileSync(temporary, Buffer.concat(parts, bytes));
			fs.renameSync(temporary, cachePath);
			this.unprunedBytes += bytes;
		} catch {
			// Read-only projects and interrupted writes must never prevent a search.
			try { fs.unlinkSync(temporary); } catch { /* No temporary file to remove. */ }
		}
	}

	delete(filePath: string): void {
		const cachePath = this.location(filePath);
		if (cachePath) {
			try { fs.unlinkSync(cachePath); } catch { /* Already removed or read-only. */ }
		}
	}

	/**
	 * Run between background slices, outside the interactive search loop. Unless forced, it waits until
	 * a sixteenth of the limit has been written, so saving a file does not list the whole cache directory.
	 */
	prune(force = false): void {
		if (this.unprunedBytes === 0 || (!force && this.unprunedBytes < this.limitBytes / 16)) {
			return;
		}
		this.unprunedBytes = 0;
		for (const directory of this.directories) {
			try {
				const files = fs.readdirSync(directory).filter(name => CACHE_FILE.test(name)).map(name => {
					const filePath = path.join(directory, name);
					const stat = fs.statSync(filePath);
					return { filePath, bytes: stat.size, modified: stat.mtimeMs };
				}).sort((a, b) => a.modified - b.modified);
				let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
				for (const file of files) {
					if (bytes <= this.limitBytes) {
						break;
					}
					fs.unlinkSync(file.filePath);
					bytes -= file.bytes;
				}
			} catch { /* Cache maintenance is best effort. */ }
		}
	}

	private location(filePath: string): string | undefined {
		const root = this.roots.find(root => {
			const relative = path.relative(root, filePath);
			return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
				&& relative.split(path.sep)[0] !== '.vshoon';
		});
		return root ? path.join(root, '.vshoon', 'cache', CACHE_DIRECTORY, `${createHash('sha256').update(path.relative(root, filePath)).digest('hex')}.bin`) : undefined;
	}
}
