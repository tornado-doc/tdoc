// The Comments feeds a page at a time, newest first (commentFeedPage): My
// docs' and a team's. Docs come by when each was last commented on; only a
// comment or reply added moves one; what is at or after `through` does not
// move as more load; every doc is checked on its full record, and one the
// viewer may not read is in no answer. Nothing more runs when a comment is
// made. Prints what it costs, and for teams of 1,500 docs.
// Run with: node test/comments-paging.test.js
const { loadWorker, makeEnv, req, issue, FakeStorage } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const at = (minutes) => new Date(Date.parse('2024-01-01T00:00:00.000Z') + minutes * 60000).toISOString();
const later = async (ms, fn) => {
  const now = Date.now;
  Date.now = () => now() + ms;
  try { return await fn(); } finally { Date.now = now; }
};

process.exitCode = 1; // unless it gets to its end
(async () => {
  console.log('comment feeds, a page at a time');
  let sqlite = true;
  try { require('node:sqlite'); } catch { sqlite = false; }
  if (!sqlite) { console.log('  skipped: no node:sqlite'); process.exit(0); }
  const mod = await loadWorker();

  // Julie's docs, oldest record first; `comments(i)` gives a doc's threads.
  async function world(count, comments, { ...extra } = {}) {
    const env = makeEnv(mod.CommentsStore, { TDOC_EMAIL_ALIAS_SECRET: 'x', ...extra });
    const who = {};
    for (const [i, login] of ['julie', 'bob', 'mia'].entries()) {
      const sid = `${i + 1}${'0'.repeat(31)}`;
      await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, created: at(0) }));
      await env.META.put(`session:${sid}`, JSON.stringify({ login, account_id: `acct-${login}`, name: login, avatar_url: '', created: new Date().toISOString() }));
      who[login] = `tdoc_sid=${sid}`;
    }
    const waits = [];
    const ctx = { waitUntil(p) { waits.push(p); } };
    const cost = { requests: 0, kv: 0, keys: 0, stores: 0, searches: 0 };
    for (const op of ['get', 'getWithMetadata', 'put', 'delete', 'list']) {
      const own = env.META[op];
      env.META[op] = function counted(...a) { cost.kv += 1; cost.keys += Array.isArray(a[0]) ? a[0].length : 1; return own.apply(this, a); };
    }
    if (env.COMMENTS) {
      const own = env.COMMENTS.get.bind(env.COMMENTS);
      env.COMMENTS.get = (id) => { const stub = own(id); return { ...stub, fetch: (...a) => { cost.stores += 1; if (String(a[0]).endsWith('/search')) cost.searches += 1; return stub.fetch(...a); } }; };
    }
    const call = async (path, { as = 'julie', ...o } = {}) => {
      cost.requests += 1;
      const r = await mod.default.fetch(req(path, { cookie: who[as], ...o }), env, ctx);
      let body = null;
      try { body = await r.json(); } catch {}
      await Promise.all(waits.splice(0));
      return { status: r.status, body };
    };
    const doc = async (slug, meta = {}, threads = null) => {
      await env.META.put(`meta:${slug}`, JSON.stringify({ title: slug, slug, created: at(0), versions: [{ n: 1, created: at(0) }], hosted: { account_id: 'acct-julie', github_login: 'julie' }, access: { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] }, ...meta }),
        { metadata: { v: 1, a: 'acct-julie', o: 'julie', k: '', w: meta.workspace_id || '', tf: '', f: 0, l: 1, c: at(0), u: at(0), t: slug, p: 0 } });
      if (threads) await env.META.put(`comments:${slug}`, JSON.stringify(threads));
    };
    const built = async (facet, slugs, idx = {}) => {
      const md = { v: 1, a: 'acct-julie', o: 'julie', k: '', w: '', tf: '', f: 0, l: 1, c: at(0), u: at(0), t: '', p: 0, ...idx };
      for (const slug of slugs) await env.META.put(`docidx:${facet}:${slug}`, '1', { metadata: md });
      await env.META.put(`docidx:built:${facet}`, at(0));
    };
    const slugs = range(count, (i) => `d${String(i).padStart(4, '0')}`);
    for (const [i, slug] of slugs.entries()) await doc(slug, {}, comments(i));
    await built('p:acct-julie', slugs);
    const thread = (id, when, text = id, replies = []) => ({ id, text, created: when, version: 1, author: { login: 'quinn', name: 'quinn' }, replies });
    // The whole feed as the client reads it; after each page, what it shows.
    const open = async (path = '/api/me/comments?', as = 'julie', seen = null) => {
      let cursor = '';
      const rows = new Map();
      const pages = [];
      let through = '';
      for (let n = 0; n < 400; n++) {
        const r = await call(`${path}paged=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { as });
        assert(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
        for (const x of r.body.items) rows.set(`${x.slug}:${x.id}`, x);
        pages.push(r.body);
        const all = [...rows.values()].sort((a, b) => String(b.created).localeCompare(String(a.created)));
        if (r.body.through && (!through || r.body.through < through)) through = r.body.through;
        if (seen) await seen(all.filter((x) => r.body.next === null || !through || String(x.created) >= through), r.body, n);
        if (r.body.next === null) return { rows: all, pages };
        cursor = r.body.next;
      }
      throw new Error('no end');
    };
    // Until every doc has been read for its time once.
    const first = async (path = '/api/me/comments?', as = 'julie') => (await call(`${path}paged=1`, { as })).body;
    const warm = async (path, as) => { for (let n = 1; n < 60; n++) if ((await first(path, as)).through) return n; throw new Error('never in order'); };
    const post = async (slug, text, as = 'julie') => { const r = await call('/api/comments', { method: 'POST', as, body: { slug, version: 1, text, anchor: null } }); assert(r.status === 200, JSON.stringify(r.body)); return r.body; };
    // The stores of one scope, or of all, not answering (some ops).
    const down = (only = '/search', how = () => Promise.reject(new Error('down'))) => {
      const own = env.COMMENTS.get;
      env.COMMENTS.get = (id) => { const stub = own(id); return { ...stub, fetch: (url, init) => (only === '/search' ? String(url).endsWith('/search') : String(init && init.body).includes(only)) ? ((cost.searches += 1), how()) : stub.fetch(url, init) }; };
      cost.searches = 0;
      return () => { env.COMMENTS.get = own; };
    };
    const store = (op, scope = 'p:acct-julie') => env.COMMENTS.get(env.COMMENTS.idFromName(`__tdoc-search__:${scope}`)).fetch('https://do/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: `__tdoc-search__:${scope}`, op }) }).then((r) => r.json());
    const timeOf = async (slug, scope) => ((await store({ kind: 'comment_times', slugs: [slug] }, scope)).times[0] || {}).at;
    return { env, call, cost, doc, built, open, slugs, thread, first, warm, post, down, who, store, timeOf };
  }
  // A doc's comments, mixed in time with the other docs'; every third has none.
  const mixed = (i) => (i % 3 === 2 ? null : range(1 + (i % 4), (k) => ({ id: `c${i}-${k}`, text: `c${i}-${k}`, created: at(((i * 7919 + k * 104729) % 100003)), version: 1, author: { login: 'quinn', name: 'quinn' }, replies: i % 5 === 0 && !k ? [{ id: `r${i}`, text: `r${i}`, created: at((i * 7919) % 100003 + 5000), author: { login: 'quinn', name: 'quinn' } }] : [] })));

  const one = (i) => [{ id: `c${i}`, text: `c${i}`, created: at(i), version: 1, author: { login: 'quinn', name: 'quinn' } }];
  const access = { visibility: 'private', team: true, commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] };

  await t('newest first, right on every page: what is shown never moves, and nothing is missed', async () => {
    const w = await world(100, mixed);
    await w.warm();
    const { rows: want } = await w.open();
    assert(want.length > 150, `${want.length} rows`);
    let shown = [];
    // A while later: what was set in the last seconds comes again.
    const { pages } = await later(60000, () => w.open('/api/me/comments?', 'julie', (now, page, n) => {
      const ids = now.map((x) => x.id);
      assert(JSON.stringify(ids.slice(0, shown.length)) === JSON.stringify(shown), `page ${n} moved what was shown`);
      assert(JSON.stringify(ids) === JSON.stringify(want.slice(0, ids.length).map((x) => x.id)), `page ${n} is not the newest`);
      if (n === 0) assert(ids.length >= 5, `the first page shows ${ids.length}`);
      shown = ids;
    }));
    assert(shown.length === want.length, `${shown.length} of ${want.length}`);
    // Docs with no comments are not read: 67 of the 100 have some.
    assert(pages.length === 6 && pages.slice(0, 5).every((p) => new Set(p.items.map((x) => x.slug)).size === 12), `${pages.length} pages`);
    assert(pages.every((p) => /^items,next,ok(,through)?$/.test(Object.keys(p).sort().join())), Object.keys(pages[0]).join());
  });

  await t('the first time: comments at once and all of them, by when docs were updated; in order once each doc was read', async () => {
    const w = await world(130, mixed);
    const { rows, pages } = await w.open();
    assert(pages[0].items.length > 0 && pages.every((p) => p.through === undefined), `first page ${pages[0].items.length} ${pages[0].through}`);
    assert(await w.warm() <= 2 && rows.length === (await w.open()).rows.length, 'comments missed the first time');
    // Before that, her own docs before those the index has in a team.
    const both = await world(60, one);
    const away = range(150, (i) => `away${i}`);
    for (const slug of away) await both.doc(slug, { workspace_id: 'team_x' });
    await both.built('p:acct-julie', away, { w: 'team_x', u: at(500) });
    assert((await both.first()).items.length === 12, `${(await both.first()).items.length}`);
    const small = await world(40, mixed);
    assert((await small.first()).through, '40 docs: from the first page');
    for (const slug of ['d0002', 'd0035']) { // one that had none
      await small.post(slug, `new on ${slug}`);
      const again = await small.first();
      assert(again.items[0].text === `new on ${slug}` && again.through, JSON.stringify(again.items[0]));
    }
    // Her docs in a team are the team's feed's.
    await small.doc('in-team', { workspace_id: 'team_x' }, [small.thread('t1', at(300000))]);
    await small.built('p:acct-julie', ['in-team']);
    for (let n = 0; n < 2; n++) {
      const here = await small.first();
      assert(here.through && !here.items.some((x) => x.id === 't1'), 'a team doc');
    }
    // A doc made since.
    await small.doc('fresh', {}, [small.thread('f1', at(200000))]);
    await small.built('p:acct-julie', ['fresh']);
    assert((await small.first()).items.some((x) => x.id === 'f1'), 'fresh');
  });

  await t('only a comment or a reply moves a doc, by its own time: not a publish, a reaction, an edit or a resolve', async () => {
    const w = await world(0, () => null);
    const pat = await issue(mod.default, w.env, 'pat');
    w.who.pat = pat.cookie;
    const up = async (slug, version, comments = []) => {
      const r = await w.call('/api/upload', { method: 'POST', as: 'nobody', token: pat.token, body: { slug, version, html: `<p>${slug} ${version}</p>`, meta: { title: slug, access: { visibility: 'private' } }, comments } });
      assert(r.status === 200, JSON.stringify(r.body));
    };
    for (let i = 0; i < 14; i++) await up(`old${i}`, 1);
    // Their first publish carries tdoc's own hello on the first doc only.
    const texts = [];
    for (let i = 0; i < 14; i++) { texts.push((await w.post(`old${i}`, `on old${i}`, 'pat')).id); await new Promise((x) => setTimeout(x, 2)); }
    await up('hot', 1);
    await w.post('hot', 'the newest', 'pat');
    const top = async () => (await w.first('/api/me/comments?', 'pat')).items[0].text;
    await w.warm('/api/me/comments?', 'pat');
    for (let i = 0; i < 30; i++) await up(`pub${i}`, 1);
    for (let i = 0; i < 14; i++) await up(`old${i}`, 2);
    for (const [i, id] of texts.entries()) {
      await w.call('/api/react', { method: 'POST', as: 'pat', body: { slug: `old${i}`, version: 2, comment_id: id, emoji: '\u{1F44D}' } });
      await w.call('/api/comments', { method: 'PATCH', as: 'pat', body: { slug: `old${i}`, version: 2, id, text: `on old${i}, edited` } });
      await w.call('/api/comments', { method: 'PATCH', as: 'pat', body: { slug: `old${i}`, version: 2, id, resolved: true } });
    }
    await w.warm('/api/me/comments?', 'pat');
    const page = await w.first('/api/me/comments?', 'pat');
    assert(page.items[0].text === 'the newest' && page.items.length >= 12 && page.items.every((x) => x.created >= page.through), `${page.items.map((x) => x.text)}`);
    // Uploaded comments: in their place; a reply, at the top; a date to come,
    // where it was when first seen, and it stays there.
    const mine = { version: 1, author: { login: 'quinn', name: 'quinn' }, replies: [] };
    const acct = `p:${JSON.parse(await w.env.META.get('hosted-account:pat')).account_id}`;
    await up('imported', 1, [{ id: 'i1', text: 'imported', created: at(5), ...mine }]);
    assert(await top() === 'the newest', await top());
    await w.call('/api/comments', { method: 'POST', as: 'pat', body: { slug: 'old0', version: 2, parent_id: texts[0], text: 'a reply' } });
    assert(await top() === 'a reply', await top());
    const agent = await w.call('/api/agent/reply', { method: 'POST', as: 'nobody', token: pat.token, body: { slug: 'old1', parent_id: texts[1], text: 'an agent replied', status: 'answered', agent_login: 'claude' } });
    assert(agent.status === 200 && await top() === 'an agent replied', `${agent.status} ${await top()}`);
    await up('imported', 2, [{ id: 'i3', text: 'imported just now', created: new Date().toISOString(), ...mine }]);
    assert(await top() === 'imported just now', await top());
    const was = await w.timeOf('imported', acct);
    await up('imported', 3, [{ id: 'i2', text: 'from the future', created: '2999-01-01T00:00:00.000Z', ...mine }]);
    const first = await w.timeOf('imported', acct);
    assert(first === was, `${first} ${was}`);
    for (let n = 1; n < 4; n++) await later(n * 25 * 60 * 60 * 1000, () => w.first('/api/me/comments?', 'pat'));
    assert(await w.timeOf('imported', acct) === first, 'it moved on its own');
    await up('only-future', 1, [{ id: 'f1', text: 'future', created: '2999-01-01T00:00:00.000Z', ...mine }]);
    await w.warm('/api/me/comments?', 'pat');
    assert(await w.timeOf('only-future', acct) <= new Date().toISOString(), await w.timeOf('only-future', acct));
    // Published again with one that is there already: nothing was added.
    const last = await w.post('old3', 'a slip', 'pat');
    await w.call(`/api/comments?slug=old3&id=${last.id}&version=2`, { method: 'DELETE', as: 'pat' });
    const slip = await w.timeOf('old3', acct);
    await up('old3', 3, [{ id: last.id, text: 'a slip', created: new Date().toISOString(), ...mine }]);
    assert(await w.timeOf('old3', acct) === slip, 'nothing was added');
    // Its newest deleted: in its place from the next check.
    await later(200 * 60 * 60 * 1000, async () => { for (let n = 0; n < 6; n++) await w.first('/api/me/comments?', 'pat'); });
    assert(await w.timeOf('old3', acct) < await w.timeOf('old4', acct), await w.timeOf('old3', acct));
  });

  await t('a comment made while the feed is being read: its doc is not lost', async () => {
    const w = await world(60, mixed);
    await w.warm();
    const { rows: want } = await w.open();
    const oldest = want[want.length - 1].slug;
    const newest = want[0].slug;
    const got = await w.open('/api/me/comments?', 'julie', async (now, page, n) => {
      if (n === 0) { await w.post(oldest, 'mid-way'); await w.post(newest, 'and on one loaded'); }
      if (n === 1) assert(page.items.some((x) => x.text === 'mid-way') && page.items.some((x) => x.text === 'and on one loaded'), 'not at once');
    });
    assert(got.rows.length === want.length + 2, `${got.rows.length} of ${want.length}`);
  });

  await t('a cursor is one viewer\'s place in one feed, for a day, and grants nothing; each doc is checked when its page is read', async () => {
    const w = await world(40, mixed);
    await w.warm();
    const { next } = await w.first();
    assert(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(next) && !/d00/.test(Buffer.from(next.split('.')[1], 'base64url').toString('latin1')), next);
    const more = (as, cursor) => w.call(`/api/me/comments?paged=1&cursor=${encodeURIComponent(cursor)}`, { as });
    const ids = (r) => r.body.items.map((x) => x.id).join();
    const page1 = ids(await more('julie', ''));
    const page2 = ids(await more('julie', next));
    assert(page1 !== page2, 'a second page');
    assert(!(await more('bob', next)).body.items.length, 'Bob with hers');
    // Not one of this feed's, changed, or old: the feed starts again.
    const team = (await w.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
    const slugs = range(20, (i) => `t${i}`);
    for (const [i, slug] of slugs.entries()) await w.doc(slug, { workspace_id: team.id, access }, [w.thread(`t${i}`, at(i))]);
    await w.built(`w:${team.id}`, slugs, { w: team.id });
    await w.warm(`/api/team/comments?id=${team.id}&`);
    const other = (await w.first(`/api/team/comments?id=${team.id}&`)).next;
    for (const bad of ['x', '0|0|0', `${next.slice(0, -2)}AA`, '9'.repeat(400), other]) {
      const got = await more('julie', bad);
      assert(got.status === 200 && ids(got) === page1, `${bad}: ${got.status}`);
    }
    assert(ids(await later(25 * 60 * 60 * 1000, () => more('julie', next))) === page1 && ids(await later(23 * 60 * 60 * 1000, () => more('julie', next))) === page2, 'a day');
    assert(ids(await later(-10 * 60 * 1000, () => more('julie', next))) === page1, 'from the future');
    const anon = await mod.default.fetch(req(`/api/me/comments?paged=1&cursor=${encodeURIComponent(next)}`), w.env, { waitUntil() {} });
    assert(anon.status === 401, `${anon.status}`);
    const on2 = [...new Set((await more('julie', next)).body.items.map((x) => x.slug))];
    const rec = JSON.parse(await w.env.META.get(`meta:${on2[0]}`));
    await w.env.META.put(`meta:${on2[0]}`, JSON.stringify({ ...rec, hosted: { account_id: 'acct-bob', github_login: 'bob' } }));
    const now = (await more('julie', next)).body.items.map((x) => x.slug);
    assert(!now.includes(on2[0]) && now.includes(on2[1]), `${on2} ${now}`);
  });

  await t('a cursor is not another member\'s, nor another secret\'s, nor anyone\'s who left; its length says nothing', async () => {
    const w = await world(0, () => null);
    const team = (await w.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
    for (const as of ['mia', 'bob']) await w.call('/api/team/join', { method: 'POST', as, body: { token: team.invite_url.split('/').pop() } });
    const slugs = range(40, (i) => `${'t'.repeat(1 + i)}${i}`);
    for (const [i, slug] of slugs.entries()) await w.doc(slug, { workspace_id: team.id, access }, [w.thread(`t${i}`, at(i))]);
    await w.built(`w:${team.id}`, slugs, { w: team.id });
    const path = `/api/team/comments?id=${team.id}&`;
    await w.warm(path);
    const ids = async (cursor, as) => { const x = await w.call(`${path}paged=1&cursor=${encodeURIComponent(cursor)}`, { as }); return x.status === 200 ? x.body.items.map((y) => y.id).join() : x.status; };
    const { pages } = await later(60000, () => w.open(path, 'mia'));
    const { next } = pages[0];
    const top = await ids('', 'mia');
    assert(new Set(pages.slice(0, -1).map((x) => x.next.length)).size === 1 && pages.length > 2, pages.map((x) => x.next && x.next.length).join());
    assert(await ids(next, 'mia') !== top, 'her own');
    assert(await ids(next, 'bob') === top && await ids(next, 'julie') === top, 'another member');
    w.env.TDOC_EMAIL_ALIAS_SECRET = 'y';
    assert(await ids(next, 'mia') === top, 'another secret');
    w.env.TDOC_EMAIL_ALIAS_SECRET = 'x';
    assert(await ids(next, 'mia') !== top, 'hers again');
    const key = [...w.env.META.map.keys()].find((k) => { try { const v = JSON.parse(w.env.META.map.get(k)); return v && v.id === team.id && Array.isArray(v.members); } catch { return false; } });
    const rec = JSON.parse(w.env.META.map.get(key));
    await w.env.META.put(key, JSON.stringify({ ...rec, members: rec.members.filter((m) => m.account_id !== 'acct-mia') }), { metadata: w.env.META.metadata.get(key) });
    assert(await ids(next, 'mia') === 404, `removed: ${await ids(next, 'mia')}`);
  });

  await t('no secret to seal a cursor with: by offset, every comment', async () => {
    const w = await world(30, mixed, { TDOC_EMAIL_ALIAS_SECRET: undefined });
    let at0 = 'paged=1', n = 0, pages = 0;
    while (at0) { const b = (await w.call(`/api/me/comments?${at0}`)).body; assert(b.through === undefined && typeof b.next !== 'string', JSON.stringify(b.next)); n += b.items.length; pages += 1; at0 = b.next === null ? '' : `offset=${b.next}`; }
    assert(pages === 3 && n === (await (await world(30, mixed)).open()).rows.length, `${pages} ${n}`);
  });

  await t('docs that cannot be read are left out, and the rest is in order', async () => {
    const w = await world(100, one);
    const up = w.down('"slug":"d0050"');
    await w.warm();
    let page;
    for (let n = 0; n < 3; n++) { page = await w.first(); assert(page.through && page.missed && page.items[0].id === 'c99', `${n}: ${page.through} ${page.missed}`); }
    const got = await later(60000, () => w.open());
    assert(got.rows.length === 99 && JSON.stringify(got.rows.map((x) => x.created)) === JSON.stringify(got.rows.map((x) => x.created).sort().reverse()), `${got.rows.length}`);
    up();
    await w.first();
    const now = await later(60000, () => w.open());
    assert(now.rows.length === 100 && !now.pages.some((x) => x.missed) && now.pages[0].through, `${now.rows.length}`);
    // What is known of one stays when it cannot be read later; many of them.
    const again = w.down('"slug":"d0050"');
    await later(26 * 60 * 60 * 1000, async () => { for (let n = 0; n < 7; n++) await w.first(); });
    again();
    assert(await w.timeOf('d0050') === at(50), await w.timeOf('d0050'));
    const many = await world(220, one);
    const own = many.env.COMMENTS.get;
    many.env.COMMENTS.get = (id) => { const stub = own(id); return { ...stub, fetch: (url, init) => (/"slug":"d0(0|1[0-2])/.test(String(init && init.body)) && String(url).endsWith('/read') ? Promise.reject(new Error('down')) : stub.fetch(url, init)) }; };
    assert(await many.warm() <= 5, 'a hundred and thirty of them');
    // One a member may not read says nothing to them.
    const t2 = await world(0, () => null);
    const team = (await t2.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
    await t2.call('/api/team/join', { method: 'POST', as: 'mia', body: { token: team.invite_url.split('/').pop() } });
    for (const [i, slug] of ['ta', 'tb'].entries()) await t2.doc(slug, { workspace_id: team.id, access: { ...access, team: !i } }, [t2.thread(slug, at(i))]);
    await t2.built(`w:${team.id}`, ['ta', 'tb'], { w: team.id });
    t2.down('"slug":"tb"');
    const theirs = await t2.first(`/api/team/comments?id=${team.id}&`, 'mia');
    assert(theirs.through && !theirs.missed && theirs.items.length === 1, JSON.stringify(theirs));
    assert((await t2.first(`/api/team/comments?id=${team.id}&`)).missed, 'its owner');
  });

  await t('while in no order: reading on finds the order for the next opening, and a doc made or published meanwhile is there', async () => {
    const w = await world(400, one);
    let { next, through } = await w.first();
    assert(through === undefined, 'in order already');
    for (let n = 0; n < 4; n++) {
      if (n === 1) {
        await w.doc('made', {}, [w.thread('made', at(500))]);
        await w.built('p:acct-julie', ['made'], { u: new Date().toISOString() });
        await w.built('p:acct-julie', ['d0399'], { u: new Date().toISOString() });
      }
      const page = (await w.call(`/api/me/comments?paged=1&cursor=${encodeURIComponent(next)}`)).body;
      assert(page.through === undefined, `${n}: ${page.through}`);
      if (n === 1) assert(page.items.some((x) => x.id === 'made') && page.items.some((x) => x.id === 'c399'), page.items.map((x) => x.id).join());
      next = page.next;
    }
    assert((await w.first()).through, 'not in order after 400 docs');
  });

  await t('many docs changed while it is read: some at a time, newest first, and none lost', async () => {
    const w = await world(150, one);
    await w.warm();
    const sizes = [];
    const got = await later(60000, () => w.open('/api/me/comments?', 'julie', async (now, page, n) => {
      sizes.push(new Set(page.items.map((x) => x.slug)).size);
      if (n === 3) for (let i = 0; i < 100; i++) await w.post(`d${String(149 - i).padStart(4, '0')}`, `new ${i}`);
    }));
    assert(got.rows.length === 250 && sizes.every((x) => x <= 52), `${got.rows.length} ${sizes}`);
    assert(got.pages[4].items[0].text === 'new 99', got.pages[4].items[0].text);
    // A store's clock a little behind the worker's.
    const { next } = await w.first();
    await later(-3000, () => w.post('d0149', 'told a little late'));
    const more = (await w.call(`/api/me/comments?paged=1&cursor=${encodeURIComponent(next)}`)).body;
    assert(more.items.some((x) => x.text === 'told a little late'), 'late');
    // Found by a check, above where the feed is.
    const before = (await w.first()).next;
    await w.store({ kind: 'comment_checked', times: [['d0001', new Date().toISOString(), Date.now()]] });
    const then = (await w.call(`/api/me/comments?paged=1&cursor=${encodeURIComponent(before)}`)).body;
    assert(then.items.some((x) => x.slug === 'd0001'), 'found');
  });

  await t('one doc by name: only one the viewer has in that feed', async () => {
    const w = await world(3, one);
    const team = (await w.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
    const other = (await w.call('/api/teams', { method: 'POST', body: { name: 'U' } })).body.team;
    await w.call('/api/team/join', { method: 'POST', as: 'mia', body: { token: team.invite_url.split('/').pop() } });
    const open = { ...access, visibility: 'public' };
    await w.doc('team-doc', { workspace_id: team.id, access }, [w.thread('td', at(1))]);
    await w.doc('team-own', { workspace_id: team.id, access: { ...access, team: false } }, [w.thread('to', at(1))]);
    await w.doc('other-doc', { workspace_id: other.id, access: open }, [w.thread('od', at(1))]);
    await w.doc('trashed', { trashed_at: at(3) }, [w.thread('tt', at(1))]);
    await w.doc('bobs', { hosted: { account_id: 'acct-bob', github_login: 'bob' }, access: open }, [w.thread('bb', at(1))]);
    await w.doc('Not a slug', {}, [w.thread('ns', at(1))]);
    const site = (await w.call('/api/feedback/connect', { method: 'POST', as: 'bob', body: { origin: 'https://bob.example' } })).body;
    await w.post(site.slug, 'on the site', 'bob');
    const rec = JSON.parse(await w.env.META.get(`meta:${site.slug}`));
    await w.env.META.put(`meta:${site.slug}`, JSON.stringify({ ...rec, access: { ...rec.access, visibility: 'public' } }));
    await w.built('p:acct-julie', ['Not a slug']);
    await w.built(`w:${team.id}`, ['Not a slug'], { w: team.id });
    assert(!(await w.open()).rows.some((x) => x.slug === 'Not a slug'), 'listed');
    const seen = async (path, as) => (await w.call(path, { as })).body.items.map((x) => x.id === site.slug ? x.text : x.slug).join();
    const me = (slug, as = 'julie') => seen(`/api/me/comments?doc=${encodeURIComponent(slug)}`, as);
    const inTeam = (slug, as = 'julie') => seen(`/api/team/comments?id=${team.id}&doc=${encodeURIComponent(slug)}`, as);
    assert(await me('d0001') === 'd0001' && await me(site.slug, 'bob') === site.slug && await inTeam('team-doc', 'mia') === 'team-doc', 'their own');
    for (const [slug, as] of [['d0001', 'bob'], [site.slug, 'julie'], ['team-doc', 'julie'], ['trashed', 'julie'], ['bobs', 'julie'], ['Not a slug', 'julie'], ['..', 'julie'], ['none', 'julie']]) assert(await me(slug, as) === '', `${as}: ${slug}: ${await me(slug, as)}`);
    for (const [slug, as] of [['d0001', 'julie'], ['other-doc', 'julie'], ['team-own', 'mia'], ['trashed', 'julie'], ['Not a slug', 'julie']]) assert(await inTeam(slug, as) === '', `team, ${as}: ${slug}: ${await inTeam(slug, as)}`);
  });

  await t('a team\'s feed is its members\', and a narrowed connection\'s only where it reaches', async () => {
    const w = await world(0, () => null);
    const julie = await issue(mod.default, w.env, 'julie');
    w.who.julie = julie.cookie;
    const [team, other] = [(await w.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team, (await w.call('/api/teams', { method: 'POST', body: { name: 'U' } })).body.team];
    await w.doc('team-doc', { workspace_id: team.id, access }, [w.thread('td', at(1))]);
    await w.built(`w:${team.id}`, ['team-doc'], { w: team.id });
    const path = `/api/team/comments?id=${team.id}&`;
    assert((await w.call(`${path}paged=1`, { as: 'bob' })).status === 404, 'an outsider');
    const scoped = async (workspaces) => (await w.call('/api/hosted/token/scoped', { method: 'POST', as: 'nobody', token: julie.token, body: { label: 'x', workspaces } })).body.token;
    const [there, elsewhere] = [await scoped([team.id]), await scoped([other.id])];
    assert(there && elsewhere, `${there} ${elsewhere}`);
    const by = (token, q) => w.call(`${path}${q}`, { as: 'nobody', token });
    for (const q of ['paged=1', 'doc=team-doc', 'offset=0']) {
      const yes = await by(there, q);
      assert(yes.status === 200 && yes.body.items.length === 1, `${q}: ${yes.status} ${JSON.stringify(yes.body)}`);
      const no = await by(elsewhere, q);
      assert(no.status !== 200, `${q}: ${no.status}`);
    }
    // The page's own gate, for a session the token route does not know.
    const src = require('fs').readFileSync(process.env.TDOC_WORKER_JS || `${__dirname}/../worker/worker.js`, 'utf8');
    const body = src.slice(src.indexOf('async function teamCommentsPage('), src.indexOf('\n}\n', src.indexOf('async function teamCommentsPage(')) + 2);
    const page = new Function('loadTeam', 'teamInsider', 'commentFeedPage', 'actorKey', `${body} return teamCommentsPage;`)(async () => ({ id: 'a', name: 'A' }), () => true, async () => ({ items: [] }), () => 'x');
    assert(await page({}, { account_id: 'x', scope: { teams: ['b'] } }, 'a') === null && await page({}, { account_id: 'x', scope: { teams: ['a'] } }, 'a'), 'the page\'s gate');
  });

  await t('a comment on a doc the viewer may not read changes nothing they get', async () => {
    const make = async () => {
      const w = await world(0, () => null);
      const team = (await w.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
      await w.call('/api/team/join', { method: 'POST', as: 'mia', body: { token: team.invite_url.split('/').pop() } });
      const slugs = range(60, (i) => `t${String(i).padStart(2, '0')}`);
      const hidden = (i) => i % 5 === 1;
      for (const [i, slug] of slugs.entries()) await w.doc(slug, { workspace_id: team.id, access: { ...access, team: !hidden(i) } }, i % 4 === 3 ? null : [w.thread(`x${i}`, at((i * 37) % 61))]);
      await w.built(`w:${team.id}`, slugs, { w: team.id });
      const path = `/api/team/comments?id=${team.id}&`;
      const bare = (page) => JSON.stringify(page, (k, v) => (k === 'next' && v ? 'more' : k === 'team' ? '' : v));
      return { w, path, hidden: slugs.filter((_, i) => hidden(i)), bare, slugs };
    };
    for (const warm of [false, true]) for (const when of ['before', 'between pages']) {
      const [a, b] = [await make(), await make()];
      const say = async (x) => { for (const slug of [x.hidden[0], x.hidden[5], x.hidden[11], x.hidden[3]]) await x.w.post(slug, 'hidden'); };
      if (warm) for (const x of [a, b]) await x.w.warm(x.path, 'mia');
      if (when === 'before') await say(b);
      const read = async (x, speak) => { const out = []; await x.w.open(x.path, 'mia', async (shown, page, n) => { out.push(x.bare(page)); if (speak && n === 0) await say(x); }); return out; };
      const [one, two] = [await read(a), await read(b, when !== 'before')];
      assert(one.length > 2 && one.length === two.length, `${warm} ${when}: ${one.length} and ${two.length} requests`);
      one.forEach((page, n) => assert(page === two[n], `${warm} ${when}, page ${n}:\n${page.slice(0, 300)}\n${two[n].slice(0, 300)}`));
      assert(!two.some((page) => b.hidden.some((slug) => page.includes(`"${slug}"`))), 'a hidden doc is named');
    }
  });

  await t('a site joined from someone else is in its place; a doc that went to a team and came back too', async () => {
    const w = await world(20, one);
    const site = (await w.call('/api/feedback/connect', { method: 'POST', as: 'bob', body: { origin: 'https://bob.example' } })).body;
    const rec = JSON.parse(await w.env.META.get(`meta:${site.slug}`));
    await w.env.META.put(`meta:${site.slug}`, JSON.stringify({ ...rec, access: { ...rec.access, allowed_users: ['julie'] } }), { metadata: w.env.META.metadata.get(`meta:${site.slug}`) });
    const key = [...w.env.META.map.keys()].find((k) => k.startsWith('feedback:space:'));
    await w.env.META.put(key.replace(/bob(?=:)/, 'julie'), site.slug);
    await w.post(site.slug, 'on the site', 'bob');
    assert((await w.first()).items[0].text === 'on the site', JSON.stringify((await w.first()).items[0]));
    await w.post('d0005', 'hers');
    await w.post(site.slug, 'on the site again', 'bob');
    const next = await w.first();
    let checks = 0;
    const up = w.down('"comment_checked"', () => { checks += 1; return Promise.reject(new Error('down')); });
    await w.first();
    up();
    assert(!checks, 'the site was read for its time again');
    assert(next.through && next.items.slice(0, 2).map((x) => x.text).join() === 'on the site again,hers', JSON.stringify(next.items[0]));
    const team = (await w.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
    const move = async (to) => assert((await w.call('/api/team/move', { method: 'POST', body: { slugs: ['d0003'], team: to } })).status === 200, 'move');
    await move(team.id);
    await w.post('d0003', 'in the team');
    assert(!(await w.open()).rows.some((x) => x.slug === 'd0003'), 'a team\'s doc in My docs');
    await move(null);
    assert((await w.first()).items[0].text === 'in the team', JSON.stringify((await w.first()).items[0]));
  });

  await t('nothing waits or fails for it when a comment is made: the store hangs or fails, and comments take as long as without', async () => {
    const jobs = [];
    const w = await world(3, one, { BACKUP_QUEUE: { async send(job) { jobs.push(job); } }, ASK_API_KEY: '' });
    const julie = await issue(mod.default, w.env, 'julie');
    w.who.julie = julie.cookie;
    const team = (await w.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
    const acct = JSON.parse(await w.env.META.get('hosted-account:julie')).account_id;
    const mine = { hosted: { account_id: acct, github_login: 'julie' } };
    for (const slug of ['ta', 'tb']) await w.doc(slug, { ...mine, workspace_id: team.id, access }, [w.thread(`${slug}1`, at(1))]);
    await w.env.META.put(`team-backup:${team.id}`, JSON.stringify({ v: 1, enabled: true }));
    let n = 0;
    const threads = [];
    for (let i = 0; i < 4; i++) threads.push((await w.call('/api/comments', { method: 'POST', body: { slug: 'tb', version: 1, text: `asked ${i}`, anchor: null } })).body.id);
    const says = {
      'a comment': () => w.call('/api/comments', { method: 'POST', body: { slug: 'ta', version: 1, text: `hi ${n += 1}`, anchor: null } }),
      'a reply': () => w.call('/api/comments', { method: 'POST', body: { slug: 'ta', version: 1, parent_id: 'ta1', text: `re ${n += 1}` } }),
      'an agent\'s reply': () => w.call('/api/agent/reply', { method: 'POST', as: 'nobody', token: julie.token, body: { slug: 'tb', parent_id: threads.pop(), text: `done ${n += 1}`, status: 'answered', agent_login: 'claude' } }),
      'a first publish': () => w.call('/api/upload', { method: 'POST', as: 'nobody', token: julie.token, body: { slug: `pub${n += 1}`, version: 1, html: '<p>x</p>', meta: { title: 'x' } } }),
      'a publish with comments, one of them not one': () => w.call('/api/upload', { method: 'POST', as: 'nobody', token: julie.token, body: { slug: `pub${n += 1}`, version: 1, html: '<p>x</p>', meta: { title: 'x' }, comments: [w.thread(`p${n}`, at(1)), null] } }),
    };
    for (const [what, say] of Object.entries(says)) {
      const took = async (how) => {
        const up = how ? w.down('/search', how) : () => {};
        const from = Date.now();
        jobs.length = 0;
        let r;
        try { r = await say(); } finally { up(); }
        assert(!r.status || r.status === 200, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
        assert(!/comment|reply/.test(what) || /publish/.test(what) || jobs.some((job) => job.kind === 'comments'), `${what}: not backed up`);
        return Date.now() - from;
      };
      await took(null);
      for (const how of [() => Promise.reject(new Error('down')), () => new Promise(() => {})]) {
        const ms = await took(how);
        // As before this: each telling of the search store waits half a second.
        const calls = w.cost.searches;
        assert(calls > 0 && calls <= 2 && ms <= 520 * calls + 600, `${what}: ${ms} ms for ${calls} store calls`);
      }
    }
    // The comment, its reindex and its backup do not need the time kept.
    const store = [];
    const own = w.env.COMMENTS.get;
    w.env.COMMENTS.get = (id) => { const stub = own(id); return { ...stub, fetch: (url, init) => { if (String(url).endsWith('/search')) store.push(JSON.parse(init.body).op); return stub.fetch(url, init); } }; };
    const src = require('fs').readFileSync(process.env.TDOC_WORKER_JS || `${__dirname}/../worker/worker.js`, 'utf8');
    const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)) + 2);
    const added = new Function('teamCommentRows', `${fn('newestCommentAt')}\n${fn('commentAddedAt')} return commentAddedAt;`)(() => { throw new Error('x'); });
    for (const op of [{ kind: 'publish_merge', localComments: [{}, null] }, { kind: 'create' }, { kind: 'raw_events' }, { kind: 'reply' }, {}]) for (const result of [null, {}, { body: { mergedComments: 2 } }, { body: { created: 'never' } }]) assert(typeof added(op, result) === 'string', JSON.stringify([op, result]));
    for (const [what, say] of Object.entries(says)) { store.length = 0; await say(); assert(store.some((op) => op.kind === 'comments' || op.kind === 'touch'), `${what}: not reindexed`); }
    w.env.COMMENTS.get = own;
  });

  await t('a comment its store was not told of: in its place from the next check', async () => {
    const w = await world(30, one);
    await w.warm();
    const top = async () => (await w.first()).items[0].text;
    const up = w.down();
    await w.post('d0002', 'lost');
    up();
    assert(await top() !== 'lost', 'not lost');
    await later(25 * 60 * 60 * 1000, async () => { await top(); await top(); });
    assert(await top() === 'lost', await top());
  });

  await t('a store that does not answer: by when docs were last updated, no claim, every comment; a page already begun says to try again', async () => {
    const w = await world(30, mixed);
    await w.warm();
    const want = (await w.open()).rows.length;
    const { next } = await w.first();
    for (const how of [() => Promise.reject(new Error('down')), () => new Promise(() => {})]) {
      const up = w.down('"comment_times"', how);
      const started = Date.now();
      const { rows, pages } = await w.open();
      assert(rows.length === want && pages.every((p) => p.through === undefined), `${rows.length} of ${want}`);
      assert(Date.now() - started < 8000, `${Date.now() - started} ms`);
      const more = await w.call(`/api/me/comments?paged=1&cursor=${encodeURIComponent(next)}`);
      assert(more.status === 503 && /Try again/.test(more.body.message), `${more.status}`);
      up();
    }
    assert((await w.call(`/api/me/comments?paged=1&cursor=${encodeURIComponent(next)}`)).status === 200, 'and then it is there');
    // One of her stores alone.
    const part = w.down('search__:l:julie"');
    assert((await w.first()).through === undefined, 'one store is down');
    part();
    // A doc made meanwhile that cannot be read: the feed goes on as it was.
    await w.doc('new-one', {}, [w.thread('n1', at(1))]);
    await w.built('p:acct-julie', ['new-one']);
    const own = w.env.META.get;
    w.env.META.get = function (k, ...a) { return [].concat(k).includes('meta:new-one') ? Promise.reject(new Error('KV')) : own.call(this, k, ...a); };
    assert((await w.call(`/api/me/comments?paged=1&cursor=${encodeURIComponent(next)}`)).body.through, 'out of order midway');
    w.env.META.get = own;
    // What was read for a time, and could not be kept.
    const x = await world(30, mixed);
    const up = x.down('"comment_checked"');
    const got = await x.open();
    assert(got.rows.length === want && got.pages[0].through === undefined, `${got.rows.length} ${got.pages[0].through}`);
    up();
    // Comments, or a record, that cannot be read: said, and there next time.
    const newest = (await w.first()).items[0].slug;
    const doc = w.down(`"slug":"${newest}"`);
    assert((await w.first()).missed, 'missed');
    doc();
    for (const known of [true, false]) {
      const y = await world(30, one);
      if (known) await y.warm();
      const get = y.env.META.get;
      y.env.META.get = function (k, ...a) { return [].concat(k).includes('meta:d0029') ? Promise.reject(new Error('KV')) : get.call(this, k, ...a); };
      const without = await y.open();
      y.env.META.get = get;
      assert(without.rows.length === 29 && (!known || without.pages.some((p) => p.missed)), `${known}: ${without.rows.length}`);
      assert((await y.first()).items[0].id === 'c29', `${known}: not right after`);
    }
  });

  await t('a late answer does not move a doc back; a deleted doc\'s time goes with it; no stores at all', async () => {
    const w = await world(30, one);
    await w.warm();
    const readAt = Date.now() - 1;
    await w.post('d0000', 'newest');
    await w.store({ kind: 'comment_checked', times: [['d0000', at(0), readAt]] });
    assert((await w.first()).items[0].text === 'newest', 'moved back');
    const was = await w.timeOf('d0000');
    const checked = async () => (await w.store({ kind: 'comment_times', slugs: ['d0000'] })).times[0].checked;
    const then = await checked();
    await later(5000, () => w.post('d0000', 'and newer'));
    assert(await checked() === then, 'a comment put off the check');
    // The time cannot be kept: reindexed all the same.
    const sql = Object.getOwnPropertyDescriptor(FakeStorage.prototype, 'sql');
    Object.defineProperty(FakeStorage.prototype, 'sql', { configurable: true, get() { const own = sql.get.call(this); return { exec: (q, ...a) => { if (/INTO comment_times/.test(q)) throw new Error('full'); return own.exec(q, ...a); } }; } });
    const odd = await w.store({ kind: 'comments', slug: 'd0000', at: new Date().toISOString() });
    Object.defineProperty(FakeStorage.prototype, 'sql', sql);
    assert(odd.ok && odd.queued, 'not reindexed');
    await w.store({ kind: 'comments', slug: 'd0000', at: at(2) });
    assert(await w.timeOf('d0000') >= was, 'an older comment moved it back');
    await w.store({ kind: 'comments', slug: 'unread', at: at(2) });
    assert(await w.timeOf('unread') === undefined, 'an old comment stood for a doc not read');
    // Marked as elsewhere from a record read late: until the next check.
    await w.store({ kind: 'comment_checked', times: [['d0007', '-', Date.now() + 1000]] });
    assert(!(await w.open()).rows.some((x) => x.slug === 'd0007'), 'elsewhere');
    await later(25 * 60 * 60 * 1000, async () => { for (let n = 0; n < 3; n++) await w.first(); });
    assert((await w.open()).rows.some((x) => x.slug === 'd0007'), 'for good');
    // Her docs in teams are read once in a while, not each time.
    const teams = range(200, (i) => `team${i}`);
    for (const slug of teams) await w.doc(slug, { workspace_id: 'team_x' });
    await w.built('p:acct-julie', teams);
    for (let n = 0; n < 4; n++) await w.first();
    Object.assign(w.cost, { keys: 0 });
    let checks = 0;
    const up = w.down('"comment_checked"', () => { checks += 1; return Promise.reject(new Error('down')); });
    await w.first();
    up();
    assert(w.cost.keys < 80 && !checks, `${w.cost.keys} keys, ${checks} checks`);
    // A many-key answer without some of its keys.
    const get = w.env.META.get;
    w.env.META.get = async function (k, ...a) { const r = await get.call(this, k, ...a); if (Array.isArray(k)) r.delete(k[0]); return r; };
    assert((await w.open()).rows.length === 32, `${(await w.open()).rows.length}`);
    w.env.META.get = get;
    await w.store({ kind: 'remove', slug: 'd0000' });
    assert(!(await w.store({ kind: 'comment_times', slugs: ['d0000', 'd0001'] })).times.some((x) => x.slug === 'd0000'), 'kept');
    w.env.COMMENTS = undefined;
    const page = await w.first();
    assert(page.through === undefined && page.items.length, JSON.stringify(page).slice(0, 200));
    assert((await w.open()).rows.length >= 30, 'all of it');
    // By offset, as a team's Comments without the flag: every page, as before.
    let offset = 0, n = 0;
    while (offset !== null) { const b = (await w.call(`/api/me/comments?offset=${offset}`)).body; assert(b.docs_total === 230, `${b.docs_total}`); n += b.items.length; offset = b.next; }
    assert(n === 30, `${n}`);
  });

  await t('what it costs', async () => {
    const spend = (w, name) => async (what, fn) => {
      Object.assign(w.cost, { requests: 0, kv: 0, keys: 0, stores: 0 });
      await fn();
      console.log(`    ${name}, ${what}: ${w.cost.requests} requests, ${w.cost.kv} KV operations (${w.cost.keys} keys), ${w.cost.stores} store reads`);
      return { ...w.cost };
    };
    const some = (i) => (i % 3 ? null : one((i * 7919) % 100003));
    const shapes = [['100 docs', await world(100, some), 'julie', ''], ['1,200 docs', await world(1200, some), 'julie', '']];
    // Her 1,500 docs in teams, and 40 that are not.
    const own = await world(40, some);
    const inTeams = range(1500, (i) => `w${i}`);
    for (const slug of inTeams) await own.doc(slug, { workspace_id: 'team_x' });
    await own.built('p:acct-julie', inTeams);
    shapes.push(['1,500 of her docs in teams, 40 not', own, 'julie', '']);
    // A team's 1,500 docs, 100 of them a member may read.
    const big = await world(0, () => null);
    const team = (await big.call('/api/teams', { method: 'POST', body: { name: 'T' } })).body.team;
    await big.call('/api/team/join', { method: 'POST', as: 'mia', body: { token: team.invite_url.split('/').pop() } });
    const theirs = range(1500, (i) => `b${String(i).padStart(4, '0')}`);
    for (const [i, slug] of theirs.entries()) await big.doc(slug, { workspace_id: team.id, access: { ...access, team: i % 15 === 7 } }, [big.thread(`x${i}`, at((i * 7919) % 100003))]);
    await big.built(`w:${team.id}`, theirs, { w: team.id });
    shapes.push(['a team of 1,500 docs, 100 readable', big, 'mia', `/api/team/comments?id=${team.id}&`]);
    for (const [name, w, as, base] of shapes) {
      const path = base || '/api/me/comments?';
      const spent = spend(w, name);
      if (!base) await spent('every page (by offset)', async () => { for (let o = 0; o !== null;) o = (await w.call(`${path}offset=${o}`, { as })).body.next; });
      const cold = await spent('the first opening', () => w.first(path, as));
      let n = 0;
      await spent('until each doc was read once', async () => { n = await w.warm(path, as); });
      await later(60000, async () => {
        let next;
        const opened = await spent('opening it', async () => { next = (await w.first(path, as)).next; });
        const more = next ? await spent('Load more', () => w.call(`${path}paged=1&cursor=${encodeURIComponent(next)}`, { as })) : opened;
        await spent('all of it', () => w.open(path, as));
        for (const x of [cold, opened, more]) assert(x.requests === 1 && x.kv <= 120 && x.keys <= 260 && x.stores <= 125, `${name}: ${JSON.stringify(x)}`);
        for (const x of [opened, more]) assert(x.keys <= 140 && x.stores <= 20, `${name}: ${JSON.stringify(x)}`);
      });
      await later(26 * 60 * 60 * 1000, async () => { const day = await spent('a day later', () => w.first(path, as)); assert(day.keys <= 160 && day.stores <= 40, `${name}: ${JSON.stringify(day)}`); });
      assert(n <= 17, `${name}: ${n}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
