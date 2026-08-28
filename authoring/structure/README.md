# structure/ — the parts, and the shapes they go in

`components.md` is the component library: what a stat tile, a comparison
matrix, a container frame or a label chip *is*, with no colour on it. Every
`style/` entry gives those same parts its own treatment, which is what makes
a style swappable rather than a rewrite.

**Section skeletons are still an empty slot.** A structure entry would answer
"which sections does this kind of doc have":
a post-mortem is timeline, blast radius, root cause, action items; a PRD
is problem, user, non-goals, success measures.

With this directory empty, the agent derives the shape from the prompt,
exactly as it does today. Nothing changes until entries are added, and
adding one must stay additive.

## Structure is the half that saves work

Recorded here so the reasoning is not lost: across the first 39 docs
written with tdoc, the strongest signal was repetition of a single kind.
Six separate docs across five near-duplicate slugs were all the same
launch post, restarted from scratch each time. Other kinds show the cost
as version depth instead — an explainer at v19, a user-feedback report at
v10.

Neither cost is a styling problem. Both are "what should this contain and
in what order," which is what an entry here would answer.

## Not a fill-in-the-blanks form

An entry should describe what a section is *for* and what makes it good,
so the agent can judge whether the material fits. A doc that emits empty
headings the writer then has to fill in is worse than no template.
