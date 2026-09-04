# Releasing and Rolling Back VShoon

VShoon ships as a Windows x64 build produced from the pinned Code - OSS core. There is no update
service, no signing certificate and no Marketplace entitlement, and none of them are missing by
accident: the fork carries a distinct product identity precisely so that it never presents itself
as Microsoft's build. Everything here assumes that.

## What a build produces

| Artifact | Path | Task |
| --- | --- | --- |
| Application folder | `VSCode-win32-x64/` (in the repository root) | `vscode-win32-x64` |
| User installer | `.core/.build/win32-x64/user-setup/VShoonSetup.exe` | `vscode-win32-x64-user-setup` |
| System installer | `.core/.build/win32-x64/system-setup/VShoonSetup.exe` | `vscode-win32-x64-system-setup` |

The application folder is the product; the installers only place it and register the identifiers
in `product.json`. Both are build output, ignored by Git, and regenerated rather than archived.

## Building

Two different builds, for two different purposes. Neither needs the other.

**A development build**, for running and debugging VShoon from sources. `F5` in the editor uses it,
and so do the smoke tests without `--package`:

```powershell
npm run build                                       # compiles the client and the built-in extensions
```

**A packaged build**, which is the product. Run these in order from the repository root:

```powershell
npm run sync                                        # core at the pinned commit, patches applied
npm run sync:check                                  # nothing has drifted apart
npm test                                            # VShoon unit tests
npm run core -- run gulp vscode-win32-x64           # the application folder
npm run smoke:start-window -- --package VSCode-win32-x64
npm run core -- run gulp vscode-win32-x64-inno-updater   # installer tooling, branded
npm run core -- run gulp vscode-win32-x64-user-setup     # the installer
```

Roughly how long each takes on a warm tree, measured on a Windows x64 development machine against
core 1.137.0 with Copilot shipped:

| Step | Time |
| --- | --- |
| `npm run sync` | seconds, plus a fetch on the first run |
| `npm run sync:check` | seconds |
| `npm test` | about 2 minutes, most of it the transpile that `pretest` runs |
| `npm run build` | about 3 minutes |
| `npm run core -- run gulp vscode-win32-x64` | about 9 minutes |
| `npm run smoke:start-window -- --package …` | about 1 minute |

A first build on a cold tree is much slower than that, and `npm run core -- install` has to have
run at least once — the wrapper says so rather than failing obscurely.

The checks worth running before a package build, none of which needs a package: `npm run typecheck`,
`npm run lint`, `npm run layers`, `npm test`, `npm run test:dbconn`, `npm run test:vsearch`,
`npm run test:scripts`, `npm run smoke:start-window`, `npm run smoke:ui-extension` and
`npm run smoke:modal-webviews`. The three smoke tests need `npm run build` first, because they
drive the real application; `smoke:ui-extension` fails with a missing-module error if the built-in
extensions were never compiled, and `smoke:modal-webviews` says so up front.

Mind the order: anything that reaches the core mirrors the overlay first, and the mirror removes
whatever the core copy holds that the sources do not — which includes every bundled extension's
compiled `out`. So run `npm run build` *after* the unit tests, not before, or the smoke tests find
no extensions to drive.

### When a build fails

**Do not simply re-run a failed package build.** A packaged build that dies partway can leave the
core's `node_modules` in a state the next run trips over — a missing `shims.txt` under
`extensions/copilot/node_modules/@github/copilot` is the one seen so far, and it disappeared once
the tree was restored. Reset first, then rebuild:

```powershell
npm run sync                                        # discards whatever the failed run left behind
npm run sync:check
npm run core -- run gulp vscode-win32-x64
```

`npm run sync` is safe to run at any time: it only ever resets the core checkout, which is build
output, and re-applies the patches this repository owns. It never touches VShoon's own sources.

If `sync:check` reports that a patch no longer matches the core, that is a real edit inside `.core`
waiting to be recorded or discarded — `npm run patch:save` records it, `npm run sync` discards it.

Every command routed through `core-exec.mjs` sets `BUILD_SOURCEVERSION` to the content hash of
VShoon's declared overlay and patch inputs. The resulting `product.commit` is a reproducible build
identity, not the pinned Code - OSS commit and not necessarily a Git commit object. This keeps the
compiled-language-pack and V8 cached-data directories aligned with the actual fork sources. It
also means any future update, crash-reporting or source-map service must treat the value as a
VShoon build identity and map it to a Git revision in release metadata instead of dereferencing it
as a commit. VShoon currently configures none of those external services.

Because the same variable puts upstream's Copilot bundler on its build pipeline path, the wrapper
also declares `VSCODE_QUALITY=stable` and reverts the stamp that path leaves in
`extensions/copilot/package.json`. [repository-layout.md](repository-layout.md) has the details;
what matters here is that neither is a knob to turn by hand.

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
- A fresh profile comes up in Korean on its first launch, launcher included.
- `resources/app/extensions/copilot/node_modules/@github/copilot/LICENSE.md` is present. Shipping
  that file is a condition of redistributing the Copilot CLI; see [licensing.md](licensing.md).
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
- **Only Windows x64 is exercised.** arm64, macOS and Linux packaging inherit upstream behavior.
  The in-app mark is shared by every platform, but the application and installer icons are
  generated for Windows only; macOS and Linux still carry the Code - OSS artwork.
