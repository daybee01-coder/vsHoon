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
| paths named by `agentAssets` | Code - OSS, mirrored by `sync` | no, excluded by `sync` |

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
the current sources. The unit tests read `.core/out` rather than the sources, so `npm test`
transpiles first for the same reason. `npm run watch` mirrors continuously for an edit-and-reload loop. Editing
files directly under `.core/src/vs/vshoon` is a mistake; the next mirror overwrites them and
prints the paths it clobbered.

## Debugging

The build runs inside the core, so the transpiled output and its source maps name the overlay
copy:

```
.core/out/vs/vshoon/node/launchRequest.js
  sources: [ "D:\...\.core\src\vs\vshoon\node\launchRequest.ts" ]
```

Left alone, a breakpoint set in `src/vs/vshoon` would never bind, because the debugger resolves
a different file. `.vscode/launch.json` closes the gap with a `sourceMapPathOverrides` entry per
overlay path:

```json
"sourceMapPathOverrides": {
    "${workspaceFolder}/.core/src/vs/vshoon/*": "${workspaceFolder}/src/vs/vshoon/*"
}
```

So breakpoints belong in `src/vs/vshoon`, the same files you edit. `npm run sync` warns when an
`overlay` entry has no matching override, because an unbound breakpoint is quiet and easy to
misread as code that never ran.

Core sources need no override: `.core/src` is where they genuinely live, so break there
directly.

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

## Agent assets are configuration

Agent tooling expects some files at fixed paths that the core, not VShoon, owns. `sync` mirrors
them from the core, and both ends live in `agentAssets` in `vshoon.lock.json` so that moving the
repository or repointing an asset never touches code:

```json
{ "from": ".github/copilot-instructions.md", "to": ".claude/CLAUDE.md", "mode": "copy" }
```

`from` is relative to the core, `to` is relative to this repository, and `mode` is either:

- `copy` — the default. Nothing records a path, so the mirror survives a rename of the
  repository or the core.
- `link` — a directory symlink, a junction on Windows. Junctions store an absolute target, so
  the link dangles after a rename until the next `sync` recreates it. Worth it only for
  something large enough that copying hurts.

`sync` also keeps these paths out of Git by rewriting a delimited block in `.git/info/exclude`
rather than listing them in `.gitignore`, so the ignore rules follow the configuration. Nothing
deletes a destination the configuration no longer names: it simply stops being ignored and
appears in `git status`, which is the signal to remove it.

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
| `npm test` | Transpile, then run the VShoon unit tests in the core |
| `npm run watch` | Mirror the overlay on every change |
| `npm run patch:save` | Rewrite the patches from the core working tree |

## Updating the core

1. Pick the new upstream commit and update `vshoon.lock.json`.
2. Run `npm run sync`. A patch that no longer applies stops the sync and names itself.
3. Resolve the conflict inside `.core`, then run `npm run patch:save`.
4. Run the checks in [AGENTS.md](../AGENTS.md), then record the update in `docs/upstream/<version>.md`.
