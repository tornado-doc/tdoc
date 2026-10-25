# Preview renderer assets

`resvg.mjs` and `resvg.wasm` are from `@resvg/resvg-wasm` 2.6.2 (MPL-2.0 in `MPL-2.0.txt`, https://github.com/yisibl/resvg-js). They are embedded by `bin/tdoc-bundle` because self-hosted tdoc publishes without a `node_modules` directory.

`NotoSansSC-Regular.ttf` and `NotoSansSC-Bold.ttf` are static weight subsets of Google Fonts' Noto Sans SC variable font, generated from GB2312 level-one characters, punctuation, and ASCII. They are licensed under OFL-1.1 in `OFL.txt`; the subsets use the renamed internal family `tdoc Preview CJK`. Source: https://github.com/google/fonts/tree/main/ofl/notosanssc . Characters outside the subset may not render in a generated card. Update the subsets when needed.

The upload stores a validated, versioned SVG source in R2 and sends a small job to the `tdoc-previews` Queue after the document metadata commits. The Queue consumer renders the PNG and records `pending`, `ready:custom`, `ready:auto`, or `failed` in META. A pending image returns 503 with `Retry-After` for at most five minutes; after that, a missing image serves the static logo. The image endpoint checks the document's current visibility on every read.

The shared SVG validator limits painted shapes, painted rectangle area, local paint references, geometry length, and stroke width. It rejects repeating gradients and very small radial gradients to keep rendering within a bounded Worker CPU budget. The browser's document Save uses the same Queue path and carries an authored SVG into the next version when no replacement is supplied. Cloudflare Preview URLs cannot consume Queues, so PR previews intentionally show the logo fallback.
