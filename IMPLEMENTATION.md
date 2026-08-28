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
- `AppMenu` / `AppMenuItem`: Base UI anchored menus and keyboard behavior.
- `SegmentedControl`: option sets used by access policy controls.

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
