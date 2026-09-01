# VShoon 에이전트 작업 지침

VShoon은 Code - OSS를 기반으로 하며 VS Code의 핵심 기능을 유지하면서 제품 수준의 UI 확장 기능과 콤팩트한 프로젝트 시작 화면을 추가하는 포크다.

이 문서는 VShoon 전용 지침이다. 작업 전 반드시 upstream 지침인 [.github/copilot-instructions.md](.github/copilot-instructions.md)도 읽고 함께 준수한다. 두 문서가 충돌하면 사용자 요구사항과 VShoon 제품 원칙을 우선하되, upstream의 코드 품질·계층·검증 규칙은 가능한 한 그대로 지킨다.

## 1. 필수 요구사항

1. VS Code의 편집기, 확장 호스트, 디버깅, 터미널, 워크스페이스, 프로필, Remote, 접근성, CLI 기능을 유지한다.
2. 일반 VS Code 확장 프로그램으로 안전하게 수정할 수 없는 UI를 VShoon에서 제한적으로 수정하거나 확장할 수 있게 한다.
3. 명시적인 열기 대상 없이 VShoon을 실행하면 전체 Workbench보다 먼저 IntelliJ 계열과 비슷한 콤팩트 시작 화면을 표시한다.
4. `microsoft/vscode`가 업데이트되어도 VShoon 변경을 쉽게 이식하고 호환성을 검증할 수 있게 한다.

제품 식별자는 다음과 같다.

- 제품명: `VShoon`
- 애플리케이션 이름: `vshoon`
- 사용자 데이터 디렉터리: `.vshoon`
- 설정 및 명령 접두사: `vshoon.*`
- 제품 전용 소스 루트: `src/vs/vshoon`

VShoon은 공개된 Code - OSS 소스를 기반으로 한다. Microsoft Visual Studio Code의 상표, 아이콘, 배포 바이너리, Marketplace 사용 권한, 업데이트 서비스, 텔레메트리 주소를 VShoon 자산으로 간주하거나 무단 재사용하지 않는다. upstream 및 서드파티 라이선스 고지를 보존한다.

## 2. 저장소 구성

이 저장소는 VShoon이 소유한 것만 추적한다. Code - OSS 코어는 고정된 커밋으로 필요할 때 받아오며 절대 커밋하지 않는다. 전체 구조와 이유는 [docs/repository-layout.md](docs/repository-layout.md)에 있다.

- `origin`: VShoon 커스텀 소스 저장소. 커밋과 푸시는 여기에만 한다.
- 코어: `vshoon.lock.json`이 고정한 `microsoft/vscode` 커밋. `npm run sync`가 `.core/`에 받아온다.
- `.core/`는 gitignore 대상이며 빌드 루트 역할을 한다.
- 사용자가 요청하지 않으면 자동으로 원격 푸시하지 않는다.

작업 대상 구분:

- VShoon 소유: `src/vs/vshoon/**`, `patches/**`, `scripts/**`, `docs/**`, `AGENTS.md`, `vshoon.lock.json`
- 코어 소유: `.core/**` 전부. 여기서 직접 편집해도 되는 것은 패치 대상 파일뿐이며, 편집 후 반드시 `npm run patch:save`를 실행한다.
- `.core/src/vs/vshoon`은 오버레이 복사본이다. 여기서 편집하면 다음 미러링 때 덮어써진다.

권장 브랜치 역할:

- `origin/main`: VShoon 통합 브랜치
- `vshoon/<기능>`: 기능 개발 브랜치
- `upstream-sync/<버전>`: 코어 버전 상향 및 호환성 검증 브랜치

VShoon 커밋은 작고 독립적으로 유지한다. 커밋 제목에는 `vshoon(product)`, `vshoon(start)`, `vshoon(ui-api)`, `vshoon(build)`, `vshoon(test)` 같은 영역을 사용한다.

## 3. Upstream 우선 원칙

- 신규 제품 로직은 기본적으로 `src/vs/vshoon/**` 아래에 작성한다.
- VShoon 전용 built-in extension은 `extensions/vshoon-*` 이름을 사용한다.
- upstream 모듈 전체를 복사해 VShoon 사본으로 유지하지 않는다.
- upstream 파일 수정은 VShoon 모듈 등록, 작은 수명주기 seam, 필요한 인터페이스 노출처럼 최소한으로 제한한다.
- 브랜딩, 시작 화면, UI API, 빌드, 테스트 변경을 서로 독립적인 커밋으로 나눈다.
- 생성된 파일, 컴파일된 JavaScript 문자열, DOM 선택자 주입, 런타임 monkey patch를 이용해 제품을 수정하지 않는다.
- 확장 프로그램에 임의 Electron 또는 Node 접근 권한을 제공하지 않는다.

