# style/ — visual register

A style entry answers "what does this page look like": which components a
doc reaches for, what the accent colors mean, and — the axis that most
separates styles — whether it overrides the overlay's reading typography or
trusts it.

## Entries

| Entry | When it applies |
|---|---|
| `default.md` | **When a doc selects nothing.** Stark sans — pure white/black, one sans, oversized tight-tracked headline, OpenAI-style diagram vocabulary (frames, mono labels, dot/hatch textures). OpenAI-index aesthetic via open fonts (no brand assets). |
| `technical.md` | When named. Cold engineering-blog register — mono, neutral greys, one sparing red-orange accent. From `judgmentlabs.ai`. |
| `editorial.md` | When named. Long-read essay — warm paper, serif body, electric-blue accent, colored inline underlines. From `cognition.com`. The one entry that overrides typography (ground + body font only). |
| `paper.md` | When named. Warm serif long-read — off-white paper, open serif display + humanist sans, clay accent. Anthropic-blog aesthetic via open fonts (no brand assets). |

`default.md` is the house style — today every doc gets it. A future entry is
an *opt-out*, so it has to be different enough to be worth naming.

## The axis that matters most

A style either **trusts** the overlay's reading typography or **overrides**
it. The default trusts it, which is why it stays calm and collides with the
overlay the least. A style that overrides typography (a presentation, a
landing page) takes on the full weight of the "Author HTML compatibility
contract" below, because it is now fighting the overlay for the same
properties.

## Constraints any entry must satisfy

The overlay injects its defaults at `:where()` zero specificity, so author
CSS always wins. That makes a style entry powerful and dangerous in the same
stroke: it can also break the overlay's own chrome. tdoc has already shipped
that bug once (#96 — `padding: 0 24px` on the content root wiped the
overlay's top reading space).

An entry must obey the "Author HTML compatibility contract" in `SKILL.md`:

- no `margin: 0 auto` and no top-level horizontal `padding` on the content
  container — the overlay owns those margins
- no global `button:hover` — it overrides the overlay's Comment control
- nothing `position: fixed` at the top — that band is the overlay's bar
- no page footer — the overlay injects its own
- `tdoc-*` classes and ids stay reserved

Rule of thumb: styles carried by left rules, pale fills, chips, type scale,
and restrained color adapt cleanly. Styles carried by full-bleed hero
sections, sticky navigation, card shadows, or an edge-to-edge background
fight the overlay.

## Adding an entry

An entry is a markdown file naming its components, its palette, and the
judgment calls they do not cover. Adding one is not just a new file:
`SKILL.md` has to learn that the name is selectable, and
`test/authoring.test.js` asserts the two stay in sync. A style the agent
cannot be told to use is a file nobody reads.

## Dark mode

`SKILL.md` currently states light mode only, and dark mode is in flight
(`feat/dark-mode-switch`). Any entry needs a dark palette, or an explicit
note that it is light-only and why.
