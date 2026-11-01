# Provider UI Implementation

The provider-owned reader UI is a React application built by Vite. Author HTML
remains framework-independent and is rendered only in the sandboxed document
frame.

## Runtime boundary

- `server/shell.js` emits an empty React root, structured boot JSON, and the
  content-hashed runtime asset tags. It contains no product UI markup.
- `shell/src/main.jsx` selects the document shell, Docs Hub, neutral landing,
  or status page from the boot discriminator.
- `server/frame-probe.js` is the only runtime installed in author HTML. It owns
  selection, anchor discovery, copy extraction, theme application, and the
  `postMessage` bridge. It has no React dependency.
- Local and Worker document routes use the same shell builder and the same
  `/d/:slug/v/:version/frame` isolation boundary.
- Remote storage remains the source of truth. React receives only provider-
  enforced capabilities and data; author HTML never defines access policy.

## Component layers

Reusable headless primitives live under `shell/src/ui/`:

- `AppDialog`: Base UI dialog, portal, focus management, Escape, and backdrop.
  The popup carries chrome.css's `.tdoc-modal` class, so every dialog keeps the
  legacy modal's type, spacing, buttons, and dark-mode treatment.
- `AppMenu` / `AppMenuItem`: Base UI anchored menus and keyboard behavior,
  styled to the legacy `.tdoc-menu` metrics (13px rows, 7px/10px padding).
- `SegmentedControl`: option sets used by access policy controls (`.tdoc-seg`).

`server/chrome.css` stays the single source of truth for how the reader chrome
looks; `shell/src/ui/ui.css` only adds what portal-rendered primitives need on
top of it (positioning, resets for controls that used to be spans). Visual
parity with the pre-React chrome is checked with the side-by-side harnesses in
`test/visual/` (see CONTRIBUTING.md).

Provider features build on those primitives:

- `TopBar`: theme, identity, sign-in, notifications, and site navigation.
- `document/`: toolbar, dialogs, comments, pin layers, access management, and
  pure API/model modules.
- `hooks/`: comments, frame bridge, notification, and Docs Hub state boundaries.
  Every session mutation runs through the hook so a failure is always a toast
  and a 401 always reaches the sign-in path — page components never catch.
- `DocsHub`: page orchestrator over `useDocsHub` and the shared row components
  in `docs-hub/rows.jsx` (`DocRow`, `FolderRow`, `RowMenu` on `AppMenu`).
- `SignInDialog` / `OnboardingDialog`: reusable cross-surface flows.

`document-shell.jsx` is the page-level orchestrator. It coordinates feature
hooks and components but does not build HTML strings or contain server policy.

## Build and deployment

`npm run build:shell` writes a Vite manifest plus hashed JavaScript and CSS to
`server/runtime/`. `server/runtime-assets.js` resolves those assets for the
local server. `bin/tdoc-bundle` embeds the same bytes in the Worker and replaces
placeholders through callbacks so minified dollar-prefixed sequences are not
interpreted as `String.replace` replacement tokens.

The Worker serves the hashed runtime paths directly. CSP nonces cover boot and
module tags; the author frame has its own sandbox CSP. Widget islands remain a
separate destination-gated nested-frame route.

## Verification

- `npm test`: policy, storage, boot-data, bundling, and behavior suites.
- `test/artifact-shell.test.js`: end-to-end shell/frame/comment boundary.
- `test/responsive.test.js`: desktop through phone layout invariants.
- `test/ui.test.js`: React primitives, document actions, and Docs Hub smoke.

TypeScript is intentionally deferred. The current API, model, hook, and
component boundaries are the migration units; conversion should not change the
runtime protocol or server boot shapes.

## Rendered version comparison

The version menu and document overflow menu open **View changes** directly in
the document area, with no dialog or setup controls. The current published
version is always compared with its previous version; the first version is
compared with an empty document. `?compare=1` opens this view
directly, and browser Back/Forward restore the reading/comparison mode. The
original reader stays mounted but hidden, preserving unsaved editor state.
Comparison includes published versions only.

Each side loads the existing `/d/:slug/v/:n/frame` route with its existing
access checks and opaque `allow-scripts` sandbox. The shell exchanges bounded
snapshots through a window-identity-checked comparison bridge; it never mounts
author markup in the provider DOM. `frame-compare.js` is dormant outside these
disposable frames. Leaving the view discards all comparison annotations. Both panes scroll together
using matched block positions, with start/end anchors and interpolation through
added or removed sections. A following frame suppresses its own resulting scroll
event so either side can lead without feedback loops.

`version-diff.js` matches stable block IDs, then equal content, then compatible
gaps. Word edits preserve unchanged inline markup. Simple tables align unique
headers and row labels; ambiguous or spanning tables fall back to whole-table
comparison. Stable SVG element IDs allow local marks; unkeyed graphics fall
back to an artifact outline and a link to the previous version. Mobile
comparison inserts inert historical text/table copies into the newer view; copied
markup cannot carry scripts, URLs, IDs or event handlers.

Finite Web Animations timelines share a bounded clock. Embedded widgets,
video, SMIL and unbounded timelines explicitly report that precise sync is
unavailable. The comparison is side by side on desktop and merged on mobile.
A contextual animation control temporarily stacks both animation frames on
mobile; changed graphics link to their previous published version. Source
styles retain their original per-version isolation; style changes are reported
separately from content changes.
