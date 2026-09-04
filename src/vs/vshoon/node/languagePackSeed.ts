/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../base/common/path.js';

/**
 * The part of a language pack manifest that the index is built from.
 */
export interface IVShoonLocalizationManifest {
	readonly name?: string;
	readonly publisher?: string;
	readonly version?: string;
	readonly contributes?: {
		readonly localizations?: readonly {
			readonly languageId?: string;
			readonly languageName?: string;
			readonly localizedLanguageName?: string;
			readonly translations?: readonly { readonly id?: string; readonly path?: string }[];
		}[];
	};
}

export interface IVShoonLanguagePack {
	readonly hash: string;
	readonly label: string | undefined;
	readonly extensions: { readonly extensionIdentifier: { readonly id: string }; readonly version: string }[];
	readonly translations: { [id: string]: string };
}

export const VSHOON_LANGUAGE_PACK_PREFIX = 'vshoon-language-pack-';

/**
 * Builds the language pack index entries one manifest contributes.
 *
 * The shape is the one the shared process writes to `languagepacks.json`, so upstream reads it
 * back without knowing VShoon produced it: an extension identifier and version per pack, absolute
 * paths per translation file, and an MD5 over the contributing extensions that names the compiled
 * bundle directory.
 */
export function toVShoonLanguagePacks(manifest: IVShoonLocalizationManifest | undefined, extensionPath: string): { [language: string]: IVShoonLanguagePack } {
	const packs: { [language: string]: IVShoonLanguagePack } = {};
	if (!manifest?.name || !manifest.publisher || !manifest.version) {
		return packs;
	}

	const id = `${manifest.publisher}.${manifest.name}`;
	for (const localization of manifest.contributes?.localizations ?? []) {
		if (typeof localization.languageId !== 'string' || !localization.translations?.length) {
			continue;
		}

		const translations: { [id: string]: string } = {};
		for (const translation of localization.translations) {
			if (typeof translation.id === 'string' && typeof translation.path === 'string') {
				translations[translation.id] = join(extensionPath, translation.path);
			}
		}

		if (Object.keys(translations).length === 0) {
			continue;
		}

		packs[localization.languageId] = {
			// CodeQL [SM04514] Names the compiled bundle directory; it is not a security boundary.
			hash: createHash('md5').update(id).update(manifest.version).digest('hex'),
			label: localization.localizedLanguageName ?? localization.languageName,
			extensions: [{ extensionIdentifier: { id }, version: manifest.version }],
			translations
		};
	}

	return packs;
}

/**
 * Writes the language pack index that a first run would otherwise not have.
 *
 * The index is normally written by the shared process, which only starts once a workbench window
 * does. A product whose default display language is not English would therefore show its very
 * first screen — the launcher — in English, and stay English until the user had opened a project
 * once and restarted. Seeding the packs VShoon itself ships closes that gap and leaves everything
 * else to upstream: the file is rewritten from the installed extensions as soon as the shared
 * process runs.
 *
 * Only the packs VShoon ships are considered, so the cost is one directory read and one manifest
 * read, and only when the file is missing.
 */
export async function seedVShoonLanguagePacks(userDataPath: string, builtinExtensionsPath: string): Promise<boolean> {
	const indexPath = join(userDataPath, 'languagepacks.json');
	try {
		await fs.access(indexPath);

		return false; // upstream owns it from here
	} catch {
		// not written yet, which is the case this exists for
	}

	let entries: string[];
	try {
		entries = await fs.readdir(builtinExtensionsPath);
	} catch {
		return false;
	}

	const packs: { [language: string]: IVShoonLanguagePack } = {};
	for (const entry of entries.filter(name => name.startsWith(VSHOON_LANGUAGE_PACK_PREFIX))) {
		const extensionPath = join(builtinExtensionsPath, entry);
		try {
			const manifest = JSON.parse(await fs.readFile(join(extensionPath, 'package.json'), 'utf8')) as IVShoonLocalizationManifest;
			Object.assign(packs, toVShoonLanguagePacks(manifest, extensionPath));
		} catch {
			continue; // a pack that cannot be read is one the product does without
		}
	}

	if (Object.keys(packs).length === 0) {
		return false;
	}

	try {
		await fs.mkdir(userDataPath, { recursive: true });
		await fs.writeFile(indexPath, JSON.stringify(packs), 'utf8');

		return true;
	} catch {
		return false;
	}
}
