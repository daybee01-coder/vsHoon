# VShoon UI Extension API

## Status

Design placeholder. Implementation begins only after the start-window lifecycle is stable.

## Policy

VShoon will expose narrowly named capabilities instead of DOM access or a generic workbench mutation API. Candidate capabilities must be driven by a concrete UI requirement and reviewed for lifecycle, trust, accessibility, localization, performance, and upstream compatibility.

Every capability will support feature detection and define its behavior when the extension runs in ordinary VS Code. Proposed APIs must remain separate from the stable `vscode` namespace until their compatibility and security model is proven.
