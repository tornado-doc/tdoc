# components — what the parts are, before anything colours them

A component is defined here by its **shape and its job**. What it looks like is
the style's answer, and every entry in `style/` gives its own. That split is the
point: a stat tile is a stat tile in `paper` and in `technical`, and swapping the
style should change how it reads, never what it is.

**This list is open.** What follows is what tdoc reaches for when nobody has
said otherwise, not the set of components a doc is allowed to contain. Take one,
adapt it, or write something that is not here at all — see "Writing a component
that is not on this list" below. What is fixed is the shape every one of them
takes on the page: a block.

## A doc is a sequence of blocks

Everything in a tdoc is one of three kinds of block, one after another:

1. **Plain blocks** — `h1`–`h4`, `p`, `ul` / `ol` / `li`, `blockquote`, `pre`,
   a simple `<table>` in `tdoc-table-scroll`, `img`, `hr`.
2. **House blocks** — the six below: stat tiles, cards, note, collapsible,
   figure, diagram. Fixed markup, styled by the reader template in every house
   style, so they look designed with no CSS of your own.
3. **Artifacts** — anything custom (a chart, a diagram, a widget, a designed
   panel) as **one self-contained element**: a `<figure>`, or an element marked
   `data-tdoc-artifact="Name"`. Inside it, anything goes.

**Text lives in `p`, `li`, `h*`, `td` / `th`, `summary` or `figcaption` — never
loose in a `div`.** `<div class="stat"><b>42%</b> of users</div>` reads fine,
but the editor cannot edit it as text, comments land on fragments, and nothing
outside your own CSS knows what it is. Write it as a house block instead.

The publish answer carries a **block check**: loose text in wrappers, and
wrapper classes that are not house blocks, listed with a one-line fix. It is a
warning — the doc is published either way.

## House blocks

Use the markup as written: the class names are the contract, and the reader
template styles them in every house style. Tune spacing or type with a scoped
rule if the doc needs it; do not rebuild them from your own `<div>`s.

| Block | Use it for | Not for |
|---|---|---|
| Stat tiles | three or four numbers that carry the argument | a fifth number (that is a table) |
| Cards | two to four parallel options, findings or parts | a sequence (an `ol`), or one item (a paragraph) |
| Note | an aside that qualifies the text around it | a warning on every section |
| Collapsible | method, raw numbers, detail most readers skip | the main argument |
| Figure | an image, chart or composed visual with a caption | decoration |
| Diagram | a drawn SVG figure that may need to scroll on a phone | text that could be a list |

**Stat tiles** — the number is the element; the label under it is one line.
Each tile is two paragraphs, so both edit and take comments like any text.

```html
<div class="tdoc-tiles">
  <div class="tdoc-tile">
    <p class="tdoc-tile-num">11%</p>
    <p>of live docs are already block-shaped</p>
  </div>
  <div class="tdoc-tile">…</div>
</div>
```

It goes where its numbers are the point, not at the top of every document as a
header band.

**Cards** — parallel items of equal weight, each a heading and a sentence or
two (a short list is fine).

```html
<div class="tdoc-cards">
  <div class="tdoc-card">
    <h3>Option A: house blocks</h3>
    <p>Fixed markup, styled by the reader; text stays editable.</p>
  </div>
  <div class="tdoc-card">…</div>
</div>
```

**Note** — qualifies rather than warns; one or more paragraphs.

```html
<aside class="note"><p>Counts exclude docs written before March.</p></aside>
```

**Collapsible** — closed by default; the summary says what is inside.

```html
<details>
  <summary>Method and raw numbers</summary>
  <p>…</p>
  <ul><li>…</li></ul>
</details>
```

**Figure** — one image or composed visual with its caption. A figure is an
artifact: comments attach to it as a whole.

```html
<figure>
  <img src="chart.png" alt="What the chart shows">
  <figcaption>One line on what the reader should take from it.</figcaption>
</figure>
```

**Diagram** — the scroll wrapper every wide drawn figure sits in, so a phone
scrolls it instead of squashing it. Atomic, like a figure.

```html
<div class="diagram-box" data-tdoc-artifact>
  <svg viewBox="…" role="img" aria-label="…">…</svg>
  <p class="cap">One line on what the reader should take from it.</p>
</div>
```

## Custom components are artifacts

A chart, a widget, a matrix with marks, a designed comparison: build what the
content needs, with your own scoped CSS (`.funnel …`, never `body p …`). Keep
it **one element** — a `<figure>` or a wrapper with `data-tdoc-artifact="Name"`
— so the reader can point at it, expand it and comment on it as a unit, and so
the prose around it stays plain blocks. Do not spread a custom design across
the page as wrappers around ordinary paragraphs.

## When a custom template is warranted

