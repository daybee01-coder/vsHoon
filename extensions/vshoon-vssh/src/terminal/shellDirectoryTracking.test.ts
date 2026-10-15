/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  directoryTrackingBootstrap,
  isTrackableRemoteDirectory,
  ShellDirectorySequenceParser,
  trackableShellFromPath,
} from './shellDirectoryTracking';

describe('SSH shell directory tracking', () => {
  it('지원하는 로그인 셸만 식별한다', () => {
    assert.strictEqual(trackableShellFromPath('/bin/bash\n'), 'bash');
    assert.strictEqual(trackableShellFromPath('/usr/bin/zsh'), 'zsh');
    assert.strictEqual(trackableShellFromPath('/usr/local/bin/fish'), 'fish');
    assert.strictEqual(trackableShellFromPath('login notice\n/bin/bash\n'), 'bash');
    assert.strictEqual(trackableShellFromPath('/bin/tcsh'), undefined);
  });

  it('기존 프롬프트에 경로 신호를 추가하고 입력 에코를 즉시 복원한다', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const bootstrap = directoryTrackingBootstrap(shell);
      assert.ok(bootstrap.startsWith(' stty echo;'));
      assert.match(bootstrap, /\\033\[2K/);
      assert.match(bootstrap, /VShoonCwd/);
      assert.match(bootstrap, /__vshoon_emit_cwd/);
      assert.ok(bootstrap.endsWith('\n'));
    }
  });

  it('청크 경계의 경로 신호를 화면 출력에서 제거한다', () => {
    const parser = new ShellDirectorySequenceParser();
    const first = parser.push('before\x1b]697;VSho');
    const second = parser.push('onCwd=/srv/app\x07after');

    assert.deepStrictEqual(first, { output: 'before', directories: [] });
    assert.deepStrictEqual(second, { output: 'after', directories: ['/srv/app'] });
    assert.strictEqual(parser.flush(), '');
  });

  it('여러 경로를 순서대로 내보내고 잘못된 경로는 무시한다', () => {
    const parser = new ShellDirectorySequenceParser();
    const result = parser.push(
      '\x1b]697;VShoonCwd=/one\x07x\x1b]697;VShoonCwd=relative\x07y\x1b]697;VShoonCwd=/two space\x07'
    );

    assert.deepStrictEqual(result, { output: 'xy', directories: ['/one', '/two space'] });
    assert.strictEqual(isTrackableRemoteDirectory('/valid'), true);
    assert.strictEqual(isTrackableRemoteDirectory('relative'), false);
    assert.strictEqual(isTrackableRemoteDirectory('/bad\npath'), false);
  });

  it('끝나지 않는 비정상 경로 신호를 무한히 버퍼링하지 않는다', () => {
    const parser = new ShellDirectorySequenceParser();
    const malformed = `\x1b]697;VShoonCwd=/${'x'.repeat(4097)}`;
    assert.deepStrictEqual(parser.push(malformed), { output: malformed, directories: [] });
    assert.strictEqual(parser.flush(), '');
  });
});
