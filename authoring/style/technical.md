# technical — the engineering-blog style (theme-following)

A take on `judgmentlabs.ai`'s dark blog, adapted to tdoc's reality: the
overlay owns theming (it has its own light/dark toggle), and a doc cannot
control the overlay chrome. So this style **follows the theme** instead of
hard-coding one. In a dark environment it is the judgmentlabs dark look; in a
light one it is its clean light inverse. It never mismatches the chrome.

The dark palette is verified 1:1 against the live judgmentlabs page.

| Token | Light (default) | Dark (`prefers-color-scheme: dark`) |
|---|---|---|
| ground | `#ffffff` | `#1a1a1a` |
| body text | `rgba(10,10,10,.92)` | `rgba(250,250,250,.9)` |
| headings | `#0a0a0a` | `rgba(250,250,250,.95)` |
| muted / links | `#737373` | `#8a8a8a` |
| code fill | `#f5f5f5` | `#232323` |
| accent | `#ff4b2e` | `#ff4b2e` (same — hot on both) |

## The two rules that make it not-break

1. **Headings must set color explicitly, in BOTH modes.** The overlay colors
   `h1`/`h2` directly, at a level that beats inheritance from `.wrap`. A
   heading with no explicit color takes the overlay's heading color — which
   on the wrong ground is invisible (this is the bug that hid the title).
   Set `.wrap h1, .wrap h2 { color: … }` in the base and again in the dark
   media block.
2. **Everything themed lives under `@media (prefers-color-scheme: dark)`.**
   The base rules are the light palette; the media block swaps grounds,
   text, fills. Then the doc always agrees with the overlay/system theme.

## Typography (this style sets it)

Judgment Labs uses "Untitled Sans"; a system sans stands in at the same
metrics. h1/h2 set family AND color explicitly (see rule 1).

```
body  16px / 26px   system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
h1    36px / 500 / -0.9px
h2    24px / 500
mono  ui-monospace, "SF Mono", Menlo, monospace   (theirs is "DM Mono")
```

## CSS

```css
/* --- light (default) --- */
body  { background:#fff; }
.wrap { color:rgba(10,10,10,.92); font:16px/1.62 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap h1 { color:#0a0a0a; font-size:36px; font-weight:500; letter-spacing:-.9px; line-height:1.25; }
.wrap h2 { color:#0a0a0a; font-size:24px; font-weight:500; margin-top:34px; }
.muted   { color:#737373; }
.wrap a  { color:#737373; text-decoration:underline; }
.tag     { font:13px ui-monospace,"SF Mono",Menlo,monospace; background:#f5f5f5; color:#171717; border-radius:4px; padding:1px 6px; }
.metric  { border:1px solid #e5e5e5; border-radius:6px; padding:12px 14px; background:#fafafa; margin:14px 0; }
.metric .k { font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:#737373; }
.metric .v { font:600 22px/1.1 ui-monospace,"SF Mono",Menlo,monospace; color:#171717; margin-top:4px; }
.callout { border-left:3px solid #ff4b2e; background:#fff5f3; padding:12px 16px; margin:16px 0; }
.diagram-box { max-width:100%; overflow-x:auto; margin:20px 0; }

/* --- dark (follows the environment) --- */
@media (prefers-color-scheme: dark) {
  body  { background:#1a1a1a; }
  .wrap { color:rgba(250,250,250,.9); }
  .wrap h1, .wrap h2 { color:rgba(250,250,250,.95); }
  .muted, .wrap a    { color:#8a8a8a; }
  .tag     { background:#232323; color:rgba(250,250,250,.9); }
  .metric  { background:#202020; border-color:#2e2e2e; }
  .metric .k { color:#8a8a8a; }
  .metric .v { color:rgba(250,250,250,.95); }
  .callout { background:#2a1a16; }
}
```

## Diagrams follow the theme too

Style SVG nodes with CSS classes, not inline fills, so a media block can flip
them. Node `.dn { fill:#fafafa; stroke:#ccc; }` in light → `fill:#202020;
stroke:#3a3a3a` in dark; keep the highlighted node's `#ff4b2e` stroke in both;
edge/text colors flip with the palette. Never drop the diagram just because
the surface changed — draw it on-theme.

## Reach for

- **`.tag`** inline for every identifier, flag, metric value, or config key.
- **`.metric`** for a standalone number; group several in a row.
- **`.callout`** at most once or twice — the accent loses force if repeated.

## Visuals are content-driven, never dictated by the style

**This style's diagram vocabulary works for ANY diagram type** — a pipeline, an architecture, a flow, context bars, a chart. The style is the visual *treatment*, never a limit on which visuals appear. Draw diagrams on-theme (they flip with the doc): light — `#fafafa` fills, `#ccc` strokes; dark — `#202020` fills, `#3a3a3a` strokes; the single `#ff4b2e` accent on the highlighted node either way; mono labels.


This style says how a visual is *colored and treated* — it never decides
whether a doc has one. A diagram, chart, table, image, or none: that follows
the content. If the doc has one, draw it in this palette; if it has none, the
style does not invent one. No style here requires, forbids, or limits any
kind of visual.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Keep the title and headings the doc would have in any style.
Tables inherit the overlay default. Link generously.
