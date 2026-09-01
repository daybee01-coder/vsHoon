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
