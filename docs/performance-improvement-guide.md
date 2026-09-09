# VShoon 성능 개선 가이드

작성일: 2026-09-08 · 대상: [Development.md](../Development.md)의 8번 기능 개선

상태: **5차 구현 진행: P1-A·P1-B·P2-A·P2-B에 이어 P2-D의 쿼리 보관 목록 순차 stat 제거. P0 배포판 A/B 측정은 여전히 미실시**.
진행 내용과 검증 결과는 [1차 작업 기록](performance-improvement-01.md), [2차 작업 기록](performance-improvement-02.md), [3차 작업 기록](performance-improvement-03.md), [4차 작업 기록](performance-improvement-04.md), [5차 작업 기록](performance-improvement-05.md)에 별도로 남긴다. 아래 정적 조사 내용은 변경 전 기준이다.
기준 코어는 [vshoon.lock.json](../vshoon.lock.json)의 Code - OSS `1.137.0`, 커밋 `6b606c6c85f184ce581f4d898e590a093e213ba3`이다. 현재 작업 트리의 7번 변경까지 포함해 조사했다. 기존 배포 파일에 같은 변경이 포함됐다고 가정하지 않는다.

## 1. 결론과 조사 범위

- 포터블 전용으로 편집·렌더링 엔진이 느려지는 분기는 조사한 초기화 경로에서 확인되지 않았다. **설치판보다 실제로 느린지는 아직 미확인**이다. 같은 빌드라도 데이터·캐시·임시 파일의 위치, 저장장치, 보안 검사, 프로필 상태에 따라 차이가 날 수 있다.
- 개발 실행과 최적화된 배포판 비교는 먼저 분리해야 한다. 현재 코어는 개발 모드에서 V8 코드 캐시를 사용하지 않는다. 기존 smoke 실행도 성능 비교용이 아니다.
- 반복 작업이나 큰 입력에서 비용이 커질 수 있는 코드가 있다. SQL 편집 이벤트의 전체 텍스트 조회, 파일 선택창의 전체 행 생성, JAR의 동기 압축 처리, SFTP **로컬 패널**의 무제한 메타데이터 조회가 우선 후보다.
- VSearch는 기존 검색과 구조가 다르므로 `Ctrl+Shift+F` 체감 차이를 Workbench 전체 지연과 구분해야 한다. 이미 worker·배치·취소·결과 제한이 있으나, 입력 대기와 검색 준비·웹뷰 초기화 비용은 따로 확인할 필요가 있다.
- 위 코드 경로의 존재는 확인했지만 CPU 프로파일이나 A/B 측정은 하지 않았다. 어느 항목도 현재 체감 저하의 확정 원인 또는 개선율로 보고하지 않는다.

조사 대상은 제품 시작 경로, 파일 선택창, 내장 확장의 활성화·입출력·검색·웹뷰, 포터블 초기화 및 기존 검증 스크립트다. 사용자 데이터, 실제 SSH 서버·DB, 배포판 실행 결과는 조사하지 않았다.

## 2. 포터블과 설치판을 비교하기 전에

### 2.1 실제로 달라지는 경로

다음은 Windows에서 별도 경로 옵션이 없는 경우의 기본값이다. `.vshoon`이 모든 데이터의 저장 위치인 것은 아니다.

| 항목 | 일반 실행 | 포터블 실행 |
| --- | --- | --- |
| 사용자 데이터 | `%APPDATA%/<product.nameShort>` | `<portable>/user-data` |
| 사용자 설치 확장 | 사용자 홈의 `.vshoon/extensions` | `<portable>/extensions` |
| 공유 데이터 | 사용자 홈 아래 제품의 `sharedDataFolderName` | `<portable>/shared-data` |
| V8 코드 캐시 | 사용자 데이터의 `CachedData/<product.commit>` | 같은 상대 경로, 포터블 데이터 안에 저장 |
| 임시 파일 | 시스템 기본 임시 경로 | `<portable>/tmp`가 있을 때만 해당 경로로 변경 |
| DBConn 기본 SQL 보관 폴더 | 사용자 홈의 `.vscode/dbconn/queries` | 현재 구현은 동일. 포터블 데이터로 자동 이동하지 않음 |

