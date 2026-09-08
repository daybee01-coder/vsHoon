# 성능 개선 1차: SQL 초안 스냅샷

대상: [성능 개선 가이드](performance-improvement-guide.md)의 P0 및 P1-A. 작성일: 2026-09-08.

## 범위와 기준선

이번 작업은 전체 가이드 완료가 아니라 첫 번째 작은 변경이다. P0 배포판 기준선은 아직 미완료이며, 배포 형식별 성능 차이를 판단하지 않는다. 별도로 코드에서 확인한 P1-A의 중복 조회만 제거했다.

- `npm run sync:check`: 로컬 코어·패치 검사 통과, 변경 전 오버레이 503개 동기화 확인. GitHub 연결 실패로 원격 upstream drift 보고는 생략됐다.
- 코어: `1.137.0`, `6b606c6c85f184ce581f4d898e590a093e213ba3`.
- 작업 폴더의 `VSCode-win32-x64/resources/app/product.json`은 아직 `nameShort: VShoon`이다. 현재 소스의 `vs Hoon`과 달라 해당 산출물을 현재 소스의 비교 기준선으로 사용하지 않았다.
- 시스템 Node는 `24.19.0`, 코어 `.nvmrc`는 `24.18.0`이다. 공식 배포처에서 Node `24.18.0`을 `.build/tools/node-v24.18.0`에 받아 공식 SHA-256 목록과 검증했다. 테스트 명령의 PATH에만 적용했으며 시스템 설치는 변경하지 않았다. 도구는 gitignore 대상의 재사용 가능한 로컬 검증 의존성이다.
- 사용자 프로필·캐시·DB·SSH 서버에 접근하거나 설정을 변경하지 않았다. 새 패키징은 수행하지 않았다.

## 변경 내용

[scriptCache.ts](../extensions/vshoon-dbconn/src/features/scriptCache.ts)의 기존 흐름은 캐시 대상일 때 `shouldCache`의 길이 검사와 `schedule`의 저장 준비에서 `getText()`를 각각 호출했다.

현재는 [scriptSnapshot.ts](../extensions/vshoon-dbconn/src/features/scriptSnapshot.ts)의 `readScriptSnapshot`이 대상 검사 후 텍스트를 한 번 확보하고, 같은 문자열로 크기를 검사해 `lastText`에 전달한다. 함수는 vscode의 타입만 참조하므로 별도 확장 호스트 없이 대상 정책과 호출 횟수를 테스트할 수 있다.

| 조건 | 변경 전 코드의 조회 횟수 | 변경 후 단위 테스트로 확인한 조회 횟수 |
| --- | --- | --- |
| 캐시 가능한 SQL, 1~1,000,000문자 | 2 | 1 |
| 빈 SQL 또는 제한 초과 SQL | 1 | 1 |
| 캐시 꺼짐, SQL 아님, 저장된 일반 파일 | 0 | 0 |

이는 `getText()` 호출 수 비교이며 실행 시간·할당 바이트·앱 반응 속도의 측정값은 아니다. “앱이 50% 빨라졌다”는 의미가 아니다. 텍스트 API의 내부 문자열 재사용 여부에 따라 실제 이득은 다를 수 있다.

유지한 동작:

- SQL이면서 untitled 또는 dirty인 문서만 캐시한다. clean untitled도 기존과 동일하게 허용한다.
- 빈 내용과 1,000,000문자 초과 내용은 신규 스냅샷 대상에서 제외한다.
- 스냅샷은 이벤트 시점에 즉시 확보한다. 텍스트 읽기를 타이머 뒤로 미루지 않는다.
- 1초 debounce, 닫기 시 flush, 저장 시 forget, 파일/인덱스 저장과 복원 로직은 변경하지 않았다.
- 콘텐츠 없는 이벤트 생략, 증분 스냅샷, 자동 저장과의 중복 쓰기 제거는 아직 구현하지 않았다. 크기 초과/빈 내용 전환 시 기존 스냅샷 처리 등 기존 정책의 변경도 별도 검토 대상으로 남긴다.

## 검증

- `npm run test:dbconn`: 해당 확장 컴파일 오류 0, 24개 테스트 파일에서 342개 테스트 통과, 실패·건너뜀 0. Node `24.18.0` 사용.
- 새 [scriptSnapshot.test.ts](../extensions/vshoon-dbconn/src/features/scriptSnapshot.test.ts)의 11개 테스트: 1/10,000/100,000/1,000,000문자 단일 조회, 빈 내용/제한 초과, 비활성화/비SQL/저장된 파일의 조회 생략, clean untitled, 편집·paste·undo에 해당하는 연속 스냅샷과 마지막 문자열 보존.
- 이 테스트는 스냅샷 함수 단위 검증이다. 실제 편집기 닫기 이벤트·디스크 flush·저장 실패·복원 UI의 통합 검증을 수행했다고 간주하지 않는다.
- 첫 린트에서 기존 `scriptCache.ts`의 필수 파일 헤더 누락이 발견되어 해당 파일에 헤더를 추가했다. 이후 `npm run core -- exec -- eslint extensions/vshoon-dbconn/src/features/scriptSnapshot.ts extensions/vshoon-dbconn/src/features/scriptSnapshot.test.ts extensions/vshoon-dbconn/src/features/scriptCache.ts` 통과(오류·경고 0). npm의 기존 프로젝트 설정 경고는 별도로 출력됐다.
- 수정한 추적 파일의 `git diff --check` 통과. 이 기록의 로컬 링크 4개가 모두 존재하고 문자 손상 표시가 없음을 확인했다.
- Workbench/시작창/코어 계층을 변경하지 않아 광범위한 코어 빌드·layers·데스크톱 smoke는 이번 단계에서 실행하지 않았다. 실제 타이핑 지연, CPU/메모리 프로파일, 포터블/설치판 A/B 측정도 미실시다.

## 다음 단계

1. 사용자가 패키징한 동일 빌드의 ZIP/설치판으로 가이드의 P0 조건을 맞추고 시작/입력 지연 기준선을 수집한다. 기존 산출물이나 개발 실행의 시간을 배포판 기준선과 섞지 않는다.
2. SQL 연속 입력 프로파일에서 스냅샷 비용과 저장 I/O를 분리한다. 이번 호출 감소가 실제 체감에 미치는 영향은 이때 확인한다.
3. P1-B 파일 선택창은 느린 디렉터리 응답을 재현하는 테스트를 먼저 만들고, 조기 표시·요청 수명·행 리스너 정리를 독립 변경으로 진행한다.
4. JAR 격리와 P2 후보는 해당 시나리오 측정 및 데이터 보존 테스트 후 진행한다. 모든 후보를 한 번에 바꾸지 않는다.
