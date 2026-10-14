// Per-request CPU must be bounded by the requester's own data, not the
// platform (Cloudflare free plan: 10ms CPU per request, error 1102 past it).
//
//   1. Every doc owns a marker key per facet (owner account, team, nobody);
//      publish / republish / move / delete keep them exact, and a republish
//      costs no extra KV write (1,000 writes a day on the free plan).
//   2. My docs, the quota count and a shared team folder read those facets,
//      never a walk over every meta key -- once the facet is built, which
//      happens lazily, a bounded batch of writes per request.
//   3. A stale marker narrows, never grants, and is swept.
//   4. Team invites have a reverse index the same way.
//   5. The doc page itself: the frame bake is one pass whatever the table
//      count, is cached per version, and the shell page reads only the head
//      of the stored bytes.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// Workers KV in miniature with an in-memory Cache API beside it, so the
// frame cache has somewhere to go.
function fakeCaches() {
  const store = new Map();
  return {
    default: {
      async match(r) { const k = typeof r === 'string' ? r : r.url; const hit = store.get(k); return hit ? hit.clone() : undefined; },
      async put(r, res) { store.set(typeof r === 'string' ? r : r.url, res.clone()); },
    },
    store,
  };
}

// The table wrapper as it shipped before: the reference the one-pass
// version must match byte for byte.
function wrapBareTablesReference(html) {
  if (typeof html !== 'string' || html.indexOf('<table') === -1) return html;
  var out = '', i = 0;
  while (i < html.length) {
    var at = html.toLowerCase().indexOf('<table', i);
    if (at === -1) { out += html.slice(i); break; }
    var before = html.slice(i, at);
    var already = /<div[^>]*class="[^"]*tdoc-table-scroll[^"]*"[^>]*>\s*$/i.test(out + before);
    var depth = 0, j = at, end = -1;
    while (j < html.length) {
      var open = html.toLowerCase().indexOf('<table', j);
      var close = html.toLowerCase().indexOf('</table', j);
      if (close === -1) break;
      if (open !== -1 && open < close) { depth++; j = open + 6; continue; }
      depth--;
      if (depth === 0) { end = html.indexOf('>', close); break; }
      j = close + 7;
    }
    if (end === -1) { out += html.slice(i); break; }
    var table = html.slice(at, end + 1);
    out += before + (already ? table : '<div class="tdoc-table-scroll">' + table + '</div>');
    i = end + 1;
  }
  return out;
}

