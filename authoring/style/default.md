# default — tdoc's own design system

**Applied when a doc selects no style, which today is every doc.**

Extracted from `tdoc.dev/d/tdoc-design-tokens/v/1`, the system already
running in tdoc's product chrome. Adopting it here makes documents and
product one system instead of two.

## Color

Nine tokens. Declare them on `:root` in the doc's `<style>` and reference
them by name; do not inline the hex values.

| Token | Value | Use |
|---|---|---|
| `--td-accent` | `#1652f0` | links, and the one primary button |
| `--td-accent-hover` | `#1245d0` | primary hover |
| `--td-ink` | `#111` | primary text |
| `--td-muted` | `#666` | secondary / meta text |
| `--td-line` | `#eee` | thin borders, dividers |
| `--td-surface` | `#f7f7f7` | subtle fills |
| `--td-danger` | `#b42318` | destructive only |
| `--td-danger-tint` | `#fdeceb` | danger hover-fill |
| `--td-ok` | `#087443` | success / confirmed |

There is no token for decorative color, because there is no decorative
color. A doc that needs a categorical palette (a chart with six series) is
the one case to add local values — keep them out of `--td-*`, which names
roles rather than colors.

## Typography

System fonts only. No web fonts, no `@font-face`, nothing to load.

```
body      15px / 1.6      system-ui, -apple-system, "Segoe UI", Roboto, sans-serif
h1        29px / 700 / -.01em letter-spacing
meta      12px            --td-muted
mono      ui-monospace, "SF Mono", Menlo, monospace
measure   max-width: 720px
```

Section labels — the small uppercase kind above a group — are `12px`,
weight `700`, `letter-spacing: .06em`, uppercase, in `--td-muted`.

**This is denser than the overlay's injected default** (body 17px, h1 34px).
That is intended: it is the same scale the product chrome uses. Do not
split the difference, and do not restore 17px for "long" docs — one scale
or the system is pointless.

## Principles

These decide the cases the token table does not cover.

- **Restraint.** The Notion / Linear / Google Docs lineage. When in doubt,
  remove. Less is more.
- **Ration the accent.** Blue is only for links and the single primary
  action in a view. Everything else is ink and muted greys. Two blue
  buttons on one screen means one of them is not primary.
- **Quiet the dangerous.** Destructive actions are low-frequency, so the
  less visible the better. Tuck them behind a `⋯`, grey at rest, and show
  red only once revealed.
- **Chrome never fights content.** Controls must not compete with the
  reading surface. A list of docs should look like a list, not a control
  panel.
- **No framework.** system-ui plus a dozen CSS variables.

## Staying inside the overlay's contract

This style is safe by construction — it is carried by type scale, spacing,
and restrained color, never by full-bleed backgrounds, sticky headers, or
card shadows. Keeping it that way is a requirement, not an accident. The
"Author HTML compatibility contract" in `SKILL.md` still governs:

- no `margin: 0 auto` and no top-level horizontal padding on `.wrap` —
  the overlay owns those margins
- no global `button:hover` — scope it, or it overrides the overlay's
  Comment control
- nothing `position: fixed` at the top, no page footer
- `tdoc-*` names stay reserved

## Dark mode

Light only. Every value here assumes a white ground. Dark mode is in
flight (`feat/dark-mode-switch`); when it lands, this file needs a second
palette rather than a filter over this one.
