# editorial — the long-read blog style

The register of a considered engineering essay: warm paper, a serif reading
voice, one electric accent, and colored underlines that mark terms inline.
Extracted from `cognition.com/blog/making-fable-cheaper-than-opus` and
adapted to fit the overlay.

**This is the one style that DOES touch typography — deliberately, and only
two properties.** It sets a warm ground and a serif body, because that pair
*is* the style; without them it isn't this. Everything else — heading scale,
measure, spacing — still comes from the overlay. Do not also override sizes.

## The two typographic moves, and no more

```css
/* warm paper ground + serif reading voice — the whole identity */
body { background:#f7f6f5; }
.wrap { font-family:"Iowan Old Style", Georgia, "Times New Roman", serif; }
```

That's it for typography. No custom `font-size`, no `max-width`, no heading
overrides. If you find yourself setting `h2 { font-size: … }`, stop — that is
the overlay's job and you are leaving this style.

## Components

```css
/* inline term underlines — the signature move. three hues, each a meaning */
.u-key  { border-bottom:2px solid #3a55f4; }   /* a defined term / the subject */
.u-good { border-bottom:2px solid #4ba181; }   /* a win, a saving, a result */
.u-warn { border-bottom:2px solid #cc7c5e; }   /* a cost, a caveat, a risk */

/* a pulled-aside block — electric-blue left rule on faint tint */
.aside { border-left:2px solid #3a55f4; background:#f2f5fa; padding:12px 16px; margin:16px 0; }

/* a result / good-news block */
.result { border-left:2px solid #4ba181; background:#f1f6f3; padding:12px 16px; margin:16px 0; }

/* wide diagram scrolls */
.diagram-box { max-width:100%; overflow-x:auto; margin:20px 0; }
```

The underlines are what make it recognizable: mark a term *in the sentence*
rather than pulling it into a box. `The <span class="u-good">40% cheaper</span>
result` reads better than a callout for a phrase.

## Palette

| Role | Value | Use |
|---|---|---|
| Ground | `#f7f6f5` warm off-white | the page |
| Ink | `#000` | serif body text |
| Accent | `#3a55f4` electric blue | the subject, asides, links |
| Good | `#4ba181` green | a win or result |
| Warn | `#cc7c5e` terracotta | a cost or caveat |

Three underline hues is the starting set, not a ceiling — add one if the
content has a fourth distinct kind of term. The look holds as long as each
hue keeps a consistent meaning across the doc.

## Reach for

- **`.u-key` / `.u-good` / `.u-warn`** inline, on the noun itself — the
  primary move. Underline the term, keep reading.
- **`.aside`** for a paragraph-long digression worth keeping but not in the
  main line.
- **`.result`** for the outcome the essay was building toward.

## Style is visual only

Governs how the page looks — never section numbering, language, tone, or
structure. Tables inherit the overlay's rounded-cell default. Link generously.

## Fits the overlay

The ground and serif are the only overrides; both sit at author level and do
not touch the overlay's chrome. Nothing full-bleed, sticky, or shadowed.
Light mode only — the warm ground is the point, and a dark variant would need
its own paper tone.