(async () => {
  globalThis.caches = fakeCaches();
  const fs = require('fs');
  const path = require('path');
  const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, opts) => {
    const r = await worker.fetch(req(p, opts), env, { waitUntil: (p2) => { env._pending = (env._pending || []).concat([p2]); } });
    let body = null; try { body = await r.clone().json(); } catch {}
    return { status: r.status, body, r };
  };
  const settle = async () => { await Promise.all(env._pending || []); env._pending = []; };
  const keys = (prefix) => [...env.META.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  const listSpy = () => {
    const seen = [];
    const orig = env.META.list.bind(env.META);
    env.META.list = async (opts) => { seen.push(opts && opts.prefix); return orig(opts); };
    return { seen, restore: () => { env.META.list = orig; } };
  };
  const puts = () => {
    let n = 0;
    const orig = env.META.put.bind(env.META);
    env.META.put = async (k, v, o) => { n += 1; return orig(k, v, o); };
    return { count: () => n, restore: () => { env.META.put = orig; } };
  };

  console.log('doc index: publish / move / delete keep the markers exact');
  const ann = await issue(worker, env, 'ann');
  const ben = await issue(worker, env, 'ben');
  const publish = (who, slug, version = 1, extra = {}) => call('/api/upload', { method: 'POST', token: who.token, body: { slug, version, html: `<p>${slug} v${version}</p>`, ...extra } });

  await t('a first publish writes exactly one marker, under the owner account; a republish writes none', async () => {
    const r = await publish(ann, 'plan');
    assert(r.status === 200, `publish ${r.status} ${JSON.stringify(r.body)}`);
    assert(env.META.map.has(`docidx:p:${ann.account_id}:plan`), `marker missing: ${keys('docidx:').join(', ')}`);
    assert(keys('docidx:').filter((k) => k.endsWith(':plan')).length === 1, `one marker expected: ${keys('docidx:').join(', ')}`);
    const before = keys('docidx:');
    const p = puts();
    const r2 = await publish(ann, 'plan', 2);
    p.restore();
    assert(r2.status === 200, `republish ${r2.status}`);
    assert(JSON.stringify(keys('docidx:')) === JSON.stringify(before), 'a republish changed the markers');
    const extra = keys('docidx:').length;
    assert(extra === before.length, 'marker count changed on republish');
  });

  let team = null;
  await t('moving into a team adds the team marker and keeps the owner one; moving out removes it', async () => {
    team = (await call('/api/teams', { method: 'POST', token: ann.token, body: { name: 'Idx team' } })).body.team;
    const moved = await call('/api/team/move', { method: 'POST', token: ann.token, body: { team: team.id, slugs: ['plan'] } });
    assert(moved.status === 200, `move ${moved.status}`);
    assert(env.META.map.has(`docidx:w:${team.id}:plan`), 'team marker missing');
    assert(env.META.map.has(`docidx:p:${ann.account_id}:plan`), 'owner marker lost on team move');
    const back = await call('/api/team/move', { method: 'POST', token: ann.token, body: { team: null, slugs: ['plan'] } });
    assert(back.status === 200, `move back ${back.status}`);
    assert(!env.META.map.has(`docidx:w:${team.id}:plan`), 'team marker survived the move out');
    assert(env.META.map.has(`docidx:p:${ann.account_id}:plan`), 'owner marker lost');
  });

  await t('deleting a doc deletes its markers', async () => {
    await call('/api/team/move', { method: 'POST', token: ann.token, body: { team: team.id, slugs: ['plan'] } });
    const del = await call('/api/doc?slug=plan', { method: 'DELETE', token: ann.token });
    assert(del.status === 200, `delete ${del.status} ${JSON.stringify(del.body)}`);
    assert(keys('docidx:').filter((k) => k.endsWith(':plan')).length === 0, `markers left: ${keys('docidx:').join(', ')}`);
  });

  console.log('doc index: readers use the facets, not the platform');
  await t('My docs, once built, lists the viewer\'s facets and never the meta: prefix; team docs come from the team facet', async () => {
    for (let i = 0; i < 4; i++) await publish(ann, `ann-${i}`);
    for (let i = 0; i < 3; i++) await publish(ben, `ben-${i}`);
    await call('/api/team/move', { method: 'POST', token: ann.token, body: { team: team.id, slugs: ['ann-3'] } });
    await call('/api/me', { token: ann.token });
    const spy = listSpy();
    const me = await call('/api/me', { token: ann.token });
    spy.restore();
    assert(me.status === 200, `me ${me.status}`);
    assert(!spy.seen.includes('meta:'), `the platform was listed: ${spy.seen.join(', ')}`);
    assert(spy.seen.includes(`docidx:p:${ann.account_id}:`) && spy.seen.includes(`docidx:w:${team.id}:`), `facets not listed: ${spy.seen.join(', ')}`);
    const mine = me.body.docs.map((d) => d.slug).sort();
    assert(JSON.stringify(mine) === JSON.stringify(['ann-0', 'ann-1', 'ann-2']), `mine: ${mine}`);
    const teamDocs = (me.body.team_docs || []).map((d) => d.slug);
    assert(JSON.stringify(teamDocs) === JSON.stringify(['ann-3']), `team docs: ${teamDocs}`);
    const reads = env.META.gets.filter((k) => k.startsWith('meta:ben-'));
    env.META.gets = [];
    await call('/api/me', { token: ann.token });
    assert(!env.META.gets.some((k) => k.startsWith('meta:ben-')), 'read someone else\'s docs');
    void reads;
  });

  await t('the quota count on publish reads the account facet, not the platform', async () => {
    const spy = listSpy();
    const r = await publish(ann, 'ann-quota');
    spy.restore();
    assert(r.status === 200, `publish ${r.status}`);
    assert(!spy.seen.includes('meta:'), `publish listed the platform: ${spy.seen.join(', ')}`);
    assert(spy.seen.includes(`docidx:p:${ann.account_id}:`), `quota did not use the facet: ${spy.seen.join(', ')}`);
  });

  await t('a shared team folder lists from the team facet', async () => {
    const folder = (await call('/api/folders', { method: 'POST', token: ann.token, body: { name: 'Shared', team: team.id } })).body.folder;
    await call('/api/folders/move', { method: 'POST', token: ann.token, body: { slugs: ['ann-3'], folder: folder.id, team: team.id } });
    const shared = await call('/api/folders', { method: 'PATCH', token: ann.token, body: { id: folder.id, team: team.id, visibility: 'public' } });
    const shareId = shared.body.folder.share_id;
    assert(shareId, 'no share id');
    const spy = listSpy();
    const listing = await call(`/api/folders/shared?id=${encodeURIComponent(shareId)}`, { token: ann.token });
    spy.restore();
    assert(listing.status === 200 && listing.body.docs.map((d) => d.slug).join() === 'ann-3', `listing ${listing.status} ${JSON.stringify(listing.body)}`);
    assert(!spy.seen.includes('meta:'), `folder share listed the platform: ${spy.seen.join(', ')}`);
  });

  await t('a stale marker never shows a doc and is swept', async () => {
    await env.META.put(`docidx:p:${ann.account_id}:ghost`, '1', { metadata: { v: 1, a: ann.account_id } });
    await env.META.put(`docidx:p:${ann.account_id}:ben-0`, '1', { metadata: { v: 1, a: ann.account_id } });
    const me = await call('/api/me', { token: ann.token });
    await settle();
    const slugs = me.body.docs.map((d) => d.slug);
    assert(!slugs.includes('ghost') && !slugs.includes('ben-0'), `stale markers granted: ${slugs}`);
    assert(!env.META.map.has(`docidx:p:${ann.account_id}:ghost`), 'ghost marker not swept');
    assert(!env.META.map.has(`docidx:p:${ann.account_id}:ben-0`), 'wrong-owner marker not swept');
  });

  console.log('doc index: lazy backfill, a bounded batch per request');
  await t('docs from before the index are found by the scan, indexed 25 a request, and the facet is marked built only once complete', async () => {
    const cat = await issue(worker, env, 'cat');
    const created = '2026-02-01T00:00:00.000Z';
    for (let i = 0; i < 30; i++) {
      const slug = `cat-${String(i).padStart(2, '0')}`;
      await env.META.put(`meta:${slug}`, JSON.stringify({ title: slug, slug, created, versions: [{ n: 1, created }], hosted: { account_id: cat.account_id, github_login: 'cat', owner_key: 'cat' } }));
    }
    const facet = `docidx:p:${cat.account_id}:`;
    const flag = `docidx:built:p:${cat.account_id}`;
    assert(!env.META.map.has(flag), 'a token mint must not build the facet');
    const first = await call('/api/me', { token: cat.token });
    await settle(); // the index is built after the response
    assert(first.status === 200 && first.body.docs.length === 30, `first My docs: ${first.status} ${first.body && first.body.docs.length}`);
    assert(keys(facet).length === 25, `first batch wrote ${keys(facet).length} markers`);
    assert(!env.META.map.has(flag), 'facet marked built before every marker was written');
    const second = await call('/api/me', { token: cat.token });
    await settle(); // the index is built after the response
    assert(second.body.docs.length === 30, 'second My docs incomplete');
    assert(keys(facet).length === 30 && env.META.map.has(flag), `after the second batch: ${keys(facet).length} markers, built=${env.META.map.has(flag)}`);
    const spy = listSpy();
    const third = await call('/api/me', { token: cat.token });
    spy.restore();
    assert(third.body.docs.length === 30, 'third My docs incomplete');
    assert(!spy.seen.includes('meta:'), 'still scanning after the facet is built');
  });

  await t('a doc with a handle and no account is found under the handle facet', async () => {
    const { putSession } = require('./helpers/worker-harness.js');
    const cookie = await putSession(env, 'dora');
    const created = '2026-02-01T00:00:00.000Z';
    await env.META.put('meta:dora-old', JSON.stringify({ title: 'Old', slug: 'dora-old', created, versions: [{ n: 1, created }], hosted: { github_login: 'dora' } }));
    const first = await call('/api/me', { cookie });
    await settle(); // the index is built after the response
    assert(first.status === 200 && first.body.docs.map((d) => d.slug).join() === 'dora-old', `first: ${first.status} ${JSON.stringify(first.body && first.body.docs)}`);
    assert(env.META.map.has('docidx:l:dora:dora-old') && env.META.map.has('docidx:built:l:dora'), `handle facet: ${keys('docidx:l:').join(', ')}`);
    const spy = listSpy();
    const again = await call('/api/me', { cookie });
    spy.restore();
    assert(again.body.docs.map((d) => d.slug).join() === 'dora-old' && !spy.seen.includes('meta:'), `second: ${spy.seen.join(', ')}`);
  });

  console.log('doc index: the daily backfill budget and marker writes that fail');
  await t('backfill stops at the platform\'s daily budget and the facet is not marked built', async () => {
    const dan = await issue(worker, env, 'dan');
    const created = '2026-02-01T00:00:00.000Z';
    for (let i = 0; i < 12; i++) {
      const slug = `dan-${String(i).padStart(2, '0')}`;
      await env.META.put(`meta:${slug}`, JSON.stringify({ title: slug, slug, created, versions: [{ n: 1, created }], hosted: { account_id: dan.account_id, github_login: 'dan', owner_key: 'dan' } }));
    }
    const facet = `docidx:p:${dan.account_id}:`;
    const flag = `docidx:built:p:${dan.account_id}`;
    // The budget is counted in the Durable Object; this day's slice is almost spent.
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName('__tdoc-index__'));
    const day = new Date().toISOString().slice(0, 10);
    const used = (await (await stub.fetch('https://do/index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: '__tdoc-index__', op: { kind: 'reserve', n: 0, cap: 300, day } }) })).json()).used;
    const capEnv = { ...env, TDOC_INDEX_BACKFILL_DAILY: String(used + 5) };
    const first = await worker.fetch(req('/api/me', { token: dan.token }), capEnv, {}).then((r) => r.json());
    assert(first.docs.length === 12, `scan still answers: ${first.docs.length}`);
    assert(keys(facet).length === 5, `wrote ${keys(facet).length} markers with 5 left in the budget`);
    assert(!env.META.map.has(flag), 'facet marked built with markers missing');
    const second = await worker.fetch(req('/api/me', { token: dan.token }), capEnv, {}).then((r) => r.json());
    assert(second.docs.length === 12 && keys(facet).length === 5, 'wrote past the budget');
    // Tomorrow (a higher cap stands in for the new day): the build resumes and completes.
    const third = await worker.fetch(req('/api/me', { token: dan.token }), { ...env, TDOC_INDEX_BACKFILL_DAILY: String(used + 100) }, {}).then((r) => r.json());
    assert(third.docs.length === 12 && keys(facet).length === 12 && env.META.map.has(flag), `after the budget returns: ${keys(facet).length} markers, built=${env.META.map.has(flag)}`);
  });

  await t('a marker write that fails never fails the publish; the doc still shows, and the facet heals itself', async () => {
    const fay = await issue(worker, env, 'fay');
    await publish(fay, 'fay-first');
    await call('/api/me', { token: fay.token });
    await settle(); // the index is built after the response
    assert(env.META.map.has(`docidx:built:p:${fay.account_id}`), 'facet not built');
    const origPut = env.META.put.bind(env.META);
    env.META.put = async (k, v, o) => { if (k.startsWith('docidx:')) throw new Error('KV put: daily write limit exceeded'); return origPut(k, v, o); };
    let r;
    try { r = await publish(fay, 'fay-second'); } finally { env.META.put = origPut; }
    assert(r.status === 200, `publish failed with marker writes failing: ${r.status} ${JSON.stringify(r.body)}`);
    assert(env.META.map.has('meta:fay-second'), 'record not stored');
    assert(!env.META.map.has(`docidx:p:${fay.account_id}:fay-second`), 'test did not exercise a failed marker');
    assert(!env.META.map.has(`docidx:built:p:${fay.account_id}`), 'facet still claims to be built after losing a marker');
    const me = await call('/api/me', { token: fay.token });
    await settle(); // the index is built after the response
    const slugs = me.body.docs.map((d) => d.slug).sort();
    assert(JSON.stringify(slugs) === JSON.stringify(['fay-first', 'fay-second']), `after a lost marker: ${slugs}`);
    assert(env.META.map.has(`docidx:p:${fay.account_id}:fay-second`) && env.META.map.has(`docidx:built:p:${fay.account_id}`), 'the rebuild did not restore the marker and the flag');
  });

  await t('when even the flag delete fails, the DO remembers the lost marker and the next reader rebuilds', async () => {
    const gus = await issue(worker, env, 'gus');
    await publish(gus, 'gus-first');
    await call('/api/me', { token: gus.token });
    await settle(); // the index is built after the response
    const origPut = env.META.put.bind(env.META);
    const origDelete = env.META.delete.bind(env.META);
    env.META.put = async (k, v, o) => { if (k.startsWith('docidx:')) throw new Error('quota'); return origPut(k, v, o); };
    env.META.delete = async (k) => { if (k.startsWith('docidx:')) throw new Error('quota'); return origDelete(k); };
    let r;
    try { r = await publish(gus, 'gus-second'); } finally { env.META.put = origPut; env.META.delete = origDelete; }
    assert(r.status === 200, `publish ${r.status}`);
    assert(env.META.map.has(`docidx:built:p:${gus.account_id}`), 'the flag delete was supposed to fail');
    const me = await call('/api/me', { token: gus.token });
    await settle(); // the index is built after the response
    const slugs = me.body.docs.map((d) => d.slug).sort();
    assert(JSON.stringify(slugs) === JSON.stringify(['gus-first', 'gus-second']), `doc lost: ${slugs}`);
    assert(env.META.map.has(`docidx:p:${gus.account_id}:gus-second`), 'marker not restored');
  });

  console.log('team invites: a reverse index');
  await t('an invite writes tinv:<invitee>:<team>; joining removes it; pending invites are read from it', async () => {
    const eve = await issue(worker, env, 'eve');
    // Invites are a browser affair (the CLI creates teams without them).
    const made = await call('/api/teams', { method: 'POST', cookie: ann.cookie, headers: { Origin: 'https://tdoc.dev' }, body: { name: 'Invites', invites: ['eve'] } });
    assert(made.status === 200, `team ${made.status}`);
    const id = made.body.team.id;
    assert(env.META.map.has(`tinv:eve:${id}`), `marker missing: ${keys('tinv:').join(', ')}`);
    await call('/api/me', { token: eve.token });
    assert(env.META.map.has('tinv:built'), 'invite index never marked built');
    const spy = listSpy();
    const me = await call('/api/me', { token: eve.token });
    spy.restore();
    assert((me.body.team_invites || []).some((x) => x.id === id), `invite not offered: ${JSON.stringify(me.body.team_invites)}`);
    assert(!spy.seen.includes('team:') && spy.seen.includes('tinv:eve:'), `invites walked the teams: ${spy.seen.join(', ')}`);
    const joined = await call('/api/team/accept-invite', { method: 'POST', cookie: eve.cookie, headers: { Origin: 'https://tdoc.dev' }, body: { id } });
    assert(joined.status === 200, `join ${joined.status} ${JSON.stringify(joined.body)}`);
    assert(!env.META.map.has(`tinv:eve:${id}`), 'marker survived the join');
    const after = await call('/api/me', { token: eve.token });
    assert(!(after.body.team_invites || []).some((x) => x.id === id), 'joined team still offered');
  });

  console.log('the doc page: one pass, cached per version, head-only shell read');
  await t('wrapBareTables matches the previous implementation byte for byte', async () => {
    const start = workerSrc.indexOf('function wrapBareTables(');
    const end = workerSrc.indexOf('\n}\n', start) + 3;
    const wrapBareTables = new Function(`${workerSrc.slice(start, end)}; return wrapBareTables;`)();
    const cases = [
      '<p>no tables</p>',
      '<table><tr><td>a</td></tr></table>',
      '<p>x</p><TABLE class="u"><tr><td><table><tr><td>in</td></tr></table></td></tr></TABLE><p>y</p>',
      '<div class="tdoc-table-scroll">\n  <table><tr><td>wrapped</td></tr></table></div><table><tr><td>bare</td></tr></table>',
      '<table><tr><td>never closed',
      '<table></table><table></table><table></table>',
      '<p>$& $1 $$</p><table><tr><td>$&</td></tr></table>',
      '<div class="tdoc-table-scroll"><table></table></div>' + 'x'.repeat(10000) + '<table></table>',
      'ÜBER <Table>İ</Table> straße',
    ];
    for (const c of cases) assert(wrapBareTables(c) === wrapBareTablesReference(c), `differs on: ${c.slice(0, 60)}`);
    // Many tables: linear, not quadratic. 400 tables in ~400KB.
    const big = Array.from({ length: 400 }, (_, i) => `<h2>${i}</h2><p>${'lorem '.repeat(150)}</p><table><tr><td>${i}</td></tr></table>`).join('\n');
    const t0 = process.cpuUsage();
    const out = wrapBareTables(big);
    const ms = (process.cpuUsage(t0).user + process.cpuUsage(t0).system) / 1000;
    assert(out === wrapBareTablesReference(big), 'differs on the big fixture');
    assert(ms < 50, `400 tables took ${ms.toFixed(1)}ms`);
  });

  await t('/frame bakes a version once: the second view is served from the cache with a fresh nonce', async () => {
    const created = '2026-01-01T00:00:00.000Z';
    const html = `<!doctype html><html><head><title>T</title></head><body><h1>T</h1><table><tr><td>1</td></tr></table><iframe src="/d/cached/v/1/widget/w"></iframe></body></html>`;
    await env.META.put('meta:cached', JSON.stringify({ title: 'T', slug: 'cached', created, versions: [{ n: 1, created, sha: '0123456789abcdef' }], access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] } }));
    await env.DOCS.put('docs/cached/v1/index.html', html);
    let gets = 0;
    const origGet = env.DOCS.get.bind(env.DOCS);
    env.DOCS.get = async (k, o) => { gets += 1; return origGet(k, o); };
    const one = await call('/d/cached/v/1/frame', { dest: 'iframe' });
    await settle();
    const two = await call('/d/cached/v/1/frame', { dest: 'iframe' });
    env.DOCS.get = origGet;
    assert(one.status === 200 && two.status === 200, `${one.status} ${two.status}`);
    assert(gets === 1, `R2 read ${gets} times for two views`);
    const a = await one.r.text(); const b = await two.r.text();
    const strip = (s) => s.replace(/nonce="[0-9a-f]+"/g, 'nonce=""');
    assert(strip(a) === strip(b), 'cached body differs');
    assert(a !== b, 'the nonce did not change');
    assert(a.includes('tdoc-table-scroll') && a.includes('<iframe sandbox="allow-scripts"') && a.includes('id="tdoc-reader-patch"') && a.includes('id="tdoc-frame-probe"'), 'bake incomplete');
    const nonce = (one.r.headers.get('content-security-policy').match(/nonce-([0-9a-f]+)/) || [])[1];
    assert(nonce && a.includes(`nonce="${nonce}"`), 'the probe tag does not carry the CSP nonce');
    // A version without a recorded hash is baked every time, never cached.
    await env.META.put('meta:nohash', JSON.stringify({ title: 'N', slug: 'nohash', created, versions: [{ n: 1, created }], access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] } }));
    await env.DOCS.put('docs/nohash/v1/index.html', html);
    gets = 0;
    env.DOCS.get = async (k, o) => { gets += 1; return origGet(k, o); };
    await call('/d/nohash/v/1/frame', { dest: 'iframe' }); await settle(); await call('/d/nohash/v/1/frame', { dest: 'iframe' });
    env.DOCS.get = origGet;
    assert(gets === 2, `unhashed version read ${gets} times`);
  });

  await t('the frame cache is behind the access gate and keyed per doc and version: a cached body is never served for another doc, another version, or to someone denied', async () => {
    const created = '2026-01-01T00:00:00.000Z';
    const hedy = await issue(worker, env, 'hedy');
    const pub = (slug, body) => ({ title: slug, slug, created, versions: [{ n: 1, created, sha: 'feedfacefeedface' }, { n: 2, created, sha: 'feedfacefeedface' }], access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] }, hosted: { account_id: hedy.account_id, github_login: 'hedy', owner_key: 'hedy' } });
    // Two docs, two versions each, all four with the SAME recorded sha.
    for (const slug of ['twin-a', 'twin-b']) {
      await env.META.put(`meta:${slug}`, JSON.stringify(pub(slug)), { metadata: { v: 1, a: hedy.account_id } });
      for (const v of [1, 2]) await env.DOCS.put(`docs/${slug}/v${v}/index.html`, `<!doctype html><html><head><title>${slug}</title></head><body><p>body of ${slug} v${v}</p></body></html>`);
    }
    const bodyOf = async (p) => (await call(p, { dest: 'iframe', cookie: hedy.cookie })).r.text();
    assert((await bodyOf('/d/twin-a/v/1/frame')).includes('body of twin-a v1'), 'a v1');
    await settle();
    assert((await bodyOf('/d/twin-b/v/1/frame')).includes('body of twin-b v1'), 'b v1 served a\'s cached body');
    await settle();
    assert((await bodyOf('/d/twin-a/v/2/frame')).includes('body of twin-a v2'), 'a v2 served v1\'s cached body');
    await settle();
    assert((await bodyOf('/d/twin-a/v/1/frame')).includes('body of twin-a v1'), 'a v1 (cached) wrong');
    // Now twin-a goes private: the cached body must not reach a stranger.
    const priv = pub('twin-a'); priv.access.visibility = 'private';
    await env.META.put('meta:twin-a', JSON.stringify(priv), { metadata: { v: 1, a: hedy.account_id } });
    const denied = await call('/d/twin-a/v/1/frame', { dest: 'iframe' });
    assert(denied.status === 401 || denied.status === 403, `stranger got ${denied.status}`);
    const html = await denied.r.text();
    assert(!html.includes('body of twin-a'), 'the cached body leaked past the gate');
    const still = await bodyOf('/d/twin-a/v/1/frame');
    assert(still.includes('body of twin-a v1'), 'the owner lost the doc');
    // Only valid slugs reach the cache key; the key is this origin's own URL.
    const src = workerSrc.slice(workerSrc.indexOf('const frameMatch = p.match'), workerSrc.indexOf('const frameMatch = p.match') + 3000);
    assert(src.indexOf('enforceDocAccess(') < src.indexOf('frameCacheGet('), 'the cache is read before the access gate');
    assert(src.indexOf('isValidSlug(slug)') < src.indexOf('frameCacheKey('), 'an unvalidated slug reaches the cache key');
  });

  await t('/export marks anchors in one pass with the same output as the rebuild-per-comment version', async () => {
    const created = '2026-01-01T00:00:00.000Z';
    const owner = await issue(worker, env, 'exp');
    const body = '<p>alpha beta gamma delta</p><p>beta gamma</p><p>epsilon zeta eta</p><p>alpha</p>';
    const r = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'exp-doc', version: 1, html: `<!doctype html><html><head><title>E</title></head><body>${body}</body></html>` } });
    assert(r.status === 200, `publish ${r.status}`);
    const anchors = ['beta gamma', 'gamma', 'alpha beta', 'beta gamma delta', 'epsilon', 'alpha', 'zeta eta', 'beta gamma'];
    for (const text of anchors) {
      const c = await call('/api/comments', { method: 'POST', cookie: owner.cookie, body: { slug: 'exp-doc', version: 1, text: `on ${text}`, anchor: { kind: 'text', text } } });
      assert(c.status === 200, `comment ${c.status} ${JSON.stringify(c.body)}`);
    }
    const page = await call('/d/exp-doc/v/1/export?download=0', { cookie: owner.cookie });
    assert(page.status === 200, `export ${page.status}`);
    const html = await page.r.text();
    const stored = await (await env.DOCS.get('docs/exp-doc/v1/index.html')).text();
    const list = await (await worker.fetch(req('/api/comments?slug=exp-doc&version=1', { cookie: owner.cookie }), env, {})).json();
    // The reference: what the sequential rebuild produced.
    let ref = stored;
    for (const c of list.comments || list) {
      if (c.anchor?.kind !== 'text' && !c.anchor?.text) continue;
      const needle = c.anchor.text;
      if (!needle || needle.length < 2) continue;
      const idx = ref.indexOf(needle);
      if (idx === -1) continue;
      const by = (c.author && c.author.login) || 'anonymous';
      ref = ref.slice(0, idx) + `<!--TDOC-COMMENT id="${c.id}" by="${by}"-->${needle}<!--/TDOC-COMMENT-->` + ref.slice(idx + needle.length);
    }
    const marked = html.slice(html.indexOf('<!doctype html>'));
    const strip = (s) => s.replace(/<style id="tdoc-reader"[\s\S]*?<\/style>\n?/g, '');
    assert(strip(marked) === strip(ref), `export differs:\n${strip(marked).slice(0, 400)}\n---\n${strip(ref).slice(0, 400)}`);
    assert((marked.match(/<!--TDOC-COMMENT /g) || []).length >= 6, 'markers missing');
  });

  await t('the shell page reads only the head of the stored bytes', async () => {
    const calls = [];
    const origGet = env.DOCS.get.bind(env.DOCS);
    env.DOCS.get = async (k, o) => { calls.push([k, o]); return origGet(k, o); };
    const page = await call('/d/cached/v/1');
    env.DOCS.get = origGet;
    assert(page.status === 200, `page ${page.status}`);
    const docRead = calls.find(([k]) => k === 'docs/cached/v1/index.html');
    assert(docRead && docRead[1] && docRead[1].range && docRead[1].range.length === 96 * 1024, `not a range read: ${JSON.stringify(docRead && docRead[1])}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
