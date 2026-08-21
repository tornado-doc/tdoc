# style/ — visual register

**Empty. Reserved.**

A style entry answers "what does this page look like": type family and
size ramp, text and background color, line height and spacing, measure,
heading-to-body contrast, how code and quotes are treated, whether there
is any ornament.

Until an entry exists here, docs use the overlay's default reading
template and nothing needs to be chosen.

## Constraints any entry must satisfy

The overlay injects its defaults at `:where()` zero specificity, so author
CSS always wins. That makes a style entry powerful and dangerous in the
same stroke: it can also break the overlay's own chrome. tdoc has already
shipped that bug once (#96 — `padding: 0 24px` on the content root wiped
the overlay's top reading space).

An entry here must obey the "Author HTML compatibility contract" in
`SKILL.md`. The parts a visual style is most likely to violate:

- no `margin: 0 auto` and no top-level horizontal `padding` on the content
  container — the overlay owns those margins
- no global `button:hover` — it overrides the overlay's Comment control
- nothing `position: fixed` at the top — that band is the overlay's bar
- no page footer — the overlay injects its own
- `tdoc-*` classes and ids stay reserved

Rule of thumb when evaluating a look to adapt: styles carried by type,
scale, spacing, and restrained color adapt cleanly. Styles carried by
full-bleed hero sections, sticky navigation, card shadows, or an edge-to-edge
background color fight the overlay.

## Dark mode

`SKILL.md` currently states light mode only, and dark mode is in flight
(`feat/dark-mode-switch`). Any entry added here needs a dark palette, or
an explicit note that it is light-only and why.
