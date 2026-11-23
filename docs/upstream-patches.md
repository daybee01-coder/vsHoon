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
| VSH-0012 | `patches/VSH-0012-os-file-drops.patch` | 선언한 bundled 웹뷰 뷰에 OS 파일 드롭 경로 전달 |
| VSH-0013 | `patches/VSH-0013-native-file-drag.patch` | 로컬 파일을 OS 드래그로 내보내는 네이티브 seam |
| VSH-0014 | `patches/VSH-0014-new-window-start.patch` | Workbench 새 창 요청을 콤팩트 시작 창으로 표시하는 표식 |
| VSH-0015 | `patches/VSH-0015-start-project-new-window.patch` | 시작 창에서 이미 열린 프로젝트도 별도 IDE 창으로 열고 시작 창의 모니터 사용 |
| VSH-0016 | `patches/VSH-0016-inline-jar-explorer.patch` | 기본 Explorer의 JAR 파일 노드 아래에 Decom 읽기 전용 VFS 내용 표시 |
| VSH-0017 | `patches/VSH-0017-editor-tab-filter.patch` | 편집기 탭 막대를 메인·SSH·SQL 그룹별로 걸러 표시, 사이드바 선택에 따라 그룹 전환 |

## VSH-0017 — 편집기 탭 그룹 필터

- 목적: 편집기 제목 도구 모음의 필터 버튼으로 **모든 편집기 / 메인 편집기 / SSH 터미널 / SQL 편집기** 중
  하나를 고르면 그 그룹의 탭만 탭 막대에 보이고 나머지는 숨긴다. 편집기는 닫지 않는다.
- 수정한 upstream 파일: `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`,
  `src/vs/workbench/browser/parts/sidebar/sidebarPart.ts`.
- 수정 이유: 확장 API는 탭을 닫을 수는 있어도 숨길 수 없다. 탭을 닫았다 다시 여는 방식은 SSH 터미널
  세션과 저장하지 않은 SQL 스크립트를 잃는다. 탭 DOM은 편집기 인덱스와 1:1로 묶여 있어(드래그 앤 드롭,
  스크롤, 고정 탭 위치) 탭을 빼는 대신 표시만 끈다.
- VShoon 소유 구현: `src/vs/vshoon/common/editorTabFilter.ts`(분류, 창 단위 필터 상태, 그룹 context key
  연결), `src/vs/vshoon/browser/editorTabFilter.ts`(제목 도구 모음 드롭다운과 명령 팔레트 명령
  `vshoon.editorTabs.show.{all,main,ssh,sql}`).
- 분류: 편집기 영역 터미널(`workbench.editors.terminal`, VSsh SSH·WSL 세션) → SSH, 언어가 `sql`이거나
  확장자가 `.sql`인 편집기(DBConn의 제목 없는 스크립트 포함) → SQL, 나머지 → 메인.
- 동작: seam은 세 곳이다. (1) 필터가 바뀌면 각 그룹이 활성 편집기가 숨겨질 경우 그 그룹에서 가장 최근에 쓴
  보이는 편집기로 바꾸고 탭을 다시 그린다. 해당 그룹에 맞는 편집기가 없으면 활성 탭 하나만 남긴다.
  (2) 빠른 열기·탐색기·확장 명령으로 다른 그룹의 편집기가 활성화되면 필터가 그 그룹으로 따라간다.
  (3) 탭을 그릴 때 활성 탭이 아니고 필터에 맞지 않으면 `display: none`. (4) 사이드바가 탐색기·VSsh·Database 뷰
  컨테이너를 열면 각각 메인·SSH·SQL로 전환한다(`showForViewContainer`). 사이드바 뷰 컨테이너 전환을 알려 주는 확장
  API가 없고 탐색기는 코어 뷰라 `SidebarPart`의 `onDidPaneCompositeOpen`에 한 줄을 붙였다.
- 의존 symbol/service: `MultiEditorTabsControl.redrawTab`, `handleOpenedEditors`, `IEditorGroupView.getEditors`·
  `openEditor`, `EditorTabsControl.contextKeyService`, `MenuId.EditorTitle`, `TerminalEditorInput.ID`,
  `FileEditorInput`/`UntitledTextEditorInput`의 `getLanguageId()`.
