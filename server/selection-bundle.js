const fs = require('fs');
const path = require('path');

// The shared selection modules (shell/src/comments/selection/) as one plain
// script for the doc frame, which takes no bundler at runtime: the local
// server and the worker bundle both run from the checkout. The modules are
// written for this: plain functions, `export` on declarations, relative
// imports of each other only. Concatenated in dependency order, imports
// dropped, exports gathered onto one object: window.TdocSelection.
const DIR = path.join(__dirname, '..', 'shell', 'src', 'comments', 'selection');
const FILES = [
  'anchors/container.js',
  'anchors/element.js',
  'anchors/region.js',
  'anchors/text-range.js',
  'anchors/registry.js',
  'pick-gesture.js',
];

module.exports = function selectionBundle() {
  const names = [];
  const body = FILES.map((file) => {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    if (/^\s*import\s+[^'"]*['"](?!\.)/m.test(src)) throw new Error(`${file}: only relative imports may be bundled for the frame`);
    if (/^\s*export\s+(default|\{|\*)/m.test(src)) throw new Error(`${file}: export declarations only`);
    return `// ── ${file}\n` + src
      .replace(/^\s*import\s[^;]*;\s*$/gm, '')
      .replace(/^export\s+(function|var|const|let)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => { names.push(name); return `${kind} ${name}`; });
  }).join('\n');
  return `var TdocSelection = (function () {\n'use strict';\n${body}\nreturn { ${names.join(', ')} };\n})();\n`;
};
