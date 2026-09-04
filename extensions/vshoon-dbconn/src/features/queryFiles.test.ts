import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  queryDisplayName,
  queryFileName,
  sanitizeLabel,
  timeStamp,
  uniqueFileName,
} from './queryFiles';

const WHEN = new Date(2026, 7, 21, 14, 30, 5);

describe('sanitizeLabel', () => {
  it('한글·영문·숫자는 그대로 둔다', () => {
    assert.equal(sanitizeLabel('주문DB2'), '주문DB2');
  });

  it('경로 구분자와 금지 문자를 하이픈으로 바꾼다', () => {
    assert.equal(sanitizeLabel('운영/서울'), '운영-서울');
    assert.equal(sanitizeLabel('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h');
    assert.equal(sanitizeLabel('..\\..\\etc'), 'etc');
  });

  it('공백은 하이픈 하나로 모은다', () => {
    assert.equal(sanitizeLabel('운영  DB   서울'), '운영-DB-서울');
  });

  it('점만으로 된 이름이 되지 않는다', () => {
    assert.equal(sanitizeLabel('...'), '');
    assert.equal(sanitizeLabel('.'), '');
    assert.equal(sanitizeLabel('   '), '');
  });

  it('너무 길면 자르되 하이픈으로 끝나지 않는다', () => {
    const long = sanitizeLabel('가'.repeat(50));
    assert.equal(long.length, 32);
    assert.ok(!long.endsWith('-'));
  });
});

describe('queryFileName', () => {
  it('연결 이름과 시각을 담는다', () => {
    assert.equal(queryFileName(WHEN, '주문DB'), '주문DB_2026-08-21_143005.sql');
  });

  it('꼬리표가 없거나 남는 글자가 없으면 시각만', () => {
    assert.equal(queryFileName(WHEN), '2026-08-21_143005.sql');
    assert.equal(queryFileName(WHEN, '///'), '2026-08-21_143005.sql');
  });

  it('이름이 시간순으로 정렬된다', () => {
    const early = queryFileName(new Date(2026, 0, 2, 9, 5, 1));
    const late = queryFileName(new Date(2026, 0, 2, 10, 5, 1));
    assert.ok(early < late);
  });
});

describe('timeStamp', () => {
  it('한 자리 값도 두 자리로 채운다', () => {
    assert.equal(timeStamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02_030405');
  });
});

describe('uniqueFileName', () => {
  it('겹치지 않으면 그대로', () => {
    assert.equal(uniqueFileName('a.sql', ['b.sql']), 'a.sql');
  });

  it('겹치면 번호를 붙인다 — 기존 파일은 절대 덮어쓰지 않는다', () => {
    assert.equal(uniqueFileName('a.sql', ['a.sql']), 'a-2.sql');
    assert.equal(uniqueFileName('a.sql', ['a.sql', 'a-2.sql']), 'a-3.sql');
  });

  it('대소문자가 달라도 같은 이름으로 본다 (윈도 파일 시스템)', () => {
    assert.equal(uniqueFileName('A.sql', ['a.sql']), 'A-2.sql');
  });
});

describe('queryDisplayName', () => {
  it('확장자를 뗀다', () => {
    assert.equal(queryDisplayName('주문DB_2026-08-21_143005.sql'), '주문DB_2026-08-21_143005');
    assert.equal(queryDisplayName('이름.SQL'), '이름');
  });
});