`--custom-template` (CLI), or a page that brings its own page-level CSS (MCP),
hands the whole page to your design: the reader template, its theme controls
and the house blocks' styling are switched off. That is right for a **designed
page the user asked for** — a landing page, a presentation, a poster, a
full-bleed simulation. It is wrong for a report, analysis, spec, proposal,
plan, review or status update, however visual: those are a standard doc in a
house style, made of blocks, with their charts and widgets as artifacts. When
unsure, it is a standard doc.

## Where each decision lives

| Question | Answered by |
|---|---|
| Which component fits this data? | `visuals.md` |
| What is that component, structurally? | this file — or your own, see below |
| What colour, stroke, type, texture? | `style/<name>.md` |
| Which sections does the doc have? | the prompt, or a `structure/` entry |

A style that starts inventing components has crossed into this file's territory,
and a component that hardcodes a hex colour has crossed into the style's.

## Page parts

**Diagram box** — the house diagram block above. `data-tdoc-artifact` makes the
whole block one comment anchor rather than leaving the reader to comment on
fragments of its text.

**Table** — one bordered card, ruled inside, with nothing filled. A hairline
under each row does the work of separating them; a header sits in the muted ink
rather than a tinted band, and numbers are tabular so a column lines up.

```html
<div class="tdoc-table-scroll">
  <table> … </table>
</div>
```

```css
/* The reader styles every cell as a standalone chip, and a chip survives any
   rule that does not name the two properties making it one. Name them. */
.wrap th, .wrap td { background: transparent; border-radius: 0; }
```

The header is a label, so it takes the style's `label-type` register rather
than a smaller, greyer version of the body. Set at body size in the muted ink
it reads as a quieter row instead of a different kind of row; in the label
register it is unmistakable at a glance, whatever its size.

Under it goes a rule in `ink`, heavier than the hairlines between rows. That
separation is structural rather than typographic, which is why it is worth
spending: the register already carries every typographic signal available —
case, tracking, size, face — so making the header bolder or darker competes
with the body text on an axis that is used up. A rule does not. A hairline in
the same weight as the row rules below is not a header rule at all; the eye
reads the header as one more row.

**Square corners.** No radius on the table and none on its cells. A rounded
card competes with the figures around it, and a radius on the cells is worse
than decorative: under `border-collapse: separate` each cell is its own box, so
a rounded one truncates the row rule at both ends and two of those meeting in
the middle read as a break in the line rather than a continuous edge to scan
down.

Filling every cell and spacing them apart has the same effect for a different
reason: the gutters cut the columns, leaving nothing continuous to follow. A
fill is also the worst case for this reader — dark mode is a whole-page invert,
so a filled cell becomes a slab where a hairline only changes colour.

Reset the cell's own shape, not only the parts you are changing. A rule that
sets borders and padding alone comes out filled and rounded anyway, because the
fill and the radius are separate properties and nothing in that rule mentions
them. This is the one part of a table that a document cannot leave unsaid, so
`bin/tdoc-validate-template` fails a document whose cells never name both.

**Tabular is a numeral feature, not a smaller face.** A column of figures lines
up because the figures are tabular, and that costs nothing:

```css
.num { font-variant-numeric: tabular-nums; }
```

Buying the same alignment with a smaller size or a monospaced family costs two
things instead. The column ends up set differently from the ones beside it, so
the type changes size mid-row for no reason the reader can see; and a
monospaced family carries no CJK, so Chinese in that column falls back and
renders as the same typeface at two sizes, one column apart.

The class also has to sit on what it describes. `.num` on a `<td>` holding a
sentence is a claim about that cell that is not true — and if it carries
`white-space: nowrap`, the sentence can never break and the table takes a width
no viewport can give it, pushing the whole page sideways. Put the class on the
numerals (`<span class="num">$1.4B</span>`), not on the cell that contains them.
`bin/tdoc-validate-template` fails a cell class that narrows type or forbids
wrapping while sitting on prose, on the custom-template path too.

**Atomic values and prose have different wrapping needs.** Tabular numerals
do not keep a number together with its unit. For a cell that is one value, use
`<td data-tdoc-cell="value"><span class="num">5</span> days</td>`.
Use the same attribute for a price, date, compact status or identifier; do not
mark a paragraph as a value. Keep paragraph cells normally wrappable. Do not
assign one first-column percentage to every table: an ID column and a prose
column have different intrinsic widths.

The provider and CLI preview share a content-based safety floor for native
tables. Each cell reserves its natural unwrapped width up to a 12em prose
reading measure; explicit value cells reserve the complete value. Insufficient
space becomes local scrolling, not one-character columns or reduced type.
This also covers old documents that have no value annotations. It does not
replace reviewing all tables in both content widths, and does not run in a
standalone HTML file opened without the provider. Author card reflows keep
their own layout; the provider does not guess whether a matrix is a record list.

