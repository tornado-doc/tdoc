# Preview renderer assets

`resvg.mjs` and `resvg.wasm` are from `@resvg/resvg-wasm` 2.6.2 (MPL-2.0 in `MPL-2.0.txt`, https://github.com/yisibl/resvg-js). They are embedded by `bin/tdoc-bundle` because self-hosted tdoc publishes without a `node_modules` directory.

`NotoSansSC-Regular.ttf` and `NotoSansSC-Bold.ttf` are static weight subsets of Google Fonts' Noto Sans SC variable font, generated from GB2312 level-one characters, punctuation, and ASCII. They are licensed under OFL-1.1 in `OFL.txt`; the subsets use the renamed internal family `tdoc Preview CJK`. Source: https://github.com/google/fonts/tree/main/ofl/notosanssc . Characters outside the subset may not render in a generated card. Update the subsets when needed.
