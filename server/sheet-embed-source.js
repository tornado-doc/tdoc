'use strict';
// Sheet embeds on the server: shared/sheet-query.mjs, shared/sheet-embed.mjs
// and shared/sheet-embed-data.mjs as one plain script that sets
// globalThis.TdocSheetEmbed. bin/tdoc-bundle and the worker test harness
// inline it into the worker (Workers allow no eval); server/server.js runs
// it once at start. /api/embed/sheet answers with TdocSheetEmbed.payload, and
// /sheet-embed.js serves TdocSheetEmbed.viewerJs (the in-frame viewer).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { moduleObject } = require('./sheets-source');

// The in-frame viewer as served at /sheet-embed.js: the sheet query (tag
// colours, value parsing), the reference rules, then the viewer, in one
// function scope. The probe carries only server/sheet-embed-loader.js.
function sheetEmbedViewerSource() {
  return '(function () {\n'
    + moduleObject('SheetQuery', 'shared/sheet-query.mjs')
    + moduleObject('SheetEmbedRef', 'shared/sheet-embed.mjs')
    + fs.readFileSync(path.join(__dirname, 'sheet-embed-viewer.js'), 'utf8')
    + '\n})();\n';
}
// Content hash: the loader asks for /sheet-embed.js?v=<this>, so the file can
// be cached for a year and a new release is a new URL.
function sheetEmbedViewerVersion(source = sheetEmbedViewerSource()) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
}
function sheetEmbedLoaderSource() {
  return fs.readFileSync(path.join(__dirname, 'sheet-embed-loader.js'), 'utf8').replace('__TDOC_SHEET_EMBED_VERSION__', sheetEmbedViewerVersion());
}

function sheetEmbedSource() {
  const viewer = sheetEmbedViewerSource();
  return '(function () {\n'
    + moduleObject('SheetQuery', 'shared/sheet-query.mjs')
    + moduleObject('SheetEmbedRef', 'shared/sheet-embed.mjs')
    + moduleObject('SheetEmbedData', 'shared/sheet-embed-data.mjs')
    + 'globalThis.TdocSheetEmbed = {\n'
    + '  refFromQuery: SheetEmbedRef.embedRefFromQuery,\n'
    + '  sheetHref: SheetEmbedRef.embedSheetHref,\n'
    + '  maxRows: SheetEmbedRef.EMBED_MAX_ROWS,\n'
    + '  maxColumns: SheetEmbedRef.EMBED_MAX_COLUMNS,\n'
    + '  payload: function (html, ref) { return SheetEmbedData.embedPayload(html, ref, SheetQuery, { maxRows: SheetEmbedRef.EMBED_MAX_ROWS, maxColumns: SheetEmbedRef.EMBED_MAX_COLUMNS }); },\n'
    + '  viewerJs: ' + JSON.stringify(viewer) + ',\n'
    + '  viewerVersion: ' + JSON.stringify(sheetEmbedViewerVersion(viewer)) + ',\n'
    + '};\n'
    + '})();\n';
}

// For node (server/server.js, tests): run the source once and hand back the API.
function loadSheetEmbed() {
  if (!globalThis.TdocSheetEmbed) new Function(sheetEmbedSource())();
  return globalThis.TdocSheetEmbed;
}

module.exports = { sheetEmbedSource, loadSheetEmbed, sheetEmbedViewerSource, sheetEmbedViewerVersion, sheetEmbedLoaderSource };
