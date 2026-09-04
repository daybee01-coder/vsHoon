'use strict';

/**
 * 통합 테스트용 `vscode` 모듈 대역.
 *
 * 드라이버 코드가 vscode 를 직접 쓰지는 않지만, 로거를 거쳐 간접적으로 끌어온다.
 * 확장 호스트 밖(순수 node)에서 드라이버를 돌리려면 그 자리에 무엇이든 있어야 한다.
 *
 * 일부러 최소한만 구현한다. 여기 없는 API 를 드라이버가 쓰기 시작하면
 * 그 순간 오류로 드러나야 한다 — 조용히 undefined 를 돌려주면
 * "테스트는 통과했는데 확장에서는 안 되는" 상태가 된다.
 */

/** 로그는 버리되, DBCONN_IT_LOG=1 이면 콘솔로 흘린다 (드라이버 디버깅용). */
const verbose = process.env.DBCONN_IT_LOG === '1';

function createOutputChannel(name) {
  const write = (level, message) => {
    if (verbose) {
      console.log(`[${name}:${level}] ${message}`);
    }
  };
  return {
    name,
    appendLine: (m) => write('info', m),
    append: (m) => write('info', m),
    error: (m) => write('error', m),
    warn: (m) => write('warn', m),
    info: (m) => write('info', m),
    debug: (m) => write('debug', m),
    trace: (m) => write('trace', m),
    show: () => undefined,
    hide: () => undefined,
    clear: () => undefined,
    replace: () => undefined,
    dispose: () => undefined,
  };
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

module.exports = {
  window: { createOutputChannel },
  workspace: {
    // 설정은 전부 기본값으로 본다. 통합 테스트는 사용자 설정에 좌우되면 안 된다.
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
  },
  EventEmitter,
  Disposable: {
    from: (...items) => ({
      dispose: () => items.forEach((item) => item?.dispose?.()),
    }),
  },
};