upstream 파일을 수정하기 전에는 VShoon 소유 모듈만으로 해결할 수 없는지 먼저 확인한다. upstream 파일을 수정한 경우 같은 변경에서 테스트와 `docs/upstream-patches.md`를 갱신한다.

## 4. UI 확장 구조

UI 확장은 다음 두 계층으로 구분한다.

1. 시작 창, 타이틀바, Workbench 셸처럼 제품 수명주기와 결합된 영역을 위한 내부 제품 기여점.
2. 서드파티 확장이 꼭 필요한 경우에만 제공하는 capability 기반의 제한된 VShoon 확장 API.

새 VShoon UI capability에는 다음 조건이 필요하다.

- 명확한 타입과 수명주기
- 허용 범위와 신뢰 경계
- 입력 검증
- API 버전 또는 기능 감지
- 접근성 및 현지화
- 호환성 테스트
- 일반 VS Code에서 실행될 때의 안전한 fallback

일반 확장 샌드박스를 포괄적으로 우회하는 API는 만들지 않는다.

## 5. 시작 화면 요구사항

시작 화면 MVP는 다음 기능을 제공한다.

- 최근 폴더 및 워크스페이스 표시
- 폴더 열기, 워크스페이스 열기, 빈 창 열기
- 최근 항목 고정, 고정 해제, 제거
- 키보드 전용 탐색
- 스크린 리더용 레이블과 올바른 포커스 이동
- 시작 화면 비활성화 설정 및 CLI 선택지

최근 항목 저장소를 직접 파싱하지 않고 upstream의 history, workspace, lifecycle, profile, window, dialog 서비스를 재사용한다.

시작 화면은 명시적인 대상이 없는 일반 데스크톱 실행에서만 표시한다. 다음 실행은 upstream 흐름을 그대로 따른다.

- 파일, 폴더, `.code-workspace` 인자가 있는 실행
- `--folder-uri`, `--file-uri`
- protocol URL
- diff, merge, wait, goto 모드
- Remote 창
- 테스트 및 extension development host
- Agent 창
- 강제 프로필 또는 임시 프로필
- 사용자가 시작 화면을 비활성화한 경우

최종 구현은 전체 Workbench를 먼저 띄운 다음 Webview로 덮는 방식이어서는 안 된다. 콤팩트 시작 창은 sandbox가 적용된 별도 Electron renderer로 구성한다.

## 6. 예정 아키텍처

현재 선택한 첫 통합 지점은 `src/vs/code/electron-main/app.ts`의 `CodeApplication.openFirstWindow()` 직전이다.

```text
CodeApplication 시작
  → main-process 서비스 초기화
  → protocol 및 실행 인자 해석
  → VShoon 시작 화면 정책 판정
      → 우회 대상: 기존 openFirstWindow 흐름
      → 표시 대상: 콤팩트 시작 창 생성
  → 프로젝트 선택
  → IWindowsMainService.open 호출
  → Workbench 준비 후 시작 창 닫기
```

제품 모듈의 기본 소유 경계:

- `src/vs/vshoon/electron-main`: 표시 정책, 시작 창 소유권, IPC 검증
- `src/vs/vshoon/electron-sandbox`: `electron-browser` 계층 규칙을 따르는 sandbox renderer 진입점
- `src/vs/vshoon/browser`: 계층 규칙상 공유 가능한 UI와 모델
- `src/vs/code/electron-main/app.ts`: 최소 delegation seam

시작 화면 IPC와 향후 UI 확장 API는 서로 독립적으로 유지한다.

## 7. 변경 추적 문서

다음 문서를 유지한다.

- `docs/repository-layout.md`: 저장소 분리 구조, 오버레이, 패치 운영
- `docs/architecture.md`: 프로세스 및 모듈 아키텍처
- `docs/start-window.md`: 시작 화면 수명주기, 우회 조건, UX
- `docs/ui-extension-api.md`: capability와 보안 모델
- `docs/upstream-patches.md`: upstream 패치 장부
- `docs/upstream/<버전>.md`: 버전별 동기화 보고서

패치 장부의 각 항목에는 패치 ID, 목적, 수정한 upstream 파일, 수정 이유, 의존 symbol/service, 충돌 위험도, 테스트, 제거 가능 조건을 기록한다.

## 8. 코어 업데이트 절차

1. `upstream-sync/<버전>` 브랜치를 만든다.
2. `vshoon.lock.json`의 `upstream.commit`과 `version`을 새 코어 커밋으로 올린다.
3. `npm run sync`를 실행한다. 적용되지 않는 패치가 있으면 sync가 해당 패치 이름과 함께 중단된다.
4. 충돌은 `.core` 안에서 패치 ID 단위로 해결한 뒤 `npm run patch:save`로 패치를 다시 기록한다.
5. `npm run typecheck`, `npm run layers`, `npm run lint`, `npm test`, 그리고 필요한 경우 데스크톱 실행을 확인한다.
6. `docs/upstream/<버전>.md`에 충돌, API 변경, 수동 확인 사항을 기록한다.
7. 검증을 통과한 뒤 VShoon 통합 브랜치에 반영한다.

