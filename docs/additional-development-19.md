# vs Hoon 고도화(19) 작업 기록

## 구현 범위

### 1. 활동 막대 선택에 따라 편집기 탭 그룹 전환 (VSH-0017 확장)

- 사이드바에서 **탐색기**를 고르면 메인 편집기, **VSsh**를 고르면 SSH 터미널, **Database**를 고르면 SQL 편집기만
  탭에 보인다. 그 밖의 사이드바(검색, 소스 제어 등)는 필터를 바꾸지 않는다.
- 매핑은 `src/vs/vshoon/common/editorTabFilter.ts`의 `VIEW_CONTAINER_TAB_KINDS`
  (`workbench.view.explorer`, `workbench.view.extension.vssh`, `workbench.view.extension.dbconn`)와
  `VShoonEditorTabFilter.showForViewContainer`가 맡는다.
- 사이드바가 뷰 컨테이너를 열 때 알려 주는 확장 API가 없고, 탐색기는 코어 뷰라 확장에서 알 수 없다. 그래서 VSH-0017에
  `sidebarPart.ts` seam 한 줄(`onDidPaneCompositeOpen` → `showForViewContainer`)을 추가했다.
- VSsh를 고르면 활성 SSH 세션이 있을 때 하단 SFTP 패널도 연다(`vssh.sessions` 트리 표시 이벤트). 이미 한 번 그려진
  웹뷰는 `WebviewView.show(true)`로 포커스를 옮기지 않는다.

### 2. 하단 패널에서 SFTP 뷰가 사라지는 버그

- 원인: VSsh가 관리하지 않는 터미널(PowerShell, Claude Code 등)이 활성화되면 `ActiveSessionManager`가 활성 세션을
  비웠다. 그러면 `vssh.connected`가 false가 되고, SFTP 뷰의 `when: vssh.connected`가 꺼져 패널 탭이 통째로 사라졌다.
  활성 세션 하나가 끊겨도 다른 세션이 남아 있는데 같은 일이 일어났다.
- 수정: 관리하지 않는 터미널로 전환하면 마지막 세션을 유지한다. 활성 세션이 끊기거나 탭이 닫히면 남아 있는 다른 세션
  (가장 나중에 연결한 것)으로 넘기고, 하나도 없을 때만 비운다(`ActiveSessionManager.release`).
- 같은 터미널을 다시 활성화할 때마다 SFTP 원격 경로가 `/`로 초기화되던 중복 전환도 함께 막았다.

### 3·4. 탐색기 우클릭 메뉴

- 파일: **SFTP로 업로드** (`vssh.sftp.uploadFromExplorer`). 여러 개를 고르면 모두 보낸다. 원격 패널이 지금 보고 있는
  폴더로 보내며, 윈도우 탐색기 드롭과 같은 경로(덮어쓰기 확인, 전송 큐)를 탄다.
- 폴더: **SFTP 로컬 패널에서 열기** (`vssh.sftp.revealInLocalPanel`). 로컬 패널을 그 폴더로 옮기고 SFTP 패널을 연다.
- 둘 다 SFTP가 활성(`vssh.connected`)이고 로컬 파일(`resourceScheme == file`)일 때만 보인다. 명령 팔레트에는 숨긴다.

### 5. SSH 탭 우클릭 → SSH 다시 연결

- 편집기 탭 우클릭 메뉴(`editor/title/context`)에 **SSH 다시 연결** (`vssh.terminal.reconnect`). SSH 터미널이 하나라도
  있을 때(`vssh.hasSshTerminal`)만 보이며, 명령 팔레트에서는 활성 터미널을 다시 연결한다.
- 탭은 그대로 두고 새 SSH 연결로 셸만 다시 연다(`SshPseudoterminal.reconnect`). 화면 기록은 남고
  `[VSsh] 다시 연결했습니다.` 한 줄을 출력한다. 새 연결이 실패하면 이전 연결은 건드리지 않는다.
