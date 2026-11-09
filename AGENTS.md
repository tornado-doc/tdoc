Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.
Published reader invariants are provider-enforced in overlay/worker code and tests, not left only to author HTML or prompts.

Shell / product UI: reuse the existing design language. Prefer AppDialog (HubDialog / NameDialog), docs-hub.css classes (page-hd, toolbar, new-folder-btn, loc-hint, manage-hint, field, tabs, doc-row), and chrome.css modal rules. Do not invent one-off panes, inline layout styles, or a parallel component kit for /me, /@, or other shell surfaces.

UI primitives are mandatory. Use shell/src/ui/ (AppButton, AppDialog, AppMenu, AppSelect, SegmentedControl, Switch, CopyPromptButton, CodeBlock); never a native <select>, whose open list the OS draws, and never a hand-sized button: AppButton owns button sizes (test/ui-primitives.test.js). If none fits, add one there. Match the page's margins, type scale and button hierarchy. Dialog styles go in ui.css or chrome.css (the feedback overlay loads only those). A UI change is done only after screenshots at desktop and phone width plus a browser regression; test/ui-primitives.test.js enforces the source rules.

Comment surfaces are shared: anything that shows a comment, reply, AI/agent answer, agent picker or handoff status reuses CommentCard, the composer agent pill and its menu, handoff-status-line and comment-area (doc page, feedback layer and Ask AI alike). Colors come only from the --td-* tokens; desktop and phone are one design: same components, icons, colors and wording; phone only adapts size and placement (a drawer instead of a popover, a hidden label). Review rejects an unexplained parallel version. A new component or pattern is allowed only with a written why in the PR: what the existing one can't do and what was tried.

Comment-layer features ship on all surfaces: the doc page, the feedback widget (SDK and bookmarklet), the feedback space page, slides, and later sheets. Filters, counts, order, search, read state, refresh and the @ list come from shell/src/comments/core/ (comment-query, comment-area, use-comment-feed, thread-seen), never a copy per surface. A feature on only some surfaces needs an explicit reason in the PR: which surface lacks it and why it cannot have it.

New or uncertain features ship behind a flag in shell/src/feature-flags.js, visible only in dev mode; flip default to true when approved; remove the flag after it's stable.

Feedback and fixes apply to both normal and dev mode unless the thing only exists behind the flag. A flag holds only features still under discussion and not settled; a bug fix or behaviour request never goes behind one, and the two versions may differ only by those unsettled features.

CLI + MCP parity: every capability is implemented once, server-side, as an HTTP endpoint in worker/worker.js. MCP tools (MCP_TOOLS, calling it in process through mcpApi) and CLI commands (bin/tdoc-*) are thin wrappers over that endpoint: argument parsing and output formatting only, no logic in only one of them. A new MCP tool or CLI command names its endpoint and its counterpart in test/cli-mcp-parity.test.js (or a stated exception).
