import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ConnectionEnvironment, DialectId } from '../types';
import { dialectIconFileName, ICON_DIRECTORY } from './dialectIconName';

/**
 * 아이콘이 빠지면 트리에 빈 칸이 남을 뿐, 오류도 로그도 없다.
 * 그래서 "이름 규칙"이 아니라 **실제 파일**과 대조한다.
 * 방언을 추가하고 scripts/build-icons.js 를 다시 돌리지 않으면 여기서 걸린다.
 */

const DIALECTS: DialectId[] = ['mysql', 'mariadb', 'postgres', 'oracle'];
const ENVIRONMENTS: ConnectionEnvironment[] = ['development', 'staging', 'production'];

/** dist-test/views/… 에서 저장소 뿌리로 거슬러 올라간다. */
const repoRoot = path.resolve(__dirname, '..', '..');

describe('dialectIconFileName', () => {
  it('환경이 개발이면 접미사를 붙이지 않는다', () => {
    assert.equal(
      dialectIconFileName('postgres', { connected: true, environment: 'development' }),
      'postgres-on.svg',
    );
  });

  it('연결 상태와 환경을 이름에 담는다', () => {
    assert.equal(
      dialectIconFileName('mysql', { connected: false, environment: 'production' }),
      'mysql-off-production.svg',
    );
    assert.equal(
      dialectIconFileName('oracle', { connected: true, environment: 'staging' }),
      'oracle-on-staging.svg',
    );
  });
});

describe('아이콘 파일', () => {
  it('방언 × 연결 상태 × 환경 조합이 모두 존재한다', () => {
    const missing: string[] = [];
    for (const dialect of DIALECTS) {
      for (const connected of [true, false]) {
        for (const environment of ENVIRONMENTS) {
          const name = dialectIconFileName(dialect, { connected, environment });
          if (!existsSync(path.join(repoRoot, ICON_DIRECTORY, name))) {
            missing.push(name);
          }
        }
      }
    }
    assert.deepEqual(
      missing,
      [],
      `아이콘이 없습니다. \`npm run icons\` 로 다시 만드세요: ${missing.join(', ')}`,
    );
  });
});
