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

## Compatibility Strategy

VShoon-specific behavior is gated by product configuration and a user/CLI opt-out. With the gate disabled, execution must follow upstream behavior. Each upstream modification is recorded in `docs/upstream-patches.md` and tested at the smallest applicable scope.
