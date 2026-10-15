/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isProbablyTextFile, remoteFileChanged, safeTemporaryFileName } from './remoteFileEditingUtils';

describe('remote file editing helpers', () => {
  it('텍스트와 바이너리를 내용으로 구분한다', () => {
    assert.deepStrictEqual(
      {
        utf8: isProbablyTextFile(Buffer.from('안녕하세요\nhello')),
        utf16Bom: isProbablyTextFile(Buffer.from([0xff, 0xfe, 0x41, 0x00])),
        binaryWithNull: isProbablyTextFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])),
        binaryControls: isProbablyTextFile(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x41])),
      },
      { utf8: true, utf16Bom: true, binaryWithNull: false, binaryControls: false }
    );
  });

  it('Windows에서 사용할 수 없는 원격 파일 이름을 안전하게 바꾼다', () => {
    const reserved = safeTemporaryFileName('CON.txt');
    assert.deepStrictEqual(
      {
        ordinary: safeTemporaryFileName('report 2026.txt'),
        invalidCharacters: safeTemporaryFileName('a:b?.txt'),
        reservedWasReplaced: reserved !== 'CON.txt' && reserved.length > 0,
      },
      { ordinary: 'report 2026.txt', invalidCharacters: 'a_b_.txt', reservedWasReplaced: true }
    );
  });

  it('서버 파일 크기·수정 시각·종류 변경을 충돌로 판정한다', () => {
    const original = { isDirectory: false, isSymbolicLink: false, size: 10, mtime: 100, mode: 0o644 };
    assert.deepStrictEqual(
      {
        same: remoteFileChanged(original, { ...original }),
        size: remoteFileChanged(original, { ...original, size: 11 }),
        time: remoteFileChanged(original, { ...original, mtime: 101 }),
        kind: remoteFileChanged(original, { ...original, isDirectory: true }),
      },
      { same: false, size: true, time: true, kind: true }
    );
  });
});
