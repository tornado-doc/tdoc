# technical — the engineering-blog style (opens dark-first)

A `judgmentlabs.ai`-flavored engineering-blog look: a system sans, mono for
identifiers, one sparing red-orange accent. It **opens dark**, which in tdoc
means one specific thing — read the next section before writing any CSS.

## How tdoc dark mode works — author LIGHT, the overlay inverts

**tdoc has no per-doc dark palette. Dark mode is a whole-page invert.** The
overlay darkens by painting the page and applying, on `html[data-tdoc-theme="dark"]`,
`filter: invert(1) hue-rotate(180deg)` (the Dark Reader trick). One transform
flips the author CSS, the diagrams, the chrome — everything — as a unit.
`hue-rotate` keeps hues roughly true; photos/video/canvas/iframe are inverted a
second time so they stay true-color.

The consequence is the rule that governs this whole style:

> **Author the doc in LIGHT only. Never write a dark rule.** A
> `html[data-tdoc-theme="dark"]` or `@media (prefers-color-scheme: dark)` block
> that sets dark colors gets **inverted back to light** — so your "dark mode"
> renders light. (This is exactly the bug that made the technical doc show
> white in dark mode: it shipped a hand-built dark palette, and the invert
> undid it.) Style the light look well; the dark look is its clean inverse,
> for free.

Because the invert changes painted pixels and not computed values, you cannot
verify dark mode with `getComputedStyle` — it will report the light values.
**Verify dark mode from a screenshot** (or your eyes), not from computed style.

## Open dark-first

Put `data-tdoc-default-theme="dark"` on the `<html>` tag. With no saved
preference, the overlay opens the doc with the invert already applied, so a
first-time reader sees the dark engineering-blog look; the bar's sun/moon
button still flips it to the plain light version and remembers the choice.

```html
<html lang="en" data-tdoc-default-theme="dark">
```

## Typography (this style sets it)

Judgment Labs uses "Untitled Sans"; a system sans stands in at the same
metrics. h1/h2 set family AND color explicitly (the overlay colors headings).

```
body  16px / 26px   system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
h1    36px / 500 / -0.9px
h2    24px / 500
mono  ui-monospace, "SF Mono", Menlo, monospace   (theirs is "DM Mono")
```

## The light palette (this is the ONLY palette — the invert makes the dark one)

| Element | Value |
|---|---|
| ground | `#ffffff` |
| body text | `rgba(10,10,10,.92)` |
| headings | `#0a0a0a` |
| muted / links | `#737373` |
| code / table cell | `#f0f0f0` / `#f5f5f5` |
| accent (rule, one highlighted node) | `#ff4b2e` |

## CSS

```css
/* LIGHT ONLY. No html[data-tdoc-theme="dark"], no @media prefers-color-scheme.
   Dark is the overlay's invert of everything below. */
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
```

## Diagrams — draw them light; they invert with the page

Draw the diagram in ink on a white field: dark strokes/labels (`#0a0a0a`),
light node fills (`#fafafa`), the `#ff4b2e` accent on the one highlighted node.
An **inline `<svg>` inverts with the page**, so an ink-on-white figure becomes
light-on-dark — correct — in dark mode with no extra work. Do not give the SVG
its own dark colors (they would invert to light).

Only `img`/`video`/`canvas`/`iframe` are restored to true color by the overlay.
If a `<canvas>` or `<iframe>` is a *drawing* (a chart, a simulation) that should
darken with the page rather than glow as a white slab, mark it
`data-tdoc-dark="invert"` so it inverts with everything else.

## Visuals are content-driven, never dictated by the style

The style is a *treatment* — a system sans, mono identifiers, one red accent,
ink-on-white diagrams — never a limit on which visuals a doc has. A pipeline,
an architecture, a flow, context bars, a bar chart, a timeline, a matrix: draw
whatever the content needs, in this light palette, and let the invert give the
dark version.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Default output language is English. Keep the title and headings the
doc would have in any style. Link generously.
