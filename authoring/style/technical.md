# technical — the engineering-blog style (theme-following)

A take on `judgmentlabs.ai`'s dark blog, adapted to tdoc's reality: the
overlay owns theming — it has its own light/dark button in the bar — and a
doc cannot restyle that chrome. So this style **follows the overlay's toggle**
instead of hard-coding one look. Dark is the judgmentlabs dark look; light is
its clean inverse. It never mismatches the chrome, because it reads the *same
signal the chrome does*.

**The signal is `data-tdoc-theme`, NOT `prefers-color-scheme`.** When the
reader clicks the bar's dark button, the overlay sets
`data-tdoc-theme="dark"` on `<html>` — it does **not** touch the OS
`prefers-color-scheme`. A style that keys its dark rules off
`@media (prefers-color-scheme: dark)` therefore ignores the button entirely:
the chrome goes dark while the doc stays light (or the reverse), and half the
components — SVG ink, code chips, table cells — end up the wrong color on the
wrong ground. That is the bug that makes "everything invisible." Key every
dark rule off `html[data-tdoc-theme="dark"]` and the doc moves as one with the
button.

**Open dark-first.** Put `data-tdoc-default-theme="dark"` on the `<html>`
tag. The overlay reads it as the initial theme when the reader has no saved
preference, so a judgmentlabs-style doc opens dark (its native look) and the
button still flips it to light.

The dark palette is verified 1:1 against the live judgmentlabs page.

| Token | Light | Dark (`html[data-tdoc-theme="dark"]`) |
|---|---|---|
| ground | `#ffffff` | `#1a1a1a` |
| body text | `rgba(10,10,10,.92)` | `rgba(250,250,250,.9)` |
| headings | `#0a0a0a` | `rgba(250,250,250,.95)` |
| muted / links | `#737373` | `#9a9a9a` |
| code / table cell | `#f0f0f0` / `#f5f5f5` | `#232323` / `#202020` |
| accent | `#ff4b2e` | `#ff6a4d` (hot on both) |

## The three rules that make it not-break

1. **Headings must set color explicitly, in BOTH modes.** The overlay colors
   `h1`/`h2` directly, at a level that beats inheritance from `.wrap`. A
   heading with no explicit color takes the overlay's heading color — which
   on the wrong ground is invisible (this is the bug that hid the title).
   Set `.wrap h1, .wrap h2 { color: … }` in the base and again in dark.
2. **Every themed rule lives under `html[data-tdoc-theme="dark"]`** — never
   `@media (prefers-color-scheme: dark)`. The base rules are the light
   palette; the dark block swaps grounds, text, and fills.
3. **Cover EVERY surface, not just prose.** Prose, headings, links, code
   chips, `<table>` cells, AND the SVG diagram all need a dark rule. A
   surface you forget stays at its light value and vanishes on the dark
   ground. Tables and inline `<code>` do **not** inherit a safe default here
   — style them yourself in both modes.

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

