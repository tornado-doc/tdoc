const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

(async () => {
  const worker = await loadWorker({ previewRenderer: true });
  const env = makeEnv(worker.CommentsStore, { TDOC_UPLOAD_TOKEN: 'admin-test-token' });
  const call = (path, opts = {}) => worker.default.fetch(req(path, opts), env, { waitUntil() {} });
  const doc = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Revenue grew 42% this quarter.</p></body></html>`;
  const meta = (title, visibility, version) => ({ title, access: { visibility }, versions: Array.from({ length: version }, (_, i) => ({ n: i + 1 })) });
  const png = (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const first = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'preview-test', version: 1, html: doc('季度增长分析报告'), meta: meta('季度增长分析报告', 'public', 1) } });
  assert.equal(first.status, 200, await first.text());
  const card1 = await call('/d/preview-test/preview/v1.png');
  assert.equal(card1.status, 200);
  const bytes1 = Buffer.from(await card1.arrayBuffer());
  assert.ok(png(bytes1));
  assert.ok(bytes1.length > 5_000);
  if (process.env.TDOC_PREVIEW_SAMPLES_DIR) {
    fs.mkdirSync(process.env.TDOC_PREVIEW_SAMPLES_DIR, { recursive: true });
    fs.writeFileSync(`${process.env.TDOC_PREVIEW_SAMPLES_DIR}/zh-card.png`, bytes1);
  }
  const page1 = await call('/d/preview-test/v/1');
  assert.ok((await page1.text()).includes('https://tdoc.dev/d/preview-test/preview/v1.png'));

  const authored = fs.readFileSync('authoring/preview-card.svg', 'utf8')
    .replace('Your report title', 'Q3 revenue growth')
    .replace('One clear conclusion from the report.', 'Revenue grew 42% this quarter.');
  const second = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'preview-test', version: 2, html: doc('Q3 revenue growth'), meta: meta('Q3 revenue growth', 'public', 2), preview_svg: authored } });
  assert.equal(second.status, 200, await second.text());
  const card2 = await call('/d/preview-test/preview/v2.png');
  assert.equal(card2.status, 200);
  const bytes2 = Buffer.from(await card2.arrayBuffer());
  assert.ok(png(bytes2));
  if (process.env.TDOC_PREVIEW_SAMPLES_DIR) fs.writeFileSync(`${process.env.TDOC_PREVIEW_SAMPLES_DIR}/en-card.png`, bytes2);
  const page2 = await call('/d/preview-test/v/2');
  assert.ok((await page2.text()).includes('https://tdoc.dev/d/preview-test/preview/v2.png'));
  assert.equal((await call('/d/preview-test/preview/v1.png')).status, 404,
    'an older card follows the document history visibility');

  for (const [slug, title, filename] of [
    ['mixed-card', '2026 Q3 中文增长报告', 'mixed-card.png'],
    ['emoji-card', '🚀 Launch results', 'emoji-card.png'],
  ]) {
    const upload = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug, version: 1, html: doc(title), meta: meta(title, 'public', 1) } });
    assert.equal(upload.status, 200, await upload.text());
    const image = await call(`/d/${slug}/preview/v1.png`);
    assert.equal(image.status, 200);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.ok(png(bytes) && bytes.length > 5_000);
    if (process.env.TDOC_PREVIEW_SAMPLES_DIR) fs.writeFileSync(`${process.env.TDOC_PREVIEW_SAMPLES_DIR}/${filename}`, bytes);
  }

  const invalid = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'malicious-card', version: 1, html: doc('Bad'), meta: meta('Bad', 'public', 1), preview_svg: '<svg width="1200" height="630"><script>alert(1)</script></svg>' } });
  assert.equal(invalid.status, 400);
  assert.equal(await env.DOCS.head('docs/malicious-card/v1/index.html'), null);
  const malformed = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'broken-card', version: 1, html: doc('Broken'), meta: meta('Broken', 'public', 1), preview_svg: '<svg width="1200" height="630"><text>oops</svg>' } });
  assert.equal(malformed.status, 400);
  assert.equal(await env.DOCS.head('docs/broken-card/v1/index.html'), null);

  const privateDoc = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'private-card', version: 1, html: doc('Secret title'), meta: meta('Secret title', 'private', 1) } });
  assert.equal(privateDoc.status, 200, await privateDoc.text());
  const privateMeta = JSON.parse(await env.META.get('meta:private-card'));
  assert.ok(privateMeta.preview.image.endsWith('.png'));
  const denied = await call('/d/private-card/preview/v1.png');
  assert.equal(denied.status, 404);
  const unlisted = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'link-card', version: 1, html: doc('Link title'), meta: meta('Link title', 'unlisted', 1) } });
  assert.equal(unlisted.status, 200, await unlisted.text());
  const linkPage = await call('/d/link-card/v/1');
  const linkHtml = await linkPage.text();
  assert.ok(linkHtml.includes('https://tdoc.dev/tdoc_logo-v2.png'));
  assert.ok(!linkHtml.includes('/d/link-card/preview/v1.png'));
  assert.ok(linkHtml.includes('A document shared on tdoc.'));
  assert.ok(!linkHtml.includes('property="og:title" content="Link title"'));
  assert.equal((await call('/d/link-card/preview/v1.png')).status, 200);

  await env.META.put('meta:lazy-card', JSON.stringify(meta('Legacy report', 'public', 1)));
  await env.DOCS.put('docs/lazy-card/v1/index.html', doc('Legacy report'));
  const legacyPage = await call('/d/lazy-card/v/1');
  assert.ok((await legacyPage.text()).includes('https://tdoc.dev/tdoc_logo-v2.png'),
    'old docs keep a PNG for social crawlers until backfilled');
  const placeholder = await call('/preview-card-placeholder.svg');
  assert.equal(placeholder.status, 200);
  assert.ok((await placeholder.text()).includes('Document preview'));
  const lazy = await call('/d/lazy-card/preview/v1.png');
  assert.equal(lazy.status, 200);
  assert.ok(png(Buffer.from(await lazy.arrayBuffer())));
  assert.equal(JSON.parse(await env.META.get('meta:lazy-card')).preview.image_v, 1);

  await env.META.put('meta:old-card', JSON.stringify(meta('旧报告', 'public', 1)));
  await env.DOCS.put('docs/old-card/v1/index.html', doc('旧报告'));
  const dry = await call('/api/admin/preview-cards/backfill', { method: 'POST', token: 'admin-test-token', body: { limit: 10 } });
  assert.equal(dry.status, 200);
  const dryData = await dry.json();
  assert.equal(dryData.dry_run, true);
  assert.equal(dryData.eligible, 1);
  assert.equal(await env.DOCS.head('docs/old-card/v1/preview.png'), null);
  const applied = await call('/api/admin/preview-cards/backfill', { method: 'POST', token: 'admin-test-token', body: { apply: true, limit: 10 } });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).updated, 1);
  assert.ok(await env.DOCS.head('docs/old-card/v1/preview.png'));
  const changedAccess = JSON.parse(await env.META.get('meta:preview-test'));
  changedAccess.access.visibility = 'private';
  await env.META.put('meta:preview-test', JSON.stringify(changedAccess));
  assert.equal((await call('/d/preview-test/preview/v2.png')).status, 404,
    'a previously public card must close when its document becomes private');
  console.log('✓ authored and generated cards render to versioned PNGs; unsafe SVGs and private OG exposure are blocked');
})().catch((error) => { console.error(error); process.exit(1); });
