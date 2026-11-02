# diagrams — SVG blocks you copy, adapt, and can trust to render

`visuals.md` decides **which** picture the data wants. `components.md` says what
the parts are. This file is the missing third thing: **working SVG you can paste
and edit**, already sized to the reading column and already avoiding the ways
hand-built figures go wrong.

Nothing here is a new component vocabulary. Every block is made of the parts
`components.md` already names — frames, label chips, arrows, bands — and is
coloured by whichever `style/` entry the doc picked. Take one, change the words,
change the box count. If none fits, build your own and keep the four rules.

## The four rules that make a figure render

**1. `viewBox="0 0 672 H"`. Always 672 wide.** The reading column is 720px with
24px of padding, so 672 is what a figure actually gets. At 672 the figure renders
1:1 — a 12px label is 12px. Author at 900 and the browser squeezes it to 672:
every label shrinks to ~9px and the figure looks cheap for no reason anyone can
name. Set the height to whatever the drawing needs; only the width is fixed.

**2. A label must fit the space you put it in.** This is the defect that gets
shipped most often, because it is invisible in the source. A caption centred
between two boxes 114px apart, holding 160px of text, sits **on top of both
boxes**. Before writing a between-boxes label, subtract: gap = next box's `x`
minus this box's `x + width`. At `font-size:11.5` a CJK glyph is ~12px and a
Latin character ~6px. Over budget → shorten it, or stack it on two lines above
the arrow.

**3. Render it and look at it.** Not the source — the picture. A figure can be
valid SVG, pass every check, and still have a leader line through a word.

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=800,2400 \
  --screenshot=/tmp/fig.png --virtual-time-budget=5000 \
  "file://$HOME/tdocs/<slug>/v1/index.html"
```

**4. Zoom before you "fix" anything.** A downscaled screenshot will lie to you
about arrowheads, about `②` vs `③`, about whether two rules touch. Crop the
suspect region and enlarge it (`sips -c H W --cropOffset Y X`, then `-Z 600`)
before changing the source. More figures have been broken by correcting a defect
that was only in the thumbnail than by the original mistake.

## Wrapping

Put every figure in a frame so it scrolls on a phone instead of overflowing, and
tag it so a reader can comment on the picture as one object:

```html
<div class="diagram-box" data-tdoc-artifact data-tdoc-aid="unique-id">
  <svg viewBox="0 0 672 220" role="img" aria-label="one sentence, what it shows">…</svg>
  <p class="cap">What the reader should take away — not a restatement of the labels.</p>
</div>
```

`role="img"` plus `aria-label` is the whole accessibility story for a figure: a
screen reader gets the sentence, not sixty disconnected `<text>` nodes.

## The arrow marker

Define it once per figure. `auto-start-reverse` means the head points along the
path, so you never hand-rotate anything:

```html
<defs>
  <marker id="a" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
  </marker>
</defs>
```

The head lands on the path's **last** vertex. `M 300 80 L 300 140` points down;
reverse the coordinates to point up. Put `marker-end="url(#a)"` on the group and
every path in it gets one.

## Block 1 — flow chain

Steps that happen in order. Three across fits comfortably; four is tight; five
wants two rows.

```html
<svg viewBox="0 0 672 132" role="img" aria-label="Three steps in order">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
    orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
  <g font-size="13" text-anchor="middle">
    <rect x="16"  y="40" width="176" height="52" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="104" y="62">First</text>
    <text x="104" y="79" font-size="11.5" opacity="0.65">what it does</text>

    <rect x="248" y="40" width="176" height="52" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="336" y="62">Second</text>
    <text x="336" y="79" font-size="11.5" opacity="0.65">what it does</text>

    <rect x="480" y="40" width="176" height="52" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="568" y="62">Third</text>
    <text x="568" y="79" font-size="11.5" opacity="0.65">what it does</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#a)">
    <path d="M192 66 L242 66"/>
    <path d="M424 66 L474 66"/>
  </g>
  <g font-size="11.5" text-anchor="middle" opacity="0.7">
    <text x="217" y="58">verb</text>
    <text x="449" y="58">verb</text>
  </g>
</svg>
```

The gaps here are 56px — enough for a short verb and nothing more. Rule 2.

## Block 2 — cycle with a return edge

A chain that loops: the last state falls back to the first when something
happens. The return path runs **below** the boxes so it crosses nothing.

Add this to Block 1 — **and grow the viewBox height to 150 when you do**. The
path drops to y=120 and its label sits at y=136, so the 132 that Block 1 ships
with would clip the label off. Growing the height is part of adding the edge,
not an afterthought:

```html
<!-- viewBox="0 0 672 150" -->
<g stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#a)">
  <path d="M568 92 L568 120 L104 120 L104 98"/>
</g>
<text x="336" y="136" font-size="11.5" text-anchor="middle">what sends it back</text>
```

Keep the return label on its own line under the path. Between the boxes there is
no room for it — that is rule 2 again.

## Block 3 — layered stack

For "these are the same thing at different distances" — surfaces, caches, tiers.
Order them top to bottom and say what each one answers.

```html
<svg viewBox="0 0 672 180" role="img" aria-label="Four layers, nearest first">
  <g font-size="12.5">
    <rect x="16" y="14"  width="640" height="36" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="30" y="31" font-weight="600">Layer one</text>
    <text x="30" y="45" font-size="11.5" opacity="0.65">what it answers</text>
    <text x="642" y="36" text-anchor="end" font-size="11" opacity="0.65">cheap</text>
    <!-- repeat at y=60, 106, 152; drop stroke-width to 1.5 and dash the ones
         that are further away -->
  </g>
</svg>
```

Weight carries the ranking: solid and heavy near the reader, thin or dashed
further off. Do not use colour for this — the styles own colour.

## Block 4 — an orthogonal axis

When one dimension is **not** a step in the main sequence, do not draw it in the
chain. Put it in a detached dashed band underneath and say so:

```html
<rect x="16" y="200" width="640" height="40" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.6"/>
<text x="336" y="218" font-size="12" text-anchor="middle" opacity="0.75">Another axis: …</text>
<text x="336" y="234" font-size="12" text-anchor="middle" opacity="0.6">where it shows, where it does not</text>
```

The dashes and the gap do the work: readers stop looking for an arrow into it.

## Block 5 — evidence status

For anything investigative: mark **what is checked** apart from **what is
supposed**. A figure that quietly presents an inference as a fact is the most
expensive mistake in this file, because it is the one a reader cannot catch.

Put the marker inside each box, in words, not as a colour alone:

```html
<text x="294" y="34" text-anchor="end" font-size="10" font-weight="700">VERIFIED</text>
<text x="642" y="34" text-anchor="end" font-size="10" font-weight="700">INFERRED</text>
```

and pair the figure with a table that carries the basis, so the claim and its
evidence travel together:

| Claim | Status | Basis |
|---|---|---|
| … | verified | where you checked it |
| … | inferred | what makes it the most economical reading |

Colour may reinforce the split; it must never be the only carrier of it.

## Block 6 — 16:9 share card

When the figure will be screenshotted and posted, give it 16:9 so nothing is
cropped: `viewBox="0 0 672 378"`. Inside that budget, at arm's length on a
phone, roughly: one headline (~30px), four boxes of two lines each, one
conclusion band, one red band. More than that and it stops being readable at the
size it will actually be seen.

Put the single hardest sentence in its own band at the bottom, visually apart.
A reader who takes one line away should take that one.
