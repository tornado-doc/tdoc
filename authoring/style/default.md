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

## Tokens

A component — including one this file has never heard of — dresses itself from
these. That is what makes a component someone else wrote swap styles correctly:
it names tokens, not colours.

| Token | Value here |
|---|---|
| `ink` | `#0a0a0a` |
| `rule` | `#111` for a figure frame, `#e5e5e5` for a hairline divider |
| `muted` | `#555` |
| `surface` | `#f5f5f5` |
| `accent-fill` | `#f7d7d1` (pink) or `#dde7f9` (blue) — one per figure |
| `accent-stroke` | `#e0a99e` / `#a9c0ee`, matching the fill |
| `accent-text` | `#b3503c` / `#26407a`, matching the fill |
| `label-type` | uppercase mono, `~10.5px`, `letter-spacing:.04em` |

A texture is `accent-fill` with `accent-stroke` marks over it, drawn inside the
`<pattern>` tile rather than on top of white.

## Component treatment (the OpenAI-index look)

`structure/components.md` says what these parts are. This is what they look
like here — verified to render in tdoc. The register is thin black line on
white with one pastel accent, and it draws any figure the content asks for.

| Component | This style's treatment |
|---|---|
| Container frame | `stroke:#111; stroke-width:1.3`, square corners, no fill, no shadow |
| Label chip | Uppercase mono `~10.5px`, `letter-spacing:.04em`, in a `stroke-width:1` box, `rx:0–1` |
| Numbered group | Sans weight 600 title inside the frame's top-left corner |
| Description box | Sans `~11px` inside a thin box |
| Primary arrow | `stroke-width:1.2`, small round arrowhead, `#111` |
| Secondary arrow | The same, `stroke-dasharray:3 3` |
| Accent fill | Pink `fill:#f7d7d1 stroke:#e0a99e`, text `#b3503c`; or blue `fill:#dde7f9 stroke:#a9c0ee`, text `#26407a` |
| Textured variant | Dot over the pink for a live state; diagonal hatch over the blue for a transformed one |
| Stacked bar | Blue shades `#c4d4f5` / `#d4e0f8` / `#e8eefb` with `#a9c0ee` strokes and mono labels; a hatched segment marks a transformed part, a dashed baseline marks a limit |
| Table | `rule` hairline border, `rx:12` card; row rules in `rule`; header in `muted`, normal case, no fill |

Solid pastel is the base and the texture is the *variant*, not the fill. Put
the colour inside the pattern tile so the texture reads on top of it rather
than over white:

```
<pattern id="pdot" width="6" height="6" patternUnits="userSpaceOnUse">
  <rect width="6" height="6" fill="#f7d7d1"/>
  <circle cx="3" cy="3" r="1.05" fill="#e0a99e"/></pattern>
<pattern id="bhatch" width="7" height="7" patternUnits="userSpaceOnUse"
  patternTransform="rotate(45)"><rect width="7" height="7" fill="#dde7f9"/>
  <line x1="0" y1="0" x2="0" y2="7" stroke="#a9c0ee" stroke-width="1.5"/></pattern>
```

Keep it airy — generous white space between containers. Outside figures the
doc stays greyscale on white; the accent lives in the figures.

## Visuals are content-driven, never limited by the style

The table above colours whatever the content needs. It does not decide whether
a doc has a figure, nor which figure — `visuals.md` picks that from the data
and `structure/components.md` says what the part is. A doc with a bar chart, a
table, a photo, or nothing follows its content; this file only says how such a
thing looks in this register.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Tables take the treatment above. Link generously.
