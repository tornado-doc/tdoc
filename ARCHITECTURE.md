# tdoc Architecture

tdoc has two runtimes with different jobs:

- **Local Studio**: private authoring, preview, and agent-assisted review on
  `localhost`.
- **Published Reader**: stable public reading and commenting on a hosted
  Worker or Vercel function.

The same document content can move between them, but the runtime code is not
hot-linked across them. Local reads local files at request time; published docs
run against a deployed snapshot.

## Core Model

```
agent prompt
  -> ~/tdocs/<slug>/vN/index.html
  -> ~/tdocs/<slug>/meta.json
  -> ~/tdocs/<slug>/comments.json
```

Each document version is a full HTML snapshot. tdoc does not store a markdown
source of truth after generation. Comments are separate structured state and can
be pulled back into the agent workflow for regeneration.

## Local Studio

The local server is `server/server.js`, usually served on
`http://localhost:7878`.

Request flow:

1. Read the requested HTML snapshot from `~/tdocs/<slug>/vN/index.html`.
2. Read `~/tdocs/<slug>/meta.json` for the version list.
3. Read `server/overlay.js` from disk for every request.
4. Inject `window.__TDOC__` with `mode: "local"`.
5. Inject the overlay script before `</body>`.

Local comments are stored in `~/tdocs/<slug>/comments.json`. Local identity is
anonymous by design: this runtime is a private authoring surface, not a shared
identity surface.

Because `server/overlay.js` is read on every request, local overlay changes are
visible immediately after refresh. This is useful for development and PR
preview, but it also means "what I see locally" depends on which checkout is
running the server.

## Published Reader

Publishing uses `bin/tdoc-publish`.

Publish flow:

1. Validate the local slug under `~/tdocs`.
2. Bundle `server/overlay.js` into the hosted runtime:
   - Cloudflare: `worker/_worker.bundled.js`
   - Vercel: generated app in `~/.tdoc/vercel-app`
3. Deploy the hosted runtime when the publish script thinks worker code changed.
4. Upload document versions and comment state through `/api/upload`.
5. Serve public URLs such as `/d/<slug>/v/<n>`.

The published runtime injects `window.__TDOC__` with `mode: "published"` and
GitHub-backed identity. Published comments live in hosted storage:

- Cloudflare: R2 for document HTML, KV plus Durable Object for metadata and
  serialized comment writes.
- Vercel: Blob for document HTML, Upstash Redis for metadata and comments.

Published overlay behavior comes from the deployed bundle. It does not change
just because a local checkout changes.

## Install, Preview, and Publish Checkouts

There are three common code locations:

- **Installed skill**: usually `~/.claude/skills/tdoc` or
  `~/.codex/skills/tdoc`. This is what the user normally runs.
- **Canonical repo clone**: a normal development checkout, for example
  `tornado-doc/tdoc`.
- **PR preview worktree**: a temporary checkout running another local server on
  a different port.

Today `bin/tdoc-publish` uses the installed skill path as its code source. If a
developer previews a PR from another worktree, publishing will not use that PR
code unless the installed skill is updated or the publish command is explicitly
pointed at that checkout.

This is the main release-chain risk: local preview, installed skill, canonical
repo, and hosted Worker can all be on different commits while showing the same
document slug.

## Author HTML Compatibility Contract

Agents can generate arbitrary HTML, so tdoc's compatibility model is a contract
rather than a hard sandbox:

- Use one primary content container: `.wrap`, `main`, `article`, `.content`, or
  `.container`. The overlay uses these roots to size the reading column and
  comment rail.
- Treat `tdoc-*` classes and ids as reserved for the overlay.
- Scope document UI rules to the document. Avoid broad rules such as
  `button:hover` because they can affect overlay buttons and comment controls.
- Prefer responsive layout rules over fixed widths. A document can override
  tdoc's low-specificity defaults, so a fixed `1120px` container can still
  break mobile.

The framework guarantees a readable default when a document does not bring its
own CSS, and it adds safety defaults for common content such as images, tables,
code, and artifacts. If a document brings high-specificity CSS, preserving that
style is the author's responsibility.

## Theme and Style State

There are two different style planes:

- **Document style** lives inside the HTML snapshot. It is part of the versioned
  document and is uploaded during publish.
- **Overlay chrome** lives in `server/overlay.js` and is bundled into the
  published runtime.

Publish does not strip the document's `<style>` block. If a local document and
its published version look different, first separate document CSS from overlay
chrome:

- document CSS should match the uploaded HTML snapshot;
- the Worker may add `data-tdoc-aid` attributes to commentable elements during
  publish, which changes the HTML bytes but not the author CSS;
- overlay UI may differ if local and published runtimes were built from
  different commits.

Viewer palette selection should not be modeled as browser-only overlay state if
the author expects it to publish. Browser `localStorage` is scoped by origin, so
a choice made on `localhost` will not carry to
`tdoc.<subdomain>.workers.dev`.

If tdoc needs an author-chosen default palette for published docs, that should
be a separate product design:

```
meta.json.theme.defaultPalette
  -> window.__TDOC__.defaultTheme
  -> overlay first-load behavior
```

That is distinct from #91's polish scope.

## Release Observability Gap

The current system does not make the runtime/version chain visible enough. A
reader can see a document URL, but not which overlay commit or publish source
produced it.

There are two concrete weak points today:

- `bin/tdoc-publish` decides whether to redeploy by comparing file modification
  times against the bundled worker. Git operations and machine changes can make
  mtime order misleading.
- An installed skill checkout can lag behind the canonical repository while
  still being the code source used by publish. That is not always the cause of a
  rendering issue, but it should be visible instead of inferred.

The next architecture fix should expose, in the page or publish output:

- document slug and version
- `mode: local | published`
- overlay version or commit SHA
- installed skill SHA used for publish
- hosted runtime deployment time or bundle SHA

This would turn "which version am I seeing?" from inference into a visible
fact, and it would prevent local-vs-published debugging from relying on
byte-count comparisons.

## Design Principle

Keep the boundary sharp:

- Local Studio optimizes for fast authoring, private iteration, and agent
  control.
- Published Reader optimizes for stable sharing, real identity, and reliable
  comments.
- The release chain must clearly show which code and document version crossed
  from one side to the other.
