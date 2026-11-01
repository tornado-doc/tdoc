const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');
(async () => {
  const { parseDiagramScene } = await import(pathToFileURL(path.resolve('shell/src/document/excalidraw-scene.mjs')));
  const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'node', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }], files: {} };
  assert.equal(parseDiagramScene(JSON.stringify(scene)).elements[0].id, 'node');
  for (const bad of [null, '{}', '{', ' '.repeat(2_000_001), JSON.stringify({ ...scene, elements: [...scene.elements, ...scene.elements] }), JSON.stringify({ ...scene, elements: [{ ...scene.elements[0], x: null }] }), JSON.stringify({ ...scene, elements: [{ ...scene.elements[0], type: 'embeddable' }] })]) {
    assert.throws(() => parseDiagramScene(bad));
  }
  console.log('✓ diagram data accepts native shapes and rejects oversized, duplicate, malformed and embedded content');
  const mod = await loadWorker();
  const env = makeEnv(mod.CommentsStore, { TDOC_UPLOAD_TOKEN: 'test-only-token' });
  const ctx = { waitUntil() {} };
  const fixture = fs.readFileSync('test/fixtures/excalidraw/index.html', 'utf8');
  const response = await mod.default.fetch(req('/api/upload', { method: 'POST', token: 'test-only-token', body: { slug: 'diagram-test', version: 1, html: fixture, meta: { title: 'Diagram test', versions: [{ n: 1 }] } } }), env, ctx);
  assert.equal(response.status, 200, await response.text());
  const raw = await mod.default.fetch(req('/d/diagram-test/v/1/raw'), env, ctx);
  assert.equal(raw.status, 200);
  assert.ok((await raw.text()).includes('data-tdoc-excalidraw='));
  const exported = await mod.default.fetch(req('/d/diagram-test/v/1/export?download=1'), env, ctx);
  assert.equal(exported.status, 200);
  const document = await exported.text();
  assert.ok(document.includes('data-tdoc-excalidraw='));
  assert.ok(document.includes('data-tdoc-diagram-snapshot'));
  const denied = await mod.default.fetch(req('/api/doc/versions', { method: 'POST', body: { slug: 'diagram-test', baseVersion: 1, html: fixture } }), env, ctx);
  assert.equal(denied.status, 401);
  console.log('✓ published upload/raw/download retain editable source + snapshot; anonymous version writes remain denied');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
