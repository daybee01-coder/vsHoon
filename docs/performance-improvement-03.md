# 성능 개선 3차: 검색 범위에 필요한 미저장 문서만 전달

작성일: 2026-09-09. 대상: [성능 개선 가이드](performance-improvement-guide.md)의 P2-B 중 dirty 문서 수집.

## 이어받은 상태와 범위

- 작업 시작 시 HEAD는 `6c6721d`이며 작업 트리는 깨끗했다. 기존 SQL 변경과 Claude Code가 진행한 [파일 선택창 2차 변경](performance-improvement-02.md)을 확인하고 보존했다.
- `npm run sync:check -- --offline` 통과: 코어 `1.137.0`, `6b606c6c85f184ce581f4d898e590a093e213ba3`, 오버레이 507개 동기화. 원격 최신 여부는 검사하지 않았다.
- 검증에는 기존 `.build/tools/node-v24.18.0`을 명령별 PATH로 사용했다. 시스템 Node·사용자 프로필·캐시는 변경하지 않았다.
- P0 배포판 비교와 2차 대화상자 실사용 검증은 여전히 남아 있다. JAR worker 격리는 데이터 보존·취소 검증을 준비한 뒤 별도 변경으로 진행한다. 이번에는 그 구조 변경과 독립적으로 검증할 수 있는 검색 준비 단계의 불필요한 스냅샷을 제거했다.

## 변경

[searchEngine.ts](../extensions/vshoon-vsearch/src/searchEngine.ts)는 검색할 로컬 경로 목록을 이미 확보한 뒤에도, 열린 모든 dirty `file:` 문서의 `getText()`를 호출해 worker에 전달했다. worker는 자신의 `paths`에 있는 키만 조회하므로 범위 밖 문서의 텍스트는 사용하지 않았다.

현재는 [dirtyTexts.ts](../extensions/vshoon-vsearch/src/dirtyTexts.ts)의 `collectDirtyTexts(paths, documents)`에 확정된 검색 경로와 문서 목록을 전달한다.

- 검색 대상에 포함된 dirty 로컬 문서만 읽는다. 제외된 파일·다른 폴더의 문서는 `getText()` 호출과 worker 입력에서 빠진다.
- 경로 비교는 기존 worker의 정확한 문자열 키 조회와 일치시킨다. 대소문자 변환·경로 정규화를 새로 적용하지 않는다.
- 대상 경로 집합은 첫 dirty 로컬 문서가 있을 때만 만든다. 해당 문서가 없는 경우 경로 집합을 만들지 않고, 검색 경로가 비어 있으면 즉시 반환한다.
- 빈 미저장 내용과 큰 미저장 내용은 그대로 전달한다. 새 크기 제한으로 결과를 누락시키지 않는다.
- 파일 열거·제외 규칙·정규식·치환·worker 격리·취소·시간 제한·웹뷰·검색 debounce는 변경하지 않았다.

추가 경로 집합에는 검색 대상 수에 비례하는 비용이 있다. 모든 미저장 문서가 검색 범위 안에 있으면 텍스트 전달량 감소는 없으므로, 모든 상황에서 빨라진다고 주장하지 않는다.

## 검증 결과

- `npm run test:vsearch`: 컴파일 오류 0, 테스트 파일 2개 통과. 새 단위/worker 테스트 6개와 기존 매칭 검사 18개가 모두 통과했다. Node 테스트 러너 요약은 기존 JS 파일을 한 테스트로 세어 총 7개 통과로 표시한다.
- `npm run core -- exec -- eslint extensions/vshoon-vsearch/src/dirtyTexts.ts extensions/vshoon-vsearch/src/dirtyTexts.test.ts extensions/vshoon-vsearch/src/searchEngine.ts`: 오류·경고 0. 기존 npm 프로젝트 설정 경고는 별도 출력됐다.
- 첫 컴파일/린트에서 신규 함수의 중괄호 누락을 발견했고 수정 후 위 검사를 재실행해 통과했다.
- `git diff --check` 통과. Git의 CRLF → LF 안내는 출력되었지만 공백 오류는 없었다.

[dirtyTexts.test.ts](../extensions/vshoon-vsearch/src/dirtyTexts.test.ts)의 검증 내용:

1. 검색 대상인 dirty 로컬 문서만 읽고, 범위 밖·저장된 파일·원격·untitled 문서는 읽지 않음.
2. 검색 경로가 비어 있으면 텍스트 조회 없음.
3. 빈 문자열과 6Mi 문자 미저장 문서를 새로운 제한 없이 전달.
4. Windows 형태의 한글 경로에서 대소문자 키 비교를 임의로 바꾸지 않음.
5. 각 10,000문자인 합성 dirty 문서 100개 중 2개만 검색할 때 실제 조회 2회, 전달 문자열 합계 20,000문자 확인. 이전 코드대로 모두 수집하면 100회·1,000,000문자가 되는 입력이다. 시간·실제 할당 바이트 측정은 아니다.
6. 실제 검색 worker를 두 번 실행해 전체 dirty 입력과 필터된 입력의 결과 메시지가 같은지 비교. 검색 대상의 최신 미저장 내용, 빈 내용, 기존 dirty 경로의 크기 제한 동작을 유지함을 확인했다. 사용자 문서나 DB에는 접근하지 않았다.

실제 검색 시간·CPU·메모리 프로파일, Workbench 실행·모달 UI·Remote·취소 통합 테스트는 이번 단계에서 수행하지 않았다. 제품 코어를 수정하지 않아 코어 빌드/layers/patch 저장도 실행하지 않았다. 패키징·커밋·원격 push는 하지 않았다.

## 남은 작업

1. P0: 동일 빌드 ZIP/설치판의 환경·프로필·캐시 조건을 맞춘 A/B 측정.
2. P1-B: 빌드 후 파일 선택창의 조기 표시·취소·키보드·빠른 연속 이동·원격 provider 실사용 검증. 2차 기록의 미확인 사항을 완료로 바꾸지 않는다.
3. P1-C: JAR 작업의 기준선 및 데이터 보존 테스트, worker 격리·취소·안전한 결과 교체 설계.
4. P2-B: 실제 검색에서 경로 열거·스냅샷·worker 시작·첫 배치 시간을 분리해 측정. 웹뷰 초기화·가상화·상주 worker는 별도 판단.
5. P2-A/C/D: SFTP 로컬 stat 동시성, 시작창 전환 수명, 쿼리 이전/목록 반복 조회는 아직 미구현.
