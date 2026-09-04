/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { toVShoonLanguagePacks } from '../../node/languagePackSeed.js';

suite('VShoon Language Pack Seed', () => {

	const extensionPath = join('C:', 'app', 'extensions', 'vshoon-language-pack-ko');

	const manifest = {
		name: 'vshoon-language-pack-ko',
		publisher: 'vshoon',
		version: '1.131.0',
		contributes: {
			localizations: [{
				languageId: 'ko',
				languageName: 'Korean',
				localizedLanguageName: '한국어',
				translations: [
					{ id: 'vscode', path: './translations/main.i18n.json' },
					{ id: 'vscode.git', path: './translations/extensions/vscode.git.i18n.json' }
				]
			}]
		}
	};

	test('describes a pack the way the shared process would', () => {
		assert.deepStrictEqual(toVShoonLanguagePacks(manifest, extensionPath), {
			ko: {
				hash: 'e85d5a342eafd51e6aacaadec40f4b4f',
				label: '한국어',
				extensions: [{ extensionIdentifier: { id: 'vshoon.vshoon-language-pack-ko' }, version: '1.131.0' }],
				translations: {
					'vscode': join(extensionPath, 'translations', 'main.i18n.json'),
					'vscode.git': join(extensionPath, 'translations', 'extensions', 'vscode.git.i18n.json')
				}
			}
		});
	});

	test('ignores anything that could not be resolved back to a translation file', () => {
		const incomplete = [
			{ ...manifest, version: undefined },
			{ ...manifest, contributes: { localizations: [{ ...manifest.contributes.localizations[0], languageId: undefined }] } },
			{ ...manifest, contributes: { localizations: [{ ...manifest.contributes.localizations[0], translations: [] }] } },
			{ ...manifest, contributes: { localizations: [{ ...manifest.contributes.localizations[0], translations: [{ id: 'vscode', path: undefined }] }] } },
			{ ...manifest, contributes: undefined },
			undefined
		];

		assert.deepStrictEqual(incomplete.map(entry => toVShoonLanguagePacks(entry, extensionPath)), incomplete.map(() => ({})));
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
