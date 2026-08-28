# components — what the parts are, before anything colours them

A component is defined here by its **shape and its job**. What it looks like is
the style's answer, and every entry in `style/` gives its own. That split is the
point: a stat tile is a stat tile in `paper` and in `technical`, and swapping the
style should change how it reads, never what it is.

**This list is open.** What follows is what tdoc reaches for when nobody has
said otherwise, not the set of components a doc is allowed to contain. Take one,
adapt it, or write something that is not here at all — see "Writing a component
that is not on this list" below. An agent bringing its own design system is
composing with tdoc, not fighting it.

## Where each decision lives

| Question | Answered by |
|---|---|
| Which component fits this data? | `visuals.md` |
| What is that component, structurally? | this file — or your own, see below |
| What colour, stroke, type, texture? | `style/<name>.md` |
| Which sections does the doc have? | the prompt, or a `structure/` entry |

A style that starts inventing components has crossed into this file's territory,
and a component that hardcodes a hex colour has crossed into the style's.

## Page blocks

**Diagram box** — the scroll wrapper every wide figure sits in, so a phone
scrolls it instead of squashing it.

```html
<div class="diagram-box" data-tdoc-artifact>
  <svg viewBox="…" role="img" aria-label="…">…</svg>
  <p class="cap">One line on what the reader should take from it.</p>
</div>
```

`data-tdoc-artifact` makes the whole block one comment anchor rather than
leaving the reader to comment on fragments of its text.

**Table** — one bordered card, ruled inside, with nothing filled. A hairline
under each row does the work of separating them; a header sits in the muted ink
rather than a tinted band, and numbers are tabular so a column lines up.

```html
<div class="tdoc-table-scroll">
  <table> … </table>
</div>
```

The shape matters more than it looks. Filling every cell and spacing them apart
turns a table into a pile of blocks: the gutters cut the columns, so the eye has
no continuous edge to scan down, and rounded corners multiply with every row.
Fills are also the worst case for this reader — dark mode is a whole-page
invert, so a filled cell becomes a slab where a hairline only changes colour.

Rounding a table needs `border-collapse: separate` with `border-spacing: 0` and
`overflow: hidden` to clip; `collapse` will not round.

**Scroll wrappers** — `tdoc-table-scroll` for a table, `diagram-box` for a
figure. Both are `overflow-x: auto`, and both need the child to have a
`min-width` or the wrapper never engages: an `svg` at `width: 100%` shrinks to
the column instead of overflowing it, and its labels land at a few pixels on a
phone. Give a wide figure a `min-width` that keeps its smallest type around
9px, and let it scroll.

**Stat tile row** — a few numbers that carry an argument on their own. Three or
four; a fifth is a table.

```html
<div class="tiles">
  <div class="tile"><b>11</b><span>what the number counts</span></div>
</div>
```

**Note** — an aside that qualifies rather than warns. One rule, no fill, no
icon: `<p class="note">`.

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
| **Stat tiles** | A few key numbers | The number is the element; the label supports it |
| **Timeline** | A sequence of events | One axis, marks in order, the current one distinguished |
| **Flow** | A process with branches | Only when it truly branches. A list of steps is a list |
| **Stacked bar** | Composition of a whole | Segments sum to the whole, and the whole is stated |
| **Radar** | Many attributes, few items | Three or four items maximum before it turns to mud |
| **Gauge** | A magnitude on a scale | The scale's ends are visible, or the reading means nothing |
| **Small multiples** | The same chart repeated | Shared axes across every panel, or they cannot be compared |

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

**Be one comment anchor.** A component assembled from `<div>`s is invisible to
the overlay as a unit: readers end up commenting on fragments of its text.
Either use a semantic tag — `<section>`, `<aside>`, `<details>` — or mark it
`data-tdoc-artifact`. That is what makes it something a reader can point at,
which is the reason it is in a tdoc rather than a screenshot.

**Survive a phone.** Fluid widths, a `viewBox` rather than pixel `width`/
`height`, and a scroll wrapper if it genuinely cannot narrow.

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