**Scroll wrappers** — `tdoc-table-scroll` for a table, `diagram-box` for a
figure. Both are `overflow-x: auto`.

Use wrapping HTML/CSS for text-heavy panels and HTML captions for explanations.
Keep SVG labels short; split longer labels into lines that fit their nodes.

```css
.diagram-box svg { display: block; width: min(100%, var(--figure-width)); height: auto; }
```

Set `--figure-width` per figure from its content and the selected style’s
typography. Bound `width`, not just `max-width` (the reader supplies its own
responsive maximum); do not enlarge a small figure just to fill the column.
Estimate SVG label size as `font-size × displayed SVG width / viewBox width`,
including cumulative scale from the text and its ancestors; target at least
12px at the smallest intended width. If transforms make this uncertain, use an
unscaled label layer or HTML. Split dense figures, or preserve their spatial
layout with `min-width` and local scrolling. Recheck label/node fit after sizing;
the estimate does not prove rendered fit.

Before finalizing a changed SVG chart, save a standalone copy with its actual
styles and preview it at the intended display widths:
`node "$SKILL_DIR/bin/tdoc-preview-svg" figure.svg --out /tmp/figure-preview --font /path/to/font.ttf --widths 343,400`.
Pass the actual smallest/largest displayed widths after the CSS cap, not the
page viewport widths; compare label size with surrounding prose in a page preview.
Repeat `--font` for other faces or CJK fallback; only supplied fonts are loaded.
Use a new `--out` directory for each revision so stale previews cannot be reused.
First use: `npm ci --prefix "$SKILL_DIR/tools/svg-preview" --ignore-scripts --no-audit --no-fund`.
Inspect the PNGs and fix clipping, unintended overlap and small labels without
removing content or changing data. Re-preview changes, not an unchanged publish.
Missing glyphs/render warnings fail; exit 0 means ready for visual review, not
layout approved. This previews the SVG only, not surrounding HTML/CSS.

**Slide** — one page of a deck. A doc that has them gets the reader's
Present control; nothing else changes about how it reads or takes comments.

```html
<section class="slide" data-tdoc-slide data-tdoc-artifact="Slide 3: the loop">
  <h2>…</h2> …
</section>
```

```css
.slide { container-type:inline-size; aspect-ratio:16/9; overflow:hidden; }
.slide h2 { font-size:max(3.6cqw,24px); } .slide p { font-size:max(1.75cqw,15px); }
```

Keep every slide's content inside its 16:9 box: the presenter scales the box
to the screen, so anything that spills is cut off. One idea per slide. Design,
layouts and phone reflow: `$SKILL_DIR/authoring/structure/slides.md`.

## Figure parts

These are the atoms of a drawn figure. Each style says what they look like.

| Part | What it is | Structural rule |
|---|---|---|
| **Container frame** | A rectangle grouping one stage of a figure | No fill of its own; the style decides corner and stroke |
| **Label chip** | The atomic noun of a figure — an input, a state, a stage | Short, uppercase, inside its own small box |
| **Numbered group** | A frame holding several steps, titled in its corner | Title reads `1: Author`, `2: Review` |
| **Description box** | One line explaining a step, inside the group it belongs to | Prose, not a label; keep it to a line |
| **Primary arrow** | The path the reader should follow first | Solid |
| **Secondary arrow** | A loop, a fallback, a return | Dashed — same weight, different dash |
| **Accent fill** | The one thing in the figure that is not greyscale | **One accent per figure.** Two competing accents make neither mean anything |
| **Textured variant** | The accent again, in a second state — live, transformed, stale | A texture over the fill, never instead of it: put the colour inside the `<pattern>` tile |

## Data components

`visuals.md` decides which of these the data calls for. Each is inline SVG,
because the host runs no author JavaScript and an SVG figure is a commentable
artifact — which is the whole point of putting it in a tdoc.

| Component | Reads as | Structural rule |
|---|---|---|
| **Bar** | Quantities compared | One baseline; bars share a zero |
| **Line** | A trend over time | Mark the points; a bare line hides how many readings there are |
| **Scatter** | A tradeoff, X against Y | Both axes drawn, both labelled |
| **Quadrant** | Position on two axes | Cross through the middle; label the axes, not the quadrants |
| **Matrix** | A feature comparison | ✓ / ✗ / ~ — a dash means "not stated", which is not the same as "no" |
| **Stat tiles** | A few key numbers | The `tdoc-tiles` house block: the number is the element; the label supports it |
| **Timeline** | A sequence of events | One axis, marks in order, the current one distinguished |
| **Flow** | A process with branches | Only when it truly branches. A list of steps is a list |
| **Stacked bar** | Composition of a whole | Segments sum to the whole, and the whole is stated |
| **Radar** | Many attributes, few items | Three or four items maximum before it turns to mud |
| **Gauge** | A magnitude on a scale | The scale's ends are visible, or the reading means nothing |
| **Small multiples** | The same chart repeated | Shared axes across every panel, or they cannot be compared |

