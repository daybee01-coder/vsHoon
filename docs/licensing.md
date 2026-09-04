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
| Microsoft's Marketplace | Its terms of use grant access to Visual Studio products, which a fork is not. VShoon points `extensionsGallery` at Open VSX instead. |
| `updateUrl` | Nothing updates itself. A new build is installed by hand; see [release.md](release.md). |
| VShoon's own telemetry configuration | No `aiConfig`, no telemetry endpoint: the workbench itself reports nowhere. This is **not** the same as a build that sends nothing — see the note below. |
| A signing certificate | The binaries are unsigned and SmartScreen warns on first run. |
| Microsoft branding | The product name, icons, identifiers and publisher metadata are VShoon's. |

These are the entitlements that belong to Microsoft's distribution rather than to the MIT-licensed
sources, which is why a fork does not inherit them.

One qualification on telemetry, because the row above is easy to over-read: the *workbench* has no
endpoint, but the build ships GitHub Copilot Chat, and that extension carries its own reporting
keys (`ariaKey`, `internalLargeStorageAriaKey`) in its manifest and activates on
`onStartupFinished` in every window. It honours the user's `telemetry.telemetryLevel` as any
extension does, and VShoon adds nothing to it — but "no telemetry configuration" describes what
VShoon declares, not everything a shipped build can send.

## Brand assets

Every brand asset is generated from `logo.png`, which is VShoon artwork: the application icon, the
two Windows tiles, the installer wizard bitmaps, the installer's own icon, the start window mark
and `code-icon.svg` — the workbench icon behind the title bar, Welcome page, banner and update
tooltip.

The Code - OSS build carries no Visual Studio Code logo to remove: the icons it ships are generic
editor glyphs rather than Microsoft's mark. Two of them are still upstream's — the empty-editor
watermark (`letterpress-*.svg`) and the per-language file icons in `resources/win32` — and both
are ordinary Code - OSS assets under the same MIT license.

Not yet done: `resources/darwin/code.icns` and `resources/linux/code.png` are still the Code - OSS
artwork. They must be replaced with VShoon assets before any macOS or Linux build is handed to
anyone.

## Built-in extensions

The package ships the Code - OSS built-ins plus VShoon-owned bundled extensions. The Code - OSS
built-ins are MIT along with the rest of the tree.
Two groups deserve their own note:

**VShoon bundled extensions.** `extensions/vshoon-dbconn`, `extensions/vshoon-decom`,
`extensions/vshoon-vssh` and `extensions/vshoon-vsearch` are merged from their own sources. DBConn keeps its `LICENSE` file and
contributor copyright. VSearch declared MIT in its manifest and carried no `LICENSE` file. VSsh
declared no license at all, and the merge set its manifest to MIT to match the rest of the fork —
that is an assertion about the author's own code, not a finding, and it is worth confirming.
Decom supplied neither a license declaration nor a license file, so its bundled manifest is
explicitly `UNLICENSED`; redistribution requires the owner to add or confirm appropriate terms.
Their runtime dependencies are installed from the versions locked in
`extensions/package-lock.json` and retain their package licenses and notices in the packaged
shared `extensions/node_modules` tree:

| Extension | Dependency | License |
| --- | --- | --- |
| `vshoon-dbconn` | `mysql2`, `pg`, `oracledb` | MIT |
| `vshoon-decom` | `adm-zip` | MIT |
| `vshoon-vssh` | `ssh2`, `iconv-lite` | MIT |
| `vshoon-vssh` | `ppk-to-openssh` | **GPL-3.0** — see below |
| `vshoon-vsearch` | `monaco-editor` (staged into `media/monaco`, not a runtime import) | MIT |

Review these locked dependencies, and their transitive ones, whenever they are upgraded.

**One bundled dependency is GPL-3.0 and it is a distribution decision, not a build detail.**
`ppk-to-openssh` converts PuTTY `.ppk` keys for VSsh, and GPL-3.0 is strong copyleft: shipping it
inside the product brings the combined work into scope of its terms, which MIT does not satisfy on
its own. The upstream plugin author saw this coming and isolated the import to a single file,
`extensions/vshoon-vssh/src/ssh/ppk.ts`, with a comment saying the license needs review before
distribution. The merge preserves that isolation and nothing else depends on the package. Three
ways out, in the order they cost least:

1. Replace it with `sshpk`, which is MIT, already present as its transitive dependency, and whose
   `lib/formats/putty.js` reads PPK v2 and v3 private keys. Only `ppk.ts` changes.
2. Drop `.ppk` support. `AuthMethod` keeps `password` and `openssh-key`; the PuTTY session import
   still works, only its key conversion goes.
3. Distribute the whole build under GPL-3.0-compatible terms, which is a decision about the fork,
   not about one extension.

Until one of those happens, a VShoon build must not be distributed on MIT terms alone.

