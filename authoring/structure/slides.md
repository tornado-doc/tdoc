# Slides

Read this whenever the doc is a deck (`<section data-tdoc-slide>` pages). The
house style is built for reading a long page; a deck built from it looks like
a wireframe: text crowded at the top of each card, the bottom half empty, no
emphasis. A deck is designed page by page.

## Three ways a deck is read

| Where | What the reader sees | What it asks of you |
|---|---|---|
| **Present** | One card at a time, 16:9, scaled to the screen | Everything fits inside the 16:9 box |
| **Browse, desktop** | Cards in a column, 16:9, about 960px wide | Same as Present |
| **Browse, phone** | Cards as wide as the phone (about 350px); the reader lets each card grow taller than 16:9 so it can be scrolled like a page | The card must reflow: columns stack, text stays readable |

Design for all three. A slide that only works as a scaled-down 16:9 picture
leaves 5px text on a phone.

## The frame

```html
<section class="slide" data-tdoc-slide data-tdoc-artifact="Slide 3: the wait">
  <div class="inner">
    <div class="top"><span class="tag">Guest journey</span><span>Shoji</span></div>
    <div class="body"> … the one idea of this slide … </div>
    <div class="foot"><span>Source: …</span><span>03 / 10</span></div>
  </div>
</section>
```

```css
.slide { container-type:inline-size; aspect-ratio:16/9; position:relative; overflow:hidden; }
.inner { position:absolute; inset:0; display:flex; flex-direction:column; padding:4.2cqw 5.2cqw 3.4cqw; }
.body  { flex:1; display:flex; flex-direction:column; justify-content:center; min-height:0; }
.slide h2 { font-size:max(4.2cqw, 24px); }
.slide p, .slide li { font-size:max(1.75cqw, 15px); }
.slide small, .foot { font-size:max(1.1cqw, 12px); }

/* Phone: the card is narrow. Let it grow and stack. */
@container (max-width: 640px) {
  .inner { position:static; }
  .cols  { grid-template-columns:1fr !important; }
}
```

- Size type in `cqw` so the slide scales with its card, and give every size a
  `px` floor with `max()` so it stays readable on a phone. At the 960px layout
  width the `cqw` value wins; on a phone the floor wins.
- Lay out with flex and grid in normal flow. **No absolute positioning of
  content** — it cannot reflow. The only absolute element is `.inner`, and the
  container query releases it on a narrow card.
- Put side-by-side content in a grid (`.cols`) that the container query turns
  into one column.
- `.body` fills the card and centres its content vertically. The bottom half of
  a card is never empty.

## Design rules

1. **One idea, one main visual per slide.** A big number, a chart, a
   before/after pair, a timeline, a quote. The headline says the conclusion;
   the visual proves it.
2. **One accent colour** for the whole deck, used for the word or number that
   matters on each slide. Everything else is ink and muted grey.
3. **Dark cover, section and closing slides**, light content slides. The change
   of background is how the reader feels the structure.
4. **Fill the card.** Headline at least `4cqw`; a headline number `9–12cqw`.
   If a slide looks sparse, make the visual bigger, not the margins.
5. **Footers carry sources and page numbers**, small and muted, so the body
   does not have to.
6. Keep each slide's content inside its 16:9 box at the desktop width — Present
   cuts off anything that spills.

## Layouts

Pick per slide; do not use the same layout twice in a row.

| Layout | Use for | Shape |
|---|---|---|
| **Cover** | First slide | Dark; large two-line headline with the accent on the key phrase; one-line subtitle; optional chips |
| **Big number** | A finding with a number | One or two numbers at `10cqw`, a short label under each, a bar showing the split |
| **Compare** | Two views, before/after, A vs B | Two columns, a thin rule or `≠` between them; on a phone they stack |
| **Steps** | A process or journey | 3–5 numbered nodes on a line; on a phone the line turns vertical |
| **Timeline** | What happened, when | A horizontal track with time stamps; the key moment in the accent |
| **Quote** | A customer's words | Large quote, attribution in the footer |
| **Split** | Two modes of one thing | Card cut in half, light and dark; stacks on a phone |
| **Closing** | Recommendation, next step | Dark; numbered actions, each one line |

## Check before publishing

Render the deck at 1280px and 390px wide (the preview helper in
`$SKILL_DIR/authoring/structure/components.md`, or Playwright) and look at every slide:

- 1280px: nothing spills out of a card, nothing crowds the top while the
  bottom is empty.
- 390px: no text under about 12px, columns stacked, nothing cut off.

Fix and re-render before publishing.
