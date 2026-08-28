# Visuals — required for every generated doc

**Read this before writing doc HTML**, on every `/tdoc new` and every
regeneration in `/tdoc edit`. It applies under every style. Voice governs the
words; this governs how much of the doc is a picture instead of words.

## Be visual-first

A tdoc doc should lead with visuals, not paragraphs. If a claim has data, a
comparison, a structure, a sequence, or a tradeoff in it, **draw it** — prose
is the connective tissue between visuals, not the main body. Aim for a visual
roughly every screenful. A wall of text with one diagram is a failure of this
contract, not a neutral choice.

Everything here is buildable as inline SVG or CSS — the host runs no author
JS, so no chart library. An SVG chart is also a commentable artifact, which is
the point of tdoc. Draw honestly: real numbers, labeled axes, no chartjunk.

## Don't default to a flowchart. Match the visual to the data.

A flowchart is one option among many, and the most overused. Pick by what the
data *is*:

| The data is… | Reach for |
|---|---|
| quantities being compared | a **bar chart** (or horizontal bars for long labels) |
| a tradeoff / relationship (X vs Y) | a **scatter or line chart** with real axes |
| a trend over time | a **line chart** |
| where things sit on two axes | a **quadrant / positioning map** |
| a feature comparison | a **matrix** with ✓ / ✗ / ~ marks |
| a few key numbers | **stat tiles** (big number + label) |
| a sequence of events | a **timeline** |
| a process with branches | a **flow diagram** (only when it truly is a flow) |
| the composition of a whole | a **stacked bar** or parts-of-100 bar |
| many attributes across a few items | a **radar** or **small multiples** |
| a magnitude on a scale | a **gauge / meter / progress bar** |

Most non-trivial docs carry **several different types**, not one repeated. A
competitor analysis wants stat tiles + a positioning map + a comparison matrix
+ maybe a bar chart. A technical design wants an architecture diagram + a
sequence + a metrics row. Reach for the variety the content earns.

## The style owns the look, not the choice

Which visual to draw is content-driven (this file). How it looks — colors,
strokes, fills, fonts, textures — is the style's job. Every style ships a
diagram vocabulary and a palette; use it. A bar chart in the default style is
black bars on white with one accent; in `paper` it is clay bars on warm
paper; in `technical` it flips with the theme. Same chart type, styled per
style.

## Draw to the edge of the viewBox

A figure sits in the same column as the prose, so its drawing has to start
where the text starts. The viewBox is the frame, not a mat: padding baked into
it pushes the ink inward and the figure reads as indented against every
paragraph around it.

Set the viewBox to the drawing's own bounds. If the leftmost stroke is at
`x=14`, the viewBox starts at 14 — not at 0 with fourteen units of nothing.
Space between a figure and the text above it is the job of CSS margin on the
wrapper, where it applies to the box rather than the picture inside it.

Two failures, both invisible until a phone narrows the column:

- **Baked padding.** `viewBox="0 0 120 64"` around ink that spans `x=34..86`
  wastes 28% of the width on each side. At a 164px card that is 46px of
  indent, against a paragraph that starts at 0.
- **Ragged starts across a set.** A row of glyphs drawn one at a time ends up
  with each one starting somewhere different — 6, 14, 20, 34 — and the row
  reads as broken even though every figure is individually fine. Draw a set on
  one geometry: same left edge, same right edge, same optical weight.

`bin/tdoc-validate-template` fails a figure whose ink starts more than 10% of
the width inside its own box, for the shapes it can parse. It cannot see
inside a `<path>`, so a hand-drawn arrow figure is on you: check that the
left-hand ink is flush before shipping it.

## Keep them commentable and responsive

Wrap wide charts in `<div class="diagram-box">` (or `tdoc-table-scroll` for
tables) so they scroll on a phone instead of overflowing. Tag an author-built
figure `data-tdoc-artifact` if it is a composed block rather than a single
`<svg>`, so a reader can comment on it as a unit.