- 충돌 위험도: 낮음. import 한 줄, 생성자 등록과 private 메서드 하나, 기존 메서드 두 곳에 각각 조건 하나.
  `sidebarPart.ts`는 import 한 줄과 생성자 등록 한 줄.
  upstream이 탭 DOM 구성이나 `handleOpenedEditors`를 바꾸면 재검토가 필요하다.
- 한계: 필터는 창 메모리에만 있어 새로 고침하면 **모든 편집기**로 돌아간다. 고정 탭을 compact/shrink로
  쓰는 경우 숨긴 고정 탭 자리만큼 고정 위치 계산이 어긋날 수 있다. Ctrl+Tab 등 그룹 내 편집기 순환은 숨긴
  편집기도 거치며, 그때 필터가 해당 그룹으로 바뀐다.
- 테스트: `src/vs/vshoon/test/common/editorTabFilter.test.ts`(분류, 필터 전환, reveal, context key),
  client typecheck, 계층 검사, `sync:check`. 개발 빌드에서 Java·SQL·텍스트 파일과 편집기 터미널을 연 뒤
  드롭다운과 명령 팔레트로 그룹을 바꿔 보이는 탭이 그룹과 일치하는지, 메인 필터에서 `.sql`을 열면 SQL로
  전환되는지 Playwright로 확인했다.
- 제거 가능 조건: upstream이 탭 필터링 또는 편집기 탭 그룹 API를 제공하는 경우.

## VSH-0014 — Start Window for the Workbench New Window Action

- 목적: 기존 Workbench에서 **새 창**을 실행하면 빈 Workbench 대신 콤팩트 시작 창을 표시한다.
- 수정한 upstream 파일: `src/vs/platform/window/common/window.ts`,
  `src/vs/workbench/browser/actions/windowActions.ts`.
- 수정 이유: Workbench의 새 창 명령은 두 번째 인스턴스의 `ILaunchMainService`를 거치지 않고
  `IHostService.openWindow()`로 main process의 native-host 채널을 직접 호출한다. 다른 빈 창 흐름과
  구분할 수 있도록 전용 boolean 표식 하나가 필요하다.
- VShoon 소유 구현: `src/vs/vshoon/electron-main/nativeHostMainService.ts`가 native-host 서비스를
  감싸 표식이 있는 요청만 시작 창 서비스로 넘긴다. `vshoon.startWindow.enabled=false`이면 원래
  요청을 그대로 위임한다. 시작 창 서비스는 초기 실행과 보조 선택기를 구분해 보조 선택기를 닫아도
  기존 Workbench를 종료하지 않는다.
- 의존 symbol/service: `IHostService.openWindow`, `INativeHostMainService`,
  `IVShoonStartWindowMainService`, `IConfigurationService`.
- 충돌 위험도: 낮음. 옵션 타입에 선택 필드 하나를 추가하고 새 창 action의 호출 인자에만 표식을
  붙인다. main-process 연결은 VSH-0002가 이미 소유한 `CodeApplication.initChannels` seam을 확장한다.
- 테스트: 새 창 정책 단위 테스트, client typecheck, 계층 검사, 대상 ESLint, 개발 빌드에서
  **새 창** 실행 후 시작 창 표시 및 닫아도 기존 Workbench가 유지되는지 확인.
- 제거 가능 조건: upstream이 제품별 새 창 factory 또는 시작 창 기여점을 제공하는 경우.

## VSH-0013 — Native File Drag Out of Bundled Webview Views

- 목적: 선언한 bundled 웹뷰 뷰가 이미 로컬에 있는 파일을 윈도우 탐색기 같은 OS 드롭 대상으로
  끌어낼 수 있게 한다.
- 수정한 upstream 파일: `src/vs/platform/native/common/native.ts`,
  `src/vs/platform/native/electron-main/nativeHostMainService.ts`,
  `src/vs/workbench/electron-browser/desktop.contribution.ts`,
  `src/vs/workbench/test/electron-browser/workbenchTestServices.ts`.
