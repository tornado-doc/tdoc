const fs = require('fs');
const path = require('path');
const { sheetsViewerVersion } = require('./sheets-source');
const { sheetEmbedLoaderSource } = require('./sheet-embed-source');

// The injected frame script is markdown input rules + the probe, one nonce.
// Local serve, the worker bundle, and test harnesses all have to agree.
const selectionBundle = require('./selection-bundle.js');

// shared/slides-markup.mjs as a plain script for the frame: the slide kit's
// layouts and stylesheet, one definition for the starter deck (blank-deck.js)
// and the slides the editor adds. Same rules as selection-bundle.js: no
// imports, `export` on declarations only, gathered onto window.TdocSlideKit.
function slideKitBundle() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'slides-markup.mjs'), 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('slides-markup.mjs: no imports may be bundled for the frame');
  if (/^\s*export\s+(default|\{|\*)/m.test(src)) throw new Error('slides-markup.mjs: export declarations only');
  const names = [];
  const body = src.replace(/^export\s+(function|const)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => { names.push(name); return `${kind} ${name}`; });
  return `var TdocSlideKit = (function () {\n'use strict';\n${body}\nreturn { ${names.join(', ')} };\n})();\n`;
}

module.exports = function frameProbeSource() {
  return selectionBundle()
    + '\n'
    // The sheets loader goes first after the shared modules: it marks a sheet
    // page pending before the probe's first layout (see sheets-loader.js).
    + fs.readFileSync(path.join(__dirname, 'sheets-loader.js'), 'utf8').replace('__TDOC_SHEETS_VERSION__', sheetsViewerVersion())
    + '\n'
    // Sheet embeds: fetches the embed viewer only when the page has one.
    + sheetEmbedLoaderSource()
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'table-layout.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'edit-markdown.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'frame-probe.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'visual-viewer.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'slides-viewer.js'), 'utf8')
    + '\n'
    + slideKitBundle()
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'slides-edit.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'version-diff.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'frame-compare.js'), 'utf8');
};

module.exports.slideKitBundle = slideKitBundle;
