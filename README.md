# VShoon

VShoon is a Code - OSS fork that keeps the VS Code core intact while adding product-level UI
capabilities and a compact IntelliJ-style start window.

This repository holds **only VShoon sources**. The Code - OSS core is fetched on demand at the
commit pinned in [`vshoon.lock.json`](vshoon.lock.json) and is never committed.

## Getting started

```sh
npm run sync                 # fetch the pinned core, apply patches, mirror the overlay
npm run core -- install      # install the core's dependencies (once, ~7 GB)
npm run typecheck            # verify
npm test                     # VShoon unit tests
npm run build                # compile the client AND the built-in extensions
```

`npm run build` is required before running the product, including from the debugger. The
type checks and the unit tests only read `src/`, so they pass against a tree whose built-in
extensions were never compiled — and that tree then fills the console with extension load
failures the moment it launches.

### Host requirements

- **Node.js matching the core's `.nvmrc`** (currently 24.18.0 or newer, same major). An older
  runtime stops `npm install` in `preinstall`. `VSCODE_SKIP_NODE_VERSION_CHECK=1` gets past it
  but is not a fix.
- **A C/C++ toolchain** (Visual Studio Build Tools on Windows) for the core's native modules.
  A dozen or so packages compile from source — `native-keymap`, `native-is-elevated`,
  `windows-foreground-love`, `node-pty`, `@vscode/spdlog`, `@vscode/windows-ca-certs`,
  `@vscode/windows-process-tree` and the rest of the `allowScripts` list in the core's
  `package.json`. A missing binding is never fatal: the caller catches the `MODULE_NOT_FOUND` and
  degrades, which is what makes one easy to miss. The product starts, one feature is quietly off,
  and the only honest check is whether the `.node` files are there:

  ```sh
  ls .core/node_modules/native-keymap/build/Release
  ```

  On Windows the C++ workload alone is not enough. The core's gyp configuration forces
  `SpectreMitigation`, so a toolchain without the Spectre-mitigated runtime libraries fails every
  module at `error MSB8040`. `--includeRecommended` does not cover it, so the component has to be
  named:

  ```sh
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
  ```

  Quote `--installPath` if you pass one. An unquoted `--installPath C:\Program Files\...` truncates
  at the space and registers an instance rooted at `C:\Program`; `vswhere` then reports it with
  `isComplete: false` and node-gyp passes it over, so every build fails with a toolchain that
  looks installed.

  `preinstall` looks for Visual Studio under `%ProgramFiles%\Microsoft Visual Studio\<year>\`
  and reports `Invalid C/C++ Compiler Toolchain` for an install anywhere else. Point it at the
  real location instead, which `vswhere -products * -format json` will tell you:

  ```sh
  vs2022_install='<installationPath>' npm run core -- install
  ```

  npm does not rebuild a package that is already present, so a tree whose native modules were
  never compiled stays broken through `npm install`. Rebuild the affected packages directly. This
  still reads the core's `.npmrc`, so the bindings target Electron, and it skips the root
  `preinstall` — which matters when the host Node is older than `.nvmrc` and a full install is
  refused:

  ```sh
  npm run core -- rebuild native-keymap @vscode/spdlog
  ```

  Verify against the Electron binary, not the host Node: the bindings are built for Electron's
  ABI and will not load anywhere else.

  ```sh
  ELECTRON_RUN_AS_NODE=1 .core/.build/electron/VShoon.exe -e "console.log(require('./.core/node_modules/native-keymap').getCurrentKeyboardLayout())"
  ```

Migrating from an existing full checkout? Skip the install by moving its dependencies over:

```sh
npm run sync
node scripts/adopt-core-deps.mjs <path to the old checkout>
```

## Documentation

- [AGENTS.md](AGENTS.md) — VShoon working rules
- [docs/repository-layout.md](docs/repository-layout.md) — how the split works and why
- [docs/start-window.md](docs/start-window.md) — start-window lifecycle and bypass matrix
- [docs/upstream-patches.md](docs/upstream-patches.md) — the patch ledger

VShoon is based on the open-source Code - OSS repository. It does not reuse Microsoft Visual
Studio Code trademarks, icons, binaries, Marketplace entitlements, update services, or telemetry
endpoints. Upstream and third-party license notices are preserved.
"# vsHoon" 
