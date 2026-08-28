# paper — the warm serif long-read style

A warm, book-ish register: an off-white paper ground, a serif display voice,
a clean humanist sans for the body, and one clay accent. The aesthetic of the
Anthropic blog, approximated with **open fonts** — because the real thing uses
Anthropic's proprietary Anthropic Serif / Anthropic Sans, which are not ours
to ship.

**Boundary:** this is a general warm-editorial aesthetic (off-white + serif +
humanist sans is used across many publications), not a brand replica. It
carries no logo, no byline, no wordmark, and must never be used to pass a doc
off as coming from Anthropic. It is a look, not an identity.

Measured against the live page, then substituted:

| Element | Real value | We ship |
|---|---|---|
| ground | `#faf9f5` off-white | `#faf9f5` |
| ink | `#141413` | `#141413` |
| display font | Anthropic Serif | `"Fraunces","Newsreader",Georgia,serif` |
| body font | Anthropic Sans | `"Inter",system-ui,-apple-system,sans-serif` |
| h1 | 49px / 500, serif | same metrics, open serif |
| body | ~20px / 1.6 | same |
| accent | clay / book-cloth | `#c15f3c` |

## The moves that make it feel right

**Serif headings on a warm ground, sans body.** This pairing is the whole
identity — an expressive serif display over a calm humanist sans, on paper
rather than stark white. h1 and h2 must set their family explicitly, or the
overlay's heading rule wins.

**Generous, unhurried spacing.** Paragraphs breathe (24px gaps), the measure
stays narrow (~640px feel — but let the baked reader template own the column;
don't set max-width yourself, the validator rejects it). Restraint over density.

**One clay accent, used sparingly.** Links and the rare emphasis in `#c15f3c`.
No second hue.

## CSS

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500&display=swap">
```
```css
body { background:#faf9f5; }
.wrap { font-family:"Inter",system-ui,-apple-system,sans-serif; color:#141413; font-size:19px; line-height:1.65; }
.wrap h1 { font-family:"Fraunces","Newsreader",Georgia,serif; font-weight:500; letter-spacing:-.005em; color:#141413; }
.wrap h2 { font-family:"Fraunces","Newsreader",Georgia,serif; font-weight:500; color:#141413; }
.wrap h3 { font-family:"Fraunces","Newsreader",Georgia,serif; font-weight:500; }
.wrap a  { color:#c15f3c; text-decoration:none; border-bottom:1px solid #e3c4b6; }
.wrap p  { margin:0 0 24px; }
/* a quiet pull-aside on the paper ground */
.aside { border-left:2px solid #c15f3c; background:#f4efe7; padding:14px 18px; margin:20px 0; border-radius:0 6px 6px 0; }
```

## Tokens

A component — including one this file has never heard of — dresses itself from
these. That is what makes a component someone else wrote swap styles correctly:
it names tokens, not colours.

| Token | Value here |
|---|---|
| `ink` | `#141413` — no pure black anywhere |
| `rule` | `#dcd3c4` |
| `muted` | `#6b6355` |
| `surface` | `#f4efe7` |
| `accent-fill` | `#f4e3dc` |
| `accent-stroke` | `#e3c4b6` |
| `accent-text` | `#c15f3c` |
| `label-type` | small-caps sans, `~11px` — the display serif stays out of figures |

Corners are softened (`rx:3`) rather than sharp, which is the one structural
habit this style asks of a component.

## Component treatment

`structure/components.md` says what these parts are. On paper they are drawn
warm and low-contrast: no pure black, no hard rectangle. The clay accent is the
only saturated thing on the page and it stays rationed.

| Component | This style's treatment |
|---|---|
| Container frame | `stroke:#dcd3c4; stroke-width:1.2`, `rx:3` — a softened corner, not a sharp one |
| Label chip | Small-caps sans `~11px` in `#6b6355`, on `#f4efe7`, `rx:3` |
| Numbered group | Serif title in `#141413`, inside the frame's top-left |
| Description box | Sans `~11.5px` in `#6b6355`, no box |
| Primary arrow | `stroke:#141413; stroke-width:1.2` |
| Secondary arrow | `stroke:#b5ab99`, `stroke-dasharray:4 4` |
| Accent fill | `fill:#f4e3dc stroke:#e3c4b6`, text `#c15f3c` |
| Textured variant | Sparse dot in `#e3c4b6` over the same fill |
| Stacked bar | Paper tints `#f4efe7` / `#ece5d8` / `#dcd3c4` with `#c9bfae` strokes |

Figure labels are the body sans, not the display serif — the serif is for
headings, and inside a drawing it turns decorative.

## Visuals are content-driven, never dictated by the style

**This style's diagram vocabulary works for ANY diagram type** — a pipeline, an architecture, a flow, context bars, a chart. The style is the visual *treatment*, never a limit on which visuals appear. Draw diagrams warm: `#faf4ec` fills, `#dcd3c4` strokes, clay `#c15f3c` on the highlighted part, serif labels.


Says how a visual is colored and treated — never whether a doc has one. A
diagram, chart, table, or none: that follows the content. Draw diagrams warm:
`#faf4ec` fills, `#dcd3c4` strokes, clay `#c15f3c` for the highlighted part,
serif labels.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Tables inherit the overlay default. Link generously.
