# VShoon Architecture

## Baseline

- Upstream: `https://github.com/microsoft/vscode.git`
- Initial base commit: `6b606c6c85f184ce581f4d898e590a093e213ba3`
- Integration branch: `vshoon/main`

VShoon preserves the Code - OSS layer order and dependency-injection model. Product-owned modules live below `src/vs/vshoon` and may depend on lower upstream layers appropriate to their runtime. Existing workbench modules must not depend on VShoon code except through a documented, minimal registration seam.

## Planned Runtime Shape

The compact launcher belongs to the Electron desktop startup path:

```text
CodeApplication.startup
  -> initialize main-process services
  -> resolve protocols and launch arguments
  -> VShoon start-window policy
       -> bypass: call existing openFirstWindow path
       -> show: open compact launcher renderer
  -> selected project: call IWindowsMainService.open
  -> close launcher after the workbench window is ready
```

The launcher must use main-process services for history and window creation. It must not launch a second VShoon executable or parse state storage. Web and server entry points remain unchanged.

## Ownership Boundaries

- `src/vs/vshoon/electron-main`: startup policy, launcher window ownership, IPC validation
- `src/vs/vshoon/electron-sandbox`: sandboxed launcher renderer bootstrap
- `src/vs/vshoon/browser`: reusable launcher UI and models where layer rules permit
- upstream `src/vs/code/electron-main/app.ts`: one small delegation seam
- upstream service implementations: unchanged unless a missing capability cannot be exposed otherwise

The UI capability bridge planned after the launcher is a separate subsystem and must not be coupled to launcher IPC.

The first UI capability subsystem is renderer-independent and declarative:

```text
bundled extension manifest
  -> vshoon.ui.headerCommands extension point
  -> VShoon manifest bridge (schema, version, permission, atomic replacement)
  -> capability registry (immutable descriptors and disposable lifecycle)
  -> future VShoon-owned header renderer
```

`workbench.common.main.ts` passes the upstream extension registry into a VShoon-owned registration
function. The VShoon module does not import Workbench modules in the opposite direction. Version 1
accepts bundled extensions only; the registry and bridge do not expose DOM, CSS, assets, or renderer
callbacks.

DBConn adds a second bounded capability without exposing a new extension-host API:

```text
extensions/vshoon-dbconn package.json
  -> vshoon.ui.modalWebviews (bundled extensions only)
  -> validated source-id/view-type registry
  -> MainThreadWebviewPanels selects MODAL_GROUP
  -> upstream ModalEditorPart owns focus trapping, accessibility and dismissal
```

The extension continues to create an ordinary `WebviewPanel`. VShoon changes only its target
editor group after matching both the bundled extension identifier and declared view type. On an
ordinary VS Code build the unknown contribution is ignored and the same panel opens in a regular
editor tab. Database credentials remain inside the existing webview-to-extension message path;
the product registry receives identifiers only.

VShoon's bundled `vshoon-start` enables the simplified-dialog route, but local `file` requests are
delegated to `VShoonFileDialog`: a product-owned modal with a branded heading, path field,
back/forward/home/parent/refresh actions, a lazily expanded directory tree, and explicit
open/save/cancel actions. It uses Codicons and Workbench theme variables. Remote and virtual file
systems continue through upstream `SimpleFileDialog`. The manifest also defaults
`workbench.iconTheme` to built-in `vs-seti`; a user's icon-theme choice still wins.

`extensions/vshoon-decom` is a bundled extension overlay. It keeps the original custom editor and
commands, while its `adm-zip` runtime dependency is supplied by the shared built-in-extension
dependency tree pinned in `.core/extensions/package-lock.json`.

## Compatibility Strategy

VShoon-specific behavior is gated by product configuration and a user/CLI opt-out. With the gate disabled, execution must follow upstream behavior. Each upstream modification is recorded in `docs/upstream-patches.md` and tested at the smallest applicable scope.
