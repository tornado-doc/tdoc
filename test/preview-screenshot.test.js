// A page screenshot as a doc version's preview card: strict PNG checks,
// write access, latest-version only, and precedence over SVG cards.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// A real, decodable RGB PNG; `shade` varies the bytes (and so the hash).
function makePng(width, height, { shade = 255, extra = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3, shade); row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...(extra ? [chunk('tEXt', Buffer.alloc(extra, 65))] : []),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  const worker = await loadWorker({ previewRenderer: true });
  const env = makeEnv(worker.CommentsStore, { TDOC_UPLOAD_TOKEN: 'admin-test-token' });
  const pending = [];
  const queued = [];
  env.PREVIEW_QUEUE = { async send(job) { queued.push(job); } };
  const drain = async () => {
    await Promise.all(pending.splice(0));
    while (queued.length) await worker.default.queue({ messages: [{ body: queued.shift(), ack() {}, retry() {} }] }, env);
  };
  const call = async (path, opts = {}) => {
    const response = await worker.default.fetch(req(path, opts), env, { waitUntil(task) { pending.push(task); } });
    await drain();
    return response;
  };
  const metaOf = async (slug) => JSON.parse(await env.META.get(`meta:${slug}`));
  const doc = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Revenue grew 42% this quarter.</p></body></html>`;
  const meta = (title, visibility, version) => ({ title, access: { visibility }, versions: Array.from({ length: version }, (_, i) => ({ n: i + 1 })) });
  const b64 = (buf) => buf.toString('base64');
  const owner = await issue(worker.default, env, 'shot-owner');
  const stranger = await issue(worker.default, env, 'shot-stranger');
  const upload = (token, slug, version, extra = {}) => call('/api/upload', { method: 'POST', token, body: { slug, version, html: doc(`${slug} v${version}`), meta: meta(`${slug} v${version}`, 'public', version), ...extra } });
  const post = (token, slug, body) => call(`/api/docs/${slug}/preview`, { method: 'POST', token, body });

  assert.equal((await upload(owner.token, 'shot-doc', 1)).status, 200);
  assert.equal((await upload(owner.token, 'shot-doc', 2)).status, 200);
  const templateCard = (await metaOf('shot-doc')).preview;
  assert.match(templateCard.image, /\/preview\/v2-[a-f0-9]{12}\.png$/);
  assert.notEqual(templateCard.image_source, 'screenshot');

  // ---- validation ----
  const good = makePng(1200, 630);
  const cases = [
    [{ version: 2, png_base64: b64(Buffer.from('GIF89a' + 'x'.repeat(200))) }, 400, 'invalid_preview_png', 'bad magic bytes'],
    [{ version: 2, png_base64: 'not base64 !!' }, 400, 'invalid_preview_png', 'not base64'],
    [{ version: 2 }, 400, 'invalid_preview_png', 'missing png'],
    [{ version: 2, png_base64: b64(makePng(800, 630)) }, 400, 'invalid_preview_dimensions', 'wrong width'],
    [{ version: 2, png_base64: b64(makePng(1200, 400)) }, 400, 'invalid_preview_dimensions', 'too short'],
    [{ version: 2, png_base64: b64(makePng(1200, 900)) }, 400, 'invalid_preview_dimensions', 'too tall'],
    [{ version: 2, png_base64: b64(good.subarray(0, good.length - 12)) }, 400, 'invalid_preview_png', 'truncated'],
    [{ version: 2, png_base64: b64(makePng(1200, 630, { extra: 420 * 1024 })) }, 413, 'preview_png_too_large', 'oversize'],
    [{ version: 0, png_base64: b64(good) }, 400, 'invalid_version', 'bad version'],
    [{ version: 9, png_base64: b64(good) }, 404, 'version_not_found', 'missing version'],
    [{ version: 1, png_base64: b64(good) }, 409, 'not_latest_version', 'older version'],
  ];
  for (const [body, status, error, label] of cases) {
    const r = await post(owner.token, 'shot-doc', body);
    const data = await r.json();
    assert.equal(r.status, status, `${label}: ${JSON.stringify(data)}`);
    assert.equal(data.error, error, label);
    if (status !== 404 || error !== 'version_not_found') assert.ok(data.message || error === 'invalid_version', `${label} explains itself`);
  }
  assert.deepEqual((await metaOf('shot-doc')).preview, templateCard, 'rejected screenshots change nothing');
  console.log('✓ bad magic, non-base64, wrong dimensions, truncation, >400KB, bad/missing/older version are refused');

  // ---- auth ----
  assert.equal((await post('', 'shot-doc', { version: 2, png_base64: b64(good) })).status, 401);
  assert.equal((await post('bogus-token', 'shot-doc', { version: 2, png_base64: b64(good) })).status, 401);
  const foreign = await post(stranger.token, 'shot-doc', { version: 2, png_base64: b64(good) });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'not_doc_owner');
  assert.equal((await post(owner.token, 'no-such-doc', { version: 1, png_base64: b64(good) })).status, 404);
  assert.deepEqual((await metaOf('shot-doc')).preview, templateCard);
  console.log('✓ only a credential that may publish the doc can set its screenshot');

  // ---- accepted ----
  const ok = await post(owner.token, 'shot-doc', { version: 2, png_base64: b64(good) });
  const okBody = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(okBody));
  const shot = (await metaOf('shot-doc')).preview;
  assert.equal(shot.image_source, 'screenshot');
  assert.equal(shot.image, okBody.image);
  assert.match(shot.image, /\/preview\/v2-[a-f0-9]{12}\.png$/);
  assert.notEqual(shot.image_hash, templateCard.image_hash);
  assert.equal(shot.description, templateCard.description, 'the words of the card are kept');
  const served = await call(shot.image);
  assert.equal(served.status, 200);
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(good), 'the PNG is stored and served byte for byte');
  assert.equal(queued.length, 0, 'a screenshot never goes through the render queue');
  const page = await (await call('/d/shot-doc')).text();
  assert.ok(page.includes(`https://tdoc.dev${shot.image}`), 'OG image is the screenshot');
  assert.ok(page.includes('name="twitter:card" content="summary_large_image"'));
  const me = await (await call('/api/me', { token: owner.token })).json();
  assert.equal(me.docs.find((row) => row.slug === 'shot-doc').image, shot.image, 'the hub shows the screenshot');
  console.log('✓ a valid 1200x630 PNG becomes the latest version card: R2, meta, OG tags and hub');

  // ---- access: the image follows the doc ----
  assert.equal((await post(owner.token, 'shot-doc', { version: 2, png_base64: b64(makePng(1200, 630, { shade: 10 })) })).status, 200);
  const privateShot = (await metaOf('shot-doc')).preview;
  const access = await call('/api/doc/access', { method: 'PATCH', token: owner.token, body: { slug: 'shot-doc', access: { visibility: 'private' } } });
  assert.equal(access.status, 200, await access.text());
  assert.equal((await call(privateShot.image)).status, 404, 'a private doc hides its screenshot from strangers');
  console.log('✓ the screenshot is served behind the doc access check');

  // ---- precedence and lazy fill ----
  // Re-publishing the same version with an authored SVG does not replace a screenshot.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#fff"/><text x="80" y="200" font-size="60">Authored</text></svg>';
  assert.equal((await upload('admin-test-token', 'shot-doc', 2, { replace: true, preview_svg: svg })).status, 200);
  assert.equal((await metaOf('shot-doc')).preview.image, privateShot.image, 'screenshot beats preview.svg for the same version');
  // The lazy fill (refreshDocPreview via the curate/fill paths) keeps it.
  const curated = await call('/api/me/profile/pin', { method: 'POST', cookie: owner.cookie, body: { slug: 'shot-doc', pinned: true } });
  assert.equal(curated.status, 200, await curated.text());
  assert.equal((await metaOf('shot-doc')).preview.image, privateShot.image, 'a refresh keeps the screenshot of the same version');
  // An owner opening My docs fills only latest versions without a matching
  // card, so the screenshot stays.
  await call('/me', { cookie: owner.cookie });
  assert.equal((await metaOf('shot-doc')).preview.image, privateShot.image, 'the lazy template fill does not overwrite a screenshot');

  // A screenshot sent with the upload is used at once (no queue render).
  const withShot = await upload(owner.token, 'shot-two', 1, { preview_png: b64(good), preview_svg: svg });
  assert.equal(withShot.status, 200, await withShot.text());
  const two = (await metaOf('shot-two')).preview;
  assert.equal(two.image_source, 'screenshot', 'screenshot beats preview.svg in the same upload');
  assert.equal(queued.length, 0);
  // An invalid screenshot is a warning; the publish goes ahead with a card.
  const badShot = await upload(owner.token, 'shot-three', 1, { preview_png: b64(makePng(1200, 300)) });
  assert.equal(badShot.status, 200);
  assert.match((await badShot.json()).preview_warning, /^preview_png: .*1200x300/);
  assert.notEqual((await metaOf('shot-three')).preview.image_source, 'screenshot');
  // A screenshot sent with an older version's upload never becomes the card.
  assert.equal((await upload(owner.token, 'shot-two', 2)).status, 200);
  const v2card = (await metaOf('shot-two')).preview;
  assert.notEqual(v2card.image_source, 'screenshot', 'a newer version without a screenshot falls back to a card');
  assert.match(v2card.image, /\/preview\/v2-/);
  const olderWithShot = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug: 'shot-two', version: 1, html: doc('shot-two v1'), meta: meta('shot-two v2', 'public', 2), preview_png: b64(makePng(1200, 630, { shade: 40 })) } });
  assert.equal(olderWithShot.status, 200, await olderWithShot.text());
  assert.notEqual((await metaOf('shot-two')).preview.image_source, 'screenshot', 'an older version screenshot does not replace the latest card');
  // The admin backfill skips docs whose latest version already has a screenshot.
  const backfill = await call('/api/admin/preview-cards/backfill', { method: 'POST', token: 'admin-test-token', body: { apply: true, limit: 10 } });
  assert.equal(backfill.status, 200);
  assert.equal((await metaOf('shot-doc')).preview.image, privateShot.image);
  console.log('✓ precedence: screenshot > preview.svg > template; lazy fill and backfill keep it; a new version falls back');

  console.log('✓ preview screenshot checks passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
