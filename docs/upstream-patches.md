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
| VSH-0005 | `patches/VSH-0005-ui-sample-build.patch` | VShoon built-in extension compile registrations |
| VSH-0006 | `patches/VSH-0006-windows-product-metadata.patch` | Windows packaging metadata files |
| VSH-0007 | `patches/VSH-0007-start-window-package.patch` | desktop bundle entrypoint and resources |
| VSH-0008 | `patches/VSH-0008-default-locale.patch` | 제품 기본 표시 언어 |
| VSH-0009 | `patches/VSH-0009-unsigned-gallery.patch` | 서명하지 않는 확장 갤러리 |
| VSH-0010 | `patches/VSH-0010-modal-webviews.patch` | built-in 웹뷰 모달 라우팅과 bundled extension 의존성 |
| VSH-0011 | `patches/VSH-0011-file-dialog-seam.patch` | 로컬 파일 선택 요청을 VShoon 전용 트리 모달로 위임 |

## VSH-0011 — VShoon File Dialog Delegation Seam

- 목적: 로컬 파일 열기·저장 요청을 VShoon 소유 계층형 파일 선택 모달로 위임한다.
- 수정한 upstream 파일: `src/vs/workbench/services/dialogs/browser/abstractFileDialogService.ts`.
- 수정 이유: Electron 네이티브 선택기는 제목 아이콘과 내부 레이아웃을 제품이 제어할 수 없다.
  기존 Remote/가상 파일 시스템 선택기는 유지하고, `file` scheme 하나만 요청된 경우에만 VShoon 구현을 생성한다.
- 의존 symbol/service: `IInstantiationService`, `Schemas.file`, `VShoonFileDialog`, 기존 `SimpleFileDialog` fallback.
- 충돌 위험도: 낮음. 파일 선택기 팩토리 한 곳에 조건부 delegation만 추가한다.
- 테스트: client typecheck, 계층 검사, VShoon 단위 테스트, 개발 빌드와 로컬/Remote 수동 확인.
- 제거 가능 조건: upstream이 제품별 파일 선택기 factory를 제공하는 경우.

## Copilot is shipped as upstream configures it

VShoon deliberately carries **no** patch against upstream's Copilot integration. `product.json`
keeps `defaultChatAgent`, the GitHub entries in `trustedExtensionAuthAccess` and the Copilot Chat
auto-update entry; packaging stages `@github/copilot`, its platform runtime and the ripgrep shim
exactly as the Code - OSS build does.

This was a deliberate reversal. Removing Copilot cost a ten-file patch across
`contrib/chat/**`, `services/accounts/**` and `platform/extensionManagement/**` — the fastest
churning part of upstream — and it broke something quietly: dropping the sign-in onboarding
contribution left `IOnboardingService` unregistered, and `StartupPageRunnerContribution` takes that
service as a constructor dependency, so the startup editor and welcome page stopped being created
in every build with nothing but one renderer log line to say so.

What shipping it means:

- The packaged build redistributes the GitHub Copilot CLI, which is **not** MIT. Its license permits
  redistribution under conditions a VShoon build meets; [licensing.md](licensing.md) records them
  and what must stay true.
- `defaultChatAgent.extensionId` is `GitHub.copilot`, the completions extension, which is *not*
  built in and is not published to Open VSX. The chat setup flow therefore cannot install it from
  VShoon's gallery. `GitHub.copilot-chat` ships built in, so chat itself is present.
- GitHub sign-in works through the device-code and personal-access-token flows only. The URL
  handler flow needs a client secret that Code - OSS builds do not carry.
- `npm run smoke:start-window` asserts that no workbench contribution failed to be created, which
  is the check that would have caught the startup page regression above.

## VSH-0001 — Product Identity

