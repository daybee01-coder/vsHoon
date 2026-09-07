import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planImport, type ImportIdentity, type ImportItem } from './plan';

function identity(name: string, overrides: Partial<ImportIdentity> = {}): ImportIdentity {
  return {
    name,
    dialect: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'app',
    user: 'app',
    ...overrides,
  };
}

/** 계획만 보면 무엇이 저장될지 알 수 있어야 한다. */
function summary(items: ImportItem<ImportIdentity>[]) {
  return items.map((item) => [item.source.name, item.name, item.status]);
}

describe('planImport', () => {
  it('빈 저장소에는 모두 그대로 들어간다', () => {
    const plan = planImport([], [identity('dev'), identity('prod')]);
    assert.deepStrictEqual(summary(plan), [
      ['dev', 'dev', 'new'],
      ['prod', 'prod', 'new'],
    ]);
  });

  it('접속 정보까지 같으면 이미 있는 것으로 본다', () => {
    const plan = planImport([identity('dev')], [identity('dev')]);
    assert.deepStrictEqual(summary(plan), [['dev', 'dev', 'existing']]);
  });

  it('이름만 같고 접속 정보가 다르면 이름을 바꿔 넣는다', () => {
    const plan = planImport(
      [identity('dev', { host: 'old.example.com' })],
      [identity('dev'), identity('dev', { host: 'other.example.com' })],
    );
    assert.deepStrictEqual(summary(plan), [
      ['dev', 'dev (복사본)', 'renamed'],
      ['dev', 'dev (복사본 2)', 'renamed'],
    ]);
  });

  it('폴더가 다르면 같은 이름을 그대로 쓴다', () => {
    const plan = planImport(
      [identity('db', { folder: '운영' })],
      [
        identity('db', { folder: '개발' }),
        identity('db', { folder: '운영', host: 'other.example.com' }),
      ],
    );
    assert.deepStrictEqual(summary(plan), [
      ['db', 'db', 'new'],
      ['db', 'db (복사본)', 'renamed'],
    ]);
  });
});
