# authoring/

The parts tdoc composes a doc from, and how they fit together. Read by the
agent at generation time, not by the reader.

These are **references, not a pipeline.** An agent that already has a house
voice and a design system — through `bin/tdoc-new` — is composing with tdoc,
and takes what is useful here or none of it. The invariants that keep a doc
working at all are a separate, much shorter list, enforced by
`bin/tdoc-validate-template`: no author JavaScript in the host, one content
root, the reserved `tdoc-*` names, a viewport meta, a body background. Those
are MUST. Everything in this directory is what tdoc reaches for when nobody
has said otherwise.

Four slots, separate because they answer different questions:

| Slot | Question it answers | Who decides |
|---|---|---|
| `voice.md` | How does the prose read? | Nobody picks "sound like AI" — it applies by default |
| `visuals.md` | Which component fits this data? | The data |
| `structure/components.md` | What is that component, structurally? | Fixed across styles — that is what makes a style swappable. The list is open |
| `style/` | What does that component look like? | **The agent picks the entry that fits the content** |

The last two are the axis that matters: a stat tile is the same stat tile in
`paper` and in `technical`, and switching between them changes how it reads,
never what it is. A style that starts inventing components, or a component
that hardcodes a colour, has broken that split.

## voice.md is a floor, not an option

Nobody picks "make it sound like AI." So voice is not a template a user
browses and selects — it applies to every doc, and the user never sees a
switch for it. `/tdoc new` and `/tdoc edit` both read it before writing
HTML.

This matters more for tdoc than for a hand-written site: the whole product
generates prose with a model, so the AI-slop failure mode is the house
default unless something pushes back on it.

## Where the opinion lives, and what it can override

Three layers express taste, and only one of them is enforced:

| Layer | Where | Strength |
|---|---|---|
| Defaults | `server/reader.css`, baked into every document at creation | `:where()` zero-specificity — the author wins every property they name, property by property |
| Recommendation | this directory | Prose and CSS the agent may take or leave |
| Contract | `bin/tdoc-validate-template` | The only MUST, and only for what breaks rendering |

The validator prints house-style deviations as **notes** and creates the
document anyway; `--strict` is how a caller asks for conformance to be
enforced. So a doc that brings its own design system is composing with tdoc,
not fighting it — which is the point of the zero-specificity defaults.

Precedence, when they disagree: **the user's own words, then the document's
declared style, then what this directory recommends, then the defaults.**

- **style/** — visual register: type, color, density, measure. Four entries
  ship (`default`, `technical`, `editorial`, `paper`); the agent picks the one
  that fits the content.
- **structure/** — `components.md` says what the parts are. Section skeletons
  are deliberately not prescribed: the agent picks the shape from the prompt.

## Before writing CSS, write the plan

Three lines, then build to them. Deciding the palette and the type pairing up
front is what separates a designed page from one that accumulates rules as it
goes — and it is cheap, because it is three lines.

- **Color** — 4–6 named values. Name the role, not the hex: `ink`, `rule`,
  `muted`, `surface`, `accent`.
- **Type** — at least two roles: a display face, a body face, and a utility
  face for captions or data when the content has any.
- **Layout** — one or two sentences on how the page is organised.

Then follow it. A rule that is not in the plan is a rule to question.

## The looks to avoid

Not "have taste" — a named list, because a named list is actionable and
"have taste" is not. When nothing in the prompt points at one of these, do not
spend the freedom on it:

- warm cream ground with a serif display and a terracotta accent
- near-black with a single acid-green or vermilion pop
- a purple-to-blue gradient hero on white
- emoji as section markers
- everything centered
- a rounded card with an accent bar down its left edge, repeated down the page
- numbered eyebrows (01 / 02 / 03) on content that is not a sequence

If the user asks for one of these, they get it — their words win. This list is
about where an unguided default lands.

## Vendored upstream

`vendor/no-ai-slop.md` is a verbatim copy of the `no-ai-slop` skill by
Peter Yang (MIT), pinned at `d30eddb9e04562234f2070b5ee63ca4649d9a05e`.

Content sha256 of that file: `16719efd6dc6fe5978be7f6db41a474ca246970e5014acc057e29d7bfbd63b0e`

Kept verbatim so `test/authoring.test.js` can detect drift against
upstream. tdoc-specific adaptation lives in `voice.md` instead, never by
editing the vendored copy.

To update: re-copy from https://github.com/petergyang/no-ai-slop, update
the pin above, and re-read `voice.md` for rules that need adjusting.
