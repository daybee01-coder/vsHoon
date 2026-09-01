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
- **A C/C++ toolchain** (Visual Studio Build Tools on Windows) for the core's native modules —
  `spdlog`, `node-pty`, `native-watchdog`. Without it the product still starts, but logging is
  degraded and the integrated terminal does not work.

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
