// The authoring guides (authoring/**/*.md) as { 'voice.md': '...', ... }.
// bin/tdoc-bundle and the test harness inline this into the worker, which
// serves them to AI apps as MCP resources (tdoc://authoring/<path>).
const fs = require('fs');
const path = require('path');

function loadAuthoringGuides(root = path.join(__dirname, '..')) {
  const base = path.join(root, 'authoring');
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(base);
  return out;
}

module.exports = { loadAuthoringGuides };
