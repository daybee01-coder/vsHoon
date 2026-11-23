/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 원격 프로그램이 켜는 마우스 보고 모드(DECSET 1000·1002·1003 등)를 터미널에 전달하지 않는다.
 *
 * vim, less, tmux 같은 프로그램이 마우스 보고를 켜면 터미널은 드래그를 프로그램에 넘기고 직접 선택하지 않는다.
 * 그러면 `copyOnSelection`이 있어도 드래그로 복사할 수 없다. 이 요청을 걸러 내면 드래그는 항상 터미널 선택이
 * 되어 바로 복사된다. 휠은 대체 화면에서 방향키로 바뀌므로 vim·less 스크롤은 그대로 동작한다.
 */

/** 마우스 보고와 그 인코딩 방식. 이 번호만 지우고 같은 시퀀스의 다른 모드(예: 1049)는 남긴다. */
const MOUSE_MODES = new Set(['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016']);

/** `ESC [ ? 번호;번호 h|l` 형태의 DEC 개인 모드 설정. */
const PRIVATE_MODE = /\x1b\[\?([\d;]*)([hl])/g;

/** 청크 끝에서 잘린, 아직 끝나지 않은 DEC 개인 모드 시퀀스. */
const PARTIAL_PRIVATE_MODE = /\x1b(?:\[(?:\?[\d;]*)?)?$/;

export class MouseReportingFilter {
  private pending = '';

  /** 걸러 낸 출력을 돌려준다. 청크 끝에서 잘린 시퀀스는 다음 청크와 합쳐 처리한다. */
  push(data: string): string {
    let text = this.pending + data;
    this.pending = '';

    const partial = PARTIAL_PRIVATE_MODE.exec(text);
    if (partial) {
      this.pending = partial[0];
      text = text.slice(0, partial.index);
    }

    return text.replace(PRIVATE_MODE, (sequence, params: string, final: string) => {
      const modes = params.split(';');
      const kept = modes.filter((mode) => !MOUSE_MODES.has(mode));
      if (kept.length === modes.length) {
        return sequence;
      }
      return kept.length > 0 ? `\x1b[?${kept.join(';')}${final}` : '';
    });
  }

  /** 스트림이 끝날 때 남은 조각을 돌려준다. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}
