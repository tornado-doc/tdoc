# HTML generation rules

Markup contract for host HTML. Prose is governed by `voice.md`; this
file covers structure, CSP, interactivity, and layout invariants.

- **The prose in the doc is governed by `$SKILL_DIR/authoring/voice.md`.** These rules
  cover markup; that file covers the words inside it. Both apply to every
  doc. It also fences off the spans the prose rules must never touch —
  code, identifiers, quoted material, and data.
- **Host HTML does not run author JavaScript.** The author document is served on its own route, `/d/<slug>/v/<n>/frame`, inside a sandboxed iframe under a nonce-based CSP (`script-src 'nonce-<n>' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts`). The nonce is stamped onto exactly one injected script — `server/frame-probe.js`, the anchoring/selection probe — and nothing else. Host `<script>` tags (inline or `src`), `onclick=`/`onchange=` attributes, and `javascript:` URLs have no nonce, so the browser refuses them: no error in the page, no visible failure — just a control that never does anything. This is true on **both** the local server (`server/server.js` → `frameCspHeader`, the `/frame` route) and published docs (`worker/worker.js` → `frameCspHeader`). The reader chrome (top bar, comments) is a separate React document that never shares the author frame's origin.
  **Exception — sandboxed island:** if the doc needs computation, write `v<n>/widgets/<name>.html` and embed `<iframe sandbox="allow-scripts" src="/d/<slug>/v/<n>/widget/<name>">`. Inline `<script>` in that widget file **does** run. Never put author JS in the host document. See "When the prompt wants something CSS can't express" below.
- Host document is one HTML file (no imports). Optional islands are extra files under `v<n>/widgets/`. External `<script src>` in the host is blocked by the same CSP, so a CDN library (D3, Chart.js, …) will not load in the host — put it in a widget island or say so rather than shipping a dead reference.
- Sandboxed-safe: the author document renders inside a sandboxed, opaque-origin iframe (`/frame`), so don't rely on top-level navigation, `window.parent`, cookies, or `localStorage`.
- Comment chrome lives in the reader shell, outside your document — **don't** add commenting UI yourself.
- Don't add a "made with tdoc" footer, version selector, or share button. The shell handles those.
- Use SVG snapshots for inline diagrams (commentable text, and CSS can animate it). For editable Excalidraw diagrams, see the artifact contract in `$SKILL_DIR/authoring/structure/components.md`. **Don't use `<canvas>` in the host** — nothing can draw to it without JS. Draw inside a widget island if needed.
- Default font stack: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Mono: `ui-monospace, "SF Mono", Menlo, monospace`.

### Interactivity: CSS only

Author `<script>` in the **host** document never executes (see above), so every
moving or switchable part of the host has to be declarative. The patterns below
are verified on this runtime; a working reference doc using all three is at
`~/tdocs/agent-gui-integration/v1/index.html`. Computed state belongs in a
sandboxed island, not in the host.

**1. Toggles and mode switches — `:checked` + sibling selectors**

A hidden `<input type="radio">` (or checkbox), then `<label for="…">` controls and
the panes it switches. Everything toggled must be a **sibling that comes after the
input**: `~` only reaches forward, and only within one parent.

```html
<div class="fig" data-tdoc-artifact>
  <input type="radio" name="mode" id="m-a" class="vis-radio" checked>
  <input type="radio" name="mode" id="m-b" class="vis-radio">
  <div class="fig-controls"><label for="m-a">Before</label><label for="m-b">After</label></div>
  <div class="pane pane-a"> … </div>
  <div class="pane pane-b"> … </div>
</div>
```
```css
/* off-screen, NOT display:none — that drops it out of the tab order */
.vis-radio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.pane-b { display: none; }
#m-b:checked ~ .pane-a { display: none; }
#m-b:checked ~ .pane-b { display: block; }
#m-b:checked ~ .fig-controls label[for="m-b"] { background: #111; border-color: #111; color: #fff; }
```

**2. Motion — CSS `@keyframes`**

For flow along a route, animate `stroke-dashoffset` on a dashed copy of the path
drawn over a static base path:

```css
.flow { stroke-dasharray: 9 22; animation: flowdash 2.2s linear infinite; }
@keyframes flowdash { to { stroke-dashoffset: -31; } }
@media (prefers-reduced-motion: reduce) { .flow { animation: none; } }
```

Always ship the `prefers-reduced-motion` guard.

**3. SVG styling — put `<style>` INSIDE the `<svg>` element**

