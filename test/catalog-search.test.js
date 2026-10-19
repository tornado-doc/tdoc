const assert = require('assert/strict');

(async () => {
  console.log('catalog search');
  const { folderPathLabel, matchesCatalogQuery, parseCatalogQuery } = await import('../shell/src/docs-hub/search.js');
  const folders = new Map([
    ['research', { id: 'research', name: 'Research', parent: '' }],
    ['q4', { id: 'q4', name: 'Q4', parent: 'research' }],
  ]);
  const doc = { title: 'Revenue plan', slug: 'rev-plan', excerpt: 'Expansion in Japan', folder: 'q4' };
  const path = folderPathLabel(doc.folder, folders);

  assert.equal(path, 'Research › Q4');
  assert.equal(matchesCatalogQuery(doc, path, 'revenue'), true);
  assert.equal(matchesCatalogQuery(doc, path, 'japan'), true);
  assert.equal(matchesCatalogQuery(doc, path, 'research'), true);
  assert.equal(matchesCatalogQuery(doc, path, 'title:japan'), false);
  assert.equal(matchesCatalogQuery(doc, path, 'preview:japan'), true);
  assert.equal(matchesCatalogQuery(doc, path, 'path:q4 title:"revenue plan"'), true);
  assert.deepEqual(parseCatalogQuery('title:"revenue plan" slug:rev'), [
    { field: 'title', value: 'revenue plan' },
    { field: 'slug', value: 'rev' },
  ]);
  console.log('  ✓ plain search spans title, preview and nested path');
  console.log('  ✓ title, slug, preview and path prefixes narrow individual terms');
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
