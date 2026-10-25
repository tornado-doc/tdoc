Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.
Published reader invariants are provider-enforced in overlay/worker code and tests, not left only to author HTML or prompts.

Shell / product UI: reuse the existing design language. Prefer AppDialog (HubDialog / NameDialog), docs-hub.css classes (page-hd, toolbar, new-folder-btn, loc-hint, manage-hint, field, tabs, doc-row), and chrome.css modal rules. Do not invent one-off panes, inline layout styles, or a parallel component kit for /me, /@, or other shell surfaces.

UI primitives are mandatory. Use shell/src/ui/ (AppDialog, AppMenu, AppSelect, SegmentedControl, Switch, CopyPromptButton); never a native <select>, whose open list the OS draws. If none fits, add one there. Match the page's margins, type scale and button hierarchy. Dialog styles go in ui.css or chrome.css (the feedback overlay loads only those). A UI change is done only after screenshots at desktop and phone width plus a browser regression; test/ui-primitives.test.js enforces the source rules.

Comment surfaces are shared: anything that shows a comment, reply, AI/agent answer, agent picker or handoff status reuses CommentCard, the composer agent pill and its menu, handoff-status-line and comment-area (doc page, feedback layer and Ask AI alike). Colors come only from the --td-* tokens; the same icon is used on desktop and phone (phone may hide the label). Review rejects a parallel version.

New or uncertain features ship behind a flag in shell/src/feature-flags.js, visible only in dev mode; flip default to true when approved; remove the flag after it's stable.
