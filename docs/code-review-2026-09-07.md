# 17번 추가개발 및 코드 점검 (2026-09-07)

## 구현 범위

- DBConn 연결 폼, VSsh 세션 폼, VSearch의 위치·크기·최대화 상태를 extension id + view type별로 기억한다. 닫았다 다시 열거나 같은 모달에서 패널이 바뀔 때 복원한다.
- 저장 범위는 Workbench 창 메모리다. 창 종료/새로고침 시 초기화하며 다른 창과 공유하지 않는다. 파일·설정·프로필 저장소에 쓰지 않는다. 복원 시 화면 경계 제한은 upstream 모달 레이아웃이 적용한다.
- Decom은 선언된 웹뷰 모달이 없어 적용 대상이 없다. 새 모달을 정식 contribution으로 등록하면 동일 동작을 사용한다.
- `Ctrl+Shift+F`(macOS `Cmd+Shift+F`)는 VSearch를 연다. 기본 검색 단축키를 대체하며 기존 검색 명령 자체는 유지한다. 사용자가 지정한 단축키는 우선한다.
- upstream 변경은 `VSH-0010`에 기록했다. 기존 미커밋 변경은 보존했다.

## 점검 범위와 해석

VShoon 소유 제품 코드, 네 내장 확장의 관련 구현과 스크립트를 정적으로 검토했다. 전체 Code - OSS의 전수 감사나 성능 측정 결과는 아니다. 아래 항목은 **후속 수정 후보**이며 이번 기능 변경과 분리해 기록한다. 우선순위는 영향 기준이고, 실제 사용자 환경에서의 발생 빈도는 측정하지 않았다.

| 우선순위 | 위치 | 근거·발생 조건·영향 | 수정 방향 및 검증 |
| --- | --- | --- | --- |
| 중간 | `src/vs/vshoon/browser/fileDialog/vshoonFileDialog.ts:15` 등 6곳 | `npm run layers`에서 browser 계층의 `INativeEnvironmentService` 참조 위반을 실제 확인했다. 이번 변경 이전부터 있던 파일 선택기 코드이며 전체 계층 검사를 실패시킨다. | native 서비스 의존을 electron-sandbox 계층으로 옮기거나 필요한 값만 browser UI에 전달한다. 파일 선택기 회귀 검증 및 전체 layers 검사를 통과시킨다. |
| 높음 | `extensions/vshoon-decom/src/zipUtil.ts`, `extractAllEntries` | ZIP entry 이름을 `path.join(destDir, ...)`에 바로 넣고 쓴다. `../`를 포함한 이름이 전달되면 지정 폴더 밖으로 해석될 수 있으며 이 함수에는 경계 검사가 없다. 실제 악성 JAR end-to-end 재현은 수행하지 않았다. | 모든 entry를 쓰기 전에 절대 경로·상위 이동·Windows drive/ADS 등을 검증하고 `path.relative`로 대상 폴더 내부인지 확인한다. 정상 JAR와 경로 이탈 entry, 심볼릭 링크를 통한 이탈도 테스트한다. |
| 중간 | `extensions/vshoon-decom/src/zipUtil.ts`, `openZip` / `extractAllEntries` / JAR 재생성 경로; `src/jarProject.ts`의 호출 | 전체 JAR 읽기, 압축 해제, 디렉터리 생성, 파일 쓰기 및 압축을 동기 수행한다. 큰 JAR 또는 많은 entry에서 extension host 이벤트 루프를 오래 점유할 수 있다. | 압축 작업을 worker/자식 프로세스로 분리하고 취소·진행 상태를 제공한다. 대형 JAR 처리 중 다른 확장 응답 지연과 최대 메모리를 측정한다. |
| 중간 | `extensions/vshoon-vssh/src/sftp/localFileSession.ts:15` | `readdir` 결과 전체에 `Promise.all(dirents.map(...stat...))`을 수행한다. 대형 폴더에서는 항목 수만큼 Promise와 파일 시스템 요청이 쌓인다. | 기존 semaphore 패턴을 재사용하되 작업 생성도 제한된 worker 반복문으로 제어한다. 수만 파일 폴더에서 메모리, 조회 시간, 취소 응답을 비교한다. |
| 중간 | `extensions/vshoon-vssh/src/sftp/localFileSession.ts:49` | `stat()`은 링크 대상을 따라간 뒤 `st.isSymbolicLink()`를 반환하므로 링크 여부가 false가 된다. 같은 클래스의 `readdir()`은 Dirent에서 링크 여부를 가져와 결과가 불일치한다. | `lstat()`에서 링크 여부를 확보하고 필요하면 `stat()`으로 대상 속성을 별도 조회한다. 파일 링크·디렉터리 링크·깨진 링크 계약 테스트를 추가한다. |
| 중간 | `extensions/vshoon-vsearch/src/searchEngine.ts:66`, `src/searchWorker.ts:41` | 수정 중인 문서 내용은 크기 검사 전에 즉시 반환한다. 큰 미저장 문서는 `maxFileSizeKb` 제한을 거치지 않고 검색되어 CPU·메모리 사용이 증가할 수 있다. | dirty 문서도 byte 길이 기준으로 제한할지 제품 정책을 정하고 로컬/원격/worker 경로에 일관되게 적용한다. 경계 크기의 한글 문서와 미저장 문서를 검증한다. |
| 낮음 | `extensions/vshoon-decom/src/zipUtil.ts:7`, `:19` | `JarEntryInfo`와 `listJarEntries`는 저장소의 해당 확장 소스에서 선언 외 참조를 찾지 못했다. 호출되면 JAR 전체를 다시 읽는 API이기도 하다. | 외부 공개 계약이 없는 내부 함수인지 확인한 뒤 타입과 함수 함께 제거한다. 확장 컴파일과 JAR 열기 회귀 검증을 수행한다. |

