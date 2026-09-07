/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copies the DBConn extension's stored state from another VS Code installation into this
 * product's own storage.
 *
 * Both installations run the same extension, so the stored shape is identical - the data does
 * not carry over on its own only because the two are addressed differently: each app has its own
 * data folder, and `globalState` / `SecretStorage` are keyed by extension id inside it. So the
 * copy is a rename: read the source app's `ItemTable` rows, write them back under this app's
 * extension id.
 *
 * Passwords are the one part that cannot be copied byte for byte. Electron `safeStorage`
 * encrypts them with an AES key that lives in each app's own `Local State`, protected by Windows
 * DPAPI for the current user - so a row copied verbatim would be undecryptable garbage in the
 * target. This script decrypts with the source app's key and re-encrypts with the target's.
 *
 * The os_crypt format handling here mirrors `extensions/vshoon-dbconn/src/migrate/secrets.ts`.
 * The two cannot share a module - that one is bundled into the extension, this one runs as a
 * repo script with no build step - and what they share is a fixed Chromium wire format.
 *
 * Usage (close the target app first):
 *
 *   node scripts/copy-dbconn-store.mjs [options]
 *
 *   --from <dir>        Source app data folder      (default: %APPDATA%\Code)
 *   --to <dir>          Target app data folder      (default: %APPDATA%\VShoon)
 *   --source-id <id>    Source extension id         (default: dbconn.dbconn)
 *   --target-id <id>    Target extension id         (default: vshoon.vshoon-dbconn)
 *   --dry-run           Report what would change, write nothing
 *   --force             Write even if the target app looks like it is running
 */

import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './core-paths.mjs';

/** globalState keys the extension stores under, and the SecretStorage key prefix. */
const PROFILES_KEY = 'dbconn.profiles.v1';
const FOLDERS_KEY = 'dbconn.folders.v1';
const PASSWORD_PREFIX = 'dbconn.password.';
/** Copied only when the target has nothing there - never clobber current history. */
const OPTIONAL_KEYS = ['dbconn.history.v1', 'dbconn.scripts.v1', 'dbconn.recentScripts.v1', 'dbconn.scripts.promptedAt'];

const DPAPI_PREFIX = 'DPAPI';
const VERSION = 'v10';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

main();

function main() {
	if (process.platform !== 'win32') {
		fail('This script is Windows-only: the stored passwords are protected by DPAPI.');
	}
	const options = parseArgs(process.argv.slice(2));

	const source = readStore(options.from, options.sourceId);
	if (!source.bucket && source.secrets.length === 0) {
		fail(`Nothing stored for "${options.sourceId}" in ${options.from}.`);
	}

	const passwords = decryptPasswords(source.secrets, options.from);
	const targetKey = encryptionKey(options.to);

	const targetPath = statePath(options.to);
	if (!existsSync(targetPath)) {
		fail(`No storage at ${targetPath}. Start the target app once so it creates its storage.`);
	}
	const target = readStore(options.to, options.targetId, { copy: false });
	const merged = mergeBucket(target.bucket, source.bucket);

	console.log(`\nfrom  ${statePath(options.from)}  [${options.sourceId}]`);
	console.log(`to    ${targetPath}  [${options.targetId}]`);
	console.log(
		`\nprofiles  ${merged.added} new, ${merged.skipped} already there, ${merged.total} total after copy`
	);
	console.log(`folders   ${merged.folders} total after copy`);
	console.log(`passwords ${passwords.length} of ${source.secrets.length} decrypted`);
	console.log(`carried   ${merged.carried.join(', ') || '(none)'}`);

	if (options.dryRun) {
		console.log('\n--dry-run: nothing written.\n');
		return;
	}

	// The app keeps its storage in memory and writes its own copy back as it goes, so writing
	// underneath a running app is liable to be overwritten. Reporting is safe either way.
	if (!options.force && isRunning(options.to)) {
		fail(
			`${basename(options.to)} looks like it is running. Close it and run this again - it would ` +
			'overwrite these rows from memory. Pass --force to write anyway.'
		);
	}

	const backup = `${targetPath}.bak-${timestamp()}`;
	copyFileSync(targetPath, backup);

	const rows = [
		[options.targetId, JSON.stringify(merged.bucket)],
		...passwords.map(({ key, password }) => [
			secretRowKey(options.targetId, key),
			JSON.stringify(encrypt(password, targetKey))
		])
	];
	writeRows(targetPath, rows);

	console.log(`\nWrote ${rows.length} rows. Backup: ${backup}`);
	console.log('Start the app and open the Database view.\n');
}

