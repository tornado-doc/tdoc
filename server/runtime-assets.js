'use strict';

const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, 'runtime');

function loadRuntimeAssets() {
  const manifestPath = path.join(RUNTIME_DIR, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Shell runtime is not built. Run npm run build:shell (${error.message})`);
  }

  const entry = Object.values(manifest).find((item) => item && item.isEntry);
  if (!entry || !entry.file) throw new Error('Shell runtime manifest has no entry');
  const cssFile = Array.isArray(entry.css) ? entry.css[0] : null;
  if (!cssFile) throw new Error('Shell runtime manifest has no CSS asset');

  return {
    js: { path: `/${entry.file}`, file: path.join(RUNTIME_DIR, entry.file), type: 'text/javascript; charset=utf-8' },
    css: { path: `/${cssFile}`, file: path.join(RUNTIME_DIR, cssFile), type: 'text/css; charset=utf-8' },
  };
}

module.exports = { loadRuntimeAssets };