A `<style>` in `<head>` was observed **not** to reach elements inside inline SVG on
this runtime. SVG-internal `<style>` is the reliable placement, so make each `<svg>`
fully self-contained:

```html
<svg viewBox="0 0 720 400" role="img" aria-label="…">
  <style>
    .flow-a { stroke-dasharray: 9 22; animation: flowdash-a 2.2s linear infinite; }
    @keyframes flowdash-a { to { stroke-dashoffset: -31; } }
    @media (prefers-reduced-motion: reduce) { .flow-a { animation: none; } }
  </style>
  …
</svg>
```

Give each SVG its own class names and `@keyframes` names (`flow-a` / `flowdash-a`,
`flow-b` / `flowdash-b`) so two figures on one page don't collide.

**What does NOT work in the host document**

- `<script>` of any kind, `on*=` handler attributes, `javascript:` URLs — all inert
  in the host. The same tags **do** run inside `v<n>/widgets/<name>.html`.
- **SMIL** (`<animate>`, `<animateMotion>`, `<animateTransform>`): verified not to
  run here — the SVG timeline stays frozen at `getCurrentTime() === 0`. Use CSS
  animation instead.
- `<canvas>` in the host: a blank box without JS. Draw inside a widget island if needed.
- Computed state in the host — simulations, a slider that recalculates a model,
  live data, sorting or filtering a table, form validation. Use a sandboxed island.

**When the prompt wants something CSS can't express**

Game of Life, a live calculator, a parameter sweep. Do **not** put `<script>` in
the host document — it is inert under CSP. Two options:

1. **Sandboxed island (preferred when it must compute).** Write a second HTML
   file and embed it as an iframe. Overlay comments on the iframe as one
   artifact (`iframe[src]` is already commentable). Do not walk into the frame.

   ```
   ~/tdocs/<slug>/v1/index.html
   ~/tdocs/<slug>/v1/widgets/compound-interest.html
   ```

   Host document:

   ```html
   <iframe
     sandbox="allow-scripts"
     src="/d/<slug>/v/1/widget/compound-interest"
     title="Compound interest"
     style="width:100%;height:320px;border:0">
   </iframe>
   ```

   The `sandbox` attribute must be `allow-scripts` only — never add
   `allow-same-origin`. The server rewrites matching widget iframes to that
   value even if the author HTML forgets or adds extra flags. Widget HTML is a
   full document; inline `<script>` there **does** run. Do not use `srcdoc`,
   `data:`, or `blob:` — those inherit the host CSP and the script stays dead.

2. **Precompute** if an island is overkill: `:checked` panels, a static SVG, or
   a CSS loop, and note in the doc what was simplified.

Download / Duplicate of a doc with islands is not supported in v1 (the
downloaded file cannot fetch `/widget/` URLs; account copy is host HTML only).

### Default styling — trust the reading template, add components on top

**The house style (`$SKILL_DIR/authoring/style/default.md`) deliberately does
not touch reading typography.** The reader template owns body size, headings,
and measure; the house style adds only semantic components (risk / positive /
leveled block / pill / diagram box). So "do not re-style" and the house style
agree: write component CSS and doc-specific CSS, but do not set your own
`font-size` on `p`, `h1`, `h2` — the template already did.

**The template is BAKED INTO the document at creation** (`tdoc-new` stamps it
as `<style id="tdoc-reader">`, the same block `/export` inlines), so every doc
is self-contained: it renders identically in the reader shell, downloaded, or
opened as a bare file. Never write your own `<style id="tdoc-reader">` — the
scaffold owns that block. The values below are that template, at `:where()`
zero specificity — the house style and your doc CSS sit on top of them and
always win.

