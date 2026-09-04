import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENVIRONMENTS,
  environmentBadge,
  environmentLabel,
  environmentStatusBackground,
  isProduction,
  normalizeEnvironment,
} from './environment';

describe('환경 표시', () => {
  it('개발은 조용히 둔다', () => {
    assert.equal(environmentBadge('development'), undefined);
    assert.equal(environmentStatusBackground('development'), undefined);
  });

  it('운영은 빨간색으로 강조한다', () => {
    assert.equal(environmentBadge('production'), '운영');
    assert.equal(environmentStatusBackground('production'), 'statusBarItem.errorBackground');
  });

  it('스테이징은 노란색으로 구분한다', () => {
    assert.equal(environmentBadge('staging'), '스테이징');
    assert.equal(environmentStatusBackground('staging'), 'statusBarItem.warningBackground');
  });

  it('모든 환경에 라벨이 있다', () => {
    for (const environment of ENVIRONMENTS) {
      assert.ok(environmentLabel(environment).length > 0);
    }
  });

  it('isProduction 은 운영에서만 참', () => {
    assert.equal(isProduction('production'), true);
    assert.equal(isProduction('staging'), false);
    assert.equal(isProduction('development'), false);
  });
});

describe('normalizeEnvironment', () => {
  it('저장된 값이 없거나 이상하면 개발로 본다', () => {
    // 이전 버전 프로필에는 environment 가 없다. 그것을 운영으로 오인하면
    // 경고가 남발되고, 반대로 운영을 개발로 낮추면 안전장치가 사라진다 —
    // 없으면 개발이 맞는 기본값이다.
    assert.equal(normalizeEnvironment(undefined), 'development');
    assert.equal(normalizeEnvironment(''), 'development');
    assert.equal(normalizeEnvironment('prod'), 'development');
    assert.equal(normalizeEnvironment(42), 'development');
  });

  it('올바른 값은 그대로 통과한다', () => {
    assert.equal(normalizeEnvironment('production'), 'production');
    assert.equal(normalizeEnvironment('staging'), 'staging');
    assert.equal(normalizeEnvironment('development'), 'development');
  });
});
