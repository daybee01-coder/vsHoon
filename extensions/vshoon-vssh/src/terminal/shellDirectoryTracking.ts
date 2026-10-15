/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

export type TrackableShell = 'bash' | 'zsh' | 'fish';

const DIRECTORY_SEQUENCE_PREFIX = '\x1b]697;VShoonCwd=';
const DIRECTORY_SEQUENCE_TERMINATOR = '\x07';

export function trackableShellFromPath(shellPath: string): TrackableShell | undefined {
  const reportedPath = shellPath.trim().split(/\r?\n/).at(-1) ?? '';
  const name = path.posix.basename(reportedPath).toLowerCase();
  if (name === 'bash' || name === 'zsh' || name === 'fish') {
    return name;
  }
  return undefined;
}

/**
 * 설치 명령은 ECHO를 끈 PTY에 처음 입력되므로 화면에는 나타나지 않는다. 각 셸의 기존 프롬프트
 * 동작을 보존하면서 프롬프트 직전에 VShoon 전용 OSC로 현재 경로만 알린다.
 */
export function directoryTrackingBootstrap(shell: TrackableShell): string {
  const emit = `printf '\\033]697;VShoonCwd=%s\\007' "$PWD"`;
  const prepare = ` stty echo; printf '\\r\\033[2K'`;
  switch (shell) {
    case 'bash':
      return `${prepare}; __vshoon_emit_cwd(){ ${emit}; }; if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then PROMPT_COMMAND+=(__vshoon_emit_cwd); else PROMPT_COMMAND="__vshoon_emit_cwd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"; fi; __vshoon_emit_cwd\n`;
    case 'zsh':
      return `${prepare}; __vshoon_emit_cwd(){ ${emit}; }; autoload -Uz add-zsh-hook; add-zsh-hook precmd __vshoon_emit_cwd; __vshoon_emit_cwd\n`;
    case 'fish':
      return `${prepare}; function __vshoon_emit_cwd --on-event fish_prompt; ${emit}; end; __vshoon_emit_cwd\n`;
  }
}

export function isTrackableRemoteDirectory(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && value.startsWith('/') && !/[\0\r\n\x07\x1b]/.test(value);
}

export interface DirectorySequenceResult {
  readonly output: string;
  readonly directories: readonly string[];
}

/** 스트림 청크 경계에 걸친 VShoon 경로 OSC를 제거하고 경로 이벤트로 분리한다. */
export class ShellDirectorySequenceParser {
  private pending = '';

  push(chunk: string): DirectorySequenceResult {
    let input = this.pending + chunk;
    this.pending = '';
    let output = '';
    const directories: string[] = [];

    while (input.length > 0) {
      const markerIndex = input.indexOf(DIRECTORY_SEQUENCE_PREFIX);
      if (markerIndex < 0) {
        const retained = matchingPrefixSuffixLength(input, DIRECTORY_SEQUENCE_PREFIX);
        output += retained ? input.slice(0, -retained) : input;
        this.pending = retained ? input.slice(-retained) : '';
        break;
      }

      output += input.slice(0, markerIndex);
      const valueStart = markerIndex + DIRECTORY_SEQUENCE_PREFIX.length;
      const terminatorIndex = input.indexOf(DIRECTORY_SEQUENCE_TERMINATOR, valueStart);
      if (terminatorIndex < 0) {
        if (input.length - valueStart > 4096) {
          output += input.slice(markerIndex);
          break;
        }
        this.pending = input.slice(markerIndex);
        break;
      }

      const directory = input.slice(valueStart, terminatorIndex);
      if (isTrackableRemoteDirectory(directory)) {
        directories.push(directory);
      }
      input = input.slice(terminatorIndex + DIRECTORY_SEQUENCE_TERMINATOR.length);
    }

    return { output, directories };
  }

  flush(): string {
    const pending = this.pending;
    this.pending = '';
    return pending;
  }
}

function matchingPrefixSuffixLength(value: string, prefix: string): number {
  const maximum = Math.min(value.length, prefix.length - 1);
  for (let length = maximum; length > 0; length--) {
    if (value.endsWith(prefix.slice(0, length))) {
      return length;
    }
  }
  return 0;
}