- Purpose: separate VShoon application data, protocol handlers, mutexes, installer identities, visible product name, extension gallery and default display language from Code - OSS.
- Upstream files: `product.json`, `src/vs/base/common/product.ts` (VShoon 전용 필드의 타입).
- Reason: side-by-side installation and a distinct, non-Microsoft product identity require unique identifiers. `defaultChatAgent`, `trustedExtensionAuthAccess` and `builtInExtensionsEnabledWithAutoUpdates` are left exactly as upstream declares them, because VShoon ships upstream's Copilot integration unchanged; see [licensing.md](licensing.md) for what that redistributes and [the note below](#copilot-is-shipped-as-upstream-configures-it).
- Dependencies: upstream product configuration schema and packaging scripts that consume `product.json`. `extensionsGallery` points at Open VSX; see [licensing.md](licensing.md) for why not the Microsoft Marketplace.
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
- 검증: VShoon 단위 테스트 32개, 대상 ESLint, `valid-layers-check`, `typecheck-client`, 전체 client 및 built-in extension 빌드 통과. 격리된 Windows 데스크톱 실행에서 시작 창 표시, 두 번째 인스턴스 포커스, 폴더 인자 전달, `--disable-start-window`의 `disabledByCli` 우회, 사용자 설정 `false`의 `disabled` 우회를 확인했다. CLI 도움말에도 전용 옵션이 노출된다. `npm run smoke:start-window`는 실제 sandbox renderer의 접근성 이름, 초기 초점, 로딩 상태와 양방향 Tab 이동을 검사한 뒤 빈 Workbench를 열어 renderer 예외 없이 초기화되는지 확인한다.
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

## VSH-0005 — VShoon Extension Build Registration

- 목적: VShoon bundled 계약 샘플과 병합한 네 확장(DBConn, Decom, VSsh, VSearch)을 upstream의 built-in
  extension compile/watch 작업에 포함한다.
- 수정한 upstream 파일: `build/gulpfile.extensions.ts`.
- 이유: upstream은 시작 시간을 줄이기 위해 extension `tsconfig.json` 경로를 정적 배열로
  관리하므로 overlay 디렉터리만 추가해서는 gulp compile task가 만들어지지 않는다.
- 의존성: `extensions/vshoon-ui-sample`, `extensions/vshoon-dbconn`, `extensions/vshoon-decom`, `extensions/vshoon-vssh`,
  `extensions/vshoon-vsearch`의 `tsconfig.json`과 upstream extension gulp task 생성기.
- 충돌 위험도: 낮음. 정적 compile 목록에 다섯 항목을 추가한다.
- 검증: 각 VShoon extension의 대상 compile task와 전체 `compile-extensions`.
- 제거 조건: upstream이 overlay extension을 자동 탐색하거나 VShoon이 별도 extension 빌드
  파이프라인을 소유하게 되는 경우.

## VSH-0010 — Bundled Modal Webviews and Bundled Extension Dependencies

- 목적: 권한을 받은 bundled extension의 특정 웹뷰만 upstream Workbench 모달 편집기로 열고,
  병합한 네 확장이 사용하는 서드파티 의존성을 built-in extension 공유 의존성으로 제공한다.
- 수정한 upstream 파일: `src/vs/workbench/api/browser/mainThreadWebviewPanels.ts`,
  `src/vs/workbench/contrib/webviewPanel/browser/webviewWorkbenchService.ts`,
  `extensions/package.json`, `extensions/package-lock.json`.
- 수정 이유: 표준 Extension API의 `createWebviewPanel`은 모달 target을 노출하지 않는다. 별도 창으로
  active editor를 옮기는 방식은 사용자의 창 배치를 바꾸며 진짜 모달 포커스 경계도 만들지 못한다.
  네 확장의 의존성(DBConn 드라이버 `mysql2`/`pg`/`oracledb`, Decom의 `adm-zip`, VSsh의 `ssh2`/`iconv-lite`/
  `ppk-to-openssh`, VSearch 미리보기가 쓰는 `monaco-editor`)은 extension host에서 런타임 로드되거나
  빌드 시 media로 staging 되므로 재현 가능한 공유 dependency lock이 필요하다. `ppk-to-openssh`는
  GPL-3.0이며 배포 조건은 [licensing.md](licensing.md)가 기록한다.
- 의존 symbol/service: `MainThreadWebviewPanels`, `IWebviewWorkbenchService`, `MODAL_GROUP`, upstream
  `ModalEditorPart`, VShoon 소유 `vshoonModalWebviewRegistry`.
- 신뢰 경계: extension point가 bundled source만 허용하고 extension id와 view type을 함께 매칭한다.
  product seam으로는 식별자만 전달되며 HTML, 자격 증명, 메시지 payload 또는 DOM handle은 전달되지 않는다.
- 충돌 위험도: 중간. upstream webview panel 생성 경로와 extension 공유 dependency lockfile 변경 시
  재검토가 필요하다.