function parseArgs(argv) {
	const appData = process.env['APPDATA'];
	if (!appData) {
		fail('APPDATA is not set.');
	}
	const options = {
		from: join(appData, 'Code'),
		to: join(appData, 'VShoon'),
		sourceId: 'dbconn.dbconn',
		targetId: 'vshoon.vshoon-dbconn',
		dryRun: false,
		force: false
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const next = argv[++i];
			if (!next) {
				fail(`${arg} needs a value.`);
			}
			return next;
		};
		switch (arg) {
			case '--from': options.from = value(); break;
			case '--to': options.to = value(); break;
			case '--source-id': options.sourceId = value(); break;
			case '--target-id': options.targetId = value(); break;
			case '--dry-run': options.dryRun = true; break;
			case '--force': options.force = true; break;
			default: fail(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function statePath(dataDir) {
	return join(dataDir, 'User', 'globalStorage', 'state.vscdb');
}

function secretRowKey(extensionId, key) {
	return `secret://${JSON.stringify({ extensionId, key })}`;
}

/**
 * Reads one extension's bucket plus its password rows.
 *
 * The source is read from a throwaway copy: the other app may be running and holding the file,
 * and its recent writes can still be sitting in the `-wal` sidecar. The copy is ours, so SQLite
 * may replay that WAL and hand back the current state instead of a stale snapshot.
 */
function readStore(dataDir, extensionId, { copy = true } = {}) {
	const path = statePath(dataDir);
	if (!existsSync(path)) {
		fail(`No storage at ${path}.`);
	}
	const workDir = copy ? mkdtempSync(join(tmpdir(), 'dbconn-copy-')) : undefined;
	const readPath = workDir ? join(workDir, 'state.vscdb') : path;
	try {
		if (workDir) {
			copyFileSync(path, readPath);
			for (const suffix of ['-wal', '-shm']) {
				if (existsSync(path + suffix)) {
					copyFileSync(path + suffix, readPath + suffix);
				}
			}
		}
		// Opened read-write on purpose: the source is our own copy, and a read-only handle
		// cannot replay a `-wal` sidecar, which is where the newest rows usually are.
		const db = new DatabaseSync(readPath);
		try {
			const bucketRow = db.prepare('select value from ItemTable where key = ?').get(extensionId);
			const secretRows = db.prepare("select key, value from ItemTable where key like 'secret://%'").all();
			const secrets = [];
			for (const row of secretRows) {
				const key = passwordKeyOf(row.key, extensionId);
				if (key) {
					secrets.push({ key, encrypted: toBytes(row.value) });
				}
			}
			return { bucket: parseJson(bucketRow?.value), secrets: secrets.filter((s) => s.encrypted) };
		} finally {
			db.close();
		}
	} finally {
		if (workDir) {
			rmSync(workDir, { recursive: true, force: true });
		}
	}
}

/** `secret://{"extensionId":"…","key":"dbconn.password.<id>"}` -> the inner key, or undefined. */
function passwordKeyOf(rowKey, extensionId) {
	const parsed = parseJson(rowKey.slice('secret://'.length));
	if (!parsed || parsed.extensionId !== extensionId || typeof parsed.key !== 'string') {
		return undefined;
	}
	return parsed.key.startsWith(PASSWORD_PREFIX) ? parsed.key : undefined;
}

/**
 * Merges the source bucket into the target's.
 *
 * A profile already in the target is left alone - matched by id (the same profile, copied
 * before) or by where it points (same folder, name, and connection details), so running this
 * twice does not double the list.
 */
function mergeBucket(targetBucket, sourceBucket) {
	const bucket = { ...(targetBucket ?? {}) };
	const existing = Array.isArray(bucket[PROFILES_KEY]) ? bucket[PROFILES_KEY] : [];
	const incoming = Array.isArray(sourceBucket?.[PROFILES_KEY]) ? sourceBucket[PROFILES_KEY] : [];

	const ids = new Set(existing.map((p) => p?.id));
	const places = new Set(existing.map(placeKey));
	const profiles = [...existing];
	let added = 0;
	let skipped = 0;
	for (const profile of incoming) {
		if (ids.has(profile?.id) || places.has(placeKey(profile))) {
			skipped++;
			continue;
		}
		ids.add(profile?.id);
		places.add(placeKey(profile));
		profiles.push(profile);
		added++;
	}
	bucket[PROFILES_KEY] = profiles;

	const folders = new Set([
		...(Array.isArray(bucket[FOLDERS_KEY]) ? bucket[FOLDERS_KEY] : []),
		...(Array.isArray(sourceBucket?.[FOLDERS_KEY]) ? sourceBucket[FOLDERS_KEY] : [])
	].filter((f) => typeof f === 'string'));
	bucket[FOLDERS_KEY] = [...folders].sort();

	const carried = [];
	for (const key of OPTIONAL_KEYS) {
		if (bucket[key] === undefined && sourceBucket?.[key] !== undefined) {
			bucket[key] = sourceBucket[key];
			carried.push(key);
		}
	}

	return { bucket, added, skipped, total: profiles.length, folders: folders.size, carried };
}

/** Where a profile points - two profiles with the same one are the same connection. */
function placeKey(profile) {
	return [
		profile?.folder ?? '',
		profile?.name,
		profile?.dialect,
		profile?.host,
		profile?.port,
		profile?.database,
		profile?.user
	].join('\u0000');
}

/** Decrypts every password row with the source app's own key. */
function decryptPasswords(secrets, dataDir) {
	if (secrets.length === 0) {
		return [];
	}
	const key = encryptionKey(dataDir);
	const decrypted = [];
	for (const secret of secrets) {
		try {
			decrypted.push({ key: secret.key, password: decrypt(secret.encrypted, key) });
		} catch (error) {
			// One unreadable password must not stop the profiles from moving over.
			console.warn(`  ! could not decrypt ${secret.key}: ${error.message}`);
		}
	}
	return decrypted;
}

/** The app's safeStorage AES key: DPAPI-protected inside its `Local State`. */
function encryptionKey(dataDir) {
	const path = join(dataDir, 'Local State');
	if (!existsSync(path)) {
		fail(`No "Local State" in ${dataDir} - cannot reach that app's encryption key.`);
	}
	const encoded = parseJson(readFileSync(path, 'utf8'))?.os_crypt?.encrypted_key;
	if (typeof encoded !== 'string') {
		fail(`No os_crypt key in ${path}.`);
	}
	let blob = Buffer.from(encoded, 'base64');
	if (blob.subarray(0, DPAPI_PREFIX.length).toString('latin1') === DPAPI_PREFIX) {
		blob = blob.subarray(DPAPI_PREFIX.length);
	}
	return unprotect(blob);
}

/**
 * Unwraps a DPAPI blob for the current user.
 *
 * Node has no DPAPI binding, and one call is not worth a native module - PowerShell is always
 * there on Windows. This only ever succeeds for the Windows account that stored the value.
 */
function unprotect(blob) {
	const encoded = blob.toString('base64');
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
		fail('Could not encode the protected key.');
	}
	const script = [
		'Add-Type -AssemblyName System.Security;',
		`$blob=[Convert]::FromBase64String('${encoded}');`,
		"[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,'CurrentUser'))"
	].join(' ');
	const stdout = execFileSync(
		'powershell.exe',
		['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
		{ encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }
	);
	const key = Buffer.from(stdout.trim(), 'base64');
	if (key.length === 0) {
		fail('DPAPI returned nothing - is this the Windows account that stored the passwords?');
	}
	return key;
}

function decrypt(bytes, key) {
	if (bytes.subarray(0, VERSION.length).toString('latin1') !== VERSION) {
		// Pre-safeStorage rows were DPAPI-encrypted on their own.
		return unprotect(bytes).toString('utf8');
	}
	const nonce = bytes.subarray(VERSION.length, VERSION.length + NONCE_LENGTH);
	const body = bytes.subarray(VERSION.length + NONCE_LENGTH, bytes.length - TAG_LENGTH);
	const decipher = createDecipheriv('aes-256-gcm', key, nonce);
	decipher.setAuthTag(bytes.subarray(bytes.length - TAG_LENGTH));
	return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Writes a value the way safeStorage would, so the target app reads it back as its own. */
function encrypt(plaintext, key) {
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([Buffer.from(VERSION, 'latin1'), nonce, body, cipher.getAuthTag()]);
}

function writeRows(path, rows) {
	const db = new DatabaseSync(path);
	try {
		db.exec('begin');
		const upsert = db.prepare(
			'insert into ItemTable (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
		);
		for (const [key, value] of rows) {
			upsert.run(key, value);
		}
		db.exec('commit');
	} catch (error) {
		db.exec('rollback');
		throw error;
	} finally {
		db.close();
	}
}

/** True when a process whose image lives in that app folder is running. */
function isRunning(dataDir) {
	const name = `${basename(dataDir)}.exe`;
	try {
		const stdout = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], {
			encoding: 'utf8',
			windowsHide: true
		});
		return stdout.toLowerCase().includes(name.toLowerCase());
	} catch {
		return false;
	}
}

function toBytes(value) {
	if (value instanceof Uint8Array) {
		return Buffer.from(value);
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = parseJson(value);
	if (parsed?.type === 'Buffer' && Array.isArray(parsed.data)) {
		return Buffer.from(parsed.data);
	}
	return /^[A-Za-z0-9+/=\r\n]+$/.test(value.trim()) ? Buffer.from(value.trim(), 'base64') : undefined;
}

function parseJson(text) {
	if (typeof text !== 'string') {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
