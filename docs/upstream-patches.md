# VShoon Upstream Patch Ledger

각 항목은 `patches/` 아래의 패치 파일 하나와 1:1로 대응한다. 적용 대상 코어 커밋은
`vshoon.lock.json`의 `upstream.commit`이며, `npm run sync`가 checkout 직후 순서대로 적용한다.
패치를 손으로 수정하지 말고 `.core`에서 파일을 고친 뒤 `npm run patch:save`로 다시 기록한다.
한 파일은 하나의 패치만 소유할 수 있다.

| 패치 ID | 파일 | 코어 대상 |
| --- | --- | --- |
| VSH-0001 | `patches/VSH-0001-product-identity.patch` | `product.json` |
| VSH-0002 | `patches/VSH-0002-start-window-seam.patch` | `src/vs/code/electron-main/app.ts` |
| VSH-0003 | `patches/VSH-0003-source-layers.patch` | `eslint.config.js` |
| VSH-0004 | `patches/VSH-0004-ui-extension-seam.patch` | `src/vs/workbench/workbench.common.main.ts` |
| VSH-0005 | `patches/VSH-0005-ui-sample-build.patch` | `build/gulpfile.extensions.ts` |
| VSH-0006 | `patches/VSH-0006-windows-product-metadata.patch` | Windows packaging metadata files |
| VSH-0007 | `patches/VSH-0007-start-window-package.patch` | desktop bundle entrypoint and resources |

## VSH-0001 — Product Identity

- Purpose: separate VShoon application data, protocol handlers, mutexes, installer identities, and visible product name from Code - OSS.
- Upstream files: `product.json`.
- Reason: side-by-side installation and a distinct, non-Microsoft product identity require unique identifiers.
- Dependencies: upstream product configuration schema and packaging scripts that consume `product.json`.
- Conflict risk: medium; upstream occasionally adds product identity fields.
- Validation: parse `product.json`; inspect packaged Windows metadata and side-by-side behavior in Phase 4.
- Removal condition: none while VShoon remains a separately distributed product.

## VSH-0002 — Start-Window Policy and Lifecycle Seam

- 목적: 대상 없는 데스크톱 실행을 Workbench 생성 전에 VShoon 시작 창으로 위임하고, 시작 창이 실행을 소유하는 동안 도착한 두 번째 인스턴스를 올바르게 처리한다.
- VShoon 소유 파일: `src/vs/vshoon/common/startWindowPolicy.ts`, `src/vs/vshoon/node/launchRequest.ts`, `src/vs/vshoon/electron-main/startWindowMainService.ts`, `src/vs/vshoon/electron-main/launchMainService.ts`, `src/vs/vshoon/electron-sandbox/startWindow/**`, `src/vs/vshoon/test/**`.
- 수정한 upstream 파일: `src/vs/code/electron-main/app.ts`, `src/vs/platform/environment/common/argv.ts`, `src/vs/platform/environment/node/argv.ts`.
- 이유: 일반 확장은 Workbench가 생성된 뒤 활성화되므로 시작 창 수명주기를 제어할 수 없다.
- 의존성: `CodeApplication.openFirstWindow`, `CodeApplication.initChannels`, `ILaunchMainService`, `IWindowsMainService`, `IWorkspacesHistoryMainService`, lifecycle 및 dialog 서비스.
- 충돌 위험도: 정책 모듈은 낮음, `app.ts` seam은 높음.
- 현재 seam: `app.ts`에서 세 곳만 수정한다. (1) `IVShoonStartWindowMainService` 등록, (2) `initChannels`에서 두 번째 인스턴스에 노출되는 `launch` 채널을 `VShoonLaunchMainService`로 감싸기, (3) `openFirstWindow`에서 설정을 포함한 정책 판정과 시작 창 수명주기 처리. 환경 인자 파일 두 곳에는 `--disable-start-window` 타입과 CLI 설명만 추가한다.
- 설정: `extensions/vshoon-start`가 application scope의 `vshoon.startWindow.enabled`를 기여한다. main process가 기본 프로필 설정을 읽으므로 `false`이면 renderer를 만들기 전에 upstream Workbench 흐름으로 우회한다.
- 두 번째 인스턴스: 시작 창이 실행을 소유하는 동안 대상 없는 요청은 시작 창을 포커스한다. 대상이 있는 요청은 upstream으로 위임하되 위임 **전에** 시작 창이 물러난다. `--wait` 요청의 `start()`는 편집이 끝나야 resolve되므로 결과를 기다리면 안 된다.
- 검증: VShoon 단위 테스트 30개, 대상 ESLint, `valid-layers-check`, `typecheck-client`, 전체 client 및 built-in extension 빌드 통과. 격리된 Windows 데스크톱 실행에서 시작 창 표시, 두 번째 인스턴스 포커스, 폴더 인자 전달, `--disable-start-window`의 `disabledByCli` 우회, 사용자 설정 `false`의 `disabled` 우회를 확인했다. CLI 도움말에도 전용 옵션이 노출된다. `npm run smoke:start-window`는 실제 sandbox renderer의 접근성 이름, 초기 초점, 로딩 상태와 양방향 Tab 이동을 검사한다.
- 제거 조건: upstream이 지원되는 pre-workbench 제품 기여점을 제공하는 경우.

