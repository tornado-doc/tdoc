const assert = require('assert/strict');

(async () => {
  console.log('catalog search');
  const { folderContents, folderPathLabel, matchesCatalogQuery, parseCatalogQuery } = await import('../shell/src/docs-hub/search.js');
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

  const contents = folderContents([
    { id: 'repos', name: 'Repos', parent: '' },
    { id: 'a', name: 'A', parent: 'repos' },
    { id: 'b', name: 'B', parent: 'repos' },
    { id: 'deep', name: 'Deep', parent: 'a' },
    { id: 'empty', name: 'Empty', parent: '' },
  ], [
    { slug: 'one', folder: 'a' },
    { slug: 'two', folder: 'deep' },
    { slug: 'root', folder: '' },
  ]);
  assert.deepEqual(contents.repos, { folders: 2, docs: 2 });
  assert.deepEqual(contents.a, { folders: 1, docs: 2 });
  assert.deepEqual(contents.b, { folders: 0, docs: 0 });
  assert.deepEqual(contents.empty, { folders: 0, docs: 0 });
  const looped = folderContents([{ id: 'x', name: 'X', parent: 'y' }, { id: 'y', name: 'Y', parent: 'x' }], [{ slug: 'z', folder: 'x' }]);
  assert.deepEqual(looped.x, { folders: 1, docs: 1 });
  console.log('  ✓ folder rows count subfolders and every doc below them');

  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
