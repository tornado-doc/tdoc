# default — the stark sans style (applied when a doc selects nothing)

**This is the house default: every doc that names no style gets it.** A cold,
spare register: pure white, pure black, one clean sans everywhere, an
oversized headline with tight tracking, and almost no color. The aesthetic of
the OpenAI research index, approximated with **open fonts** — the real page
uses OpenAI's proprietary OpenAI Sans, which is not ours to ship.

**Boundary:** this is a general stark-minimal aesthetic (white + black + a
single geometric sans is used everywhere), not a brand replica. No logo, no
byline, no wordmark; never used to pass a doc off as coming from OpenAI. A
look, not an identity.

Measured against the live page, then substituted:

| Element | Real value | We ship |
|---|---|---|
| ground | `#ffffff` | `#ffffff` |
| ink | `#000000` | `#0a0a0a` |
| all type | OpenAI Sans | `"Inter",system-ui,-apple-system,sans-serif` |
| h1 | 59px / 500 / **-1.78px tracking** | same metrics, open sans |
| body | 17px / 28 | same |
| link | black at 60% | `rgba(10,10,10,.6)` |

## The moves that make it feel right

**One sans, no serif, no warmth.** Everything is the same geometric-humanist
sans. The register comes from scale and restraint, not from type contrast.

**An oversized headline with tight tracking.** h1 is large (≈56px) with
negative letter-spacing (`-.03em`). That single move is most of the look. h1
and h2 set their family explicitly (the overlay colors/styles headings).

**Near-zero color.** Black on white. Links are black dimmed to ~60%, not a
hue. Reserve any real color for a chart that genuinely needs it.

## CSS

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
```
```css
body { background:#fff; }
.wrap { font-family:"Inter",system-ui,-apple-system,sans-serif; color:#0a0a0a; font-size:17px; line-height:1.65; }
.wrap h1 { font-family:"Inter",system-ui,sans-serif; font-weight:600; font-size:clamp(38px,6vw,56px); letter-spacing:-.03em; line-height:1.05; color:#0a0a0a; }
.wrap h2 { font-family:"Inter",system-ui,sans-serif; font-weight:600; letter-spacing:-.015em; color:#0a0a0a; margin-top:40px; }
.wrap a  { color:rgba(10,10,10,.6); text-decoration:none; border-bottom:1px solid rgba(10,10,10,.2); }
/* a hairline-ruled note — no fill, just a rule */
.note { border-top:1px solid #e5e5e5; padding-top:12px; margin:20px 0; color:#555; font-size:15px; }
```

## The diagram vocabulary (the OpenAI-index look)

This style has a full technical-diagram vocabulary, verified to render in
tdoc. It draws ANY diagram — a pipeline, context-window bars, an architecture,
a flow — from one small set. The style is the *treatment*, not a fixed set of
shapes; it never limits what kind of visual a doc contains.

- **Container frames — sharp, not rounded.** Thin black rectangles
  (`stroke:#111; stroke-width:1.3`), square corners, no fill, no shadow. Only
  the small inner pill labels get a hairline `rx:0–1`.
- **Mono pill labels.** Uppercase monospace, `~10.5px`, `letter-spacing:.04em`,
  inside a thin (`stroke-width:1`) box — for the atomic nouns of the figure
  (an input, a stage, a state). Use your own labels, not a reference's.
- **Numbered container groups.** A big frame grouping steps, with a sans
  weight-600 title inside its top-left corner (`1: Author`, `2: Review`).
- **Description boxes.** Short sans (`~11px`) inside a thin box for a step's
  one-line explanation.
- **Arrows.** Thin (`1.2`), small round arrowhead, black for the main path; a
  **dashed** (`stroke-dasharray:3 3`) variant for a secondary path or a loop.
- **One accent per figure, filled solid.** Pink (`fill:#f7d7d1
  stroke:#e0a99e`, text `#b3503c`) or blue (`fill:#dde7f9 stroke:#a9c0ee`,
  text `#26407a`). Solid pastel is the base; a texture is the *variant*, not
  the fill.
- **Textured variants** via SVG `<pattern>` — the signature. A **dot** texture
  over the pink for a live/active state; a **diagonal hatch** over the blue for
  a transformed/compressed one. Put the solid color *inside* the pattern tile
  so the texture reads on top of the fill, not over white:

```
<pattern id="pdot" width="6" height="6" patternUnits="userSpaceOnUse">
  <rect width="6" height="6" fill="#f7d7d1"/>
  <circle cx="3" cy="3" r="1.05" fill="#e0a99e"/></pattern>
<pattern id="bhatch" width="7" height="7" patternUnits="userSpaceOnUse"
  patternTransform="rotate(45)"><rect width="7" height="7" fill="#dde7f9"/>
  <line x1="0" y1="0" x2="0" y2="7" stroke="#a9c0ee" stroke-width="1.5"/></pattern>
```

- **Stacked bars for composition.** A vertical bar split into labeled segments
  (blue shades `#c4d4f5` / `#d4e0f8` / `#e8eefb`, `#a9c0ee` strokes, mono
  labels) reads a whole-made-of-parts — a context window, a version stack, a
  budget. A hatch segment marks a transformed part; a dashed baseline marks a
  limit.

Keep it airy — generous white space between containers. Outside diagrams the
doc stays greyscale on white; the accent lives in the figures.

## Visuals are content-driven, never limited by the style

The vocabulary above is a *palette for whatever visual the content needs* — it
never decides whether a doc has a diagram, nor restricts it to these shapes. A
doc with a bar chart, a table, a photo, or nothing follows its content; this
style only says how such a thing looks in this register.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Tables inherit the overlay default. Link generously.
