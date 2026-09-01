# VShoon Start Window

## Goal

Provide a calm, compact project-selection window before the full workbench is created. The start window is a native Electron browser window with a sandboxed renderer, not a workbench webview.

## Selected Integration Point

The initial policy decision belongs immediately before `CodeApplication.openFirstWindow()` in `src/vs/code/electron-main/app.ts`, after main-process services and protocol handlers are ready. The current upstream method already centralizes the launch cases that must bypass the launcher.

The first implementation should extract or delegate only the policy decision. Window creation, CLI parsing, profile selection, and workspace opening remain owned by upstream services.

## Bypass Matrix

The launcher is eligible only for a desktop launch with no target and no special mode.

| Launch condition | Behavior |
| --- | --- |
| No target, ordinary desktop launch | Show VShoon start window |
| File, folder, or workspace argument | Existing workbench path |
| `--folder-uri` or `--file-uri` | Existing workbench path |
| Protocol URL | Existing protocol path |
| `--diff`, `--merge`, `--wait`, `--goto` | Existing workbench path |
| Extension development/test mode | Existing workbench path |
| Agent window | Existing agent-window path |
| Remote authority | Existing remote path |
| Temporary or forced profile | Initially bypass; revisit with profile UI |
| Start window disabled | Existing workbench path |

Session restoration needs an explicit product decision during implementation: the default proposal is to show the launcher for an icon/desktop launch and list restored workspaces as recent entries, while never intercepting explicit CLI targets.

## Single Instance Behavior

VShoon keeps upstream's single-instance model: a second process fails to claim the main IPC
handle, hands its arguments to the running instance through `ILaunchMainService.start()`, and
exits. The start window changes what the *running* instance should do with that request.

While the start window owns the launch there is no workbench window yet. Upstream answers a
target-less request by opening an empty workbench window (`openWithoutArgumentsInNewWindow`
defaults to a new window everywhere except macOS), which would leave an empty editor next to a
start window the user never dismissed. VShoon therefore wraps the launch service that is exposed
on the `launch` channel.

| Second-instance request | Behavior while the start window owns the launch |
| --- | --- |
| No target | Focus the existing start window |
| `--reuse-window`, no target | Focus the existing start window |
| File, folder, or workspace argument | Upstream opens the workbench; start window steps down |
| `--folder-uri` or `--file-uri` | Upstream opens the workbench; start window steps down |
| `--new-window` | Upstream opens an empty window; start window steps down |
| `--open-url` with urls | Upstream protocol path; start window steps down |
| `--diff`, `--merge`, `--wait`, `--goto` | Upstream opens the workbench; start window steps down |
| `--remote`, `--profile`, `--profile-temp` | Upstream opens the workbench; start window steps down |
| Extension development, test, or agents mode | Upstream path; start window steps down |
| Start window no longer owns the launch | Unchanged upstream behavior |

`--new-window` bypasses the start window on the initial launch for the same reason: it is an
explicit request for an empty workbench window, so both entry points share one eligibility check.

Stepping down happens *before* the request is delegated. `ILaunchMainService.start()` does not
settle until the opened window closes when the request carries `--wait`, so waiting for it would
keep the start window alive for the whole editing session.

`--status` and other diagnostics never reach the launch service, and `getMainProcessId()` is
delegated unchanged so that the Windows foreground handshake keeps working.

## Debugging the Launcher

`scripts/code.bat` and `code.sh` export `VSCODE_CLI=1`, which `isLaunchedFromCli` reports as a
CLI launch, so the policy bypasses the launcher with `notDesktopLaunch`. Every debug
configuration routed through those scripts therefore opens the workbench directly, no matter
what the rest of the launch looks like:

| Launch | Decision |
| --- | --- |
| Electron binary, no `VSCODE_CLI` | `{ show: true }` |
| Same binary with `VSCODE_CLI=1` | `{ show: false, reason: 'notDesktopLaunch' }` |

That is the policy working as specified, not a defect. To debug the launcher, use the
**VShoon: Start Window (desktop launch)** configuration, which runs the Electron binary directly
and unsets `VSCODE_CLI`, reproducing what happens when a desktop user opens the product.

## Service Reuse

- `IWorkspacesHistoryMainService.getRecentlyOpened()` supplies recent entries.
- `IWindowsMainService.open()` opens a selected folder or workspace.
- lifecycle services coordinate shutdown and readiness.
- dialog services implement folder/workspace selection.
- profile services provide the active/default profile when profile selection is added.

## IPC Contract

The renderer receives a serialized, display-only recent-item model. It may request only enumerated actions: open recent, remove recent, pin/unpin, choose folder, choose workspace, open empty window, or close. Main process code validates item IDs and resolves them back to service-owned objects; arbitrary paths or command names are not accepted without validation.

## Current Lifecycle Note

`VShoon 열기` 동작은 시작 창을 먼저 숨긴다. 기존 `IWindowsMainService`가 Workbench `BrowserWindow`를 실제 생성한 뒤에만 시작 창과 IPC listener를 폐기한다. 유일한 창을 먼저 닫으면 Electron의 `window-all-closed` 처리로 앱이 종료될 수 있으므로 이 순서를 유지한다.

두 번째 인스턴스가 시작 창을 밀어내는 경우에도 같은 순서를 따른다. `supersede()`는 창을 숨기고 소유권만 즉시 넘긴 뒤, 다른 창이 실제로 생길 때까지 기다렸다가 폐기한다. 이때 `show()`는 `superseded`로 완료되므로 `openFirstWindow()`는 앱을 종료하지 않고 빈 결과를 반환한다.

## MVP Acceptance Criteria

- No full workbench renderer is created before the launcher on an eligible launch.
- Choosing an item opens it through `IWindowsMainService`.
- Explicit launch targets behave exactly as upstream.
- The renderer has context isolation and no direct Node access.
- Keyboard-only navigation and screen-reader labels work.
- Empty and stale recent lists remain usable.