VShoon 기능을 비활성화하면 upstream 동작과 같아야 한다.

## 9. 개발 및 검증 규칙

- 빌드와 검사는 `.core`에서 직접 실행하지 말고 저장소 루트의 npm 스크립트로 실행한다. 이 스크립트들이 오버레이를 먼저 미러링하므로 오래된 소스로 빌드되는 일이 없다. 명령 목록은 [docs/repository-layout.md](docs/repository-layout.md)에 있다.
- 코어가 없거나 오래되었으면 먼저 `npm run sync`를 실행한다.
- upstream이 고정한 Node 버전과 패키지 도구를 사용한다.
- 사용자에게 보이는 문자열은 upstream 현지화 체계를 사용한다.
- TypeScript는 upstream 스타일과 탭 들여쓰기를 따른다.
- 부팅 경로에 성능 측정 없이 동기 I/O를 추가하지 않는다.
- disposable은 생성 직후 적절한 소유자에 등록한다.
- 서비스는 생성자 주입을 사용하며 메서드 내부에서 임의로 service locator를 호출하지 않는다.
- 기존 테스트를 삭제하거나 약화해 변경을 통과시키지 않는다.
- 광범위한 자동 포맷과 파괴적인 Git 명령을 사용하지 않는다.
- 사용자가 만든 변경과 기존 VShoon 변경을 보존한다.

시작 경로는 최소한 다음 경우를 검증한다.

- 인자 없는 실행
- 파일, 폴더, workspace 인자 실행
- 두 번째 인스턴스
- 최근 항목이 비어 있는 경우
- 존재하지 않거나 손상된 최근 항목
- 프로필 및 Remote 창
- extension development host
- 키보드 전용 사용

작업 완료 조건:

- 관련 타입 검사 또는 컴파일 통과
- 관련 린트 및 단위 테스트 통과
- 적용 가능한 경우 Windows 개발 빌드 실행 확인
- 기존 Workbench 직접 실행 회귀 확인
- 코어 파일을 수정했다면 `npm run patch:save` 실행 및 `docs/upstream-patches.md` 갱신
- 실제 수행한 검증 결과 보고

## 10. 개발 단계

### 0단계 — 포크 기반

- [x] Code - OSS upstream 연결 및 초기 기준 커밋 고정
- [x] 개인 VShoon origin 연결
- [x] 최소 VShoon 제품 식별자 적용
- [x] Windows C++ 빌드 도구 및 npm 의존성 설치
- [ ] 라이선스와 배포 차이 세부 문서화
- [ ] 변경 전 upstream 개발 빌드 검증

### 1단계 — 시작 경로 구조

- [x] desktop main, window, lifecycle, history 서비스의 첫 흐름 조사
- [x] Workbench 생성 전 첫 seam 후보 선택
- [x] 시작 화면 표시 여부 정책과 단위 테스트 구현
- [x] 실제 CLI 및 제품 상태를 시작 화면 정책 입력으로 연결
- [x] 단일 인스턴스 동작 확정
- [x] 시작 창 controller와 sandbox renderer의 첫 수명주기 구현

### 2단계 — 시작 화면 MVP

- [x] sandboxed 시작 창 renderer의 기본 화면과 안전한 IPC 구현
- [ ] 최근 프로젝트와 열기·제거·고정 동작 연결
- [ ] 설정, CLI, 접근성, 단위 테스트, smoke test 추가

### 3단계 — 제한된 UI 확장

- [ ] 구체적인 UI 요구사항을 capability로 분류
- [ ] 내부 contribution registry와 제한된 bridge 설계
- [ ] 버전, 검증, 권한, fallback 구현
- [ ] 샘플 확장과 계약 테스트 작성

### 4단계 — 패키징과 업데이트

- [ ] VShoon 고유 아이콘 및 설치 관리자 식별자 완성
- [ ] Windows 개발 패키지 빌드 및 실행
- [ ] upstream 동기화 검사 자동화
- [ ] 배포 및 롤백 절차 작성

## 11. 에이전트 작업 방식

- 작업 전에 이 문서와 upstream 지침을 읽는다.
- 관련 upstream 구현과 기존 테스트 패턴을 먼저 조사한다.
- 되돌릴 수 있는 작은 변경 단위로 진행한다.
- 사용자에게 중간 진행 상황과 중요한 판단을 한글로 전달한다.
- 사용자 요청이 없다면 원격 push, PR 생성, 릴리스, 외부 메시지 전송을 하지 않는다.
- 기능 완료를 주장하기 전에 실제 검증 결과를 확인한다.
