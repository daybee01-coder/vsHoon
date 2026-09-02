# Releasing and Rolling Back VShoon

VShoon ships as a Windows x64 build produced from the pinned Code - OSS core. There is no update
service, no signing certificate and no Marketplace entitlement, and none of them are missing by
accident: the fork carries a distinct product identity precisely so that it never presents itself
as Microsoft's build. Everything here assumes that.

## What a build produces

| Artifact | Path | Task |
| --- | --- | --- |
| Application folder | `VSCode-win32-x64/` (beside the repository root) | `vscode-win32-x64` |
| User installer | `.core/.build/win32-x64/user-setup/VShoonSetup.exe` | `vscode-win32-x64-user-setup` |
| System installer | `.core/.build/win32-x64/system-setup/VShoonSetup.exe` | `vscode-win32-x64-system-setup` |

The application folder is the product; the installers only place it and register the identifiers
in `product.json`. Both are build output, ignored by Git, and regenerated rather than archived.

## Building

```powershell
npm run sync                                        # core at the pinned commit, patches applied
npm run sync:check                                  # nothing has drifted apart
npm test                                            # VShoon unit tests
npm run core -- run gulp vscode-win32-x64           # the application folder
npm run smoke:start-window -- --package VSCode-win32-x64
npm run core -- run gulp vscode-win32-x64-inno-updater   # installer tooling, branded
npm run core -- run gulp vscode-win32-x64-user-setup     # the installer
```

The packaged smoke test is not optional. A packaged build fails in ways a development run cannot
show: it bundles the renderer through a different entrypoint list and rewrites every `localize`
call into a message-table index. Both of those have already broken the start window while
`npm run smoke:start-window` against the development build stayed green.

## Verifying before handing a build out

- `VShoon.exe` carries the VShoon mark, and its version resource reads `VShoon` /
  `VShoon Contributors` — the native `.node` dependencies too, which is what the Windows metadata
  step exists for.
- `VShoon.VisualElementsManifest.xml` names VShoon, not Code - OSS.
- The packaged start window opens, localizes its labels and reaches the workbench.
- An existing VS Code installation still starts, and its recent list is untouched.

## Rolling back

**A user rolls back by installing the previous installer.** Nothing updates itself: `product.json`
declares no update URL, so an installed build stays exactly where it is until someone replaces it.
Keep the installer of the last known-good build for as long as anyone runs it.

**Uninstalling is safe next to VS Code.** VShoon owns its own install directory, application ids,
mutexes, URL protocol and `.vshoon` data folder, so removing it never touches a VS Code
installation or its settings. Uninstall through Windows Settings or the uninstaller in the install
directory.

**User data survives an uninstall.** Recent projects and the VShoon pin list live under the
`.vshoon` data folder (`vshoon.startWindow.pinnedProjects` in the state store). Delete that folder
only to reset a profile deliberately; a rollback does not require it.

**Rolling back a core bump** means reverting `vshoon.lock.json` and any patches that changed with
it, then `npm run sync` and rebuilding. `npm run sync:check` confirms the checkout matches the
restored pin before the rebuild starts.

**Rolling back a VShoon change** is an ordinary revert, followed by `npm run sync:check` and a
rebuild. VShoon features are gated, so a change that only affects the start window can also be
switched off at runtime with `vshoon.startWindow.enabled` or `--disable-start-window` instead of
being rebuilt.

## Known gaps

- **The binaries are unsigned.** Windows SmartScreen warns on first run of the installer. Signing
  needs a certificate this project does not have; the build treats a missing `signtool.exe` as
  "nothing to strip" rather than failing.
- **The packaged version is the core version.** Windows version resources and the installer read
  `.core/package.json`, so a build made against core 1.137.0 reports `1.137.0` while VShoon's own
  `package.json` says `0.1.0`. A VShoon product version needs its own decision before a build is
  handed to anyone outside the project.
- **Only Windows x64 is exercised.** arm64, macOS and Linux packaging inherit upstream behavior
  and VShoon brand assets exist for Windows only.