**Fetched at build time.** `product.json` lists `ms-vscode.js-debug`, `ms-vscode.js-debug-companion`
and `ms-vscode.vscode-js-profile-table` in `builtInExtensions`. They come from the configured
gallery — Open VSX — rather than from Microsoft's Marketplace. All three are MIT.

**GitHub Copilot is shipped, and it is the one thing here that is not MIT.**
`extensions/copilot` (`GitHub.copilot-chat`) is MIT in source, but the packaged extension bundles
`@github/copilot` — the GitHub Copilot CLI — under GitHub's own license. That license grants
redistribution only under all of the following, and a VShoon build has to keep meeting every one:

| Condition (GitHub Copilot CLI License §2) | How VShoon meets it |
| --- | --- |
| Distributed only in unmodified form | The build stages the npm package as published; §3 also forbids derivative works, so it must never be repacked or rewritten |
| Redistributed solely as part of an application with material functionality beyond the Software | It ships inside an editor |
| Not distributed standalone or as a primary product | It is one built-in extension's dependency |
| A copy of the license and all notices retained | `LICENSE.md` travels with the package |
| The application licensed independently | VShoon is MIT, which §2 explicitly permits |

§8 separates the two questions worth keeping apart: this license covers **redistributing the
binary**, and grants no right to **use GitHub's services**. Whether a given user may use Copilot
from VShoon is between that user and their GitHub Copilot terms, not something a build can confer.

Two practical consequences, neither of them a licensing matter:

- `defaultChatAgent.extensionId` is `GitHub.copilot`, the completions extension. It is not built in
  and not on Open VSX, so the chat setup flow cannot install it from VShoon's gallery. Chat itself
  is built in and present.
- GitHub sign-in works through the device-code and personal-access-token flows. The URL handler
  flow calls for a client secret that Code - OSS builds do not ship, so it fails before the token
  exchange.

## The extension gallery

`product.json` points `extensionsGallery` at [Open VSX](https://open-vsx.org), the open registry
that Eclipse runs and that other Code - OSS distributions use. It speaks the same gallery API, so
search, install, update and the extension detail pages all work without touching Microsoft's
service.

This is a licensing decision, not a technical one. The Visual Studio Marketplace terms of use grant
access "in connection with Visual Studio products and services"; a fork is not one, so pointing a
VShoon build at `marketplace.visualstudio.com` would use an entitlement it does not have — the same
reason the update service and telemetry endpoints are absent.

Open VSX does not repository-sign what it serves, and an OSS build ships no signature verifier, so
`product.json` says as much and `VSH-0009` skips a check that could only ever fail. The user
setting `extensions.verifySignature` is untouched.

What that costs: extensions published only to the Microsoft Marketplace are not installable from
inside VShoon. Microsoft's C/C++, C#, Python and Remote-* extensions are the notable ones, and so
is `GitHub.copilot` — the completions half of Copilot, which the product configuration names as the
default chat agent. A user who has a `.vsix` can still install it by hand.

It also decides where the build gets the three extensions in `builtInExtensions`: with a gallery
configured, `build/lib/builtInExtensions.ts` downloads them from it rather than from GitHub
releases. All three are published to Open VSX at the pinned versions.

## Staged Monaco distribution

`extensions/vshoon-vsearch/media/monaco` is a copy of the `monaco-editor` npm release that
VSearch's preview pane loads in its webview. It is Microsoft's, MIT licensed, and released on its
own schedule, so it is pinned as a shared extension dependency and generated by
`npm run sync:monaco` rather than committed. The staged tree omits `min/vs/language`: those are
the language-service web workers, which the preview never starts.

This is the same editor the workbench itself is built from, but it is a second, independent copy —
a webview cannot reach the product's own module tree.

## Display language translations

The built-in Korean language pack under `extensions/vshoon-language-pack-ko` is generated from
`microsoft/vscode-loc` at the commit pinned in `vshoon.lock.json`. Those translations are
Microsoft's and MIT licensed; the generated extension ships the upstream `LICENSE.md` beside them
and its README records the exact source commit. The manifest is VShoon's, the strings are not.

Nothing is fetched from the Marketplace: `vscode-loc` is the public repository the published
language packs are themselves built from.

## Rules this fork follows

From [AGENTS.md](../AGENTS.md): VShoon does not treat Visual Studio Code trademarks, icons,
release binaries, Marketplace entitlement, update service or telemetry endpoints as its own
assets, and preserves upstream and third-party license notices.

## Open items

- License terms for the Decom source. Until the owner supplies them, it is integrated for local
  builds but must not be redistributed.

- A VShoon product version. Windows version resources currently report the core version
  (`1.137.0`), not VShoon's `0.1.0`.
- macOS and Linux brand assets.
- How a user is meant to get `GitHub.copilot`, which the product names but the gallery cannot serve.
- Which way out of the `ppk-to-openssh` GPL-3.0 obligation the fork takes. Until then the build is
  not distributable on MIT terms.