## VSH-0003 — VShoon 소스 계층 규칙

- 목적: `src/vs/vshoon/**` 파일에 upstream과 동일한 import 계층 검사를 적용한다.
- 수정한 upstream 파일: `eslint.config.js`.
- 이유: 새 제품 소스 루트는 명시적인 `code-import-patterns` 대상이 없으면 린트 경고가 발생하고 계층 위반도 검사할 수 없다.
- 허용 의존성: VShoon은 `vs/base`, `vs/base/parts`, `vs/platform`, `vs/code`, `vs/vshoon`을 사용할 수 있다. 제품 진입 seam을 위해 `vs/code`에서 `vs/vshoon`으로 향하는 참조도 허용한다.
- 충돌 위험도: 낮음. upstream import 규칙 배열의 인접 변경 시 수동 병합이 필요할 수 있다.
- 검증: VShoon 소스 및 테스트 파일 대상 ESLint, 전체 계층 검사.
- 제거 조건: VShoon 소스가 upstream 표준 루트로 이동하거나 별도 ESLint 구성을 사용하게 되는 경우.

## VSH-0004 — UI Extension Registration Seam

- 목적: 공통 Workbench API extension point가 등록될 때 VShoon 소유의 선언적 UI extension
  point도 함께 로드한다.
- 수정한 upstream 파일: `src/vs/workbench/workbench.common.main.ts`.
- 이유: extension manifest contribution point는 Workbench renderer bundle에서 등록되어야 하며,
  일반 확장은 제품 수준 schema와 수명주기 hook을 안전하게 등록할 수 없다.
- VShoon 소유 구현: `src/vs/vshoon/browser/uiExtensionPoint.ts`와
  `src/vs/vshoon/common/uiContribution*.ts`.
- 의존성: `ExtensionsRegistry`, extension description과 collector, manifest JSON schema,
  VShoon capability registry와 bridge.
- 신뢰 경계: 초기 handler는 bundled extension만 허용한다. 서드파티 선언은 capability별 권한
  서비스가 구현될 때까지 collector 오류로 거부한다.
- 충돌 위험도: 낮음. 기존 API extension-point import 옆에서 upstream registry를 VShoon 등록
  함수에 전달한다. VShoon 모듈은 Workbench 계층을 역으로 import하지 않는다.
- 검증: `npm run sync`, VShoon 단위 테스트 30개, `typecheck-client`, ESLint, 전체 소스
  계층 검사와 전체 client 및 built-in extension 빌드.
- 제거 조건: upstream이 Workbench 파일 수정 없이 제품 소유 extension point를 로드할 수 있는
  공식 등록 hook을 제공하는 경우.

## VSH-0005 — UI Sample Extension Build Registration

- 목적: VShoon bundled 계약 샘플을 upstream의 built-in extension compile/watch 작업에 포함한다.
- 수정한 upstream 파일: `build/gulpfile.extensions.ts`.
- 이유: upstream은 시작 시간을 줄이기 위해 extension `tsconfig.json` 경로를 정적 배열로
  관리하므로 overlay 디렉터리만 추가해서는 gulp compile task가 만들어지지 않는다.
