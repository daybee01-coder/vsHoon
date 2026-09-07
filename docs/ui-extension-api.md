# VShoon UI Extension API

## Status

The start-window lifecycle is stable. VShoon currently has two internal, versioned declarative
capabilities. Neither extends the stable `vscode` namespace or exposes renderer objects.

## Policy

VShoon will expose narrowly named capabilities instead of DOM access or a generic workbench mutation API. Candidate capabilities must be driven by a concrete UI requirement and reviewed for lifecycle, trust, accessibility, localization, performance, and upstream compatibility.

Every capability will support feature detection and define its behavior when the extension runs in ordinary VS Code. Proposed APIs must remain separate from the stable `vscode` namespace until their compatibility and security model is proven.

## Requirement Classification

| Requirement | Mechanism | Decision |
| --- | --- | --- |
| Run an existing command from a small VShoon-owned header slot | `workbench.header.command` capability | Phase 3 v1 |
| Open a bundled extension's declared webview as a Workbench modal | `workbench.webview.modal` capability | Phase 3 v1 |
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

### `workbench.webview.modal`

A bundled extension declares a bounded list under `vshoon.ui.modalWebviews`:

```json
[
  {
    "version": 1,
    "viewType": "dbconn.connectionForm",
    "size": { "width": 760, "height": 625 }
  }
]
```

`src/vs/vshoon/common/modalWebviews.ts` atomically validates and stores the pair of extension
identifier and webview `viewType`, plus an optional bounded initial size. When that extension creates the panel,
`MainThreadWebviewPanels` targets upstream's `MODAL_GROUP`; `ModalEditorPart` owns the overlay,
focus trap, `aria-modal`, keyboard dismissal and outside-click behavior. A declared size is passed
only for that matching panel, so one bundled panel does not inherit another panel's last size. The
Workbench still clamps it to the available area. The declaration cannot set markup, styles,
commands, arbitrary editor types or another extension's panel.

Three bundled panels declare it, and all three used to move themselves into a separate window:

| Extension | View type | Panel |
| --- | --- | --- |
| `vshoon-dbconn` | `dbconn.connectionForm` | Connection form (`760×625`) |
| `vshoon-vssh` | `vsshSessionForm` | SSH session form (`540×560`) |
| `vshoon-vsearch` | `vsearch.panel` | Find in Files panel (`1200×700`) |

None of them asks for anything modal any more: each calls `createWebviewPanel` with an ordinary
view column and the product decides where it lands. In ordinary VS Code the VShoon contribution
point does not exist, so the exact same call opens a standard editor tab. The same fallback is what
a user gets from `workbench.editor.useModal: 'off'`, which upstream honors ahead of any
`MODAL_GROUP` request.

`npm run smoke:modal-webviews` is the capability's compatibility test. It runs each real command in
a built VShoon and asserts both halves: the panel is a `role="dialog"` overlay with `aria-modal`
whose webview is laid out inside it, and no editor tab carries it.

### `workbench.view.osFileDrop`

A bundled extension declares which of its webview views accept files dropped from the operating
system, under `vshoon.ui.osFileDrops`:

```json
[
  {
    "version": 1,
    "viewType": "vssh.sftp"
  }
]
```

A webview cannot receive these drops on its own. Upstream's webview preload reports a file drag to
the host, and `WebviewElement` puts `pointer-events: none` on the iframe for the rest of the
gesture, so the drop lands on the Workbench instead of the view. Even if it did land there, a
webview has no way back to a path: Electron removed `File.path` in version 32.

`src/vs/vshoon/common/osFileDrops.ts` validates and stores the pair of extension identifier and
view type. `WebviewViewPane` then handles the drop where the path is knowable — the Workbench
renderer, which has `webUtils.getPathForFile` — and posts the resolved paths into the declared view
on the message channel it already listens to:

```json
{
  "type": "vshoon.osFileDrop",
  "viewType": "vssh.sftp",
  "paths": ["C:\Users\me\report.pdf"],
  "position": { "x": 210, "y": 84 }
}
```

`position` is relative to the view's own container, which is what lets a two-pane view tell which
side was targeted. The declaration cannot name another extension's view, reach a view that did not
declare it, or influence which paths are reported: those come from the drop event itself. A view
that has not declared the capability keeps upstream behavior exactly, and the files open as editors.

| Extension | View type | View |
| --- | --- | --- |
| `vshoon-vssh` | `vssh.sftp` | SFTP two-pane browser |

Windows blocks drag and drop from an ordinary process into an elevated one (UIPI), so a VShoon
started with administrator rights never sees these drops at all, whatever it declares.

The same declaration also covers the other direction. A declared view sends

```json
{ "type": "vshoon.osFileDrag", "paths": ["C:\Users\me\report.pdf"] }
```

on its ordinary webview message channel, and the Workbench starts a native drag of those files so
Explorer and the desktop accept them. A webview cannot begin such a drag itself, and upstream's own
drag-out path is limited to a single `file:` URI, so VSH-0013 exposes `webContents.startDrag`
through `INativeHostService` instead. The paths must already exist; nothing is written on the
view's behalf, so a view that wants to export a remote file stages a local copy first. At most 100
paths are accepted and empty ones are rejected.

Because the request arrives from the view's own webview, an extension using this must be able to
trust its webview content — the same condition the drop direction carries.

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

## Manifest Bridge

The declarative extension points `vshoon.ui.headerCommands` and `vshoon.ui.modalWebviews` are
processed in the local UI extension host path. The bridge translates extension metadata and
collector diagnostics into renderer-independent registries. It disposes
registrations when the extension is disabled, uninstalled, or reloaded and will never forward DOM
handles or renderer callbacks.

On ordinary VS Code the proposed `vshoon` contribution point is unknown and the extension must
fall back to its command palette/menu contribution. Extensions must treat VShoon support as an
optional enhancement, not an activation requirement.

`extensions/vshoon-ui-sample` is the bundled contract sample. It declares the same command in the
standard `commands` contribution and in `vshoon.ui.headerCommands`; therefore its Command Palette
fallback remains available when the VShoon capability is absent. The Workbench-side contract tests
cover schema registration, bundled acceptance, third-party rejection, and unload cleanup.
The modal-webview contract tests cover the same lifecycle and additionally verify atomic rejection
of malformed or duplicate view types.

Bundled modal layouts are remembered by extension id and view type in Workbench renderer memory.
Closing/reopening a panel restores its size, position, and maximized state; window close or reload
resets the session. Different windows do not share layouts. The product controller hooks into
the upstream modal lifecycle, while upstream continues to clamp geometry to the visible bounds.
There is no additional extension API, persistent storage, or pointer-move IPC.