- 테스트: modal registry 및 extension-point 단위 테스트, DBConn·VSearch 단위 테스트,
  전체 client typecheck와 built-in extension build, `sync:check`. `npm run smoke:modal-webviews`가
  실제 빌드에서 세 확장의 명령을 각각 실행해, 패널이 `role="dialog"`와 `aria-modal`을 가진 모달로
  열리고 웹뷰가 그 모달 안에 배치되며 편집기 탭으로는 열리지 않는지 확인한다. 선언한 view type을
  어긋나게 두면 이 smoke test가 모달을 기다리다 실패하므로, 검사가 seam 자체를 보고 있음을 확인했다.
- 제거 가능 조건: upstream Extension API가 권한·fallback을 갖춘 modal webview target을 공식 지원하는 경우.

## VSH-0006 — Windows Product Metadata and Packaging

- 목적: Windows 실행 파일과 설치 프로그램에서 Microsoft/VS Code 배포 메타데이터를 제거하고 VShoon 제품 메타데이터를 일관되게 사용한다.
- 수정한 upstream 파일: `build/lib/electron.ts`, `build/gulpfile.vscode.ts`, `build/gulpfile.reh.ts`, `build/gulpfile.vscode.win32.ts`, `build/win32/code.iss`.
- 수정 이유: Code - OSS 빌드 기본값에는 회사명, 저작권, 게시자 URL, 설치 파일 이름이 Microsoft 또는 VS Code 값으로 하드코딩되어 있다. 또한 Windows 패키징 마지막 단계가 `signtool.exe`로 기존 서명을 확인하는데, 서명을 하지 않는 개발 머신에는 Windows SDK 서명 도구가 없어 `ENOENT`로 패키징 전체가 실패한다. `hasAuthenticodeSignature`가 ENOENT를 "서명 없음"으로 처리하도록 좁혀서, 서명 파이프라인이 있는 환경의 동작은 그대로 두고 개발 패키지 빌드만 통과시킨다.
- 의존 symbol/service: `product.json`의 `companyName`, `copyright`, `win32PublisherName`, `win32PublisherUrl`, `win32SetupBaseName`과 Electron/Inno Setup 패키징 작업. Inno Setup 쪽은 `PublisherName`, `PublisherUrl`, `SetupBaseName`, `Copyright` 정의를 `code.iss`의 `AppPublisher`, `AppPublisherURL`, `OutputBaseFilename`, `AppCopyright`에 연결한다.
- 충돌 위험도: 중간. upstream Windows 패키징 정의나 executable resource 편집 단계가 바뀌면 재검토가 필요하다.
- 테스트: build TypeScript 검사, clean `npm run sync`, Windows x64 패키지 생성 후 실행 파일 version resource와 Inno Setup 메타데이터 검사.
- 제거 가능 조건: upstream 패키징이 모든 게시자·저작권·설치 파일 정보를 `product.json`에서 직접 읽도록 변경되는 경우.

## VSH-0009 — Unsigned Extension Gallery

- 목적: Open VSX처럼 저장소 서명을 하지 않는 갤러리에서도 확장을 설치할 수 있게 한다.
- 수정한 upstream 파일: `src/vs/platform/extensionManagement/node/extensionManagementService.ts`.
- 수정 이유: 패키지 빌드는 설치 전에 서명을 검증하고 실패하면 설치를 중단한다. Open VSX는 Microsoft 저장소 서명을 하지 않고, OSS 빌드에는 검증기(`vsda`)도 없다. 그대로 두면 모든 확장 설치가 `Signature verification was not executed`로 실패한다. 개발 실행은 `environmentService.isBuilt`가 false라 이 경로를 타지 않으므로 패키지에서만 드러난다.
- 의존 symbol/service: `IProductService`, `product.json`의 `extensionsGallery.vshoonRepositorySigned`, `VerifyExtensionSignatureConfigKey`.
- 충돌 위험도: 낮음. `downloadExtension` 앞에 조건 하나를 더한다.
- 동작: `vshoonRepositorySigned`가 `false`일 때만 검증을 끈다. 필드가 없으면 upstream과 동일하게 검증하며, 사용자 설정 `extensions.verifySignature`도 그대로 남는다. 확장 관리 서비스 한 곳만 고치므로 Workbench 설치와 CLI `--install-extension`이 같은 동작을 한다.
- 테스트: 패키지 빌드 후 `bin\vshoon.cmd --install-extension <id>`로 설치 확인.
- 제거 가능 조건: 갤러리가 저장소 서명을 제공하고 빌드에 검증기가 포함되는 경우.

