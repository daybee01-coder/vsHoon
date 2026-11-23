/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

const SAVE_DELAY_MS = 2000;

interface StoredEntry<T> {
	stamp: string;
	value: T;
}

interface StoredCache<T> {
	format: string;
	entries: Record<string, StoredEntry<T>>;
}

/**
 * Per-file index data that survives restarts, the way an IDE keeps its stub indexes on disk. An
 * entry is reused only while the file's stamp (modification time and size) is unchanged, so a
 * changed file is parsed again and a missing, corrupt or outdated cache only costs a full parse.
 */
export class StubCache<T> {
	private entries = new Map<string, StoredEntry<T>>();
	private loading: Promise<void> | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;

	/**
	 * @param file JSON file that holds the entries, or undefined to keep them in memory only.
	 * @param format Parser version; entries written by another version are discarded.
	 */
	constructor(private readonly file: string | undefined, private readonly format: string) { }

	/** Reads the stored entries once; later calls wait for the same read. */
	load(): Promise<void> {
		this.loading ??= (async () => {
			if (!this.file) {
				return;
			}
			try {
				const stored: StoredCache<T> = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
				if (stored?.format === this.format && stored.entries && typeof stored.entries === 'object') {
					for (const [key, entry] of Object.entries(stored.entries)) {
						if (typeof entry?.stamp === 'string' && !this.entries.has(key)) {
							this.entries.set(key, entry);
						}
					}
				}
			} catch {
				// A first run or a corrupt file starts empty.
			}
		})();
		return this.loading;
	}

	get(key: string, stamp: string): T | undefined {
		const entry = this.entries.get(key);
		return entry?.stamp === stamp ? entry.value : undefined;
	}

	set(key: string, stamp: string, value: T): void {
		this.entries.set(key, { stamp, value });
		this.scheduleSave();
	}

	delete(key: string): void {
		if (this.entries.delete(key)) {
			this.scheduleSave();
		}
	}

	/** Drops entries of files that a complete scan no longer found. */
	retain(keys: ReadonlySet<string>): void {
		for (const key of [...this.entries.keys()]) {
			if (!keys.has(key)) {
				this.delete(key);
			}
		}
	}

	/** Writes pending changes now. */
	async flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.file || !this.dirty) {
			return;
		}
		this.dirty = false;
		const stored: StoredCache<T> = { format: this.format, entries: Object.fromEntries(this.entries) };
		const temporary = `${this.file}.${process.pid}.tmp`;
		try {
			await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
			await fs.promises.writeFile(temporary, JSON.stringify(stored));
			await fs.promises.rename(temporary, this.file);
		} catch {
			// The cache is optional; the next start parses again.
			await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	dispose(): void {
		void this.flush();
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.file && !this.timer) {
			this.timer = setTimeout(() => { void this.flush(); }, SAVE_DELAY_MS);
		}
	}
}

/** The stamp of a file on disk. */
export function fileStamp(stat: { mtime: number; size: number }): string {
	return `${stat.mtime}:${stat.size}`;
}