- 의존성: `extensions/vshoon-ui-sample/tsconfig.json`과 upstream extension gulp task 생성기.
- 충돌 위험도: 낮음. 정적 compile 목록에 한 항목만 추가한다.
- 검증: `compile-extension:vshoon-ui-sample`과 전체 `compile-extensions`.
- 제거 조건: upstream이 overlay extension을 자동 탐색하거나 VShoon이 별도 extension 빌드
  파이프라인을 소유하게 되는 경우.

## VSH-0006 — Windows Product Metadata

- 목적: Windows 실행 파일과 설치 프로그램에서 Microsoft/VS Code 배포 메타데이터를 제거하고 VShoon 제품 메타데이터를 일관되게 사용한다.
- 수정한 upstream 파일: `build/lib/electron.ts`, `build/gulpfile.vscode.ts`, `build/gulpfile.reh.ts`, `build/gulpfile.vscode.win32.ts`, `build/win32/code.iss`.
- 수정 이유: Code - OSS 빌드 기본값에는 회사명, 저작권, 게시자 URL, 설치 파일 이름이 Microsoft 또는 VS Code 값으로 하드코딩되어 있다. 또한 Windows 패키징 마지막 단계가 `signtool.exe`로 기존 서명을 확인하는데, 서명을 하지 않는 개발 머신에는 Windows SDK 서명 도구가 없어 `ENOENT`로 패키징 전체가 실패한다. `hasAuthenticodeSignature`가 ENOENT를 "서명 없음"으로 처리하도록 좁혀서, 서명 파이프라인이 있는 환경의 동작은 그대로 두고 개발 패키지 빌드만 통과시킨다.
- 의존 symbol/service: `product.json`의 `companyName`, `copyright`, `win32PublisherName`, `win32PublisherUrl`, `win32SetupBaseName`과 Electron/Inno Setup 패키징 작업. Inno Setup 쪽은 `PublisherName`, `PublisherUrl`, `SetupBaseName`, `Copyright` 정의를 `code.iss`의 `AppPublisher`, `AppPublisherURL`, `OutputBaseFilename`, `AppCopyright`에 연결한다.
- 충돌 위험도: 중간. upstream Windows 패키징 정의나 executable resource 편집 단계가 바뀌면 재검토가 필요하다.
- 테스트: build TypeScript 검사, clean `npm run sync`, Windows x64 패키지 생성 후 실행 파일 version resource와 Inno Setup 메타데이터 검사.
- 제거 가능 조건: upstream 패키징이 모든 게시자·저작권·설치 파일 정보를 `product.json`에서 직접 읽도록 변경되는 경우.

## VSH-0007 — Start Window Package Resources

- 목적: 프로덕션 desktop bundle에 시작 창 renderer 진입점과 HTML/CSS/PNG 정적 파일을 포함한다.
- 수정한 upstream 파일: `build/buildfile.ts`, `build/next/index.ts`.
- 수정 이유: 개발 실행은 `src`의 정적 파일을 직접 읽지만 패키지 빌드는 명시적인 entrypoint/resource 목록만 복사하므로, 등록하지 않으면 시작 창이 `ERR_FILE_NOT_FOUND`로 종료된다.
- 의존 symbol/service: `build/buildfile.ts`의 desktop `code` entrypoint 목록, `build/next/index.ts`의 `codeEntryPoints`와 `desktopResourcePatterns`.
- 충돌 위험도: 낮음. 기존 desktop 목록에 VShoon 경로 항목만 추가한다.
- 주의: 번들러가 두 벌이다. `buildfile.ts`는 기존 gulp 번들러가, `build/next/index.ts`의 `codeEntryPoints`는 현재 패키징이 사용하는 esbuild 번들러가 읽는다. 한쪽만 등록하면 개발 실행은 정상인데 패키지에서만 renderer 번들이 빠진다.
- 테스트: `vscode-win32-x64` 패키지 생성 후 `out/vs/vshoon/electron-sandbox/startWindow`의 JS/HTML/CSS/PNG 존재 확인 및 packaged start-window smoke test. smoke test는 제품 마크 이미지가 실제로 디코딩되는지도 확인하므로 CSP나 리소스 누락이 회귀하면 실패한다.
- 제거 가능 조건: upstream bundler가 제품 overlay의 renderer entrypoint와 정적 파일을 선언적으로 수집할 수 있게 되는 경우.