- 수정 이유: 샌드박스 웹뷰는 실제 경로를 가진 네이티브 드래그를 시작할 수 없다. upstream이 파일을
  OS로 내보낼 때 쓰는 `DownloadURL`은 주석이 스스로 밝히듯 단일 파일과 `file:` URI로 제한되고
  ([workbench/browser/dnd.ts](../.core/src/vs/workbench/browser/dnd.ts)), 여러 항목이나 폴더에는
  쓸 수 없다. `webContents.startDrag`만이 이를 제대로 처리하는데 main 프로세스 API이므로,
  `INativeHostService`에 최소한의 진입점 하나를 추가하고 desktop 계층에서 구현을 등록한다.
- 의존 symbol/service: `INativeHostService`, `NativeHostMainService.windowById`, Electron
  `webContents.startDrag`와 `nativeImage`, `registerWorkbenchContribution2`, VShoon 소유
  `vshoonOsFileDragDelegate`.
- 신뢰 경계: 드래그 요청은 VSH-0012가 이미 권한을 확인한 뷰의 웹뷰 메시지로만 들어온다. seam은
  browser 계층이라 native 서비스를 직접 참조하지 않고 delegate만 호출하며, 구현은 desktop 계층이
  채운다. 경로 개수는 100개로 제한하고 빈 문자열을 거부한다. 파일을 새로 만들거나 지우지 않고
  이미 있는 경로를 셸에 넘기기만 한다. 다만 경로 자체는 확장의 웹뷰가 제시한 값이므로, 이 기능을
  쓰는 확장은 자기 웹뷰 콘텐츠를 신뢰할 수 있어야 한다(VSH-0012와 같은 조건).
- 충돌 위험도: 낮음. 네이티브 서비스에 메서드 하나, desktop 기여 등록 한 곳을 더한다. upstream이
  `INativeHostService` 형태나 contribution 등록 방식을 바꾸면 재검토가 필요하다.
- 테스트: 드래그 요청 파싱 단위 테스트(형식·개수·빈 경로 거부), client typecheck, 계층 검사,
  확장 컴파일, 개발 빌드. 실제 셸로의 드래그는 마우스 버튼이 눌린 상태를 요구해 CDP로 합성할 수
  없으므로 수동 확인으로 남는다.
- 제거 가능 조건: upstream이 웹뷰에서 네이티브 파일 드래그를 시작하는 공식 경로를 제공하는 경우.

## VSH-0012 — OS File Drops for Bundled Webview Views

