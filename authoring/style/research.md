# research — the research-note style

The feel of a considered analysis memo, not a marketing page. Extracted from
`tdoc.dev/d/avgraph-auto-research/v/1`.

**The one thing that defines it: trust the overlay's reading typography.**
Don't set your own body size, heading scale, or content `max-width` — the
overlay already gives a comfortable reading column. Everything else here is
a starting kit, not a rulebook. Reach for what the doc needs; extend it when
the content genuinely calls for something the kit doesn't have.

**Tables are part of that — don't style them either.** Plain `<table><tr><td>`
inherits the overlay's default: rounded grey cells separated by white gaps
(`border-spacing`, per-cell `border-radius`, `--td-surface` fill), which is
the look this style is known for. Writing your own `border-collapse` or
`border-bottom` overrides it into a flat ruled grid and breaks the family
resemblance. Only wrap a wide table in `<div class="tdoc-table-scroll">` so
it scrolls on a phone; never restyle the cells.

## A starting kit

```css
/* metadata chip — a short label beside a heading or item */
.pill { display:inline-block; font-size:13px; padding:2px 10px;
  border-radius:999px; background:#f0f1f4; margin-right:6px; }

/* leveled / layered block — a thin left rule */
.lvl  { border-left:3px solid #111; padding:2px 0 2px 16px; margin:24px 0; }

/* a risk, cost, or failure mode — warm orange */
.risk { background:#fdf6f0; border-left:3px solid #c97b3d; padding:12px 16px; margin:16px 0; }

/* a key observation or good outcome — green */
.good { background:#f0f7f1; border-left:3px solid #4a8f5d; padding:12px 16px; margin:16px 0; }

/* wrap a wide SVG so it scrolls instead of overflowing on a phone */
.diagram-box { max-width:100%; overflow-x:auto; margin:20px 0; }
```

For diagrams, orange (`#c97b3d`) marks the part under discussion, plain grey
(`#f5f6f8` / `#999`) the rest, a dashed orange edge a weaker or proposed link.

Orange reads as risk, green as a win — that meaning is what matters, not a
color count. Add more hues when the content earns them (a third category, a
chart with several series); just keep each one meaningful and let plain
paragraphs carry most of the doc, so the accents still stand out when they
appear.

## Link generously

A research note earns trust by being checkable. When the doc names a source,
a repo, a commit, a spec, a prior doc, an issue, or a page it draws on, make
it a real hyperlink — `<a href>` in the doc's own accent, which the overlay
already styles. Prefer an inline link on the noun itself over a bare URL, and
gather a short "References" or "Sources" list at the end when there are
several. A claim the reader can follow to its source beats one they have to
take on faith.

## Visuals are content-driven, never dictated by the style

**This style's diagram vocabulary works for ANY diagram type** — a pipeline, an architecture, a flow, context bars, a chart. The style is the visual *treatment*, never a limit on which visuals appear. Draw diagrams in the research-note palette: `#f5f6f8` node fills, `#999` strokes, orange `#c97b3d` or green `#4a8f5d` for the part under discussion, dashed for a weaker link, `system-ui` labels.


This style says how a visual is *colored and treated* — it never decides
whether a doc has one. A diagram, chart, table, image, or none: that follows
the content. If the doc has one, draw it in this palette; if it has none, the
style does not invent one. No style here requires, forbids, or limits any
kind of visual.

## Style is visual only

The kit decides how the page *looks*. It says nothing about section
numbering, language, tone, or how the doc is organized — those follow the
content and the prompt, never the style. (A style pulled from a Chinese doc
does not make an English doc number its sections 一、二、三.)

## Fits the overlay

Carried by left rules, pale fills, and chips — nothing full-bleed, sticky,
or shadowed — so it stays inside the "Author HTML compatibility contract" in
`SKILL.md` without effort. Light mode only for now; the pale fills assume a
white ground.
