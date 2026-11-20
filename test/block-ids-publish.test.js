// Stable block ids end to end (flag stableBlockIds, server/block-ids.js):
// every publish path writes the version's sidecar (docs/<slug>/v<N>/blocks.json)
// and never fails over it; a missing sidecar is built when asked for; a text
// comment whose words were edited away after an agent republished (paragraphs
// inserted above, a light edit) comes back with the block it was made on
// (GET /api/comments blocks=1, get_comments block_id), for dev mode only.
// Run with: node test/block-ids-publish.test.js
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
const ORIGIN = { Origin: 'https://tdoc.dev' };

(async () => {
  console.log('stable block ids: sidecars on publish, comments follow their block');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_REMOTE_MCP: '1' });
  env.TDOC_DEBUG_ACCOUNTS = 'alice@tdoc.test';
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  let sidN = 0;
  const person = async (login) => {
    const sid = (++sidN).toString(16).padStart(32, '0');
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name: login, email: `${login}@tdoc.test`, avatar_url: '', created: new Date().toISOString() }));
    const cookie = `tdoc_sid=${sid}`;
    const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', cookie, body: { label: login } }), env, {});
    const data = await r.json();
    assert(r.status === 200 && data.token, `token ${r.status}`);
    return { ...data, cookie, login };
  };
  const alice = await person('alice');
  const sidecar = (slug, v) => {
    const raw = env.DOCS.map.get(`docs/${slug}/v${v}/blocks.json`);
    return raw ? JSON.parse(raw) : null;
  };
  const idWith = (s, words) => {
    const b = s.blocks.find((x) => x.t.includes(words));
    assert(b, `no block with "${words}" in v${s.version}: ${s.blocks.map((x) => x.t).join(' | ')}`);
    return b.id;
  };
  const page = (body) => `<!doctype html><html><head><title>Plan</title></head><body><div class="wrap">${body}</div></body></html>`;
  const V1 = page('<h1>Plan</h1><p>Billing ships first because invoices block two renewals this quarter.</p><p>Mobile waits for a designer.</p>');
  const V2 = page('<h1>Plan</h1><p>Summary: billing, then mobile.</p><p>Owners are listed at the end.</p><p>Billing ships first because invoices now block three renewals this quarter.</p><p>Mobile waits for a designer.</p>');
  const upload = (slug, version, html) => call('/api/upload', { method: 'POST', token: alice.token, body: { slug, version, html, meta: { title: 'Plan', versions: [{ n: version, created: new Date().toISOString() }] } } });
  const mcp = async (name, args) => {
    const r = await call('/mcp', { method: 'POST', token: alice.token, headers: { Accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    const body = r.body || JSON.parse(/data: (.*)/.exec(r.text)[1]);
    return body.result;
  };

  const slug = 'block-plan';
  let commentId = null;
  let blockId = null;

  await t('a first publish writes v1\'s sidecar', async () => {
    const r = await upload(slug, 1, V1);
    assert(r.status === 200, `upload ${r.status} ${r.text}`);
    const s = sidecar(slug, 1);
    assert(s && s.format === 1 && s.version === 1, 'v1 sidecar missing');
    assert(s.blocks.length === 3, `blocks ${s.blocks.length}`);
    blockId = idWith(s, 'invoices block two');
    assert(String(env.DOCS.map.get(`docs/${slug}/v1/index.html`)).indexOf(blockId) === -1, 'the stored HTML carries no block id');
  });

  await t('a comment on v1, then an agent republish with paragraphs above and a light edit: the block keeps its id', async () => {
    const c = await call('/api/comments', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, version: 1, text: 'Which renewals?', anchor: { kind: 'text', text: 'invoices block two renewals', context_before: 'Billing ships first because ', context_after: ' this quarter.' } } });
    assert(c.status === 200, `comment ${c.status} ${c.text}`);
    commentId = c.body.id;
    const r = await upload(slug, 2, V2);
    assert(r.status === 200, `upload v2 ${r.status} ${r.text}`);
    const s = sidecar(slug, 2);
    assert(s, 'v2 sidecar missing');
    assert(idWith(s, 'now block three') === blockId, 'edited block lost its id');
    assert(idWith(s, 'mobile waits') === idWith(sidecar(slug, 1), 'mobile waits'));
  });

  await t('GET /api/comments blocks=1 (dev mode): the comment carries its block in v2, edited', async () => {
    const r = await call(`/api/comments?slug=${slug}&version=2&blocks=1`, { cookie: alice.cookie });
    assert(r.status === 200, `${r.status} ${r.text}`);
    const c = r.body.find((x) => x.id === commentId);
    assert(c && c.anchor_block, `no anchor_block: ${JSON.stringify(c)}`);
    assert(c.anchor_block.id === blockId);
    assert(c.anchor_block.from_version === 1);
    assert(c.anchor_block.tag === 'p');
    assert(JSON.stringify(c.anchor_block.path) === JSON.stringify([0, 3]), `path ${JSON.stringify(c.anchor_block.path)}`);
    assert(c.anchor_block.quote_found === false, 'the quote is gone from v2');
    assert(c.anchor_block.head.startsWith('billingshipsfirst'), c.anchor_block.head);
    const v1 = await call(`/api/comments?slug=${slug}&version=1&blocks=1`, { cookie: alice.cookie });
    const on1 = v1.body.find((x) => x.id === commentId);
    assert(on1.anchor_block && on1.anchor_block.quote_found === true && on1.anchor_block.id === blockId, JSON.stringify(on1.anchor_block));
  });

  await t('without blocks=1, or with dev mode off, nothing is added', async () => {
    const plain = await call(`/api/comments?slug=${slug}&version=2`, { cookie: alice.cookie });
    assert(!plain.body.some((x) => x.anchor_block), 'anchor_block without blocks=1');
    await env.META.put('dev-mode:alice@tdoc.test', 'off');
    const off = await call(`/api/comments?slug=${slug}&version=2&blocks=1`, { cookie: alice.cookie });
    assert(off.status === 200 && !off.body.some((x) => x.anchor_block), 'anchor_block with dev mode off');
    const tool = await mcp('get_comments', { slug });
    assert(!tool.structuredContent.comments.some((x) => x.block_id), 'block_id with dev mode off');
    await env.META.delete('dev-mode:alice@tdoc.test');
  });

  await t('get_comments (dev mode) gives block_id and says the passage changed', async () => {
    const tool = await mcp('get_comments', { slug });
    const c = tool.structuredContent.comments.find((x) => x.id === commentId);
    assert(c && c.block_id === blockId && c.block_edited === true, JSON.stringify(c));
    const text = tool.content.map((x) => x.text || '').join('\n');
    assert(text.includes(`[block ${blockId}, passage since edited]`), text);
  });

  await t('a browser save writes the next sidecar from the previous one', async () => {
    const html = V2.replace('Mobile waits for a designer.', 'Mobile waits for a designer in March.');
    const r = await call('/api/doc/versions', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, baseVersion: 2, html } });
    assert(r.status === 200, `save ${r.status} ${r.text}`);
    const s = sidecar(slug, 3);
    assert(s && s.version === 3, 'v3 sidecar missing');
    assert(idWith(s, 'now block three') === blockId);
    assert(idWith(s, 'in march') === idWith(sidecar(slug, 2), 'mobile waits'));
  });

  await t('edit_doc (MCP) writes the sidecar too', async () => {
    const r = await mcp('edit_doc', { slug, edits: [{ find: 'Owners are listed at the end.', replace: 'Owners are listed below.' }] });
    assert(!r.isError, JSON.stringify(r));
    const s = sidecar(slug, 4);
    assert(s && idWith(s, 'now block three') === blockId, 'v4 sidecar');
  });

  await t('missing sidecars are built in memory when read, from the nearest one below, and never written by a read', async () => {
    const saved = {};
    for (const v of [2, 3, 4]) { saved[v] = env.DOCS.map.get(`docs/${slug}/v${v}/blocks.json`); env.DOCS.map.delete(`docs/${slug}/v${v}/blocks.json`); }
    const puts = env.DOCS.putCalls;
    const r = await call(`/api/comments?slug=${slug}&version=4&blocks=1`, { cookie: alice.cookie });
    const c = r.body.find((x) => x.id === commentId);
    assert(c.anchor_block && c.anchor_block.id === blockId, JSON.stringify(c.anchor_block));
    assert(env.DOCS.putCalls === puts, 'a read wrote to R2');
    for (const v of [2, 3, 4]) { assert(!sidecar(slug, v), `v${v} stored by a read`); env.DOCS.map.set(`docs/${slug}/v${v}/blocks.json`, saved[v]); }
  });

  await t('resolved comments are not looked up', async () => {
    const r0 = await call('/api/comments', { method: 'PATCH', cookie: alice.cookie, headers: ORIGIN, body: { slug, id: commentId, resolved: true, version: 4 } });
    const r = await call(`/api/comments?slug=${slug}&version=4&blocks=1`, { cookie: alice.cookie });
    const c = r.body.find((x) => x.id === commentId);
    assert(r0.status === 200 && c && (c.status === 'applied' || c.resolved), `not resolved: ${r0.status} ${r0.text}`);
    assert(!c.anchor_block, 'resolved thread looked up');
    await call('/api/comments', { method: 'PATCH', cookie: alice.cookie, headers: ORIGIN, body: { slug, id: commentId, resolved: false, version: 4 } });
  });

  await t('a doc whose owner is not in dev mode gets no sidecars', async () => {
    const bob = await person('bob');
    const r = await call('/api/upload', { method: 'POST', token: bob.token, body: { slug: 'block-bob', version: 1, html: V1, meta: { title: 'Plan' } } });
    assert(r.status === 200, `upload ${r.status} ${r.text}`);
    assert(!sidecar('block-bob', 1), 'sidecar for a doc without the flag');
    const s = await call('/api/doc/versions', { method: 'POST', cookie: bob.cookie, headers: ORIGIN, body: { slug: 'block-bob', baseVersion: 1, html: V2 } });
    assert(s.status === 200 && !sidecar('block-bob', 2), 'browser save wrote one');
  });

  await t('the upload starts the sidecar after everything else, in waitUntil', async () => {
    const pending = [];
    const r = await worker.fetch(req('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'block-later', version: 1, html: V1, meta: { title: 'Plan' } } }), env, { waitUntil(p) { pending.push(p); } });
    assert(r.status === 200);
    assert(pending.length >= 1, 'nothing handed to waitUntil');
    await Promise.all(pending);
    assert(sidecar('block-later', 1), 'not written after waitUntil');
  });

  await t('a doc purged while the sidecar is built gets no sidecar; one from a purged doc is never read', async () => {
    const pending = [];
    const r = await worker.fetch(req('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'block-purge', version: 1, html: V1, meta: { title: 'Plan' } } }), env, { waitUntil(p) { pending.push(p); } });
    assert(r.status === 200);
    // The purge began meanwhile: the hold names this doc.
    const meta = JSON.parse(env.META.map.get('meta:block-purge'));
    env.COMMENTS.stateFor('block-purge').storage.map.set('purgeHold', { at: Date.now(), identity: meta.created });
    await Promise.all(pending);
    assert(!sidecar('block-purge', 1), 'sidecar written for a purged doc');
    // Another doc took the slug meanwhile (KV names it): not written either.
    const pending2 = [];
    const r2 = await worker.fetch(req('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'block-taken', version: 1, html: V1, meta: { title: 'Plan' } } }), env, { waitUntil(p) { pending2.push(p); } });
    assert(r2.status === 200);
    const m2 = JSON.parse(env.META.map.get('meta:block-taken'));
    env.META.map.set('meta:block-taken', JSON.stringify({ ...m2, created: '2030-01-01T00:00:00.000Z' }));
    await Promise.all(pending2);
    assert(!sidecar('block-taken', 1), 'sidecar written over another doc');
    env.META.map.set('meta:block-taken', JSON.stringify(m2));
    // A leftover from an earlier doc on the slug names that doc: not read.
    assert((await upload('block-reuse', 1, V1)).status === 200);
    const old = sidecar('block-reuse', 1);
    old.doc = '1999-01-01T00:00:00.000Z';
    old.blocks.forEach((b) => { b.id = `x${b.id}`; });
    env.DOCS.map.set('docs/block-reuse/v1/blocks.json', JSON.stringify(old));
    const c = await call('/api/comments', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug: 'block-reuse', version: 1, text: 'q', anchor: { kind: 'text', text: 'invoices block two renewals' } } });
    const got = (await call(`/api/comments?slug=block-reuse&version=1&blocks=1`, { cookie: alice.cookie })).body.find((x) => x.id === c.body.id);
    assert(!(got.anchor_block && got.anchor_block.id.startsWith('x')), `read a stale doc's sidecar: ${JSON.stringify(got.anchor_block)}`);
  });

  await t('a replaced latest version gets a fresh sidecar; the stale one is not read', async () => {
    const other = 'block-replace';
    assert((await upload(other, 1, V1)).status === 200);
    const before = sidecar(other, 1);
    assert(before && before.sha, 'no sha recorded');
    const meta = JSON.parse(env.META.map.get(`meta:${other}`));
    assert(before.sha === meta.versions[0].sha, 'sha is not the stored bytes');
    // Admin replace of the latest version with other bytes.
    env.TDOC_UPLOAD_TOKEN = 'admin-token';
    const r = await call('/api/upload', { method: 'POST', token: 'admin-token', body: { slug: other, version: 1, replace: true, html: V2, meta: { title: 'Plan', versions: [{ n: 1, created: meta.versions[0].created }] } } });
    assert(r.status === 200, `replace ${r.status} ${r.text}`);
    const after = sidecar(other, 1);
    const metaAfter = JSON.parse(env.META.map.get(`meta:${other}`));
    assert(after && after.sha === metaAfter.versions[0].sha && after.sha !== before.sha, 'sidecar not rebuilt for the new bytes');
    assert(after.blocks.length === 5, `blocks ${after.blocks.length}`);
  });

  await t('KV behind the publish does not drop the sidecar (the committed record is used)', async () => {
    const get = env.META.get.bind(env.META);
    let lag = false;
    env.META.get = async (k) => (lag && k === 'meta:block-lag' ? null : get(k));
    try {
      const pending = [];
      const r = await worker.fetch(req('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'block-lag', version: 1, html: V1, meta: { title: 'Plan' } } }), env, { waitUntil(p) { pending.push(p); } });
      assert(r.status === 200);
      lag = true;
      await Promise.all(pending);
    } finally { env.META.get = get; }
    assert(sidecar('block-lag', 1), 'sidecar dropped while KV lagged');
  });

  await t('an orphan sidecar never makes a slug taken', async () => {
    env.DOCS.map.set('docs/block-orphan/v1/blocks.json', '{}');
    const carol = await person('carol');
    const r = await call('/api/upload', { method: 'POST', token: carol.token, body: { slug: 'block-orphan', version: 1, html: V1, meta: { title: 'Plan' } } });
    assert(r.status === 200, `orphan sidecar made the slug taken: ${r.status} ${r.text}`);
  });

  await t('a doc that never had sidecars still gets ids (backfill from v1)', async () => {
    const other = 'block-legacy';
    assert((await upload(other, 1, V1)).status === 200);
    const c = await call('/api/comments', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug: other, version: 1, text: 'q', anchor: { kind: 'text', text: 'invoices block two renewals' } } });
    assert((await upload(other, 2, V2)).status === 200);
    env.DOCS.map.delete(`docs/${other}/v2/blocks.json`);
    const r = await call(`/api/comments?slug=${other}&version=2&blocks=1`, { cookie: alice.cookie });
    const got = r.body.find((x) => x.id === c.body.id);
    assert(got.anchor_block && got.anchor_block.path[1] === 3 && got.anchor_block.quote_found === false, JSON.stringify(got.anchor_block));
    // With nothing stored within reach, a read makes no ids up.
    env.DOCS.map.delete(`docs/${other}/v1/blocks.json`);
    const none = (await call(`/api/comments?slug=${other}&version=2&blocks=1`, { cookie: alice.cookie })).body.find((x) => x.id === c.body.id);
    assert(!none.anchor_block, 'ids made up with no sidecar stored');
  });

  await t('a failing sidecar write never fails the publish', async () => {
    const put = env.DOCS.put.bind(env.DOCS);
    env.DOCS.put = async (k, v, o) => { if (String(k).endsWith('/blocks.json')) throw new Error('R2 down'); return put(k, v, o); };
    const errors = console.error;
    console.error = () => {};
    try {
      const r = await upload('block-fail', 1, V1);
      assert(r.status === 200, `upload ${r.status} ${r.text}`);
      const s = await call('/api/doc/versions', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug: 'block-fail', baseVersion: 1, html: V2 } });
      assert(s.status === 200, `save ${s.status} ${s.text}`);
    } finally { env.DOCS.put = put; console.error = errors; }
    assert(!sidecar('block-fail', 1) && !sidecar('block-fail', 2));
  });

  await t('a sheet doc gets no sidecar', async () => {
    const sheet = '<!doctype html><html><head><title>S</title></head><body><table data-tdoc-sheet data-name="T"><thead><tr><th data-key="a">A</th></tr></thead><tbody><tr data-row="1"><td>x</td></tr></tbody></table></body></html>';
    const r = await upload('block-sheet', 1, sheet);
    assert(r.status === 200, `upload ${r.status} ${r.text}`);
    assert(!sidecar('block-sheet', 1), 'sheet sidecar');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
