# Licensing and Distribution

This records what a VShoon build actually contains, under which licenses, and how the result
differs from Microsoft's Visual Studio Code distribution. It is a record of the build, not legal
advice; a distribution beyond the people working on this fork should be reviewed by whoever is
accountable for it.

Everything below was read out of the Windows x64 package produced by
`npm run core -- run gulp vscode-win32-x64`.

## What VShoon is built from

Code - OSS at the commit pinned in `vshoon.lock.json`, under the MIT license. The package keeps
both upstream notices at `resources/app/`:

- `LICENSE.txt` — the Code - OSS MIT license, Microsoft's copyright intact.
- `ThirdPartyNotices.txt` — upstream's third-party notices, unmodified.

VShoon's own sources under `src/vs/vshoon` carry the same header as the rest of the tree.

## What is deliberately absent

| Not in VShoon | Consequence |
| --- | --- |
| `extensionsGallery` | No Marketplace. Extensions are installed from a VSIX or another gallery the user configures. |
| `updateUrl` | Nothing updates itself. A new build is installed by hand; see [release.md](release.md). |
| Telemetry configuration | No `aiConfig`, no telemetry endpoint, nothing to send. |
| A signing certificate | The binaries are unsigned and SmartScreen warns on first run. |
| Microsoft branding | The product name, icons, identifiers and publisher metadata are VShoon's. |

These are the entitlements that belong to Microsoft's distribution rather than to the MIT-licensed
sources, which is why a fork does not inherit them.

## Brand assets

Every Windows brand asset is generated from `logo.png`, which is VShoon artwork: the application
icon, the two Windows tiles, the installer wizard bitmaps, the installer's own icon and the start
window mark.

The Code - OSS build carries no Visual Studio Code logo to remove — the workbench watermark
(`letterpress-*.svg`) and `code-icon.svg` are generic editor glyphs, and the per-language file
icons in `resources/win32` are ordinary Code - OSS assets under the same MIT license.

Not yet done: `resources/darwin/code.icns` and `resources/linux/code.png` are still the Code - OSS
artwork. They must be replaced with VShoon assets before any macOS or Linux build is handed to
anyone.

## Built-in extensions

The package ships 98 extensions. The Code - OSS built-ins are MIT along with the rest of the tree.
Two groups deserve their own note:

**Fetched at build time.** `product.json` lists `ms-vscode.js-debug`, `ms-vscode.js-debug-companion`
and `ms-vscode.vscode-js-profile-table` in `builtInExtensions`. Because VShoon declares no
`extensionsGallery`, `build/lib/builtInExtensions.ts` takes them from each extension's GitHub
release rather than from the Marketplace, so the Marketplace terms of use never enter the picture.
All three are MIT.

**GitHub Copilot.** `extensions/copilot` is MIT in source, but the packaged extension bundles
`@github/copilot` (the GitHub Copilot CLI) under GitHub's own license, not MIT. That license
permits redistribution only when the software is unmodified, is part of an application with
material functionality of its own, is not offered standalone, ships with a copy of its license,
and does not borrow GitHub's branding beyond identifying the software. A VShoon build satisfies
the shape of those conditions today: it ships the binary unmodified inside an editor, with
`LICENSE.md` intact.

If that dependency is not wanted, the answer is to drop the extension from the packaged build —
never to modify or repackage the binary, which the license does not allow.

## Rules this fork follows

From [AGENTS.md](../AGENTS.md): VShoon does not treat Visual Studio Code trademarks, icons,
release binaries, Marketplace entitlement, update service or telemetry endpoints as its own
assets, and preserves upstream and third-party license notices.

## Open items

- A VShoon product version. Windows version resources currently report the core version
  (`1.137.0`), not VShoon's `0.1.0`.
- macOS and Linux brand assets.
- Whether VShoon ships the Copilot extension at all.