VSearch worker의 `readFileSync`는 검색 정규식과 함께 별도 worker thread에서 실행된다. 동기 API라는 이유만으로 extension host 차단 문제로 분류하지 않았다.

## 검증

- `npm run build`: client 및 내장 확장 컴파일 통과. 최초 발견한 새 모달 코드의 nullable 타입 오류를 수정한 뒤 통과했다.
- `npm run lint`: 통과. 최초 발견한 새 모듈의 Workbench 직접 import 경고를 식별자 전달 구조로 수정했다.
- `npm test`: 40개 통과. 모달별 상태 분리, 재열기, 일반 편집기 복귀, 최대화, 메모리 snapshot과 새 session 초기화를 포함한다.
- `npm run test:scripts`: 3개 통과.
- `npm run layers`: 기존 파일 선택기의 native 타입 참조 6곳으로 실패. 위 표에 후속 수정으로 기록했다.
- 실행 환경은 Windows, Node `24.19.0`이었다. upstream `.nvmrc`의 `24.18.0`과 패치 버전이 다르므로 고정 버전에서의 재검증은 남아 있다.
- `npm run smoke:modal-webviews`: 통과. 세 패널이 각각 `role="dialog"`와 `aria-modal`을 가진 모달로 열렸고, 선언한 크기로 배치되었으며, 편집기 탭으로는 열리지 않았다.
- `npm run smoke:modal-webviews -- --remember-layout`: 통과. 세 패널을 각각 크기 변경·이동한 뒤 닫고 다시 열어, 남긴 geometry 그대로 복원되는지 확인했다. 이 경로는 처음에 실패했고 원인은 모두 테스트 하네스였다. 수정 내역과 근거는 아래에 따로 기록한다.
- `npm run sync:check -- --offline`: 통과. core `1.137.0 @ 6b606c6c85`, overlay 488개 파일이 동기 상태였다.
- 패키징은 요청에 따라 수행하지 않았다.

## 레이아웃 smoke test 수정

`--remember-layout` 경로는 처음에 실패했다. 원인은 모두 테스트 하네스에 있었고 제품 코드는 바꾸지 않았다. 수정 후 연속 5회 통과했고, 플래그 없는 기본 경로도 2회 통과했다.

**모달을 다시 열지 못하던 원인**

