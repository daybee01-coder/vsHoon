'use strict';

/**
 * `require('vscode')` 를 대역 모듈로 돌린다.
 *
 * 확장 호스트 안에서만 존재하는 모듈이라, 순수 node 에서 드라이버를 돌리려면
 * 해석 단계에서 갈아 끼워야 한다. `node --require` 로 테스트보다 먼저 실행된다.
 */

const path = require('node:path');
const Module = require('node:module');

const STUB = path.join(__dirname, 'vscode.cjs');
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveWithVscodeStub(request, ...rest) {
  if (request === 'vscode') {
    return STUB;
  }
  return originalResolve.call(this, request, ...rest);
};
