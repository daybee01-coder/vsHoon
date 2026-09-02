# VShoon Repository Layout

VShoon tracks only what VShoon owns. The Code - OSS core is fetched on demand at a pinned
commit and is never committed, so this repository stays a few hundred kilobytes and consumes
no Git LFS quota.

## What lives where

| Path | Owner | Committed |
| --- | --- | --- |
| `src/vs/vshoon/**` | VShoon | yes |
| `extensions/vshoon-*` | VShoon | yes |
| `logo.png`, the generated Windows brand assets and the start window mark | VShoon | yes |
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

`npm run sync` copies the product source and built-in-extension entries listed in
`vshoon.lock.json` into the matching paths under `.core`. It does not create a symlink
or a Windows junction, because several upstream build steps walk the tree with
`readdirSync(dir, { withFileTypes: true })` and descend only when `entry.isDirectory()` is true.
A junction reports `isDirectory() === false`, so those steps silently skip the whole overlay:
`transpile-client` found 8625 of 8632 source files and produced no `out/vs/vshoon` at all, while
`tsc` and ESLint — which resolve through `stat` — saw it and passed. A copied tree is
indistinguishable from core sources to every tool.

Overlay entries may be directories or individual files. VShoon uses file entries for the
Windows application icon, tile manifest and installer artwork so the product assets replace only
the matching Code - OSS defaults without copying or owning the rest of `resources/win32`.

`logo.png` in the repository root is the brand master and the only hand-maintained image.
`npm run brand:win32` trims its transparent margin and redraws every generated size from it:
`resources/win32/code.ico`, the two Windows tile PNGs, the fourteen Inno Setup wizard bitmaps and
`src/vs/vshoon/electron-sandbox/startWindow/vshoon-logo.png`, which the start window shows as its
product mark. Regenerate rather than edit those files, and commit the result — the build has no
image toolchain of its own. Regeneration is deterministic: running it again on unchanged artwork
produces byte-identical files, so it never turns up as a diff on its own. `resources/win32/VisualElementsManifest.xml` is the one brand file
written by hand; it carries the tile colours and the short display name.

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

This is verified against a running build: with the override in place, js-debug emits

```json
{"event":"breakpoint","body":{"reason":"changed","breakpoint":{
    "verified": true,
    "source": {"path": "d:\project\vscode\vsHoon\src\vs\vshoon\node\launchRequest.ts"}}}}
```

— bound to the edited source, not to the overlay copy.

One caveat if you drive the debugger from a CLI rather than from VS Code: `${workspaceFolder}`
is resolved by VS Code itself, and a standalone js-debug adapter rejects the configuration with
`Unable to resolve ${workspaceFolder}`. Pass the same fields with absolute paths in that case.

Core sources need no override: `.core/src` is where they genuinely live, so break there
directly.

## Modified core files are patches

VShoon owns a small set of edits to core files. They are stored as patches, applied by `npm run sync`
after checkout, and listed in [upstream-patches.md](upstream-patches.md):

| Patch | Core file |
| --- | --- |
| `VSH-0001-product-identity.patch` | `product.json` |
| `VSH-0002-start-window-seam.patch` | `src/vs/code/electron-main/app.ts`, native argument type and option registry |
| `VSH-0003-source-layers.patch` | `eslint.config.js` |
| `VSH-0004-ui-extension-seam.patch` | `src/vs/workbench/workbench.common.main.ts` |
| `VSH-0005-ui-sample-build.patch` | `build/gulpfile.extensions.ts` |
| `VSH-0006-windows-product-metadata.patch` | `build/lib/electron.ts`, the Windows gulpfiles, `build/win32/code.iss` |
| `VSH-0007-start-window-package.patch` | `build/buildfile.ts`, `build/next/index.ts` |

A patch owns its files exclusively; two patches must never touch the same file, and
`npm run patch:save` refuses to run if they do. To change a core file, edit it inside `.core`
and run `npm run patch:save`, which rewrites each patch from the core working tree with
`core.abbrev` pinned so the same change always produces the same bytes.

## Checking that everything still agrees

`npm run sync:check` reads the core without writing to it and fails when the pieces have drifted
apart:

- a patch file that no npm script applies, or a listed patch that is missing;
- a core checkout that is not at the pinned commit;
- a patch whose recorded bytes no longer match the core working tree, which is what an edit made
  inside `.core` and never saved looks like;
- an edited core file that no patch owns, which the next `npm run sync` would silently discard;
- a core file that has gone missing, which is usually a build step deleting sources it does not
  need rather than anything a patch should record;
- an overlay whose core copy is stale or was edited in place;
- a missing agent asset.

Without `--offline` it also reports how far the pinned commit has fallen behind upstream `main`.
`npm run sync:check -- --try <ref>` answers the question a core bump really asks — *will the
patches still apply?* — by test-applying each one against a throwaway index built from that ref,
so nothing is fetched into the working tree and no second checkout is needed.

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
| `npm run sync:check` | Verify the core, patches and overlay still agree, and report upstream drift |
| `npm run sync:check -- --try <ref>` | Also test-apply every patch to a candidate upstream ref |
| `npm run brand:win32` | Regenerate the Windows icon, tiles, installer artwork and start window mark from `logo.png` |
| `npm run core -- <args>` | Run any npm command inside the core |
| `npm run typecheck` | `typecheck-client` in the core |
| `npm run transpile` | `transpile-client` in the core |
| `npm run compile` | `compile` in the core |
| `npm run lint` | ESLint over `src/vs/vshoon` |
| `npm run layers` | `valid-layers-check` in the core |
| `npm run build` | Compile the client and the built-in extensions |
| `npm test` | Transpile, then run the VShoon unit tests in the core |
| `npm run smoke:start-window` | Launch an isolated Windows start window and verify the brand mark, accessibility and keyboard focus |
| `npm run watch` | Mirror the overlay on every change |
| `npm run patch:save` | Rewrite the patches from the core working tree |
| `npm run patch:save -- --add <patch> <core-file>...` | Add newly owned core files while rewriting a patch |

## Updating the core

1. Run `npm run sync:check -- --try <candidate ref>` to see which patches the bump will break.
2. Pick the new upstream commit and update `vshoon.lock.json`.
3. Run `npm run sync`. A patch that no longer applies stops the sync and names itself.
4. Resolve the conflict inside `.core`, then run `npm run patch:save` and `npm run sync:check`.
5. Run the checks in [AGENTS.md](../AGENTS.md), then record the update in `docs/upstream/<version>.md`.