- 이전 연결의 셸 스트림과 클라이언트 `close`는 무시해 탭이 닫히지 않게 했다. SFTP 패널과 원격 파일 시스템은 새 연결로
  바뀐다.
- 탭 우클릭 메뉴는 `vscode-terminal:` 주소만 넘기고 확장 API로는 그 주소의 터미널을 찾을 수 없다. 그래서 그 탭을
  `vscode.open`으로 활성화한 뒤 활성 터미널을 쓴다. 터미널 탭이 있는 편집기 그룹이 하나뿐이면 그 그룹에서 열어 탭이
  다른 그룹으로 옮겨지지 않게 한다.

### 6. vi에서 드래그로 바로 복사

- 드래그 복사 자체는 이미 있다. VSsh가 `terminal.integrated.copyOnSelection: true`를 기본값으로 기여하고, 코어
  `TerminalClipboardContribution`이 선택이 바뀔 때마다 클립보드에 쓴다. 개발 빌드에서 편집기 영역 터미널에
  `VSHOONCOPYTEST`를 출력하고 드래그만 했을 때 시스템 클립보드에 들어가는 것을 확인했다.
- vi에서 안 되던 원인: vim(less, tmux, mc 등도 같음)이 마우스 보고 모드(DECSET 1000·1002·1006 등)를 켜면 터미널은
  드래그를 원격 프로그램에 넘기고 선택을 만들지 않는다. 선택이 없으니 복사도 없다.
- 수정: SSH 셸 출력에서 마우스 보고 모드 요청만 걸러 낸다(`terminal/mouseReportingFilter.ts`). 대체 화면(1049),
  커서 표시(25), 괄호 붙여넣기(2004) 같은 다른 모드는 그대로 전달하고, 청크 경계에서 잘린 시퀀스는 이어 붙여 처리한다.
  드래그는 항상 터미널 선택이 되어 바로 복사되고, 휠은 대체 화면에서 방향키로 바뀌어 vim·less 스크롤은 유지된다.
- 설정 `vssh.terminal.mouseReporting`(기본 `false`)을 켜면 이전처럼 원격 프로그램이 마우스를 받는다. 이때는
  **Shift+드래그**로 선택한다. 새로 연결한 터미널부터 적용된다. WSL 터미널은 일반 프로세스 터미널이라 대상이 아니다.

## 검증

- `npm test`: VShoon 단위 테스트 55개 통과. 새 테스트 `follows the side bar view container that owns an editor tab group`.
- `npm run typecheck`: 오류 0.
- `npm run test:vssh`: 컴파일 오류 0, 단위 테스트 17개 통과(새 `SSH mouse reporting filter` 2개).
- 개발 빌드(Playwright): 편집기 터미널과 Welcome 탭을 연 상태에서 VSsh 선택 → 터미널만, 탐색기 선택 → Welcome만
  보이는 것을 확인. Database 선택 시 SQL 편집기가 없으면 활성 탭만 남는다(VSH-0017 기존 규칙).
- 드래그 복사 확인(위 6번). 마우스 보고 필터는 단위 테스트로만 확인했다.

## 남은 확인

- 실제 SSH 서버로 vi 드래그 복사, SFTP 업로드·로컬 패널 이동·SSH 다시 연결·비-VSsh 터미널 전환 후 SFTP 패널 유지 실사용 확인.
  개발 빌드 검증에는 접속 가능한 SSH 계정이 없었다.

## 한계

- 다시 연결하면 SFTP 원격 파일 시스템의 세션 id가 바뀐다. 이전 연결로 열어 둔 원격 파일 편집기는 저장할 수 없으므로
  다시 열어야 한다(연결이 끊겼을 때와 같다).
- 마우스 보고를 거르면 vim의 마우스 클릭 커서 이동, tmux 창 클릭 전환 등 원격 프로그램의 마우스 기능은 쓸 수 없다.
  필요하면 `vssh.terminal.mouseReporting`을 켠다.
- 터미널 탭이 여러 편집기 그룹에 흩어져 있으면 **SSH 다시 연결**이 그 탭을 활성 그룹으로 옮길 수 있다.