## Drawing one

`diagrams.md` in this directory carries paste-ready SVG for the figure shapes —
flow chain, cycle with a return edge, layered stack, orthogonal band, evidence
status, 16:9 share card — already at the column's 672px width, plus the four
rules that decide whether a hand-built figure renders or quietly breaks. Read it
before drawing by hand.

## Writing a component that is not on this list

The nine parts and twelve chart types above cover what has come up so far. They
are not a vocabulary limit — a doc that needs a decision ladder, an org chart, a
burndown, a seating plan should have one, and no permission is required.

What a new component has to satisfy is short, and none of it is about taste:

**Name tokens, not colours.** Every `style/` entry declares `ink`, `rule`,
`muted`, `surface`, `accent-fill`, `accent-stroke`, `accent-text` and
`label-type`. A component built from those is dressed correctly by all four
styles — and by any style added later, which has to answer for the same tokens.
A component with a pure-black stroke written into it looks wrong the moment
somebody picks `paper`, where nothing is pure black.

**Be one block.** A component assembled from `<div>`s is invisible to the
overlay as a unit: readers end up commenting on fragments of its text. Make it
one element — a `<figure>`, or a wrapper marked `data-tdoc-artifact` — or, if
it is really text, write it as plain and house blocks with the text in `p`,
`li` and `h*`. That is what makes it something a reader can point at, which is
the reason it is in a tdoc rather than a screenshot.

**Survive a phone.** Use fluid widths, an SVG `viewBox`, and local scrolling
when a figure cannot narrow. Let text containers grow with their content;
never fit required text with clipping, line clamping or a fixed/max height.
An intentionally bounded viewport must scroll to expose all its content.

**Compute nothing in the host.** The same rule as everything else: `:checked`
for state, CSS `@keyframes` for motion, a sandboxed widget island if it truly
needs to calculate.

Meet those four and the component behaves like the ones listed here: it swaps
style, it takes comments, it survives a regeneration. Nothing else is required
of it, and it does not need to be added to this file to be used.

## Two rules that outlive any style

**Draw to the edge of the viewBox.** The viewBox is the frame, not a mat.
Padding baked into it indents the figure against every paragraph on the page —
invisible at desktop width, obvious on a phone. If the leftmost stroke is at
`x=14`, the viewBox starts at 14. Space between a figure and its neighbours is
CSS margin on the wrapper, where it applies to the box and not to the picture.

A set of figures drawn one at a time is the common way this goes wrong: each is
individually reasonable, their ink starts at 6, 14, 20 and 34, and the row reads
as broken. Draw a set on one geometry — same left edge, same right edge.

**Nothing computes in the host.** Author `<script>`, `on*=` handlers and
`<canvas>` are inert under the host CSP: no error, just a control that never
works. A toggle is `:checked` plus sibling selectors; motion is CSS
`@keyframes` with a `prefers-reduced-motion` guard; SVG styling goes in a
`<style>` *inside* the `<svg>`. Anything that genuinely needs to compute belongs
in a sandboxed widget island.


## Optional Excalidraw artifact

The provider loads the official `@excalidraw/excalidraw` React editor on demand.
Do not add React, script tags, an editor iframe, or a CDN import to author HTML.

```html
<figure id="value-flow" data-tdoc-artifact="Value flow"
  aria-label="Value flow" data-tdoc-excalidraw="HTML-ATTRIBUTE-ESCAPED SCENE JSON">
  <div class="diagram-box" data-tdoc-diagram-snapshot>
    <!-- the SVG exported from the same scene -->
  </div>
  <figcaption>What the diagram shows.</figcaption>
</figure>
```

Give every figure a unique stable ID. Store valid Excalidraw JSON (`type`,
`version`, `elements`, `appState`, `files`) in the attribute, escaping `&`, `"`,
`<` and `>` for HTML. Source limit: 2 MB and 5,000 elements. This first version
supports shapes, text, lines, arrows and freehand drawings, not embedded web
pages or image elements. Use native text/container and arrow bindings so labels
and connectors follow their shapes. Include a responsive, accessible SVG
snapshot even when no JavaScript is available. Keep scene and snapshot in sync.
After manual edits, update the saved scene while preserving element IDs and
positions rather than regenerating a layout that discards those edits.

The source and snapshot live in the same HTML version: existing write, publish,
pull, duplicate and download flows carry both. Owners choose Apply to document
then Save, using the normal permission and base-version conflict checks. Readers
may edit a temporary copy and download it; they cannot apply it to the source
document. Comments attach to the figure, not individual Excalidraw elements.