The template is modeled after the `conway-life` doc ("What if a doc could think?"): tight, readable, system fonts only. **Download** is a menu: **Download HTML** (`/export`, which relies on the same `<style id="tdoc-reader">` block your document already carries) and **Download PDF** (print that same reading column; use the browser's Save as PDF). Neither includes reader chrome (bar, comments).

- System font stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`)
- Body: 17px / line-height 1.65 / `#111` on white
- h1: 34px / line-height 1.15 / -0.01em letter-spacing
- h2: 24px / 1.25 / 40px top margin
- h3: 19px / 1.35 / 28px top margin
- Paragraph: 18px bottom margin
- Blockquote: 3px solid `#111` left rule, `#f5f6f8` background-ish quoted block (mono pre)
- pre: mono 15px, light gray background, left-rule, scrolling overflow
- Code (inline): 0.92em mono, light-gray rounded chip

**Pick a style from `$SKILL_DIR/authoring/style/` for every doc**, and use that
entry's CSS as written. Add only the
house style's components and tightly scoped CSS for content-specific charts,
diagrams, and controls. Do not invent additional bare-element rules or change
root layout with arbitrary CSS. Width is a separate template choice:

- **Default:** `<div class="wrap">` keeps the centered 720px reading column.
- **Wide:** `<div class="wrap" data-tdoc-width="wide">` uses the available
  page width with the same padding, typography, and chosen house style. Use
  it for diagram-heavy designs or wide comparisons that cannot fit the normal
  column comfortably, or when the user asks for a full-width document. It does
  **not** require `--custom-template` or a different aesthetic.

The document uses the author's layout; readers do not choose a width mode.
At the standard 720px root, 24px padding per side leaves **672px for content**;
on a 375px phone there are about **311px**. Design for the content box, not the
browser window. Use container queries for layout changes inside that root.
Tables must allocate readable columns even with long identifiers; a fixed table
minimum width alone does not do that. Mark atomic values (amount + unit, dates,
statuses, identifiers) with `<td data-tdoc-cell="value">5 days</td>`; leave
paragraphs wrappable. Do not apply a single first-column percentage to unrelated
tables. Use the chosen style's table component or deliberately reflow the table.
The provider protects native table cells using measured content: short values
reserve their natural width; prose reserves up to a 12em reading measure;
explicit value cells remain unbroken. If columns cannot fit, the table scrolls
inside its wrapper. This applies to every native table, including old documents,
and recomputes after reader-width changes and edits. It is a safety floor, not
an author layout or an aesthetic pass. Review the checker's reported adjustments
and **every table**, including short values and the final table in the document.
SVG labels must fit their nodes and viewBox
at every size: use line breaks/reflow or readable local scrolling, not tiny type.

Keep one primary root. Do not add viewport-width children, negative margins,
or hide page overflow to simulate wide mode. Comment placement measures the
actual root; desktop pins stay inside the viewport, and phones use the
existing comment drawer.

A different file in `$SKILL_DIR/authoring/style/` applies only when the user
names it. A presentation or landing page may replace the reading aesthetic
only when the user explicitly asks; programmatic creation must mark that
exception with `--custom-template`.

What to write:

```html
<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    /* Required: an explicit ground, so the page never renders transparent.
       Everything else — type, headings, tables, code, the column — comes from
       the baked template unless your style entry says otherwise. */
    body { background: #fff; }
  </style>
</head><body>
  <div class="wrap">
    <h1>{title}</h1>
    <p class="meta">{subtitle or attribution}</p>
    <!-- content here using plain <h2>, <h3>, <p>, <ul>, <pre>, <table>, etc. -->
    <!-- host interactivity goes in <style>, not <script>. Computation
         belongs in v1/widgets/<name>.html. See HTML generation rules. -->
  </div>
</body></html>
```

The baked template's `:where()` rules handle:
- Centered article column (`max-width: 720px`, padded) by default; opt into
  the available full width with `data-tdoc-width="wide"` on the root.
  Do not restate root sizing in CSS: the template owns spacing, and
  `frame-probe.js` measures the result to place comments
- All heading sizes, weights, spacing
- Paragraph + list spacing
- Code/pre, blockquote, table styling
- Link color
- Image margins

Only add CSS for **doc-specific** content (a custom widget, a simulation, a chart). When you do, scope it tightly (e.g. `.my-slider { ... }`), not `body p { ... }`.

### Required container structure

Wrap the doc content in a single container element with one of these selectors: **`.wrap`** (preferred), `main`, `article`, `.content`, or `.container`. `frame-probe.js` relies on this to:
- Detect article width for the responsive breakpoint
- Anchor the article to the LEFT when there are comments (so growing/shrinking the window preserves the right-side comment column)
- Calculate where comment cards land

Note: select the column with `data-tdoc-width="wide"` when needed; do not set arbitrary root width, margin or padding. The template supplies spacing, and the probe measures the resulting column for comment placement.

### Required: explicit body background

Always set `body { background: #fff; }` (or your chosen color) so the page doesn't render as transparent over the reader's own ground.

**Author in light only — dark mode is a whole-page invert**, applied inside the frame by `frame-probe.js` (`filter: invert(1) hue-rotate(180deg)`, the Dark Reader trick). A hand-written dark palette gets inverted back to light, so a `@media (prefers-color-scheme: dark)` block that sets dark colors renders *light*. Style the light look well and the dark one is its clean inverse, for free. See `$SKILL_DIR/authoring/style/technical.md` for the full rule.

### Responsive defaults (REQUIRED)

Every doc must work on mobile out of the box. The baked template carries defensive caps for media, but the document itself has to be authored responsively — it is a file that will also be read outside tdoc:

- **Always include** `<meta name="viewport" content="width=device-width, initial-scale=1">` in `<head>`. Nothing adds it for you — the frame serves your HTML as written — and the validator rejects a document without it.
- **Use fluid widths**, not hardcoded pixels. The default 720px column has a
  **672px** usable canvas; select `data-tdoc-width="wide"` on the root when
  the content needs more room. Keep root spacing in the template. On phones
  both layouts shrink to the viewport. Use `minmax(0, 1fr)` for grid text tracks,
  `min-width: 0` on their children and `overflow-wrap: anywhere` for long identifiers;
  stack text-heavy columns on small screens.
- **SVG / images**: use fluid sizing (`width: 100%; height: auto`) and an SVG
  `viewBox`. Follow the figure rules in `$SKILL_DIR/authoring/structure/components.md`
  for readable labels, HTML captions and intentional local scrolling.
- **Tables**: wrap in `<div class="tdoc-table-scroll">`. Preserve semantic
  `<table>` / `<th>` / `<td>` relationships; mark atomic cells with
  `data-tdoc-cell="value"`. Do not use page clipping or shrinking text to fit.
  Native tables get the same content-width protection in the provider and CLI
  preview. An intentional card reflow remains the author's responsibility.
- **Code blocks (`<pre>`)**: `max-width: 100%; overflow-x: auto;`.
- **Design for constrained and expanded content at phone, tablet and desktop widths.**
  When previewing, inspect the document frame as well as the shell: a fitting
  shell can hide an overflowing iframe. Wide figures/tables may scroll locally;
  the whole page must not. Static validation does not prove rendered layout.

The baked template carries `:where()` defensive defaults (media elements are
capped at `max-width: 100%`). Provider-computed table geometry is transient and
is not written into saved author HTML. If delivering a standalone HTML export,
verify that export separately; the hosted reader's safety floor is not proof
that a file opened without the provider will have the same layout.

### Don't conflict with the reader

- **Don't define `button:hover { background: ... }`** globally — `frame-probe.js` injects the hover Comment pill as a `<button>` *inside* your document, so a global rule reaches it. Scope hover rules to your own buttons (e.g. `.my-btn:hover`, or `.wrap button:hover`).
- **Don't invent new `tdoc-*` names.** The prefix belongs to tdoc, and the probe injects `.tdoc-hover-outline` / `.tdoc-comment-pill` into your document. Two `tdoc-*` classes are the opposite — they are **for you to use**, and the components file asks you to: `tdoc-table-scroll` (a table's scroll wrapper) and `tdoc-artifact` / `data-tdoc-artifact` (make a composed block one comment anchor).
- **Don't position-fixed elements at the top.** The top bar is in the shell now, so you will not overlap it — but a fixed banner is positioned against the frame's own viewport and will sit on top of your text as it scrolls.
- **Don't use a `<footer>`.** The shell supplies the page footer; the validator rejects an author one.

