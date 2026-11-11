'use strict';
// The sheets viewer as served at /sheets-viewer.js: the shared pure modules
// (shared/sheet-query.mjs, shared/sheet-markup.mjs, shared/doc-type.mjs -- the
// sheet-only rule My docs labels by -- and shared/sheet-rules.mjs, with its
// panels in server/sheets-rules-ui.js) each wrapped as a
// plain object (their `export`s become its properties), then the in-frame
// viewer (server/sheets-viewer.js), all in one function scope. The probe
// carries only server/sheets-loader.js, which fetches this file when a doc
// actually holds a sheet, so docs without one pay nothing for it.
// Local serve, the worker bundle and the test harnesses all build it here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function moduleObject(globalName, rel) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (/^\s*import\b/m.test(src)) throw new Error(`${rel} must not import: it is inlined into the frame`);
  const names = [];
  src = src.replace(/^export (const|let|function|class) ([A-Za-z_$][\w$]*)/gm, (m, kw, id) => { names.push(id); return `${kw} ${id}`; });
  if (/^\s*export\b/m.test(src)) throw new Error(`${rel}: only "export const|function|class name" can be inlined`);
  return `var ${globalName} = (function () {\n'use strict';\n${src}\nreturn { ${names.join(', ')} };\n})();\n`;
}

function sheetsViewerSource() {
  return '(function () {\n'
    + moduleObject('SheetQuery', 'shared/sheet-query.mjs')
    + moduleObject('SheetMarkup', 'shared/sheet-markup.mjs')
    + moduleObject('DocType', 'shared/doc-type.mjs')
    + moduleObject('SheetRules', 'shared/sheet-rules.mjs')
    + fs.readFileSync(path.join(__dirname, 'sheets-rules-ui.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, 'sheets-viewer.js'), 'utf8')
    + '\n})();\n';
}

// Content hash: the loader asks for /sheets-viewer.js?v=<this>, so the file
// can be cached for a year and a new release is a new URL.
function sheetsViewerVersion(source = sheetsViewerSource()) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
}

module.exports = { sheetsViewerSource, sheetsViewerVersion, moduleObject };
