# VShoon Repository Layout

VShoon tracks only what VShoon owns. The Code - OSS core is fetched on demand at a pinned
commit and is never committed, so this repository stays a few hundred kilobytes and consumes
no Git LFS quota.

## What lives where

| Path | Owner | Committed |
| --- | --- | --- |
| `src/vs/vshoon/**` | VShoon | yes |
| `patches/*.patch` | VShoon | yes |
| `vshoon.lock.json` | VShoon | yes |
| `scripts/*.mjs` | VShoon | yes |
| `docs/**`, `AGENTS.md` | VShoon | yes |
| `.core/**` | Code - OSS | no, gitignored |
| `.claude/CLAUDE.md`, `.claude/skills` | Code - OSS, mirrored by `sync` | no, gitignored |

## Why the core is not committed

The upstream repository carries 164k commits and ~271 MB of Git LFS fixtures under
`extensions/copilot/test/simulation/cache/`. None of it is VShoon content, and pushing it to a
private fork spends LFS storage and bandwidth on files VShoon never builds or runs.

`npm run sync` fetches the pinned commit with `--depth 1 --filter=blob:none` and
`GIT_LFS_SKIP_SMUDGE=1`, so the LFS fixtures arrive as ~130-byte pointer files and no history is
downloaded at all. The resulting `.core/.git` is about 60 MB instead of 2.1 GB.

## The core is the build root

Every upstream build entry point resolves paths relative to the repository root:
`src/tsconfig.json` compiles `./vs/**/*.ts` into `../out/vs`, and gulp, rspack, `product.json`
and `package.json` all assume the same layout. A core cannot be pointed at an external `src/`,
so the direction is inverted: the core checkout is the build root and VShoon sources are laid
into it.

## The overlay is copied, not linked

`npm run sync` copies `src/vs/vshoon` into `.core/src/vs/vshoon`. It does not create a symlink
or a Windows junction, because several upstream build steps walk the tree with
`readdirSync(dir, { withFileTypes: true })` and descend only when `entry.isDirectory()` is true.
A junction reports `isDirectory() === false`, so those steps silently skip the whole overlay:
`transpile-client` found 8625 of 8632 source files and produced no `out/vs/vshoon` at all, while
`tsc` and ESLint — which resolve through `stat` — saw it and passed. A copied tree is
indistinguishable from core sources to every tool.

To keep the copy from going stale, `scripts/core-exec.mjs` mirrors the overlay before it hands
any command to the core, so `npm run typecheck`, `npm test` and `npm run compile` always build
the current sources. `npm run watch` mirrors continuously for an edit-and-reload loop. Editing
files directly under `.core/src/vs/vshoon` is a mistake; the next mirror overwrites them and
prints the paths it clobbered.

## Modified core files are patches

VShoon owns three edits to core files. They are stored as patches, applied by `npm run sync`
after checkout, and listed in [upstream-patches.md](upstream-patches.md):

| Patch | Core file |
| --- | --- |
| `VSH-0001-product-identity.patch` | `product.json` |
| `VSH-0002-start-window-seam.patch` | `src/vs/code/electron-main/app.ts` |
| `VSH-0003-source-layers.patch` | `eslint.config.js` |

A patch owns its files exclusively; two patches must never touch the same file, and
`npm run patch:save` refuses to run if they do. To change a core file, edit it inside `.core`
and run `npm run patch:save`, which rewrites each patch from the core working tree with
`core.abbrev` pinned so the same change always produces the same bytes.

## Commands

| Command | Effect |
| --- | --- |
| `npm run sync` | Fetch or reset the core, apply patches, mirror the overlay |
| `npm run core -- <args>` | Run any npm command inside the core |
| `npm run typecheck` | `typecheck-client` in the core |
| `npm run transpile` | `transpile-client` in the core |
| `npm run compile` | `compile` in the core |
| `npm run lint` | ESLint over `src/vs/vshoon` |
| `npm run layers` | `valid-layers-check` in the core |
| `npm test` | VShoon unit tests in the core |
| `npm run watch` | Mirror the overlay on every change |
| `npm run patch:save` | Rewrite the patches from the core working tree |

## Updating the core

1. Pick the new upstream commit and update `vshoon.lock.json`.
2. Run `npm run sync`. A patch that no longer applies stops the sync and names itself.
3. Resolve the conflict inside `.core`, then run `npm run patch:save`.
4. Run the checks in [AGENTS.md](../AGENTS.md), then record the update in `docs/upstream/<version>.md`.
