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
| `vshoon.startWindow.enabled` is `false` | Existing workbench path |
| `--disable-start-window` | Existing workbench path for this launch |
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
| `--disable-start-window` | Upstream opens the workbench; start window steps down |
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

## Disabling the Launcher

`vshoon.startWindow.enabled` is an application-scoped setting contributed by the
`vshoon-start` built-in extension. It defaults to `true`. The main process reads the default
profile's user configuration before deciding whether to create a renderer; setting it to
`false` therefore keeps the entire launch on the upstream workbench path.

`--disable-start-window` is the non-persistent equivalent. It is a native CLI option rather
than a renderer convention, so it is preserved when the command is forwarded to an existing
instance. If that instance is currently showing the launcher, it steps down before the
upstream launch service opens the workbench.

## Debugging the Launcher

`scripts/code.bat` and `code.sh` export `VSCODE_CLI=1`, which `isLaunchedFromCli` reports as a
CLI launch, so the policy bypasses the launcher with `notDesktopLaunch`. Every debug
configuration routed through those scripts therefore opens the workbench directly, no matter
what the rest of the launch looks like:

| Launch | Decision |
| --- | --- |
| Electron binary, no `VSCODE_CLI` | `{ show: true }` |
| Same binary with `VSCODE_CLI=1` | `{ show: false, reason: 'notDesktopLaunch' }` |

That is the policy working as specified, not a defect. **VShoon: Start Window (desktop launch)**
runs the Electron binary directly with `VSCODE_CLI` unset, reproducing what a desktop user gets.
It is the first configuration in `launch.json`, so plain F5 reaches the launcher; the workbench
configurations sit behind it in the dropdown.

## Service Reuse

- `IWorkspacesHistoryMainService.getRecentlyOpened()` supplies recent entries.
- `IWindowsMainService.open()` opens a selected folder or workspace.
- lifecycle services coordinate shutdown and readiness.
- dialog services implement folder/workspace selection.
- profile services provide the active/default profile when profile selection is added.

## IPC Contract

One `invoke` channel, `vscode:vshoonStartWindow`, carries an enumerated request and returns a
display-only model. The preload exposes `send` and `invoke` but no `on`, so the renderer pulls;
requests that change the list return the new one rather than pushing an update.

| Request | Returns |
| --- | --- |
| `configuration` | the translated messages and the display language |
| `projects` | the recent list |
| `togglePin`, `removeRecent` | the recent list, updated |
| `openRecent`, `chooseFolder`, `chooseWorkspace`, `openEmpty` | opens a window |
| `quit` | closes the launcher, which ends the session |

`configuration` comes first and nothing is rendered before it resolves. A bundled build rewrites
every `localize` call into an index into a message table that only the main process holds, so a
renderer that localized before that table arrived would throw `NLS MISSING` instead of drawing
its labels — a failure that a development build, which keeps the English fallback inside the
call, never shows. The packaged start-window smoke test is the check that keeps it honest.

Anything else is refused before it reaches a handler. An `id` names an entry in the model the
renderer was last given; the main process resolves it against that list, so a path the renderer
invents is not a path the main process will open.

Pins are VShoon state, not upstream state: `IRecentlyOpened` has no pinned concept, so the ids
live under `vshoon.startWindow.pinnedProjects` in `IStateService` and are overlaid onto the
upstream list at read time. Pinned entries keep the order they were pinned in, so the shortlist
a user arranges does not reshuffle as projects are opened.

## The Launcher Must Not Block Startup

`show()` resolves when the window has loaded, not when the user chooses. That is a constraint,
not a preference: application storage only initializes at `LifecycleMainPhase.AfterWindowOpen`
(`storageMainService.ts`), and `CodeApplication` sets that phase *after* `openFirstWindow`
returns. A launcher that waits for input inside that call deadlocks the moment it reads the
recent list, because `getRecentlyOpened()` awaits storage that startup has not reached yet.

So the seam hands the rest of the launch to the launcher and returns. The launcher opens the
workbench itself through `IWindowsMainService`, and closing it without choosing anything calls
`ILifecycleMainService.quit()`.

## Current Lifecycle Note

`VShoon 열기` 동작은 시작 창을 먼저 숨긴다. 기존 `IWindowsMainService`가 Workbench `BrowserWindow`를 실제 생성한 뒤에만 시작 창과 IPC listener를 폐기한다. 유일한 창을 먼저 닫으면 Electron의 `window-all-closed` 처리로 앱이 종료될 수 있으므로 이 순서를 유지한다.

두 번째 인스턴스가 시작 창을 밀어내는 경우에도 같은 순서를 따른다. `supersede()`는 창을 숨기고 소유권만 즉시 넘긴 뒤, 다른 창이 실제로 생길 때까지 기다렸다가 폐기한다.

## MVP Acceptance Criteria

- No full workbench renderer is created before the launcher on an eligible launch.
- Choosing an item opens it through `IWindowsMainService`.
- Explicit launch targets behave exactly as upstream.
- The renderer has context isolation and no direct Node access.
- Keyboard-only navigation and screen-reader labels work.
- Empty and stale recent lists remain usable.

## Accessibility and Smoke Coverage

The renderer sends all visible strings through `vs/nls`, derives the document language from the
runtime locale, and exposes loading and result changes through `aria-busy` and polite status
regions. Initial focus moves to the first recent project, or to **Open Folder** when the list is
empty. Up/Down, Home, and End move between project-open buttons; Tab continues into each
project's pin and remove actions. Pinning restores the same action, removing restores the nearest
surviving project, and cancelling a native picker restores the button that opened it.

Focus outlines use separate light and dark contrast ramps and defer to system Highlight colors
in forced-colors mode. `npm run smoke:start-window` launches the real sandbox renderer with an
isolated empty profile and verifies its accessible button names, loading state, initial focus,
and forward/reverse Tab movement through the Chrome accessibility and input protocols.

The header carries the VShoon mark, `vshoon-logo.png`, generated next to the renderer by
`npm run brand:win32` from the same `logo.png` the Windows icon comes from. It is decorative next
to the product name, so it ships with an empty `alt` and stays out of the accessibility tree; the
content security policy allows `img-src 'self'` and nothing else, and the smoke test asserts the
image actually decodes so a missing packaging pattern or a tightened policy fails loudly.
