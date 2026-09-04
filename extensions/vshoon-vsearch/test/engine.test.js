// 순수 매칭 로직(matcher.ts) 테스트. vscode 모듈에 의존하지 않으므로 스텁이 필요 없다.
const path = require('path');
const e = require(path.join(__dirname, '..', 'out', 'matcher.js'));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
    console.log('  OK   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + '\n       기대: ' + b + '\n       실제: ' + a);
  }
}

const text = 'const foo = 1;\r\nlet foobar = foo + 2;\nFOO();';

// 1) 기본 문자열 검색 (대소문자 무시)
let m = e.findMatches(text, e.buildMatcher('foo', { regex: false, caseSensitive: false, wholeWord: false }), 100);
check('대소문자 무시 검색 개수', m.matches.length, 4);
check('첫 일치 위치(line, column)', [m.matches[0].line, m.matches[0].column], [0, 6]);
check('마지막 일치 라인', m.matches[3].line, 2);

// 2) 대소문자 구분
m = e.findMatches(text, e.buildMatcher('foo', { regex: false, caseSensitive: true, wholeWord: false }), 100);
check('대소문자 구분 검색 개수', m.matches.length, 3);

// 3) 단어 단위
m = e.findMatches(text, e.buildMatcher('foo', { regex: false, caseSensitive: true, wholeWord: true }), 100);
check('단어 단위 검색 개수', m.matches.length, 2);

// 4) 정규식 + 그룹 치환
const re = e.buildMatcher('let (\\w+)', { regex: true, caseSensitive: true, wholeWord: false });
const one = re.exec('let foobar = foo + 2;');
check('정규식 매치 성공', one !== null, true);
check('정규식 치환 확장 ($1, $&)', e.expandReplacement('const $1 /* $& */', one), 'const foobar /* let foobar */');
check('$$ 이스케이프', e.expandReplacement('$$1', one), '$1');

// 5) 비정규식 모드에서 특수문자는 리터럴로 취급
m = e.findMatches('a.b axb', e.buildMatcher('a.b', { regex: false, caseSensitive: true, wholeWord: false }), 100);
check('리터럴 점(.) 검색', m.matches.length, 1);

// 6) 줄 나누기 (CRLF / LF 혼용)
const lines = e.splitLines(text);
check('줄 개수', lines.length, 3);
check('두번째 줄 시작 오프셋', lines[1].start, 16);
check('두번째 줄 내용', lines[1].text, 'let foobar = foo + 2;');

// 7) 길이 0 매치는 결과에 넣지 않는다
//    (넣으면 "빈 범위 치환" = 문자 삽입이 되어 바꾸기가 파일을 망가뜨린다)
m = e.findMatches('abc', e.buildMatcher('x*', { regex: true, caseSensitive: true, wholeWord: false }), 50);
check('길이 0 매치는 제외', m.matches.length, 0);
m = e.findMatches('abcx', e.buildMatcher('x*', { regex: true, caseSensitive: true, wholeWord: false }), 50);
check('길이 0 은 빼고 실제 매치만', m.matches.map((x) => [x.column, x.length]), [[3, 1]]);

// 8) 파일당 최대 일치 개수 제한
m = e.findMatches('aaaaa', e.buildMatcher('a', { regex: false, caseSensitive: true, wholeWord: false }), 3);
check('최대 개수 제한', [m.matches.length, m.truncated], [3, true]);

// 9) 긴 줄 미리보기 잘라내기
const longLine = 'x'.repeat(200) + 'TARGET' + 'y'.repeat(200);
m = e.findMatches(longLine, e.buildMatcher('TARGET', { regex: false, caseSensitive: true, wholeWord: false }), 10);
const item = m.matches[0];
check('미리보기 안에서의 일치 위치가 맞는지', item.preview.substr(item.previewColumn, 6), 'TARGET');
check('미리보기 길이 제한', item.preview.length <= 301, true);

// 10) 지나치게 긴 한 줄은 건너뛴다 (압축 파일에서 정규식이 폭주하는 것을 막는다)
const hugeLine = 'a'.repeat(e.MAX_LINE_LENGTH + 10);
m = e.findMatches(hugeLine, e.buildMatcher('a', { regex: false, caseSensitive: true, wholeWord: false }), 10);
check('한계를 넘는 줄은 검사하지 않음', m.matches.length, 0);

console.log('\n통과 ' + pass + ' / 실패 ' + fail);
process.exit(fail === 0 ? 0 : 1);
