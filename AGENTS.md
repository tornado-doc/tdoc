Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.
Published reader invariants are provider-enforced in overlay/worker code and tests, not left only to author HTML or prompts.

Shell / product UI: reuse the existing design language. Prefer AppDialog (HubDialog / NameDialog), docs-hub.css classes (page-hd, toolbar, new-folder-btn, loc-hint, manage-hint, field, tabs, doc-row), and chrome.css modal rules. Do not invent one-off panes, inline layout styles, or a parallel component kit for /me, /@, or other shell surfaces.
