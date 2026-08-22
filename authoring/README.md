# authoring/

What every generated doc must go through, and where the optional
choices live. Read by the agent at generation time, not by the reader.

Three slots, deliberately separate because they answer different questions:

| Slot | Question it answers | Status |
|---|---|---|
| `voice.md` | How does the prose read? | **Always applied.** Not a choice. |
| `style/` | What does the page look like? | Empty — reserved. |
| `structure/` | Which sections does this kind of doc have? | Empty — reserved. |

## voice.md is a floor, not an option

Nobody picks "make it sound like AI." So voice is not a template a user
browses and selects — it applies to every doc, and the user never sees a
switch for it. `/tdoc new` and `/tdoc edit` both read it before writing
HTML.

This matters more for tdoc than for a hand-written site: the whole product
generates prose with a model, so the AI-slop failure mode is the house
default unless something pushes back on it.

## style/ and structure/ are empty on purpose

Both are reserved mount points. The directory layout and the way a doc
names its choice are settled here so adding entries later is additive,
but no entries ship yet.

- **style/** — visual register: type, color, density, measure. Author CSS
  always wins over the overlay (`:where()` zero-specificity), so a style
  entry can also break overlay chrome. Anything added here has to respect
  the "Author HTML compatibility contract" in `SKILL.md`.
- **structure/** — section skeletons per document kind. Default is empty,
  meaning the agent picks the shape from the prompt, exactly as today.

## Vendored upstream

`vendor/no-ai-slop.md` is a verbatim copy of the `no-ai-slop` skill by
Peter Yang (MIT), pinned at `d30eddb9e04562234f2070b5ee63ca4649d9a05e`.

Content sha256 of that file: `16719efd6dc6fe5978be7f6db41a474ca246970e5014acc057e29d7bfbd63b0e`

Kept verbatim so `test/authoring.test.js` can detect drift against
upstream. tdoc-specific adaptation lives in `voice.md` instead, never by
editing the vendored copy.

To update: re-copy from https://github.com/petergyang/no-ai-slop, update
the pin above, and re-read `voice.md` for rules that need adjusting.