## VSH-0008 — Default Display Language

- 목적: 새 설치가 제품이 정한 표시 언어로 시작하게 한다. VShoon은 `ko`다.
- 수정한 upstream 파일: `src/main.ts`, `src/vs/base/common/product.ts`.
- 수정 이유: Windows에서는 OS 언어가 표시 언어를 결정하지 못한다. `src/main.ts`가 argv.json에 locale이 없으면 Electron `lang` 스위치를 `en`으로 고정하고, 그러면 `resolveNLSConfiguration`이 `userLocale.startsWith('en')` 조건에 걸려 언어 팩이 설치돼 있어도 영어로 되돌아간다. 따라서 기본 argv.json에 제품 기본 언어를 써 두는 방법 외에는 기본값을 정할 수 없다.
- 의존 symbol/service: `getUserDefinedLocale`, `resolveNLSConfiguration`, `IProductConfiguration`, `product.json`의 `vshoonDefaultLocale`, VShoon 소유 `src/vs/vshoon/node/languagePackSeed.ts`.
- 충돌 위험도: 낮음. locale 해석 함수 끝에 fallback 한 줄과 인터페이스 선택 필드 하나를 더한다.
- 동작: `--locale`과 argv.json의 `locale`이 모두 없을 때만 제품 기본값을 쓴다. `vshoonDefaultLocale`이 없으면 upstream과 동일하게 영어다. "Configure Display Language"로 고른 언어는 argv.json에 기록되므로 항상 제품 기본값보다 우선하고, "Clear Display Language Preference"는 그 기록을 지우므로 제품 기본값으로 돌아온다. argv.json 기본 템플릿을 건드리지 않기 때문에 이미 설치된 환경에도 그대로 적용된다.
- 첫 실행: `languagepacks.json`은 원래 shared process가 쓰는데, shared process는 Workbench 창이 열려야 시작한다. 그래서 아무 것도 하지 않으면 첫 실행은 영어이고, 특히 사용자가 가장 먼저 보는 시작 창이 영어로 뜬다. VShoon이 자기가 배포하는 언어 팩만 미리 색인해 두고(`seedVShoonLanguagePacks`) 나머지는 upstream에 맡긴다. shared process가 실행되면 설치된 확장 기준으로 이 파일을 다시 쓴다.
- 테스트: `src/vs/vshoon/test/node/languagePackSeed.test.ts`의 색인 생성 단위 테스트, 그리고 패키지 빌드 후 새 프로필 첫 실행에서 시작 창과 Workbench가 한국어로 뜨는지 확인.
- 제거 가능 조건: upstream이 제품 단위 기본 표시 언어를 지원하는 경우.

## VSH-0007 — Start Window Package Resources

- 목적: 프로덕션 desktop bundle에 시작 창 renderer 진입점과 HTML/CSS/PNG 정적 파일을 포함한다.
- 수정한 upstream 파일: `build/buildfile.ts`, `build/next/index.ts`.
- 수정 이유: 개발 실행은 `src`의 정적 파일을 직접 읽지만 패키지 빌드는 명시적인 entrypoint/resource 목록만 복사하므로, 등록하지 않으면 시작 창이 `ERR_FILE_NOT_FOUND`로 종료된다.
- 의존 symbol/service: `build/buildfile.ts`의 desktop `code` entrypoint 목록, `build/next/index.ts`의 `codeEntryPoints`와 `desktopResourcePatterns`.
- 충돌 위험도: 낮음. 기존 desktop 목록에 VShoon 경로 항목만 추가한다.
- 주의: 번들러가 두 벌이다. `buildfile.ts`는 기존 gulp 번들러가, `build/next/index.ts`의 `codeEntryPoints`는 현재 패키징이 사용하는 esbuild 번들러가 읽는다. 한쪽만 등록하면 개발 실행은 정상인데 패키지에서만 renderer 번들이 빠진다.
- 테스트: `vscode-win32-x64` 패키지 생성 후 `out/vs/vshoon/electron-sandbox/startWindow`의 JS/HTML/CSS/PNG 존재 확인 및 packaged start-window smoke test. smoke test는 제품 마크 이미지가 실제로 디코딩되는지도 확인하므로 CSP나 리소스 누락이 회귀하면 실패한다.
- 제거 가능 조건: upstream bundler가 제품 overlay의 renderer entrypoint와 정적 파일을 선언적으로 수집할 수 있게 되는 경우.