코어 근거는 `.core/src/bootstrap-node.ts`의 `configurePortable`, `.core/src/vs/platform/environment/node/userDataPath.ts`의 `doGetUserDataPath` 및 `getDefaultUserDataPath`, `.core/src/vs/platform/environment/common/environmentService.ts`의 `extensionsPath`·`appSharedDataHome`, `.core/src/main.ts`의 `getCodeCachePath`다. `.core`는 `npm run sync`로 구성하는 비추적 소스다.

주의할 점:

- 포터블 판정은 `product`에 `target`이 없고 포터블 데이터 디렉터리가 존재하는 경우다. Windows ZIP 실행 디렉터리의 `data` 또는 `VSCODE_PORTABLE` 지정 경로를 사용한다. 설치판 폴더에 `data`만 만들어 비교하지 않는다.
- 포터블 사용자 데이터는 `--user-data-dir`보다 우선한다. 반면 현재 고정 코어의 `extensionsPath`는 `--extensions-dir`, `VSCODE_EXTENSIONS`, 포터블 경로 순으로 판정하고, 공유 데이터도 명시적 옵션이 우선한다. 옵션으로 격리했다고 추정하지 말고 실제 경로를 기록한다.
- 일반적인 ZIP/설치판 지원 조건과 `data/tmp` 동작은 [공식 포터블 안내](https://code.visualstudio.com/docs/setup/portable)를 참고한다. 세부 우선순위는 이 저장소의 고정 코어 구현을 기준으로 확인한다.
- USB·네트워크·동기화 폴더와 내부 SSD를 비교하면 배포 형식과 저장장치 효과가 섞인다. 백신·인덱서의 개입은 측정할 가설이며 현재 원인으로 확인한 것이 아니다. 보안 기능을 일괄 해제하지 않는다.
- DBConn 경로는 [queryStore.ts](../extensions/vshoon-dbconn/src/features/queryStore.ts)의 `folderUri`가 정한다. `dbconn.scripts.folder`로 변경 가능하다. 포터블 측정에서도 이 폴더의 위치·파일 수를 맞춰야 한다. 향후 경로 변경은 별도의 데이터 이전 작업이지 단순 성능 최적화가 아니다.

### 2.2 캐시와 표시 이름 변경

`.core/src/main.ts`는 `--no-cached-data`, `VSCODE_DEV`, `product.commit` 부재 중 하나라도 해당하면 코드 캐시 경로를 만들지 않는다. 배포판에서는 실행 중인 제품의 커밋과 사용자 데이터 경로를 확인한다. 새 커밋의 첫 실행과 같은 커밋의 재실행을 섞지 않는다.

7번에서 `product.nameShort`를 `VShoon`에서 `vs Hoon`으로 변경했다. 코어는 `getUserDataPath(args, product.nameShort)`를 호출하므로 **기본 경로의 일반 배포 실행은 `%APPDATA%/VShoon`에서 `%APPDATA%/vs Hoon`으로 달라질 수 있다**. 포터블·명시적 경로·개발 실행에는 같은 결론을 그대로 적용할 수 없다. 이름 변경 전후 체감 차이는 실제 프로필과 캐시 재사용 여부부터 확인한다. 기존 데이터를 자동 이동하거나 삭제하지 않는다.

[smoke-start-window.mjs](../scripts/smoke-start-window.mjs)는 격리된 새 프로필과 `--no-cached-data` 등을 사용하는 기능 검증이다. 이 스크립트의 대기 시간·타임아웃, 빌드 소요 시간은 제품 시작 속도의 측정값이 아니다.

## 3. 후속 측정 절차

### 3.1 비교군

| 비교 | 통제할 조건 | 확인하려는 것 |
| --- | --- | --- |
| 동일 빌드의 ZIP 일반 모드 ↔ ZIP 포터블 모드 | 동일 SSD, 동일 코드와 확장, 복제한 데이터 상태 | 데이터 위치와 포터블 설정의 영향 |
| 동일 빌드 계열의 ZIP ↔ 설치판 | 컴파일된 앱 내용·버전 일치, 설치 메타데이터 차이 기록 | 설치 형식 자체와 경로 효과 |
| VShoon 내장 확장 켬 ↔ 개별 끔 | 같은 배포판·프로필 복제본·워크스페이스 | 기능별 확장 호스트 비용 |
| VShoon ↔ 대응 Code - OSS 빌드 | 가능한 한 같은 코어·Electron·빌드 최적화 | 제품 오버레이·패치의 영향 |
| VShoon ↔ 사용 중인 공식 VS Code | 버전·확장·언어·설정 차이 명시 | 실제 사용 체감. 차이 전부를 VShoon 변경 탓으로 해석하지 않음 |

ZIP과 설치판의 `product.target` 등은 다를 수 있으므로 제품 파일 전체 해시 일치를 요구하지 않는다. 핵심 JS·리소스·내장 확장이 같은 빌드에서 왔는지 확인한다. 새 패키징은 사용자가 수행하며, 이번 문서 작업에서 패키징하지 않는다.

1. 실행 파일 절대 경로, 앱/코어/Electron/Node 버전, 제품 커밋, 배포 방식, CPU·RAM·디스크, 전원 모드, 화면 배율, 언어를 기록한다. 개발 실행 여부와 실제 사용자 데이터·확장·공유 데이터·임시 경로도 기록한다.
2. 원본을 건드리지 않는 전용 테스트 프로필/포터블 데이터 복제본을 준비한다. 실행 중인 데이터 디렉터리를 복사하거나 두 프로세스가 같은 프로필을 동시에 쓰지 않는다. 설정·확장 버전·복원 창·SQL/JAR/SSH 세션 상태를 맞춘다.
3. 최초 프로필 시작, 기존 프로필의 앱 재시작, 재부팅 후 시작을 별도 집단으로 기록한다. 앱 재시작을 OS 디스크 캐시까지 비운 콜드 스타트라고 부르지 않는다. 사용자 캐시 삭제로 조건을 맞추지 않는다.
4. 워밍업 1회는 별도 기록하고 동일 조건에서 우선 10회 이상 번갈아 실행한다. 중앙값·최소/최대·원시값을 남긴다. 작은 차이는 반복 수를 늘려 재검증하며, 소수 표본으로 p95를 확정하지 않는다.
5. 프로파일러 없는 시간 측정과 프로파일러를 켠 원인 조사를 분리한다. 앱 프로세스가 모두 종료됐는지 확인해 첫 실행과 두 번째 인스턴스 전달 시간을 섞지 않는다.

### 3.2 내장 확장 분리 시 주의

고정 코어의 `.core/src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts`에서 `_isDisabledInEnv`는 전체 사용자 확장 비활성화 시 built-in을 제외한다. 따라서 `--disable-extensions`만으로 DBConn·VSsh·VSearch·Decom 비용이 제거됐다고 볼 수 없다.

별도 테스트 프로필에서 `--disable-extension vshoon.vshoon-dbconn`처럼 manifest의 `publisher.name`에 해당하는 ID를 개별 지정하고 실행 중인 확장 목록으로 확인한다. 다른 대상은 `vshoon.vshoon-vssh`, `vshoon.vshoon-vsearch`, `vshoon.vshoon-decom`이다. 전체 사용자 확장 비활성화와 개별 ID 옵션을 섞으면 앞 분기가 우선할 수 있으므로, 사용자 확장이 없는 격리 환경에서 개별 끄기 비교를 한다. SQL 편집·검색처럼 해당 기능을 측정할 때는 활성화된 정상 동작도 반드시 비교한다.

DBConn에는 `onLanguage:sql` 활성화 이벤트가 있다. 다른 내장 확장에 명시적인 `*`/`onStartupFinished`가 없더라도 명령·뷰·custom editor 기여 및 복원 상태에 따라 활성화될 수 있다. “이벤트 항목 없음 = 시작 비용 없음”으로 판정하지 않는다.

### 3.3 시나리오와 지표

| 시나리오 | 분리해서 기록할 지표 |
| --- | --- |
| 인자 없는 데스크톱 실행 | 프로세스 시작 → 시작창 첫 표시 → 키보드 입력 가능 |
| 시작창에서 프로젝트 선택 | 선택 → Workbench 표시 → 편집기 입력 가능. 창이 사라진 공백 시간 별도 |
| 폴더/파일 인자 직접 실행 | 시작 → Workbench 표시/입력 가능. 시작창 경유와 따로 비교 |
| SQL 입력 | 10KB/100KB/약 1백만 문자/제한 초과 문서, 입력 지연·확장 호스트 CPU·할당량·쓰기 횟수 |
| 파일 선택창과 SFTP 로컬 패널 | 100/1만/5만 항목에서 첫 표시·목록 준비·빠른 폴더 전환·메모리 |
| VSearch | 첫 열기/재열기, 마지막 키 입력 → 검색 시작/첫 결과/완료, 대량 결과 스크롤 |
| JAR 열기·재빌드 | 10/100/500MB 등 크기와 엔트리 수를 따로 기록, 다른 확장 명령의 지연·최대 메모리·취소 |
| 반복/유휴 | 창·모달 20회 열기/닫기 후 메모리 추세, 안정화 후 60초 CPU·타이머·디스크 I/O |

크기와 반복 수는 제안한 시험 입력이지 통과한 실측 결과가 아니다. 민감한 실제 SQL·SSH·프로젝트 대신 재현 가능한 테스트 데이터를 사용한다.

Process Explorer/`--status`로 main·renderer·extension host 등을 구분하고, `Developer: Show Running Extensions`에서 확장 호스트 프로파일을 수집한다. 렌더러 입력/스크롤은 개발자 도구 Performance, Workbench 시작은 Startup Performance 및 `--prof-startup`을 보조 자료로 사용한다. 방법은 [upstream 성능 조사 안내](https://github.com/microsoft/vscode/wiki/Performance-Issues)를 참고한다. CPU가 낮아도 I/O 대기일 수 있으므로 CPU만으로 배제하지 않는다.

콤팩트 시작창은 별도 renderer이므로 Workbench 시작 통계만으로 전체 구간을 설명할 수 없다. 후속 계측에서 시작 정책 진입, 시작창 표시/준비, 열기 요청, 목적 Workbench 준비 시점을 각각 남긴다. 개발 시작창 재현은 `VShoon: Start Window (desktop launch)` 구성을 사용한다. `scripts/code.bat`은 CLI 정책으로 우회하므로 시작창 측정에 사용하지 않는다. 배포판 비교에서는 명시적 대상 없는 실제 데스크톱 실행 조건을 유지한다.

## 4. 코드에서 확인한 개선 후보

P0는 비교 전제, P1은 우선 재현·개선할 후보, P2는 관련 증상 확인 후 진행할 후보다. 순위는 실측 효과 순위가 아니며 프로파일에 따라 조정한다.

### P0 — 배포판·프로필·캐시 기준선 확립

- 확인: 개발 실행은 코드 캐시를 끄며 이름/커밋 변경은 캐시 재사용 조건을 바꿀 수 있다. 포터블과 DBConn 데이터 위치도 다를 수 있다.
- 후속 작업: 3절의 비교표와 원시 측정값 작성. 같은 조건에서 차이가 없으면 포터블 전용 최적화는 보류한다.
- 완료 기준: 재현 절차와 실행 파일/프로필/캐시 상태가 타인이 반복할 수 있을 정도로 기록됨. 기존 사용자 설정·캐시 손상 없음.

### P1-A — SQL 편집마다 전체 문서를 읽는 초안 캐시

- 근거: [scriptCache.ts](../extensions/vshoon-dbconn/src/features/scriptCache.ts)의 `shouldCache`가 `getText().length`를 읽고, 이어 `schedule`이 다시 `getText()`를 호출한다. 1,000ms debounce는 이후 저장만 늦춘다. `MAX_CHARS = 1_000_000`도 전체 텍스트 조회 후 검사한다.
- 영향 가설: 큰 SQL의 연속 입력에서 전체 텍스트 조회/전달과 GC 비용이 누적될 수 있다. SQL 외 일반 편집 지연의 근거는 아니다.
- 후속 작업: 변경 버전과 이벤트 내용으로 중복 예약을 줄이고 같은 이벤트의 이중 `getText`부터 제거한다. 스냅샷 지연 또는 증분 반영은 닫기 직전 마지막 내용을 안전하게 확보하는 설계와 함께 진행한다. 단순히 타이머 안으로 옮기면 이미 닫힌 문서의 마지막 편집을 잃을 수 있다.
- 추가 확인: [queryStore.ts](../extensions/vshoon-dbconn/src/features/queryStore.ts)는 보관 폴더 SQL을 1,200ms 뒤 자동 저장한다. 두 기능이 켜진 문서는 초안 쓰기 → 원본 저장 → 초안 정리의 중복 I/O가 생길 수 있다. 두 저장의 실제 횟수와 복구 요구를 먼저 확인한다.
- 검증: 크기별 연속 입력·paste·undo/redo, 타이머 이전 닫기, 저장 실패, 자동 저장 on/off, 빈 문서·크기 제한 경계, 복원. 복구 품질을 낮추거나 자동 저장 범위를 일반 파일로 넓히지 않는다.

### P1-B — 파일 선택창의 늦은 표시와 행 수명 관리

- 진행: 조기 표시, 세대 기반 요청 수명, 렌더 단위 행 리스너를 구현했다. 큰 목록의 가상화와 실행 검증은 남아 있다. [2차 작업 기록](performance-improvement-02.md) 참고.
- 근거: [vshoonFileDialog.ts](../src/vs/vshoon/browser/fileDialog/vshoonFileDialog.ts)의 `show`는 `await render()` 뒤 `widget.show()`를 호출한다. `readChildren`은 디렉터리 항목을 읽어 정렬하고 `render`는 전체 행을 생성한다.
- 확인: `createRow`의 행별 리스너는 대화상자 전체 `store`에 등록된다. 폴더 이동 시 DOM은 교체되지만 해당 리스너의 정리는 대화상자 종료까지 미뤄진다. 열린 대화상자 안에서 제거된 행이 유지될 수 있으며, 종료 후 영구 누수라고 단정하지 않는다.
- 영향 가설: 큰 디렉터리나 느린 provider에서 클릭 후 아무 반응이 없는 구간, 탐색 반복에 따른 DOM/메모리 비용이 생길 수 있다.
- 후속 작업: 위젯을 먼저 보여 로딩·취소 상태를 제공하고, 렌더 단위 disposable 및 비동기 결과 세대 번호/취소를 둔다. 큰 목록에는 upstream 가상 목록/트리 사용 가능성을 먼저 검토한다. 빠른 이동의 오래된 결과가 새 목록에 덮이지 않아야 한다.
- 검증: 첫 표시와 목록 준비 시간을 따로 측정하고 반복 이동 후 객체 유지 여부 확인. 키보드·스크린 리더·초점 복원, 파일 유형 필터, 없는/권한 없는 폴더, 원격 provider, 취소 중 응답도 검증한다.

### P1-C — JAR 작업의 확장 호스트 동기 점유

- 근거: [zipUtil.ts](../extensions/vshoon-decom/src/zipUtil.ts)의 `openZip`은 JAR 전체를 `readFileSync`로 읽는다. `extractAllEntries`는 동기 압축 해제·디렉터리 생성·쓰기를 반복한다. `rebuildJarFromFolder`도 동기 탐색/읽기 후 `toBuffer()`와 동기 쓰기로 재구성한다.
- 영향 가설: 큰 JAR을 처리하는 동안 같은 확장 호스트의 다른 기능 응답이 늦어지고, 압축/해제 버퍼로 최대 메모리가 증가할 수 있다. JAR을 사용하지 않는 시작/유휴 지연의 증거는 아니다.
- 후속 작업: CPU 압축 작업을 worker/별도 프로세스로 격리하고, 파일 I/O 동시성과 메모리 사용량을 제한한다. `async` 선언만 추가하는 것으로 동기 압축 비용은 제거되지 않는다. 진행률·취소·오류 복구와 임시 결과의 안전한 교체를 함께 설계한다.
- 검증: 다른 확장 명령 응답, 큰/손상된 JAR, 취소, 긴 Windows 경로, 중첩 JAR의 STORED 방식·디렉터리 엔트리 보존, 엔트리 경로 경계, 원본 복구. 현재 필요한 클래스만 디컴파일하는 동작은 유지한다.

### P2-A — SFTP 로컬 목록의 무제한 stat와 설정 저장소 I/O

- 진행: 세션 단위 세마포어로 동시 `stat` 수를 제한했다. 한도는 측정으로 정한 값이 아니며, 보이는 항목 우선 채우기와 탐색 취소는 남아 있다. [4차 작업 기록](performance-improvement-04.md) 참고.
- 근거: [localFileSession.ts](../extensions/vshoon-vssh/src/sftp/localFileSession.ts)의 `readdir`는 모든 엔트리에 `stat`를 적용한 `Promise.all`을 만든다. **원격 SFTP 네트워크 요청의 동시성 문제로 확인한 것이 아니라 로컬 파일 시스템 조회 문제다.**
- 후속 작업: 제한된 작업자 수로 작업을 생성하고 필요하다면 보이는 항목부터 메타데이터를 채운다. 느린/큰 폴더에서 동시 조회 수, 첫 목록 지연, 빠른 이동 후 불필요한 완료 처리를 비교한다. 제한 수는 측정으로 정한다.
- 추가 근거: [sessionStorage.ts](../extensions/vshoon-vssh/src/sessions/sessionStorage.ts), [hostKeyStore.ts](../extensions/vshoon-vssh/src/ssh/hostKeyStore.ts)에 동기 읽기·mtime 확인·쓰기가 있다. 작은 파일의 저빈도 작업이면 영향이 작을 수 있다. 프로파일에 나타날 때만 캐시/비동기화 후보로 올린다.
- 검증: 링크·접근 오류·큰 디렉터리·탐색 취소·정렬 일관성, 세션 외부 변경 감지, 호스트 키 검증 보존. 신뢰 확인을 생략해 속도를 얻지 않는다.

### P2-B — VSearch 준비 단계·웹뷰·대량 결과

- 근거: [searchEngine.ts](../extensions/vshoon-vsearch/src/searchEngine.ts)의 `runSearch`는 `collectFiles` 완료 후 새 worker를 만든다. `collectDirtyTexts`는 검색 대상 여부와 무관하게 열린 dirty `file:` 문서 전체 텍스트를 모아 전달한다. [searchWorker.ts](../extensions/vshoon-vsearch/src/searchWorker.ts)의 dirty 경로는 디스크 파일 크기 검사보다 먼저 반환된다.
- 후속 작업: 열거/dirty 수집/worker 시작/첫 배치/완료를 계측한다. 검색 대상에 필요한 dirty 텍스트만 전달하고 대형 미저장 문서 정책을 명시한다. 큰 문서를 조용히 제외해 결과 정확도를 낮추지 않는다. 캐시나 상주 worker는 생성 비용이 실제로 유의미할 때만 도입한다.
- UI 근거: [main.js](../extensions/vshoon-vsearch/media/main.js)는 입력 후 300ms 검색 debounce, 400ms 상태 저장 debounce를 둔다. 시작 시 `initMonaco`를 호출한다. 결과는 배치별 DOM 생성이며 20,000행 제한이 있다. [searchPanel.ts](../extensions/vshoon-vsearch/src/searchPanel.ts)는 숨긴 웹뷰의 컨텍스트를 보존한다.
- UI 후속 작업: 첫 모달 표시와 Monaco 사용 가능 시간을 구분한다. 필요할 때 미리보기 초기화/모델 유지량 제한을 검토하고, 대량 결과에서 가상화 효과를 측정한다. 300ms를 바로 없애면 검색 횟수가 늘 수 있으므로 명시적 실행과 연속 입력 정책을 나눠 비교한다. 숨김과 실제 닫기는 다른 수명이다.
- 검증: 첫 결과/완료 지연, dirty 문서 결과, 검색 제외 조건·대소문자·정규식·치환, 취소·15초 제한·이전 결과 차단, 스크롤·선택·키보드. 현재의 worker 격리와 배치 전송을 유지한다. worker 안의 동기 읽기를 확장 호스트 직접 점유와 혼동하지 않는다.
- 경계: Workbench 내부 Monaco를 웹뷰에서 비공식 참조하거나 DOM 주입으로 공유하지 않는다. 검색 기능/지원 범위가 다른 비교에서는 같은 정답 결과 집합을 먼저 확인한다.

### P2-C — 시작창 전환의 폴링·실패 경로

- 근거: [startWindowMainService.ts](../src/vs/vshoon/electron-main/startWindowMainService.ts)의 `releaseWhenWorkbenchOpens`는 50ms 간격으로 시작창 이외의 `BrowserWindow` 존재를 확인한다. 목적 Workbench의 준비 완료 확인은 아니다. 기존 Workbench가 있는 새 창 요청에서는 다른 기존 창으로도 조건이 충족될 수 있다.
- 확인: 열기 전에 시작창을 숨기며, 실패 경로에서 표시 복원/폴링 해제가 명시적으로 수행되지 않는다. 다른 창이 생기지 않으면 폴링이 이어질 수 있다. 타이머 정리 disposable은 서비스 전체 수명에 등록된다.
- 영향 가설: 실패/반복 열기에서 불필요한 체크와 정리 객체가 누적되거나 화면 공백이 생길 수 있다. 정상 전환에서 짧게 끝나는 폴링을 상시 CPU 병목으로 표현하지 않는다.
- 후속 작업: 실제 열기 결과의 창과 준비 상태를 연결하는 upstream lifecycle seam을 검토한다. 요청 단위 타이머/구독 소유권, 실패·취소 시 정리와 시작창 복원, 중복 요청 처리를 명시한다.
- 검증: 최초 실행·새 창 반복·이미 열린 Workbench·열기 실패·두 번째 인스턴스·파일/폴더/workspace 인자·Remote·프로필·`--wait`·extension development host. 체감 속도를 위해 전체 Workbench를 먼저 띄우는 방식은 제품 요구 위반이다.

### P2-D — 쿼리 이전/목록의 반복 조회

- 진행: 목록의 파일별 `stat`을 순차 대기에서 한도 8의 동시 조회로 바꿨다. 한도는 측정으로 정한 값이 아니며, 이전(`migrateLegacy`)의 완료 표시·재시도 조건과 목록 캐시는 남아 있다. [5차 작업 기록](performance-improvement-05.md) 참고.
- 근거: [queryStore.ts](../extensions/vshoon-dbconn/src/features/queryStore.ts)는 활성화 시 `migrateLegacy()`를 호출한다. 사용자 지정 폴더가 없는 경우 이전 SQL 폴더를 검사하고 대상과 비교하며, 완료 표시 없이 원본을 남긴다. `list()`는 각 SQL 파일을 순차 `stat`한다.
- 후속 작업: SQL 파일이 많은 조건에서 활성화 및 목록 갱신을 측정한다. 완료 버전/재시도 조건을 가진 이전 상태, 제한된 병렬 메타데이터 조회, 명확한 무효화 조건이 있는 목록 캐시를 검토한다.
- 검증: 일부 복사 실패 후 재시도, 중복 파일명·사용자 수정 파일 보존, 이후 원본 추가 정책, 보관 폴더 변경·외부 변경. 이전을 무조건 한 번만 수행하도록 막거나 원본을 삭제하지 않는다.

## 5. 불필요하다고 단정하면 안 되는 기존 동작

- VSsh 전송 큐 UI에는 이미 250ms 갱신 제한이 있다. [sftpPanelView.ts](../extensions/vshoon-vssh/src/sftp/sftpPanelView.ts)의 `scheduleQueueUiUpdate`/`flushQueueUiUpdate`를 조사한 뒤 추가 batching을 판단한다.
- VSearch에는 검색 debounce, worker 격리, 결과 batch, 취소, 시간·행 수 제한이 있다. 제한을 없애거나 정규식을 확장 호스트로 옮기지 않는다.
- 내장 언어 팩 시드는 인덱스 존재 확인 후 필요할 때 초기화한다. 매 시작마다 모든 번역을 다시 생성하는 것으로 보지 않는다. 부팅 비용이 의심되면 최초/재시작을 분리한다.
- 숨긴 웹뷰 컨텍스트 보존은 재표시 비용과 메모리의 교환이다. 일괄 제거하면 첫 열기/복원 비용이 늘 수 있다. 실제 닫기 후 참조와 편집 모델 수명부터 확인한다.
- 캐시·자동 저장·호스트 키 검사·파일 변경 감지·접근성을 끄는 것은 기본 개선책이 아니다. 사용자가 요청한 기능을 유지하면서 중복 비용을 줄인다.

## 6. 구현 순서와 완료 조건

1. P0 기준선과 프로파일 수집. 시작 지연, 일반 입력 지연, 특정 기능 지연 중 재현되는 범위를 정한다.
2. 해당 범위의 P1 후보를 작은 독립 변경으로 처리한다. 예: SQL 중복 스냅샷 제거와 파일 선택창 표시/수명 개선은 별도 작업으로 나눈다.
3. JAR 격리처럼 구조 변경이 필요한 항목은 취소·데이터 보존 테스트를 먼저 마련한다. P2는 측정 결과에 따라 승격하거나 보류한다.
4. 변경 전후 동일 시나리오를 반복한다. 측정 산포 안의 차이는 “개선 확인”으로 표시하지 않는다. 입력 응답·최대 메모리·I/O 중 무엇이 좋아지고 나빠졌는지 함께 기록한다.
5. 제품 소유 소스에서 우선 해결한다. upstream 변경이 꼭 필요하면 기존 구현으로 불가능한 이유, 작은 seam, 테스트를 기록하고 `npm run patch:save` 및 [패치 장부](upstream-patches.md)를 함께 갱신한다.

후속 구현 때의 검증 목록:

- 루트 스크립트로 관련 타입 검사/린트/단위 테스트 및 필요한 `npm run layers` 수행. 기존 실패와 새 실패를 구분하고, 기능 완료 전에 새 회귀를 해결한다.
- 내장 확장은 루트 `npm run build` 또는 해당 확장 테스트 스크립트로 컴파일한다. `npm run lint`는 제품 코어 소스 범위이므로 내장 확장 린트까지 수행했다고 보고하지 않는다.
- DBConn/VSearch는 각각 `npm run test:dbconn`, `npm run test:vsearch`를 사용한다. `npm run test:decom`은 현재 컴파일 명령뿐이므로 JAR 런타임 검증을 대체하지 않는다. VSsh 변경도 별도 관련 테스트/수동 시나리오가 필요하다.
- 데스크톱 실행 전 `npm run build`. 시작 경로 변경 시 `npm run smoke:start-window`, UI 변경 시 관련 모달 smoke와 키보드/스크린 리더 확인. smoke는 기능 회귀용이며 성능 측정은 별도다.
- 직접 Workbench 열기, 확장 호스트·디버깅·터미널·워크스페이스·프로필·Remote·CLI·접근성 기능을 보존한다. 변경 영역별 실제 실행 결과를 남긴다.
- 패키징·원격 push·PR·릴리스는 이 가이드 작업 범위가 아니다.

### 결과 기록 양식

후속 실행마다 아래 필드를 채우고 원시 시간/프로파일 파일을 연결한다. 프로파일에 경로·SQL·호스트명 등이 포함될 수 있으므로 공유 전 확인한다.

```text
측정일 / 변경 ID / 실행 파일 경로 / 제품·코어 커밋:
비교군 / 하드웨어 / 전원 모드 / 배포 방식:
실제 데이터·확장·임시 경로 / 캐시·프로필 상태:
확장·언어·설정 / 워크스페이스·입력 데이터:
재현 절차 / 시작·종료 시점 정의 / 반복 수:
변경 전후 원시값 / 중앙값·범위 / CPU·메모리·I/O:
원인 프로파일 / 개선 여부 / 악화된 지표:
회귀 검사 명령과 결과 / 수동 확인 / 미확인 사항:
```

## 7. 최초 가이드 작성 시 검증 범위

코드 경로·설정·루트 검사 명령을 정적으로 확인하고 가이드를 작성했다. 문서 내 로컬 링크 19개가 모두 존재하고, 문자 손상 표시와 줄 끝 공백이 없음을 확인했다. `Development.md`에 대한 `git diff --check`도 통과했다. 앱 코드·코어·설정·캐시를 변경하지 않았으며, 성능 벤치마크·빌드·런타임 테스트·패키징은 수행하지 않았다. 이 문서의 후보와 시험 입력을 실측 결과로 취급하지 않는다.
