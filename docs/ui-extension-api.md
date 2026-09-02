# VShoon UI Extension API

## Status

The start-window lifecycle is stable. Phase 3 begins with one internal, versioned capability
and its product-owned registry. There is no public extension API or upstream renderer seam yet.

## Policy

VShoon will expose narrowly named capabilities instead of DOM access or a generic workbench mutation API. Candidate capabilities must be driven by a concrete UI requirement and reviewed for lifecycle, trust, accessibility, localization, performance, and upstream compatibility.

Every capability will support feature detection and define its behavior when the extension runs in ordinary VS Code. Proposed APIs must remain separate from the stable `vscode` namespace until their compatibility and security model is proven.

## Requirement Classification

| Requirement | Mechanism | Decision |
| --- | --- | --- |
| Run an existing command from a small VShoon-owned header slot | `workbench.header.command` capability | Phase 3 v1 |
| Add arbitrary markup, CSS, scripts, or renderer callbacks | DOM/renderer access | Rejected |
| Replace title bar, activity bar, editor, or workbench layout | Generic shell mutation | Rejected |
| Add project actions to the compact start window | Start-window IPC | Separate subsystem; not part of this API |
| Add standard views, menus, status bar items, or webviews | Existing VS Code contribution points | Use upstream API |

The first requirement is intentionally small but complete: an extension declares a localized
title and an already registered command. VShoon owns layout, focus order, theming, rendering,
and command invocation. A contribution cannot provide HTML, CSS, URI assets, event handlers,
or extension-host objects.

## Capability v1

`workbench.header.command` has version `1` and contains:

- a source-scoped contribution ID;
- an existing command ID;
- a localized title and optional tooltip;
- a bounded integer ordering hint.

The internal registry is implemented in `src/vs/vshoon/common/uiContributions.ts`. Consumers
must call `supports(capability, version)` before registration or rendering. Registration returns
a disposable; disposing it removes the action immediately. Registry results are immutable,
ordered snapshots.

## Validation and Trust Boundary

The registry rejects unsupported versions, malformed or overlong identifiers, blank or control-
character text, invalid ordering hints, duplicate source/capability/ID tuples, unauthorized
sources, and more than ten contributions from one source.

The bridge, not the extension, constructs the source record. Its `trusted` field means that the
bridge has authorized that source for this specific VShoon capability; workspace trust alone is
not sufficient. Initial product integration will authorize only product and bundled-extension
sources. Third-party authorization remains disabled until the permission UX and persistence
model are implemented.

`src/vs/vshoon/common/uiContributionBridge.ts` implements the renderer-independent part of this
boundary. It accepts unknown manifest data, rejects undeclared properties and malformed values,
validates the complete contribution group before changing the live registry, and preserves the
previous group when validation fails. Bundled extensions are authorized by product metadata;
third-party input requires an explicit capability permission supplied by the future permission
service.

## Planned Bridge

The proposed declarative extension point is named `vshoon.ui.headerCommands` and will be processed
in the local UI extension host path. The remaining upstream seam will translate extension
metadata and collector diagnostics into the renderer-independent bridge. It will dispose
registrations when the extension is disabled, uninstalled, or reloaded and will never forward DOM
handles or renderer callbacks.

On ordinary VS Code the proposed `vshoon` contribution point is unknown and the extension must
fall back to its command palette/menu contribution. Extensions must treat VShoon support as an
optional enhancement, not an activation requirement.

`extensions/vshoon-ui-sample` is the bundled contract sample. It declares the same command in the
standard `commands` contribution and in `vshoon.ui.headerCommands`; therefore its Command Palette
fallback remains available when the VShoon capability is absent. The Workbench-side contract tests
cover schema registration, bundled acceptance, third-party rejection, and unload cleanup.