- 목적: 윈도우 탐색기에서 끌어온 파일의 실제 경로를, 이를 선언한 bundled 확장의 웹뷰 뷰에 전달한다.
- 수정한 upstream 파일: `src/vs/workbench/contrib/webviewView/browser/webviewViewPane.ts`.
- 수정 이유: 웹뷰는 OS 파일 드롭을 받을 수 없다. 웹뷰 preload가 드래그 항목이 전부 파일이면
  `drag-start`를 호스트에 보내고, `WebviewElement`가 iframe에 `pointer-events: none`을 걸어
  드롭을 Workbench로 넘긴다(electron#18226 회피). 확장이 웹뷰 안에서 아무리 `drop`을 처리해도
  이벤트 자체가 도달하지 않는다. 게다가 Electron 32부터 `File.path`가 없어져, 도달하더라도
  웹뷰에서는 경로를 알 수 없다. 경로를 아는 곳은 `webUtils.getPathForFile`을 쓸 수 있는 Workbench
  렌더러뿐이므로, 드롭을 빼앗기는 바로 그 자리에서 경로를 풀어 선언한 뷰에 돌려준다.
- 의존 symbol/service: `WebviewViewPane`의 `extensionId`·`id`·pane body 컨테이너, `containsDragType`,
  `DataTransfers.FILES`, `getPathForFile`, `IOverlayWebview.postMessage`, VShoon 소유
  `vshoonOsFileDropRegistry`.
- 신뢰 경계: extension point가 bundled source만 허용하고 extension id와 view type을 함께 매칭한다.
  경로는 Workbench가 드롭 이벤트에서 직접 풀어낸 값이며 확장이 제시한 값을 쓰지 않는다. 선언하지
  않은 뷰에서는 리스너가 즉시 빠져나가 upstream 동작이 그대로 유지된다. 전달은 뷰가 이미 듣고 있는
  웹뷰 메시지 채널을 쓰므로 새 extension host API를 열지 않는다. 다만 확장이 그 경로를 다시 호스트로
  돌려보내는 구간은 확장 자신의 웹뷰를 거치므로, 이 경로를 받는 확장은 자기 웹뷰 콘텐츠를 신뢰할 수
  있어야 한다.
- 충돌 위험도: 낮음. 웹뷰 뷰 pane 한 곳에 조건부 리스너만 추가한다. upstream이 웹뷰 드래그 차단
  방식이나 `getPathForFile` 노출을 바꾸면 재검토가 필요하다.
- 테스트: 레지스트리 단위 테스트(권한·형식·중복 거부, 부분 등록 없음), client typecheck, 계층 검사,
  확장 컴파일, 개발 빌드에서 SFTP 뷰에 파일 dragover를 보내 VShoon 리스너가 이를 취소하는지 확인.
  실제 OS 드래그는 CDP로 합성되지 않아(Electron이 `Input.dispatchDragEvent`를 DOM에 전달하지 않음)
  탐색기에서의 최종 확인은 수동으로 남아 있다. UIPI 때문에 승격 실행 중에는 드롭 자체가 차단되므로
  비승격 실행이 전제다.
- 제거 가능 조건: upstream이 웹뷰에 OS 드롭 경로를 전달하는 공식 경로를 제공하는 경우.

## VSH-0011 — VShoon File Dialog Delegation Seam

- 목적: 로컬 파일 열기·저장 요청을 VShoon 소유 계층형 파일 선택 모달로 위임한다.
- 수정한 upstream 파일: `src/vs/workbench/services/dialogs/browser/abstractFileDialogService.ts`.
- 수정 이유: Electron 네이티브 선택기는 제목 아이콘과 내부 레이아웃을 제품이 제어할 수 없다.
  기존 Remote/가상 파일 시스템 선택기는 유지하고, `file` scheme 하나만 요청된 경우에만 VShoon 구현을 생성한다.
  확장 호스트가 로컬 선택 요청을 빈 `availableFileSystems` 배열로 전달하는 경우에는 기본 URI와 창 scheme으로
  로컬 요청인지 판정해 동일한 VShoon 선택기를 사용한다.
- 의존 symbol/service: `IInstantiationService`, `IPathService.userHome`, `VShoonFileDialog`,
  `shouldUseVShoonFileDialog`, 기존 `SimpleFileDialog` fallback.
- 충돌 위험도: 낮음. 파일 선택기 팩토리 한 곳에 조건부 delegation만 추가한다.
- 테스트: 빈 scheme 배열·로컬/Remote·혼합 scheme·다중 선택 정책 단위 테스트, client typecheck, 계층 검사,
  개발 빌드와 로컬/Remote 수동 확인.
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

- Purpose: separate VShoon application data, protocol handlers, mutexes, installer identities, visible product name, extension gallery and default display language from Code - OSS. Allow a locally installed official OpenAI Codex extension (`openai.chatgpt`) to use the two proposed APIs declared by its manifest.
- Upstream files: `product.json`, `src/vs/base/common/product.ts` (VShoon 전용 필드의 타입).
- Reason: side-by-side installation and a distinct, non-Microsoft product identity require unique identifiers. `defaultChatAgent`, `trustedExtensionAuthAccess` and `builtInExtensionsEnabledWithAutoUpdates` are left exactly as upstream declares them, because VShoon ships upstream's Copilot integration unchanged; see [licensing.md](licensing.md) for what that redistributes and [the note below](#copilot-is-shipped-as-upstream-configures-it).
- Dependencies: upstream product configuration schema and packaging scripts that consume `product.json`. `extensionsGallery` points at Open VSX; see [licensing.md](licensing.md) for why not the Microsoft Marketplace. `extensionEnabledApiProposals` grants `languageModelProxy` and `chatSessionsProvider` only to `openai.chatgpt`; the extension remains a user-installed VSIX and is not redistributed with VShoon.
- Conflict risk: medium; upstream occasionally adds product identity fields.
- Validation: parse `product.json`; verify both enabled proposal names exist in the pinned core; inspect packaged Windows metadata and side-by-side behavior in Phase 4.
- Removal condition: none while VShoon remains a separately distributed product.

## VSH-0002 — Start-Window Policy and Lifecycle Seam

- 목적: 대상 없는 데스크톱 실행을 Workbench 생성 전에 VShoon 시작 창으로 위임하고, 시작 창이 실행을 소유하는 동안 도착한 두 번째 인스턴스를 올바르게 처리한다.
- VShoon 소유 파일: `src/vs/vshoon/common/startWindowPolicy.ts`, `src/vs/vshoon/node/launchRequest.ts`, `src/vs/vshoon/electron-main/startWindowMainService.ts`, `src/vs/vshoon/electron-main/launchMainService.ts`, `src/vs/vshoon/electron-sandbox/startWindow/**`, `src/vs/vshoon/test/**`.
- 수정한 upstream 파일: `src/vs/code/electron-main/app.ts`, `src/vs/platform/environment/common/argv.ts`, `src/vs/platform/environment/node/argv.ts`.
- 이유: 일반 확장은 Workbench가 생성된 뒤 활성화되므로 시작 창 수명주기를 제어할 수 없다.
- 의존성: `CodeApplication.openFirstWindow`, `CodeApplication.initChannels`, `ILaunchMainService`, `IWindowsMainService`, `IWorkspacesHistoryMainService`, lifecycle 및 dialog 서비스.
- 충돌 위험도: 정책 모듈은 낮음, `app.ts` seam은 높음.
- 현재 seam: `app.ts`에서 네 곳을 수정한다. (1) `IVShoonStartWindowMainService` 등록, (2) `initChannels`에서 두 번째 인스턴스에 노출되는 `launch` 채널을 `VShoonLaunchMainService`로 감싸기, (3) 같은 메서드에서 Workbench 새 창 표식을 처리하도록 `nativeHost` 채널을 감싸기, (4) `openFirstWindow`에서 설정을 포함한 정책 판정과 시작 창 수명주기 처리. 환경 인자 파일 두 곳에는 `--disable-start-window` 타입과 CLI 설명만 추가한다.
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

- 목적: VShoon bundled 계약 샘플과 병합한 네 확장(DBConn, Decom, VSsh, VSearch), Spring 실행 확장, 터미널 PATH에 `vshoon` 명령을 넣는 시작 확장을 upstream의 built-in
  extension compile/watch 작업에 포함한다.
- 수정한 upstream 파일: `build/gulpfile.extensions.ts`.
- 이유: upstream은 시작 시간을 줄이기 위해 extension `tsconfig.json` 경로를 정적 배열로
  관리하므로 overlay 디렉터리만 추가해서는 gulp compile task가 만들어지지 않는다.
- 의존성: `extensions/vshoon-ui-sample`, `extensions/vshoon-dbconn`, `extensions/vshoon-decom`, `extensions/vshoon-vssh`,
  `extensions/vshoon-vsearch`, `extensions/vshoon-spring`, `extensions/vshoon-start`의 `tsconfig.json`과 upstream extension gulp task 생성기.
- 충돌 위험도: 낮음. 정적 compile 목록에 일곱 항목을 추가한다.
- 검증: 각 VShoon extension의 대상 compile task와 전체 `compile-extensions`.
- 제거 조건: upstream이 overlay extension을 자동 탐색하거나 VShoon이 별도 extension 빌드
  파이프라인을 소유하게 되는 경우.

## VSH-0010 — Bundled Modal Webviews and Bundled Extension Dependencies

- 목적: 권한을 받은 bundled extension의 특정 웹뷰를 upstream Workbench 모달 또는 보조 데스크톱 창으로 열고,
  병합한 네 확장이 사용하는 서드파티 의존성을 built-in extension 공유 의존성으로 제공한다.
- 수정한 upstream 파일: `src/vs/workbench/api/browser/mainThreadWebviewPanels.ts`,
  `src/vs/workbench/contrib/webviewPanel/browser/webviewWorkbenchService.ts`,
  `src/vs/workbench/browser/parts/editor/modalEditorPart.ts`,
  `extensions/package.json`, `extensions/package-lock.json`.
- 수정 이유: 표준 Extension API의 `createWebviewPanel`은 모달 target을 노출하지 않는다. 별도 창으로
  active editor를 옮기는 방식은 사용자의 창 배치를 바꾸며 진짜 모달 포커스 경계도 만들지 못한다.
  모달 편집기의 기본 크기 상태는 모든 패널이 공유하므로, 선언과 일치한 웹뷰에만 제한된 초기 크기를
  전달하지 않으면 VSsh·DBConn·VSearch가 직전에 닫힌 다른 모달의 크기를 물려받는다.
  네 확장의 의존성(DBConn 드라이버 `mysql2`/`pg`/`oracledb`, Decom의 `adm-zip`, VSsh의 `ssh2`/`iconv-lite`/
  `ppk-to-openssh`, VSearch 미리보기가 쓰는 `monaco-editor`)은 extension host에서 런타임 로드되거나
  빌드 시 media로 staging 되므로 재현 가능한 공유 dependency lock이 필요하다. `ppk-to-openssh`는
  GPL-3.0이며 배포 조건은 [licensing.md](licensing.md)가 기록한다.
- 의존 symbol/service: `MainThreadWebviewPanels`, `IWebviewWorkbenchService`, `MODAL_GROUP`, `AUX_WINDOW_GROUP`, upstream
  `ModalEditorPart`, VShoon 소유 `vshoonModalWebviewRegistry`.
- 신뢰 경계: extension point가 bundled source만 허용하고 extension id와 view type을 함께 매칭한다.
  크기는 정수 `400×300` 이상 `2400×1600` 이하로 제한하고 Workbench가 실제 가용 영역으로 다시
  축소한다. product seam으로 HTML, 자격 증명, 메시지 payload 또는 DOM handle은 전달되지 않는다.
- 충돌 위험도: 중간. upstream webview panel 생성 경로와 extension 공유 dependency lockfile 변경 시
  재검토가 필요하다.
- 테스트: modal registry 및 extension-point 단위 테스트, DBConn·VSearch 단위 테스트,
  전체 client typecheck와 built-in extension build, `sync:check`. `npm run smoke:modal-webviews`가
  실제 빌드에서 DBConn·VSsh 명령을 각각 실행해, 패널이 `role="dialog"`와 `aria-modal`을 가진 모달로
  열리고 웹뷰가 그 모달 안에 배치되며 편집기 탭으로는 열리지 않는지 확인한다. 선언한 view type을
  어긋나게 두면 이 smoke test가 모달을 기다리다 실패하므로, 검사가 seam 자체를 보고 있음을 확인했다.
  `npm run smoke:java-search`는 VSearch 팝업의 머리글을 실제로 끌어 웹뷰와 함께 창 경계 밖으로
  넘어가고 머리글은 창 안에 남는지 검증한다. registry 테스트는 `presentation: 'window'`와 잘못된 값의 거부를 검사한다.
- 제거 가능 조건: upstream Extension API가 권한·fallback을 갖춘 modal webview target을 공식 지원하는 경우.

2026-09-07: `ModalEditorPart`의 active editor 전환과 disposable 수명주기에
`VShoonModalWebviewLayout`을 연결했다. 위치·크기 setter가 공개 서비스에서는 readonly여서
제품 모듈만으로 복원할 수 없으므로 이 작은 seam을 추가했다. 저장과 플러그인 구분은
VShoon 모듈이 담당하고 화면 경계 제한은 upstream layout을 재사용한다.
창 메모리에서 extension id + view type별로 보관하며 창 종료/새로고침 시 초기화된다.
추가 검증은 layout snapshot 단위 테스트와 `npm run smoke:modal-webviews -- --remember-layout`이다.
후자는 세 패널을 각각 크기 변경·이동한 뒤 닫고 다시 열어, 남긴 geometry 그대로 복원되는지 확인한다.

2026-11-04 후속: VSearch는 `presentation: 'window'`를 선언해 `AUX_WINDOW_GROUP`으로 직접 연다.
표준 API에서 auxiliary target을 지정할 수 없으므로 기존 생성 seam에 위임만 추가했다. 옵션은 검증된
크기와 고정된 compact 모드뿐이며 임의 창 옵션을 확장에 노출하지 않는다. 다시 표시할 때는 해당 웹뷰의
기존 그룹을 사용해 다른 편집기나 새 보조 창으로 옮기지 않는다. DBConn·VSsh의 모달 동작은 유지한다.

2026-11-04 재점검: 사용자 요청으로 VSearch를 다시 모달 팝업으로 연다(`presentation` 선언 제거).
`presentation: 'window'` 경로는 capability로 유지한다. `ModalEditorPart`의 머리글 끌기, 크기 조절과
재배치 clamp가 `VShoonModalWebviewLayout.positionBounds()`를 먼저 묻도록 했다. 선언된 번들 패널이면
창 경계를 넘어 잘린 채 배치될 수 있고 머리글 160×48px는 창 안, 제목 표시줄 아래에 남는다.
일반 모달 편집기는 `undefined`를 받아 upstream clamp를 그대로 사용한다. `VShoonModalWebviewLayout`
생성 위치를 끌기 처리기 앞으로 옮겨 첫 layout 전에 준비되게 했다.

## VSH-0006 — Windows Product Metadata and Packaging

- 목적: Windows 실행 파일과 설치 프로그램에서 Microsoft/VS Code 배포 메타데이터를 제거하고 VShoon 제품 메타데이터를 일관되게 사용한다.
- 수정한 upstream 파일: `build/.moduleignore.win32`, `build/lib/electron.ts`, `build/gulpfile.vscode.ts`, `build/gulpfile.reh.ts`, `build/gulpfile.vscode.win32.ts`, `build/win32/code.iss`.
- 수정 이유: Code - OSS 빌드 기본값에는 회사명, 저작권, 게시자 URL, 설치 파일 이름이 Microsoft 또는 VS Code 값으로 하드코딩되어 있다. 또한 Windows 패키징 마지막 단계가 `signtool.exe`로 기존 서명을 확인하는데, 서명을 하지 않는 개발 머신에는 Windows SDK 서명 도구가 없어 `ENOENT`로 패키징 전체가 실패한다. `hasAuthenticodeSignature`가 ENOENT를 "서명 없음"으로 처리하도록 좁혀서, 서명 파이프라인이 있는 환경의 동작은 그대로 두고 개발 패키지 빌드만 통과시킨다. `oracledb`는 모든 플랫폼의 네이티브 바이너리를 한 패키지에 싣기 때문에 Windows 정리 규칙에서 Darwin/Linux 파일을 제외하여, Windows 리소스 편집기가 ELF/Mach-O `.node` 파일을 처리하지 않도록 한다.
- 의존 symbol/service: `product.json`의 `companyName`, `copyright`, `win32PublisherName`, `win32PublisherUrl`, `win32SetupBaseName`과 Electron/Inno Setup 패키징 작업. Inno Setup 쪽은 `PublisherName`, `PublisherUrl`, `SetupBaseName`, `Copyright` 정의를 `code.iss`의 `AppPublisher`, `AppPublisherURL`, `OutputBaseFilename`, `AppCopyright`에 연결한다.
- 충돌 위험도: 중간. upstream Windows 패키징 정의나 executable resource 편집 단계가 바뀌면 재검토가 필요하다.
- 테스트: build TypeScript 검사, clean `npm run sync`, Windows 의존성 패키징에서 `oracledb`의 Windows x64 바이너리만 남는지 확인, Windows x64 패키지 생성 후 실행 파일 version resource와 Inno Setup 메타데이터 검사.
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

## VSH-0015 — 시작 창의 프로젝트를 새 IDE 창으로 열기

- 목적: 같은 프로젝트가 열려 있어도 별도 창을 만들고, 시작 창에서 여는 Workbench를 시작 창과 같은 모니터에 배치한다.
- upstream 파일: `src/vs/platform/windows/electron-main/windows.ts`, `src/vs/platform/windows/electron-main/windowsMainService.ts`, `src/vs/platform/windows/electron-main/windowsStateHandler.ts`.
- 수정 이유: 프로젝트 중복 처리와 새 창의 초기 위치는 창을 생성하기 전에 upstream 창 서비스가 결정한다.
- 의존 symbol/service: `IOpenConfiguration`, `IWindowsMainService.open`, `IWindowsMainService.openEmptyWindow`, `findWindowOnWorkspaceOrFolder`, `WindowsStateHandler.getNewWindowState`.
- 동작: `forceNewWindow`와 `vshoonNewProjectWindow`를 함께 전달하면 기존 프로젝트 창 검색을 건너뛴다. `vshoonDisplayId`를 전달하면 창 상태의 표시 모드를 유지하고 해당 모니터의 작업 영역에 배치한다.
- 충돌 위험도: 낮음. 내부 열기 옵션과 프로젝트 중복 판정, 새 창 상태 계산에 한정한다.
- 테스트: `npm run smoke:start-window`에서 기존 프로젝트의 새 창 생성, 시작 창과 Workbench 사이의 모니터 전달, CLI 직접 실행을 검사한다. 보조 모니터의 좌표를 `-- --secondary-display x,y`로 넘기면 Workbench를 해당 모니터로 옮겨 시작 창을 열고, 다시 시작 창의 위치를 바꿔 선택한 프로젝트가 같은 모니터를 따르는지 확인한다.
- 제거 가능 조건: upstream이 이미 열린 프로젝트의 새 창 생성과 새 창의 대상 모니터 지정을 지원하는 경우.

## VSH-0016 — 기본 Explorer의 인라인 JAR 탐색

- 목적: JAR를 워크스페이스 폴더로 마운트하지 않고 기존 Explorer 파일 노드 아래에서 바로 펼친다.
- upstream 파일: `src/vs/workbench/contrib/files/browser/views/explorerView.ts`, `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts`, `src/vs/workbench/contrib/files/common/explorerModel.ts`, `src/vs/workbench/contrib/files/test/browser/explorerModel.test.ts`.
- 수정 이유: 일반 확장 API는 기본 Explorer의 파일 노드에 자식을 제공하거나 파일 열기를 트리 확장으로 바꿀 수 없다.
- 의존 symbol/service: `ExplorerView`, `ExplorerDataSource`, `ExplorerItem`, `ICommandService`, `IFileService`.
- 동작: 로컬 `.jar`와 JAR 내부의 가상 `.jar`에 twistie를 제공하고, 펼칠 때 bundled Decom의 `decom.resolveExplorerJar` 명령이 반환한 `vshoon-jar:` VFS 자식을 연결한다. JAR 열기는 편집기 대신 트리를 확장한다. 시각적 부모가 JAR여도 자식 모델의 실제 가상 URI는 보존한다.
- 신뢰 경계: core는 VFS URI를 직접 만들거나 ZIP을 읽지 않는다. Decom이 항목명과 크기를 검증하고 등록한 읽기 전용 파일 시스템만 사용한다. 쓰기·이름 변경·삭제는 파일 시스템 제공자 단계에서 거부한다.
- 충돌 위험도: 중간. Explorer 데이터 소스와 열기 이벤트에 작은 분기가 있고, 시각적 부모와 파일 URI를 분리하는 모델 seam이 있어 upstream 트리 모델 변경 시 재검증이 필요하다.
- 테스트: 제품 공통 판정 단위 테스트, 실제 CFR·영속 캐시 재사용·오버로드 선언 이동을 포함한 Decom 32개 테스트, `npm run smoke:decom`에서 `BOOT-INF/classes`와 중첩 JAR 탐색, 읽기 전용 Java 문서와 줄 번호, 캐시 생성, 전체 압축 해제 없음, 원본 JAR 불변, 백업 미생성을 검사한다.
- 제거 가능 조건: upstream이 기본 Explorer 파일 노드의 제한된 자식 공급자 API와 파일 열기 재정의 API를 제공하는 경우.
