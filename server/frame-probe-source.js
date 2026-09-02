const fs = require('fs');
const path = require('path');

// The injected frame script is markdown input rules + the probe, one nonce.
// Local serve, the worker bundle, and test harnesses all have to agree.
module.exports = function frameProbeSource() {
  return fs.readFileSync(path.join(__dirname, 'edit-markdown.js'), 'utf8')
    + '\n'
    + fs.readFileSync(path.join(__dirname, 'frame-probe.js'), 'utf8');
};
