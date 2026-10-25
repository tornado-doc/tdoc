const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

(async () => {
  const worker = await loadWorker({ previewRenderer: true });
  const env = makeEnv(worker.CommentsStore, { TDOC_UPLOAD_TOKEN: 'admin-test-token' });
  const pending = [];
  const queued = [];
  env.PREVIEW_QUEUE = { async send(job) { queued.push(job); } };
  const drain = async () => {
    await Promise.all(pending.splice(0));
    while (queued.length) {
      const job = queued.shift();
      await worker.default.queue({ messages: [{ body: job, ack() {}, retry() {} }] }, env);
    }
  };
  const call = async (path, opts = {}) => {
    const response = await worker.default.fetch(req(path, opts), env, { waitUntil(task) { pending.push(task); } });
    await drain();
    return response;
  };
  const cardUrl = async (slug) => JSON.parse(await env.META.get(`meta:${slug}`)).preview.image;
  const doc = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Revenue grew 42% this quarter.</p></body></html>`;
  const meta = (title, visibility, version) => ({ title, access: { visibility }, versions: Array.from({ length: version }, (_, i) => ({ n: i + 1 })) });
  const png = (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const first = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'preview-test', version: 1, html: doc('季度增长分析报告'), meta: meta('季度增长分析报告', 'public', 1) } });
  assert.equal(first.status, 200, await first.text());
  const firstCardUrl = await cardUrl('preview-test');
  assert.match(firstCardUrl, /\/preview\/v1-[a-f0-9]{12}\.png$/);
  const card1 = await call(firstCardUrl);
  assert.equal(card1.status, 200);
  const bytes1 = Buffer.from(await card1.arrayBuffer());
  assert.ok(png(bytes1));
  assert.ok(bytes1.length > 5_000);
  if (process.env.TDOC_PREVIEW_SAMPLES_DIR) {
    fs.mkdirSync(process.env.TDOC_PREVIEW_SAMPLES_DIR, { recursive: true });
    fs.writeFileSync(`${process.env.TDOC_PREVIEW_SAMPLES_DIR}/zh-card.png`, bytes1);
  }
  const page1 = await call('/d/preview-test/v/1');
  assert.ok((await page1.text()).includes(`https://tdoc.dev${firstCardUrl}`));

  const authored = fs.readFileSync('authoring/preview-card.svg', 'utf8')
    .replace('Your report title', 'Q3 revenue growth')
    .replace('One clear conclusion from the report.', 'Revenue grew 42% this quarter.');
  const second = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'preview-test', version: 2, html: doc('Q3 revenue growth'), meta: meta('Q3 revenue growth', 'public', 2), preview_svg: authored } });
  assert.equal(second.status, 200, await second.text());
  const secondCardUrl = await cardUrl('preview-test');
  const card2 = await call(secondCardUrl);
  assert.equal(card2.status, 200);
  const bytes2 = Buffer.from(await card2.arrayBuffer());
  assert.ok(png(bytes2));
  if (process.env.TDOC_PREVIEW_SAMPLES_DIR) fs.writeFileSync(`${process.env.TDOC_PREVIEW_SAMPLES_DIR}/en-card.png`, bytes2);
  const page2 = await call('/d/preview-test/v/2');
  assert.ok((await page2.text()).includes(`https://tdoc.dev${secondCardUrl}`));
  assert.equal((await call(firstCardUrl)).status, 404,
    'an older card follows the document history visibility');

  const sameVersionNewTitle = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'preview-test', version: 2, replace: true, html: doc('Renamed report'), meta: meta('Renamed report', 'public', 2), preview_svg: authored.replace('Q3 revenue growth', 'Updated report') } });
  assert.equal(sameVersionNewTitle.status, 200, await sameVersionNewTitle.text());
  const replacedCardUrl = await cardUrl('preview-test');
  assert.notEqual(replacedCardUrl, secondCardUrl, 'replacing v2 with new SVG must use a new crawler URL');
  const withoutSvg = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'preview-test', version: 2, replace: true, html: doc('Renamed again'), meta: meta('Renamed again', 'public', 2) } });
  assert.equal(withoutSvg.status, 200, await withoutSvg.text());
  assert.equal(await cardUrl('preview-test'), replacedCardUrl, 'replace without SVG keeps its authored card');
  const nextWithoutSvg = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'preview-test', version: 3, html: doc('Third version'), meta: meta('Third version', 'public', 3) } });
  assert.equal(nextWithoutSvg.status, 200, await nextWithoutSvg.text());
  const carriedUrl = await cardUrl('preview-test');
  assert.match(carriedUrl, /\/preview\/v3-[a-f0-9]{12}\.png$/);
  assert.equal(await env.META.get(`preview-status:preview-test:v3:${carriedUrl.match(/-([a-f0-9]{12})\.png$/)[1]}`), 'ready:custom');
  assert.ok(png(Buffer.from(await (await call(carriedUrl)).arrayBuffer())));

  for (const [slug, title, filename] of [
    ['mixed-card', '2026 Q3 中文增长报告', 'mixed-card.png'],
    ['emoji-card', '🚀 Launch results', 'emoji-card.png'],
  ]) {
    const upload = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug, version: 1, html: doc(title), meta: meta(title, 'public', 1) } });
    assert.equal(upload.status, 200, await upload.text());
    const image = await call(await cardUrl(slug));
    assert.equal(image.status, 200);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.ok(png(bytes) && bytes.length > 5_000);
    if (process.env.TDOC_PREVIEW_SAMPLES_DIR) fs.writeFileSync(`${process.env.TDOC_PREVIEW_SAMPLES_DIR}/${filename}`, bytes);
  }

  const invalid = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'malicious-card', version: 1, html: doc('Bad'), meta: meta('Bad', 'public', 1), preview_svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><script>alert(1)</script></svg>' } });
  assert.equal(invalid.status, 200);
  assert.equal((await invalid.json()).preview_warning, 'unsafe_preview_svg');
  assert.ok(await env.DOCS.head('docs/malicious-card/v1/index.html'));
  const malformed = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'broken-card', version: 1, html: doc('Broken'), meta: meta('Broken', 'public', 1), preview_svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><text>oops</svg>' } });
  assert.equal(malformed.status, 200);
  assert.equal((await malformed.json()).preview_warning, 'invalid_preview_svg');
  assert.ok(await env.DOCS.head('docs/broken-card/v1/index.html'));
  const expensive = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">' + '<rect opacity=".5"/>'.repeat(2600) + '</svg>';
  const capped = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'expensive-card', version: 1, html: doc('Safe fallback'), meta: meta('Safe fallback', 'public', 1), preview_svg: expensive } });
  assert.equal(capped.status, 200);
  assert.equal((await capped.json()).preview_warning, 'unsafe_preview_svg');
  assert.ok(png(Buffer.from(await (await call(await cardUrl('expensive-card'))).arrayBuffer())));
  const { previewNormalizeSvg } = require('../server/preview/validate-svg.js');
  const gradient = '\uFEFF<?xml version="1.0"?><!-- authored --><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630"><defs><linearGradient id="ink"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="1200" height="630" style="fill:url(#ink)"/></svg>';
  assert.equal(previewNormalizeSvg(gradient).error, undefined, 'CLI and Worker accept safe local gradients and XML prelude');
  assert.equal(previewNormalizeSvg(gradient.replace('url(#ink)', 'url(https://example.com/a)')).error, 'unsafe_preview_svg');
  assert.equal(previewNormalizeSvg(gradient.replace('fill:url(#ink)', 'fill-opacity:.5;fill:url(#ink)')).error, undefined);
  assert.equal(previewNormalizeSvg(gradient.replace('<defs>', '<!-- inside drawing --><defs>')).error, 'unsafe_preview_svg');
  assert.equal(previewNormalizeSvg(gradient.replace('<defs>', '<!-- split --><script></script><defs>')).error, 'unsafe_preview_svg');
  const costlyGradient = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><radialGradient id="g" r="0.01" spreadMethod="reflect"><stop offset="0" stop-color="#fff"/></radialGradient></defs>' + '<rect width="1200" height="630" fill="url(#g)" stroke-width="2000"/>'.repeat(90) + '</svg>';
  assert.equal(previewNormalizeSvg(costlyGradient).error, 'unsafe_preview_svg', 'full-canvas gradient/stroke work is bounded');
  assert.equal(previewNormalizeSvg(gradient.replace('style="fill:url(#ink)"', 'style="stroke-width:2000;fill:url(#ink)"')).error, 'unsafe_preview_svg');
  assert.equal(previewNormalizeSvg(gradient.replace('width="1200" height="630" style=', 'width="1e9" height="630" style=')).error, 'unsafe_preview_svg');
  assert.equal(previewNormalizeSvg(costlyGradient.replace('r="0.01" spreadMethod="reflect"', 'r=".01"')).error, 'unsafe_preview_svg');
  const owner = await issue(worker.default, env, 'preview-owner');
  const stranger = await issue(worker.default, env, 'preview-stranger');
  assert.equal((await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'owned-card', version: 1, html: doc('Owned'), meta: meta('Owned', 'public', 1), preview_svg: authored } })).status, 200);
  const saved = await call('/api/doc/versions', { method: 'POST', cookie: owner.cookie, body: { slug: 'owned-card', baseVersion: 1, html: doc('Owned and edited') } });
  assert.equal(saved.status, 200, await saved.text());
  assert.match(await cardUrl('owned-card'), /\/preview\/v2-[a-f0-9]{12}\.png$/, 'browser edits keep the authored card');
  assert.ok(png(Buffer.from(await (await call(await cardUrl('owned-card'))).arrayBuffer())));
  const raceUpload = await worker.default.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'race-card', version: 1, html: doc('Queued original'), meta: meta('Queued original', 'public', 1), preview_svg: authored } }), env, { waitUntil(task) { pending.push(task); } });
  assert.equal(raceUpload.status, 200);
  await Promise.all(pending.splice(0));
  const raceSave = await worker.default.fetch(req('/api/doc/versions', { method: 'POST', cookie: owner.cookie, body: { slug: 'race-card', baseVersion: 1, html: doc('Edited before original render') } }), env, {});
  assert.equal(raceSave.status, 200, await raceSave.text());
  const raceUrl = await cardUrl('race-card');
  assert.match(raceUrl, /\/preview\/v2-[a-f0-9]{12}\.png$/);
  assert.equal(queued.length, 2, 'both versions are independently queued');
  queued.reverse();
  await drain();
  assert.ok(png(Buffer.from(await (await call(raceUrl)).arrayBuffer())), 'new version keeps the card even when old render finishes last');
  const deniedUpload = await call('/api/upload', { method: 'POST', token: stranger.token, body: { slug: 'owned-card', version: 2, html: doc('Stolen'), meta: meta('Stolen', 'public', 2), preview_svg: expensive } });
  assert.equal(deniedUpload.status, 403, 'write access is checked before preview validation or rendering');
  const originalPut = env.DOCS.put.bind(env.DOCS);
  let failedRenders = 0;
  env.DOCS.put = async (key, value, options) => {
    if (key.startsWith('docs/failure-card/') && key.endsWith('.png')) { failedRenders++; throw new Error('simulated preview store failure'); }
    return originalPut(key, value, options);
  };
  try {
    const failedCardBody = { slug: 'failure-card', version: 1, html: doc('Failure cache'), meta: meta('Failure cache', 'public', 1), preview_svg: authored };
    assert.equal((await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: failedCardBody })).status, 200);
    assert.equal((await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { ...failedCardBody, replace: true } })).status, 200);
    assert.equal(failedRenders, 1, 'a failed render is negatively cached for repeat uploads');
    assert.equal((await call(await cardUrl('failure-card'))).status, 200, 'missing card reads fall back to the logo');
    const failedMeta = JSON.parse(await env.META.get('meta:failure-card'));
    assert.equal(failedMeta.preview.image_custom, false, 'a failed authored render is never marked custom');
  } finally { env.DOCS.put = originalPut; }
  const uploaded = await worker.default.fetch(req('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'pending-card', version: 1, html: doc('Pending card'), meta: meta('Pending card', 'public', 1) } }), env, { waitUntil(task) { pending.push(task); } });
  assert.equal(uploaded.status, 200);
  await Promise.all(pending.splice(0));
  assert.equal(queued.length, 1, 'upload only enqueues rendering after the metadata commit');
  const pendingImage = await worker.default.fetch(req(await cardUrl('pending-card')), env);
  assert.equal(pendingImage.status, 503, 'a crawler should retry while the queue job is pending');
  assert.equal(pendingImage.headers.get('Retry-After'), '2');
  const pendingHash = (await cardUrl('pending-card')).match(/-([a-f0-9]{12})\.png$/)[1];
  const pendingStatusKey = `preview-status:pending-card:v1:${pendingHash}`;
  await env.META.delete(pendingStatusKey);
  assert.equal((await worker.default.fetch(req(await cardUrl('pending-card')), env)).status, 200,
    'an expired pending marker falls back to a PNG instead of a permanent 503');
  await env.META.put(pendingStatusKey, 'pending', { expirationTtl: 300 });
  await drain();
  assert.ok(png(Buffer.from(await (await call(await cardUrl('pending-card'))).arrayBuffer())));

  const previewQueue = env.PREVIEW_QUEUE;
  delete env.PREVIEW_QUEUE;
  try {
    const noQueue = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'no-queue-card', version: 1, html: doc('Publish anyway'), meta: meta('Publish anyway', 'public', 1) } });
    assert.equal(noQueue.status, 200, 'a missing queue binding cannot fail publishing');
    const fallback = await call(await cardUrl('no-queue-card'));
    assert.equal(fallback.status, 200, 'a missing queue binding serves the logo PNG');
    assert.ok(png(Buffer.from(await fallback.arrayBuffer())));
  } finally { env.PREVIEW_QUEUE = previewQueue; }

  const privateDoc = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'private-card', version: 1, html: doc('Secret title'), meta: meta('Secret title', 'private', 1) } });
  assert.equal(privateDoc.status, 200, await privateDoc.text());
  const privateMeta = JSON.parse(await env.META.get('meta:private-card'));
  assert.ok(privateMeta.preview.image.endsWith('.png'));
  const denied = await call(await cardUrl('private-card'));
  assert.equal(denied.status, 404);
  const unlisted = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'link-card', version: 1, html: doc('Link title'), meta: meta('Link title', 'unlisted', 1) } });
  assert.equal(unlisted.status, 200, await unlisted.text());
  const linkPage = await call('/d/link-card/v/1');
  const linkHtml = await linkPage.text();
  assert.ok(linkHtml.includes('https://tdoc.dev/tdoc_logo-v2.png'));
  assert.ok(!linkHtml.includes('/d/link-card/preview/v1-'));
  assert.ok(linkHtml.includes('A document shared on tdoc.'));
  assert.ok(!linkHtml.includes('property="og:title" content="Link title"'));
  assert.ok(linkHtml.includes('<title>Link title'), 'browser tab keeps the real title');
  assert.equal((await call(await cardUrl('link-card'))).status, 200);

  await env.META.put('meta:lazy-card', JSON.stringify(meta('Legacy report', 'public', 1)));
  await env.DOCS.put('docs/lazy-card/v1/index.html', doc('Legacy report'));
  const legacyPage = await call('/d/lazy-card/v/1');
  assert.ok((await legacyPage.text()).includes('https://tdoc.dev/tdoc_logo-v2.png'),
    'old docs keep a PNG for social crawlers until backfilled');
  const placeholder = await call('/preview-card-placeholder.svg');
  assert.equal(placeholder.status, 200);
  assert.ok((await placeholder.text()).includes('Document preview'));
  const lazy = await call('/d/lazy-card/preview/v1-000000000000.png');
  assert.equal(lazy.status, 404);
  assert.equal(JSON.parse(await env.META.get('meta:lazy-card')).preview, undefined,
    'GET must never write metadata from a stale read');

  await env.META.put('meta:old-card', JSON.stringify(meta('旧报告', 'public', 1)));
  await env.DOCS.put('docs/old-card/v1/index.html', doc('旧报告'));
  const dry = await call('/api/admin/preview-cards/backfill', { method: 'POST', token: 'admin-test-token', body: { limit: 10 } });
  assert.equal(dry.status, 200);
  const dryData = await dry.json();
  assert.equal(dryData.dry_run, true);
  assert.equal(dryData.eligible, 2);
  assert.equal((await env.DOCS.list({ prefix: 'docs/old-card/v1/preview-' })).objects.length, 0);
  const applied = await call('/api/admin/preview-cards/backfill', { method: 'POST', token: 'admin-test-token', body: { apply: true, limit: 10 } });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).updated, 2);
  assert.ok((await cardUrl('old-card')).includes('/preview/v1-'));
  const changedAccess = JSON.parse(await env.META.get('meta:preview-test'));
  changedAccess.access.visibility = 'private';
  await env.META.put('meta:preview-test', JSON.stringify(changedAccess));
  assert.equal((await call(secondCardUrl)).status, 404,
    'a previously public card must close when its document becomes private');
  console.log('✓ authored and generated cards render to versioned PNGs; unsafe SVGs and private OG exposure are blocked');
})().catch((error) => { console.error(error); process.exit(1); });
