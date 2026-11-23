/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MouseReportingFilter } from './mouseReportingFilter';

describe('SSH mouse reporting filter', () => {
  it('마우스 보고 모드만 지우고 나머지 출력과 다른 DEC 모드는 남긴다', () => {
    const filter = new MouseReportingFilter();
    assert.deepStrictEqual(
      [
        // vim 시작: 대체 화면 + 마우스 보고(1000, 1006)
        filter.push('\x1b[?1049h\x1b[?1000h\x1b[?1006hvim'),
        // 한 시퀀스에 섞인 모드
        filter.push('\x1b[?1049;1002;1006l'),
        filter.push('\x1b[?25h\x1b[?2004h'),
        filter.push('plain text'),
      ],
      ['\x1b[?1049hvim', '\x1b[?1049l', '\x1b[?25h\x1b[?2004h', 'plain text']
    );
  });

  it('청크 경계에서 잘린 시퀀스를 이어 붙여 처리한다', () => {
    const filter = new MouseReportingFilter();
    assert.deepStrictEqual(
      [filter.push('a\x1b'), filter.push('[?10'), filter.push('00hb\x1b[?'), filter.push('25l'), filter.push('c\x1b['), filter.flush()],
      ['a', '', 'b', '\x1b[?25l', 'c', '\x1b[']
    );
  });
});