- upstream `chat.agentsControl.enabled`의 기본값은 `compact`다. 채팅이 활성화되는 순간 unified agents bar가 command center를 넘겨받아 검색창을 `display: none`으로 숨기고, 그 뒤로 되돌아오지 않는다. 모든 Quick Access 단계가 그 검색창 클릭을 거치므로 첫 열기는 이 경합을 대개 이기고 닫은 뒤의 두 번째 클릭은 항상 진다. 클릭은 0×0 요소의 좌상단, 즉 창 아이콘 자리에 떨어졌다. smoke 프로필에서 이 지표를 `hidden`으로 두어 환경을 결정적으로 만들었다.
- title bar는 레이아웃 직후 한동안 0×0으로 측정되고, 창이 포커스를 잡는 중에 도착한 클릭은 그대로 버려진다. 크기가 실제로 잡힐 때까지 기다린 뒤 클릭하고, 첫 시도가 빗나가면 최대 네 번까지 다시 시도한다.
- Quick Access는 첫 매칭 행이 나타난 뒤에도 필터링을 계속하고, Enter는 그 순간 포커스된 행을 실행한다. 매칭 행의 존재가 아니라 매칭 행이 포커스를 가졌는지 기다리도록 바꿨다. 입력이 실제로 반영됐는지도 함께 확인하고, 콜드 프로필에서 확장 호스트가 명령을 등록하는 시간을 감안해 대기 한도를 패널 자체와 같은 40초로 맞췄다.
- VSearch 재열기는 Quick Access를 다시 거칠 이유가 없다. Quick Access는 확장 활성화를 기다리는 수단인데 재열기 시점에는 이미 활성화되어 있다. 실패 시점 상태를 덤프해 보니 포커스는 입력창에 있는데 Escape가 Quick Access를 닫지 못하고 있었다. warm-up과 Escape를 건너뛰고 `Ctrl+Shift+F`만 보낸다.

**제스처와 측정이 실제 동작과 어긋나던 원인**

- 1200×700을 요청하는 VSearch 모달은 기본 창 너비 1200과 같아 뷰포트로 클램프된다. 좌우 리사이즈 핸들이 화면 밖이고 가로 이동도 막힌다. 세 패널이 모두 갖는 자유도인 높이와 세로 위치로 검증 축을 옮겼다.
- upstream은 모달이 중앙에서 20px 안으로 들어오면 중앙에 스냅하고, 그 경우 커스텀 위치를 저장하지 않는다(`position = undefined`). 게다가 높이를 줄이면 중앙이 줄어든 만큼의 절반까지 내려와, 적당한 이동은 오히려 스냅 범위 안으로 끌려들어간다. 상단 가장자리까지 끌어 title bar offset에 클램프시키면 중앙에서 충분히 멀고 매 실행 같은 값이 된다.
- 고정 거리로 위로 끌면 포인터가 창 밖 음수 좌표로 나가 합성 이동이 전달되지 않는다. 고정 delta 대신 뷰포트 상단을 목표로 삼는다.
- 닫기 버튼은 헤더 안에 있고 헤더가 드래그 핸들이다. 누른 채로 움직이면 — 길이 0인 드래그도 그렇게 움직인다 — 드래그 제스처로 읽혀 mouseup이 아무것도 닫지 않는다. 포인터를 먼저 옮긴 뒤, 누르고 움직이지 않고 뗀다.
- 드래그가 끝나면 upstream이 한 번 더 레이아웃한다. 포인터를 뗀 직후 읽은 좌표는 아직 이동 중인 값일 수 있어, 실제로 복원이 맞는데도 비교가 어긋났다. 좌표가 더 이상 변하지 않을 때까지 기다렸다가 읽는다.

**택하지 않은 방법**

창을 넓혀 VSearch 클램프를 피하는 쪽은 택하지 않았다. Electron은 `Browser.setWindowBounds`를 구현하지 않고, `Emulation.setDeviceMetricsOverride`로 페이지 뷰포트만 1600×1000으로 넓히면 실제 창 1200×800과 어긋나 합성 마우스 입력이 빗나가면서 DBConn·VSsh의 재열기가 깨졌다. 실제로 확인하고 되돌렸다.

이 클램프 때문에 VSearch의 크기 일치 검증은 요청 값과 클램프 값이 같아 통과한다. 패널별 크기 seam은 760과 540을 요청하는 DBConn·VSsh가 실제로 증명한다.