### Author HTML compatibility contract (invariant)

Agents generate arbitrary HTML. The baked template is **`:where()` zero-specificity** so **author CSS always wins** — property by property: what you name is yours, what you leave alone keeps the default. That also means a bad author rule silently breaks layout (e.g. `padding: 0 24px` on the content root wiped the top reading space — #96). Contract:

- One primary content container: `.wrap` (preferred), `main`, `article`, `.content`, or `.container`.
- Select default or `data-tdoc-width="wide"` on the primary root. **No arbitrary**
  root width / `margin` / `padding` overrides — the template owns column spacing.
- Treat `tdoc-*` classes/ids as reserved.
- Scope document UI rules to the document (never global `button:hover`).
- Prefer fluid/`max-width` layouts over fixed pixel shells.

### Access policy (published docs — invariant)

Remote storage holds optional `meta.access`:

```json
{
  "visibility": "public | unlisted | private",
  "commenting": "owner | invited | signed_in | off",
  "history_visibility": "owner | invited | public",
  "allowed_users": ["github-login"]
}
```

- **public / unlisted**: link-readable without login. Unlisted is not catalog-discovery; `/me` still lists the signed-in publisher's docs.
- **private**: the doc publisher (hosted `github_login`, or `TDOC_OWNER` on BYOK/legacy) + `allowed_users`. Gates `/d/.../v/N`, export, fork, `GET /api/comments`.
- **history_visibility**: version picker visibility (new policies default owner-only / pure-publish).
- Legacy meta without `access` stays world-readable + full history (back-compat).
- **Access only ever tightens by omission.** A flag left out keeps what is
  already stored — the CLI leaves an existing `meta.access` alone, and the
  worker carries the stored block forward when an upload names none. A publish
  that means to OPEN a doc must say so (`--visibility public`); this is why
  FIRST-DOC.md names the policy instead of publishing flagless.
- Initial publish can set access via `tdoc-publish --visibility|--history|--commenting|--allow-user`.
- After publish, access must be mutable directly on remote storage (`PATCH /api/doc/access` with the upload token) without local `meta.json` or full HTML re-upload.
- `/me` on hosted tdoc.dev lists the signed-in account's docs. On BYOK it lists the worker operator's docs. Remote write actions still use the upload token for CLI; the publisher's session cookie may mutate their own docs (CSP on every response).

### Agent catalog: owned docs / folders + shared folder links

Agents must **not** scrape the HTML `/me` page. After the account is connected
(`tdoc-publish --signin-only` or a normal publish → `~/.tdoc/published.json`):

```bash
bash "$SKILL_DIR/bin/tdoc-me"
```

Prints JSON: the same owned `docs` + `folders` the user sees on `/me` (hosted
Bearer). Open a doc with the usual `/d/<slug>/v/<n>` URL (Bearer still required
for private).

**Folder share links** (`/f/<share_id>` from My docs → folder ⋮ → Share):

```bash
bash "$SKILL_DIR/bin/tdoc-me" --shared <share_id>
```

Access is **intersection / filter**, not union: opening a shared folder does
not escalate any doc's ACL. The listing only includes docs this viewer may
already read (folder visibility/invitees first, then each doc's
`meta.access`). An unlisted folder with a private invitee-only doc shows the
private doc only to that invitee (cookie or their hosted Bearer).

Underlying APIs (CLI wraps these; prefer the CLI): `GET /api/me`,
`GET /api/folders/shared?id=<share_id>`.


### Comment anchor stability (important for `/tdoc edit`)

**The system handles this for you.** Element anchors are identity-based, not path-based: at publish time, the Worker stamps every commentable artifact with a content-hashed `data-tdoc-aid` attribute. The set of commentable artifacts:

- **Media leaves:** `img, svg, canvas, video, pre, figure, iframe[src]`
- **Semantic blocks:** `section, aside, blockquote, table, details` (`article` is intentionally excluded — it's a content-root pattern; using it would make the whole doc one artifact)
- **Author opt-in:** any element tagged `data-tdoc-artifact` or with class containing `tdoc-artifact`

The **same artifact in any future version gets the same aid**, regardless of how the HTML around it is restructured. Comments anchor by aid; resolution is identity-first. If an aid disappears from the new version, the Worker marks the comment `kind: "lost"` so it renders unanchored — it will **never silently re-attach to a different artifact**.

### Make an author-composed block commentable as a unit

If your doc has a "card" or composite widget built from `<div>`s (a transcript panel, a comparison card, a custom interactive widget), it won't be commentable as a unit by default — the probe resolves anchors to its inner text, not to the card. Two ways to fix:

1. **Use a semantic tag**: change `<div class="my-card">` to `<section class="my-card">` (or `<aside>`, `<details>` if appropriate). Automatic — no other change needed.
2. **Opt in explicitly** with `data-tdoc-artifact`:
   ```html
   <div class="my-card" data-tdoc-artifact>…composite content…</div>
   ```
   Or use a class containing `tdoc-artifact`. Works on any tag.

Both paths give the block a stable aid and the full hover-to-comment affordance, identical to the media-leaf experience.

You generally don't need to do anything special when regenerating — the aid stamping is automatic on `/tdoc publish`. But it's still polite to:

- **Keep an artifact's essential content stable** if its comment thread is still meaningful. The aid is derived from the artifact's tag + intrinsic attrs (`viewBox`, `src`, `alt`, `aria-label`, `title`) + normalized inner content. Trivial whitespace changes don't matter; replacing an SVG with an entirely different one *does* (and that's the right behavior — the comments were about the old artifact).
- **Stable author-given ids are still nice** for things like deep links, but they're no longer required for anchor stability.
- **When a comment intentionally goes unanchored** (because you replaced the artifact), say so in the agent reply. The user sees "anchor lost" in the margin and knows to either re-anchor it or accept the loss.

