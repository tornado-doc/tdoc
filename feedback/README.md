# Product feedback client

Comments left on someone's own app, handed to a person or an agent through
the same tdoc comment stack as any doc. Two ways in, nothing to install:

- **Bookmarklet** — drag the button on `/feedback` to the bookmarks bar, click
  it on any page of the app.
- **One line** — `<script src="https://tdoc.dev/feedback.js"></script>` in the
  app (dev/preview builds).

`src/main.jsx` is the whole client. It imports the shell's `CommentComposer`,
`CommentCard` and `server/chrome.css`, so the UI *is* tdoc's; `npm run
build:feedback` writes one self-contained IIFE to `server/runtime/feedback.js`,
which `bin/tdoc-bundle` inlines into the worker (served at `/feedback.js`) and
`server/server.js` serves as-is. Commit the built file with the source.

The client never sees the tdoc cookie (it runs on the app's origin). The first
time it runs on an app it opens `/feedback/connect` on the tdoc origin, which
signs the person in, finds or creates the app's feedback space (a normal doc,
`created_from: 'feedback'`), and posts back a token bound to that one doc.
See `getSession` and `FEEDBACK_TOKEN_PATHS` in `worker/worker.js`.

A site's own space (`data-tdoc-space`, the SDK in `packages/feedback`) is
bound to its origins in My docs → Feedback → Add to your site, or by an agent
with the MCP tool `create_feedback_space` (`POST /api/feedback/space`), which
makes a private space bound to the origins and returns the embed line. The
binding lives in its own KV key, `site:<slug>` (legacy: `meta.site`), so
binding a site and changing Share never overwrite each other; see
`siteBindingKey`.