```html
<html lang="en" data-tdoc-default-theme="dark">   <!-- opens dark-first -->
```
```css
/* --- light (base) --- */
body  { background:#fff; }
.wrap { color:rgba(10,10,10,.92); font:16px/1.62 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap h1 { color:#0a0a0a; font-size:36px; font-weight:500; letter-spacing:-.9px; line-height:1.25; }
.wrap h2 { color:#0a0a0a; font-size:24px; font-weight:500; margin-top:34px; }
.muted   { color:#737373; }
.wrap a  { color:#737373; text-decoration:underline; }
.tag     { font:13px ui-monospace,"SF Mono",Menlo,monospace; background:#f5f5f5; color:#171717; border-radius:4px; padding:1px 6px; }
code     { font:.85em ui-monospace,"SF Mono",Menlo,monospace; background:#f0f0f0; color:#171717; padding:1px 5px; border-radius:3px; }
table    { border-collapse:separate; border-spacing:3px; width:100%; }
th       { color:#737373; text-align:left; font:600 11px/1 ui-monospace,Menlo,monospace; letter-spacing:.04em; text-transform:uppercase; padding:8px 10px; }
td       { background:#f5f5f5; color:#171717; padding:9px 10px; border-radius:4px; }
.callout { border-left:3px solid #ff4b2e; background:#fff5f3; padding:12px 16px; margin:16px 0; }
.diagram-box { max-width:100%; overflow-x:auto; margin:20px 0; }

/* --- dark: the overlay's toggle, keyed on the same attribute the chrome sets --- */
html[data-tdoc-theme="dark"] body  { background:#1a1a1a; }
html[data-tdoc-theme="dark"] .wrap { color:rgba(250,250,250,.9); }
html[data-tdoc-theme="dark"] .wrap h1,
html[data-tdoc-theme="dark"] .wrap h2 { color:rgba(250,250,250,.95); }
html[data-tdoc-theme="dark"] .muted,
html[data-tdoc-theme="dark"] .wrap a  { color:#9a9a9a; }
html[data-tdoc-theme="dark"] .tag,
html[data-tdoc-theme="dark"] code     { background:#232323; color:rgba(250,250,250,.92); }
html[data-tdoc-theme="dark"] th       { color:#9a9a9a; }
html[data-tdoc-theme="dark"] td       { background:#202020; color:rgba(250,250,250,.92); }
html[data-tdoc-theme="dark"] .callout { background:#2a1a16; }
```

## Diagrams follow the theme too — via role classes, not inline fills

An SVG built with inline `fill="#0a0a0a"` cannot flip: those presentation
attributes are baked for one ground. Give each shape a **role class** and
keep the light hex as the attribute default (so it still reads in light and in
an export); then a CSS rule beats the attribute in dark. This is the move that
keeps the diagram from disappearing on the dark ground.

```css
/* light hex stays on the elements as the default; these bite only in dark */
html[data-tdoc-theme="dark"] .wrap svg .d-frame { stroke:#5c5c5c; } /* box + arrow strokes */
html[data-tdoc-theme="dark"] .wrap svg .d-ink   { fill:#eaeaea; }   /* labels, titles */
html[data-tdoc-theme="dark"] .wrap svg .d-node  { fill:#242424; }   /* box / bar fills */
html[data-tdoc-theme="dark"] .wrap svg .d-muted { fill:#9a9a9a; }
/* the accent flips a touch warmer so it stays hot on the dark ground */
html[data-tdoc-theme="dark"] .wrap svg .d-acc-stroke { stroke:#ff6a4d; }
html[data-tdoc-theme="dark"] .wrap svg .d-acc-text   { fill:#ff8a6d; }
```

Do **not** put a fill class on a shape filled by a `<pattern>` (`fill="url(#…)"`)
— that would override the pattern; instead flip the `<rect>`/`<circle>` *inside*
the pattern (they are ordinary SVG elements a class can target). Never drop the
diagram because the surface changed — draw it on-theme.

## Reach for

- **`.tag`** / `<code>` inline for every identifier, flag, metric value, or config key.
- **`.metric`** for a standalone number; group several in a row.
- **`.callout`** at most once or twice — the accent loses force if repeated.

## Visuals are content-driven, never dictated by the style

**This style's diagram vocabulary works for ANY diagram type** — a pipeline, an
architecture, a flow, context bars, a chart. The style is the visual
*treatment*, never a limit on which visuals appear. Draw diagrams on-theme
(they flip with the doc via the role classes above): light — `#fafafa` fills,
`#ccc`/`#0a0a0a` strokes; dark — `#242424` fills, `#5c5c5c` strokes; the
`#ff4b2e`/`#ff6a4d` accent on the highlighted node; mono labels.

This style says how a visual is *colored and treated* — it never decides
whether a doc has one. A diagram, chart, table, image, or none: that follows
the content. If the doc has one, draw it in this palette; if it has none, the
style does not invent one. No style here requires, forbids, or limits any
kind of visual.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Keep the title and headings the doc would have in any style. Style
tables explicitly in both modes (they do not inherit a safe default). Link
generously.
