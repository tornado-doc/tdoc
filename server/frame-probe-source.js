const fs = require('fs');
const path = require('path');
const { sheetsViewerVersion } = require('./sheets-source');

// The injected frame script is markdown input rules + the probe, one nonce.
// Local serve, the worker bundle, and test harnesses all have to agree.
module.exports = function frameProbeSource() {
  // The sheets loader goes first: it marks a sheet page pending before the
  // probe's first layout (see sheets-loader.js).
  return fs.readFileSync(path.join(__dirname, 'sheets-loader.js'), 'utf8').replace('__TDOC_SHEETS_VERSION__', sheetsViewerVersion())
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
    + fs.readFileSync(path.join(__dirname, 'version-diff.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'frame-compare.js'), 'utf8');
};
