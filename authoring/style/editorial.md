# editorial — the long-read blog style

A take on `cognition.com`'s blog: warm paper, a serif reading voice, a light
serif headline, sans subheads, and one electric-blue accent. Verified against
the live page's computed styles.

| Element | Real value | We ship |
|---|---|---|
| ground | `#f7f6f5` | `#f7f6f5` |
| body / h1 font | STK Bureau Serif | `"Iowan Old Style", Georgia, "Times New Roman", serif` |
| h2 font | NB International (sans) | `system-ui, -apple-system, "Segoe UI", sans-serif` |
| h1 | 32px / **weight 300** / -0.64px | same metrics |
| body | 15px / 22.5px, black | same |
| link | electric blue `#2200ff`, **2px underline** | same |

## The underline means "link"

A hyperlink gets a **2px electric-blue underline** (`border-bottom`). This is
the affordance: underline = clickable. It reads as a link because it *is* one,
so it never lies to the reader. Use it for every real reference — a repo, a
commit, a spec, a prior doc.

Do **not** underline a word that is not a link. For inline emphasis use `<b>`
(or `<i>`) — an underline reads as a link, so it stays reserved for real
links. Keep emphasis sparing; the serif voice carries most of the weight.

The colored bars on the reference (blue `#3a55f4` / green `#4ba181` /
terracotta `#cc7c5e`) are **category markers for rows inside a comparison or
timeline block** — block-level, not inline underlines:

```css
.row-key  { border-left:3px solid #3a55f4; padding-left:12px; }
.row-good { border-left:3px solid #4ba181; padding-left:12px; }
.row-warn { border-left:3px solid #cc7c5e; padding-left:12px; }
```

## The typographic moves that make it 1:1

Serif body, **thin** serif h1 (weight 300, not bold), sans h2. This three-way
split is the signature. h1 must set its family AND weight explicitly, or the
overlay's heading rule wins and it comes out sans.

```css
body { background:#f7f6f5; }
.wrap { font-family:"Iowan Old Style", Georgia, "Times New Roman", serif; color:#000; }
.wrap h1 { font-family:"Iowan Old Style", Georgia, serif; font-weight:300; letter-spacing:-.02em; }
.wrap h2 { font-family:system-ui,-apple-system,"Segoe UI",sans-serif; font-weight:500; }
.wrap a  { color:#2200ff; text-decoration:none; border-bottom:2px solid #2200ff; }

/* pulled-aside blocks */
.aside  { border-left:2px solid #3a55f4; background:#eef1fb; padding:12px 16px; margin:16px 0; }
.result { border-left:2px solid #4ba181; background:#f0f6f2; padding:12px 16px; margin:16px 0; }
.diagram-box { max-width:100%; overflow-x:auto; margin:20px 0; }
```

## Visuals are content-driven, never dictated by the style

**This style's diagram vocabulary works for ANY diagram type** — a pipeline, an architecture, a flow, context bars, a chart. The style is the visual *treatment*, never a limit on which visuals appear. Draw diagrams warm and understated: `#fff` node fills, `#b3bdc9` strokes, electric-blue `#3a55f4` on the focus node, terracotta `#cc7c5e` for a caveat path, serif or system labels.


This style says how a visual is *colored and treated* — it never decides
whether a doc has one. A diagram, chart, table, image, or none of these:
that follows the content. If the doc has an architecture diagram, keep it and
draw it in this palette (serif labels, `#3a55f4`/`#cc7c5e` accents on a warm
ground). If it has none, the style does not invent one. No style here
requires, forbids, or limits any kind of visual.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Tables inherit the overlay's rounded-cell default. Link generously
(the blue is this style's main accent).
