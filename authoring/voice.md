# Voice — required for every generated doc

**Read this before writing doc HTML.** Applies to `/tdoc new` and to every
regeneration in `/tdoc edit`. There is no opt-out and no user-facing switch.

The full rule set is `vendor/no-ai-slop.md` (no-ai-slop by Peter Yang, MIT).
Read it. This file only records how it applies to tdoc, because tdoc
differs from the drafts that skill was written for in two ways.

## No bullshit. Keep it efficient.

Above every specific rule below, this is the stance: say the thing, then
stop. Every sentence carries a fact, a mechanism, a number, or a judgment the
reader can act on. If a sentence would survive being deleted, delete it.
Don't pad to sound thorough, don't restate the point in different words, and
don't warm up before getting to it. A shorter doc that a reader finishes
beats a longer one they skim. This holds for every doc, by default — there is
no version of a tdoc doc that is exempt from it.

## Apply at generation, not as a cleanup pass

Upstream is written as an editor: a human pastes a draft, it gets fixed.
tdoc has no draft — the agent is writing the prose in the first place. So
these are constraints on what you write, not a second pass over what you
already wrote. Do not generate slop and then clean it.

Never ask the reader to paste a draft, and never emit a "What changed"
section into a doc. Those upstream behaviors belong to the editing flow,
not to generation.

## What the rules govern, and what they must not touch

They govern prose: headings, paragraphs, list items, captions, callouts,
table cell text, and any narration around a figure.

They must not rewrite:

- code inside `<pre>` / `<code>`, including comments and string literals
- identifiers, API names, CLI flags, file paths, error strings
- quoted material — if the doc quotes a person, an issue, a log line, or a
  commit message, the quote is evidence and stays verbatim, slop or not
- data: table values, axis labels, legends, numbers
- text inside SVG that labels a diagram part rather than narrating it

A rule that improves a sentence will corrupt an error string. When a span
is a name, a value, or a quotation, leave it alone.

## Whose voice is being preserved

Upstream spends much of its length protecting a writer's personal voice:
their bluntness, humor, hedges, digressions. A generated doc has no such
writer, so that half has no object and cannot be followed literally.

It does have an anchor: **the user's own prompt.** When the user's request
carries specific wording, a stance, a metaphor, or a level of bluntness,
that is the voice to carry into the doc. Prefer their nouns over synonyms
you find more elegant. If they were blunt, do not make the doc diplomatic.

Absent any signal, default to plain and direct rather than inventing a
personality.

## The failures that actually show up in generated docs

The whole upstream list applies. These are the ones a model reaches for
hardest when generating from a prompt, so they are worth naming twice:

- **Binary contrasts.** "It's not X, it's Y." State Y.
- **Faux-insight setups.** "What most people miss," "here's the thing."
- **Colon reveals.** A noun phrase, a colon, a dramatic lowercase reveal.
- **Importance puffery.** Telling the reader a fact is pivotal or vital
  instead of giving them the fact and letting them judge.
- **Interpretive metadiscourse.** "This distinction matters." If it does,
  the surrounding prose already showed it.
- **Trailing `-ing` clauses that fake analysis.** "..., highlighting the
  team's commitment to quality."
- **Portability test.** If a sentence could move unchanged to another
  company or product, it is filler. Replace it with a fact, a mechanism, a
  number, or a judgment specific to this subject.

Banned words and phrases: see the lists in `vendor/no-ai-slop.md`. They are
the authority; do not maintain a second copy here.

## When a rule fights the document

Correctness wins over voice. If following a rule would make a technical
statement wrong, ambiguous, or unsearchable, keep the accurate wording.
Prose rules never justify changing what the doc claims.
