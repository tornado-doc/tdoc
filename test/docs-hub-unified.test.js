// The personal and team catalogs are one UI, not two implementations that
// happen to look alike today. Browser behavior for the shared rows/toolbar is
// covered in ui.test.js; these assertions keep the composition shared.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const hub = fs.readFileSync(path.join(root, 'shell/src/docs-hub.jsx'), 'utf8');
const teams = fs.readFileSync(path.join(root, 'shell/src/docs-hub/teams.jsx'), 'utf8');
const rows = fs.readFileSync(path.join(root, 'shell/src/docs-hub/rows.jsx'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
const local = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');

let pass = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  pass += 1;
  console.log(`  ✓ ${message}`);
};

console.log('My docs and team spaces share one catalog');
ok((hub.match(/<DocsToolbar\b/g) || []).length === 2,
  'personal and team spaces render the same DocsToolbar component');
ok(hub.includes('<DocList\n              docs={hub.shownDocs}') && teams.includes('<DocList'),
  'personal and team spaces render the same DocList component');
ok(hub.includes("${doc.title} ${doc.slug} ${doc.excerpt || ''}")
  && fs.readFileSync(path.join(root, 'shell/src/hooks/use-docs-hub.js'), 'utf8').includes("${doc.title} ${doc.slug} ${doc.excerpt || ''}"),
  'both spaces search title, slug, and preview');
ok(rows.includes('className="doc-preview-excerpt"') && rows.includes('className="doc-preview-image"'),
  'the shared row renders cached excerpt and image previews');
ok(worker.includes('const rowPreview = (row) =>') && local.includes('preview.excerpt'),
  'hosted and local catalogs expose preview metadata without reading document content');

console.log(`\n${pass} passed, 0 failed`);
