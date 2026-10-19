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
ok(hub.includes('matchesCatalogQuery(doc, teamPathForDoc(doc), hub.query)')
  && fs.readFileSync(path.join(root, 'shell/src/hooks/use-docs-hub.js'), 'utf8').includes('matchesCatalogQuery(doc, folderPathLabel(doc.folder, folderById), query)'),
  'both spaces use the same all-folder field-aware search');
ok(rows.includes('className="doc-preview-excerpt"') && rows.includes('className="doc-preview-image"'),
  'the shared row renders cached excerpt and image previews');
ok(rows.includes('doc-card-preview') && hub.includes('CatalogLayoutToggle') && teams.includes('layout={layout}'),
  'personal and team catalogs share the persistent grid/list preview switch');
ok(hub.includes('doc.workspace_id === team.id') && worker.includes("workspace_id: row.meta && row.meta.workspace_id"),
  'Recent and Starred rows are scoped to the active workspace');
ok(worker.includes('const rowPreview = (row) =>') && local.includes('preview.excerpt'),
  'hosted and local catalogs expose preview metadata without reading document content');

console.log(`\n${pass} passed, 0 failed`);
