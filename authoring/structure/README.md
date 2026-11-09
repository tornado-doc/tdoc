# structure/ — the parts, and the shapes they go in

`components.md` is the component library: what a stat tile, a comparison
matrix, a container frame or a label chip *is*, with no colour on it. Every
`style/` entry gives those same parts its own treatment, which is what makes
a style swappable rather than a rewrite. It opens with the block model every
doc follows: plain blocks, six house blocks with fixed markup (stat tiles,
cards, note, collapsible, figure, diagram), and anything custom as one artifact
element.

Document shape is not kept here. Which sections a doc has is decided by the
prompt and the material, per doc.

`slides.md` and `sheets.md` are the two document shapes the reader draws
itself: a deck (`data-tdoc-slide`) and a spreadsheet (`data-tdoc-sheet`).
