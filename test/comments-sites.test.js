// Comments and Sites (commentsSitesTabs): My docs' comment feed
// (/api/me/comments) lists the comments on the person's own docs and on
// their own and joined sites (feedback spaces), each row saying whether it
// came from a doc or a site and, for a site, its host, the page and the
// element clicked. The team feed (/api/team/comments) marks a team site's
// rows the same way. Nobody sees a site comment they could not already open:
// a stranger, a non-member, a feedback token and a scoped token get nothing.
// Runs worker.js in-process with fake bindings (helpers/worker-harness.js).

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function sessionFor(env, login) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    login, name: login, avatar_url: '', account_id: `acct-${login}`, created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

async function seedDoc(env, slug, owner, extra = {}) {
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put(`meta:${slug}`, JSON.stringify({
    title: slug, slug, created, versions: [{ n: 1, created }],
    hosted: { account_id: `acct-${owner}`, github_login: owner },
    access: { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
    ...extra,
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${slug}</h1><p>Ship on Dec 18</p>`);
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  // TDOC_OWNER: Julie is also the deploy operator, who owns docs naming no
  // owner (the ownerless facet). An alias secret, so hidden addresses alias.
  const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie', TDOC_EMAIL_ALIAS_SECRET: 'test-alias-secret' });
  const call = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), env, { waitUntil() {} });
    let body = null;
    try { body = await r.clone().json(); } catch {}
    return { status: r.status, body, r };
  };
  console.log('comments and sites (commentsSitesTabs)');

  const julie = await sessionFor(env, 'julie');
  const bob = await sessionFor(env, 'bob');
  const carol = await sessionFor(env, 'carol');
  const dave = await sessionFor(env, 'dave');
  await seedDoc(env, 'q4-plan', 'julie');
  await seedDoc(env, 'bob-doc', 'bob');
  // A commenter who signed in by email, on three of Julie's docs; she
  // invited that address to one of them.
  const ERIN = 'erin.hidden@example.com';
  const erinSid = 'e1'.repeat(16);
  await env.META.put(`session:${erinSid}`, JSON.stringify({ email: ERIN, name: ERIN, created: '2026-01-01T00:00:00.000Z' }));
  const erin = `tdoc_sid=${erinSid}`;
  const publicAccess = { visibility: 'public', commenting: 'signed_in', history_visibility: 'owner' };
  await seedDoc(env, 'erin-a', 'julie', { access: { ...publicAccess, allowed_users: [] } });
  await seedDoc(env, 'erin-b', 'julie', { access: { ...publicAccess, allowed_users: [] } });
  await seedDoc(env, 'erin-invited', 'julie', { access: { ...publicAccess, allowed_users: [ERIN] } });
  for (const slug of ['erin-a', 'erin-b', 'erin-invited']) {
    const c = await call('/api/comments', { method: 'POST', cookie: erin, body: { slug, version: 1, text: `Erin on ${slug}`, anchor: { text: 'Ship on Dec 18' } } });
    assert(c.status === 200, `erin comment ${slug} ${c.status} ${JSON.stringify(c.body)}`);
  }
  // A legacy doc that names no owner: the operator's.
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put('meta:legacy-note', JSON.stringify({ title: 'Legacy note', slug: 'legacy-note', created, versions: [{ n: 1, created }], access: { visibility: 'unlisted', commenting: 'signed_in' } }));
  await env.DOCS.put('docs/legacy-note/v1/index.html', '<h1>Legacy</h1><p>Ship on Dec 18</p>');
  const legacy = await call('/api/comments', { method: 'POST', cookie: julie, body: { slug: 'legacy-note', version: 1, text: 'Operator note', anchor: { text: 'Ship on Dec 18' } } });
  assert(legacy.status === 200, `legacy comment ${legacy.status} ${JSON.stringify(legacy.body)}`);
  // Enough of Julie's docs for more than one page of the feed.
  for (let i = 0; i < 14; i++) await seedDoc(env, `bulk-${String(i).padStart(2, '0')}`, 'julie');

  // Julie's own doc, with a comment.
  const docComment = await call('/api/comments', { method: 'POST', cookie: julie, body: { slug: 'q4-plan', version: 1, text: 'Clashes with the freeze', anchor: { text: 'Ship on Dec 18' } } });
  assert(docComment.status === 200, `doc comment ${docComment.status} ${JSON.stringify(docComment.body)}`);

  // Julie's site (a feedback space), with a comment left on a page of it.
  const connect = async (cookie, origin) => (await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin } })).body;
  const site = await connect(julie, 'https://hustlefree.ai');
  assert(site && site.slug && site.token, `connect ${JSON.stringify(site)}`);
  const anchor = { kind: 'product', url: 'https://hustlefree.ai/pricing?plan=pro', selector: '#trial', tag: 'BUTTON', text: 'Start free trial' };
  const siteComment = await call('/api/comments', { method: 'POST', token: site.token, body: { slug: site.slug, version: 1, text: 'Hard to find on a phone', anchor } });
  assert(siteComment.status === 200, `site comment ${siteComment.status}`);
  const local = await connect(julie, 'http://localhost:3000');
  await call('/api/comments', { method: 'POST', token: local.token, body: { slug: local.slug, version: 1, text: 'Local note', anchor: { kind: 'product', url: 'http://localhost:3000/', selector: 'img.hero-logo', tag: 'img' } } });
  // Bob's own site: never Julie's business.
  const bobSite = await connect(bob, 'https://bob.example');
  await call('/api/comments', { method: 'POST', token: bobSite.token, body: { slug: bobSite.slug, version: 1, text: 'Bob private note', anchor: { kind: 'product', url: 'https://bob.example/', selector: 'h1', tag: 'h1', text: 'Bob' } } });

  const all = async (cookie) => {
    const items = [];
    let offset = 0;
    let first = null;
    for (let i = 0; i < 20 && offset != null; i++) {
      const page = await call(`/api/me/comments?offset=${offset}`, { cookie });
      if (page.status !== 200) return { status: page.status, body: page.body, items };
      first = first || page.body;
      items.push(...page.body.items);
      offset = page.body.next;
    }
    return { status: 200, items, first };
  };

  await t('My docs feed: doc and site comments together, each with its source', async () => {
    const { status, items } = await all(julie);
    assert(status === 200, `status ${status}`);
    const doc = items.find((item) => item.id === docComment.body.id);
    assert(doc && doc.source === 'doc' && doc.title === 'q4-plan' && doc.anchor === 'Ship on Dec 18' && !doc.site, `doc row ${JSON.stringify(doc)}`);
    const s = items.find((item) => item.text === 'Hard to find on a phone');
    assert(s && s.source === 'site' && s.slug === site.slug, `site row ${JSON.stringify(s)}`);
    assert(s.site.host === 'hustlefree.ai' && s.site.origin === 'https://hustlefree.ai', `site host ${JSON.stringify(s.site)}`);
    assert(s.site.page === '/pricing?plan=pro', `page ${s.site.page}`);
    assert(s.site.element === 'button "Start free trial"', `element ${s.site.element}`);
    const l = items.find((item) => item.text === 'Local note');
    assert(l && l.site.host === 'localhost:3000' && l.site.element === 'img.hero-logo', `test site row ${JSON.stringify(l)}`);
    assert(!items.some((item) => item.text === 'Bob private note' || item.slug === 'bob-doc'), 'another person\'s site or doc listed');
    assert(!JSON.stringify(items).includes('allowed_users'), 'feed leaks access policy');
  });

  await t('addresses are redacted per doc: a hidden commenter has a different alias on each doc; one she was invited to shows her as on its page', async () => {
    const { items } = await all(julie);
    const on = (slug) => items.find((item) => item.slug === slug && item.text === `Erin on ${slug}`);
    const a = on('erin-a'), b = on('erin-b'), invited = on('erin-invited');
    assert(a && b && invited, `erin rows ${JSON.stringify(items.filter((i) => /Erin/.test(i.text)).map((i) => i.slug))}`);
    assert(/^email-alias:[0-9a-f]{12}$/.test(a.author.key) && /^email-alias:[0-9a-f]{12}$/.test(b.author.key), `aliases ${a.author.key} ${b.author.key}`);
    assert(a.author.key !== b.author.key, 'the same alias across docs');
    assert(!JSON.stringify([a, b]).includes(ERIN), 'a hidden address leaks');
    // The doc page shows the owner the address she invited; so does the feed.
    const page = await call('/api/comments?slug=erin-invited', { cookie: julie });
    const there = (Array.isArray(page.body) ? page.body : []).find((c) => c.text === 'Erin on erin-invited');
    assert(there && JSON.stringify(there.author).includes(ERIN), `doc page ${JSON.stringify(there && there.author)}`);
    assert(invited.author.key === `email:${ERIN}`, `invited ${JSON.stringify(invited.author)}`);
    // And the same doc's alias is the one its own page gives.
    const pageA = await call('/api/comments?slug=erin-a', { cookie: julie });
    assert(pageA.body.find((c) => c.text === 'Erin on erin-a').author.login === a.author.key, 'feed alias differs from the doc page');
  });

  await t('the deploy operator\'s feed includes docs that name no owner; nobody else\'s does', async () => {
    assert((await all(julie)).items.some((item) => item.slug === 'legacy-note' && item.text === 'Operator note'), 'operator misses the ownerless doc');
    assert(!(await all(bob)).items.some((item) => item.slug === 'legacy-note'), 'a stranger sees the ownerless doc');
  });

  await t('a stranger gets none of them; anonymous and a feedback token are refused', async () => {
    const { status, items } = await all(bob);
    assert(status === 200, `bob ${status}`);
    assert(!items.some((item) => item.slug === site.slug || item.slug === 'q4-plan' || item.slug === local.slug), `bob sees Julie's comments ${JSON.stringify(items.map((i) => i.slug))}`);
    assert(items.some((item) => item.text === 'Bob private note'), 'bob sees his own site');
    const anon = await call('/api/me/comments');
    assert(anon.status === 401, `anonymous ${anon.status}`);
    const token = await call('/api/me/comments', { token: site.token });
    assert(token.status === 401 || token.status === 403, `feedback token ${token.status}`);
  });

  await t('reading Julie\'s site by its link is not joining it: still nothing for Bob', async () => {
    await call('/api/doc/access', { method: 'PATCH', cookie: julie, body: { slug: site.slug, access: { visibility: 'unlisted' } } });
    const opened = await call(`/d/${site.slug}`, { cookie: bob });
    assert(opened.status === 200, `bob opens the link ${opened.status}`);
    const { items } = await all(bob);
    assert(!items.some((item) => item.slug === site.slug), 'link reader sees the site in My docs');
    await call('/api/doc/access', { method: 'PATCH', cookie: julie, body: { slug: site.slug, access: { visibility: 'private' } } });
  });

  await t('the feed is read in bounded pages of documents', async () => {
    const first = await call('/api/me/comments?offset=0', { cookie: julie });
    assert(first.status === 200 && first.body.docs_scanned <= 12 && first.body.next === first.body.docs_scanned, `page ${JSON.stringify({ ...first.body, items: first.body.items.length })}`);
    assert(first.body.docs_total >= 17, `total ${first.body.docs_total}`);
  });

  let team = null;
  await t('a team site: marked as a site in the team feed for members, not listed in My docs, 404 for a non-member', async () => {
    const created = await call('/api/teams', { method: 'POST', cookie: julie, body: { name: 'Tdoc' } });
    assert(created.status === 200, `team ${created.status}`);
    team = created.body.team;
    const token = team.invite_url.split('/').pop();
    const joined = await call('/api/team/join', { method: 'POST', cookie: carol, body: { token } });
    assert(joined.status === 200, `join ${joined.status}`);
    const moved = await call('/api/team/move', { method: 'POST', cookie: julie, body: { slugs: [site.slug], team: team.id } });
    assert(moved.status === 200, `move ${moved.status} ${JSON.stringify(moved.body)}`);
    const feed = await call(`/api/team/comments?id=${team.id}`, { cookie: carol });
    assert(feed.status === 200, `carol feed ${feed.status}`);
    const row = feed.body.items.find((item) => item.slug === site.slug);
    assert(row && row.source === 'site' && row.site.host === 'hustlefree.ai' && row.site.page === '/pricing?plan=pro', `team site row ${JSON.stringify(row)}`);
    const outsider = await call(`/api/team/comments?id=${team.id}`, { cookie: dave });
    assert(outsider.status === 404 && !JSON.stringify(outsider.body).includes('Hard to find'), `dave ${outsider.status}`);
    const daveMine = await all(dave);
    assert(daveMine.status === 200 && !daveMine.items.length, `dave My docs ${JSON.stringify(daveMine.items)}`);
    const { items } = await all(julie);
    assert(!items.some((item) => item.slug === site.slug), 'a team site also listed in My docs');
    assert(items.some((item) => item.slug === local.slug), 'personal site gone');
  });

  await t('a scoped token cannot read the My docs feed', async () => {
    const issued = await call('/api/hosted/token/scoped', { method: 'POST', cookie: julie, body: { workspaces: ['me'] } });
    assert(issued.status === 200 && issued.body.token, `mint ${issued.status} ${JSON.stringify(issued.body)}`);
    const r = await call('/api/me/comments', { token: issued.body.token });
    assert(r.status === 401 || r.status === 403, `scoped token ${r.status}`);
  });

  // A page of the feed at its largest: 12 docs, 120 commenters each, all
  // different. `invited`: how many of each doc's email commenters its owner
  // invited. Warmed through one worker instance (the comment stores migrate
  // their KV rows), then read through a fresh one, whose caches are cold.
  async function bigFeed({ invited = 0 } = {}) {
    const warm = await loadWorker();
    const big = makeEnv(warm.CommentsStore, { TDOC_EMAIL_ALIAS_SECRET: 'test-alias-secret' });
    const cookie = await sessionFor(big, 'olga');
    // As on a deployment where some account was deleted once: addresses are
    // checked against its tombstones (the key pin, worker identityKey).
    const kid = require('crypto').createHmac('sha256', 'tdoc-identity-kid\0test-alias-secret').update('kid').digest('hex').slice(0, 16);
    await big.META.put('account-identity-key', JSON.stringify({ name: 'TDOC_EMAIL_ALIAS_SECRET', kid }));
    for (let d = 0; d < 12; d++) {
      const slug = `big-${String(d).padStart(2, '0')}`;
      const email = (i) => `p${d}x${i}@people.example`;
      await seedDoc(big, slug, 'olga', {
        access: { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: Array.from({ length: invited }, (_, i) => email(i * 3)) },
      });
      await big.META.put(`comments:${slug}`, JSON.stringify(Array.from({ length: 120 }, (_, i) => {
        const account = `acct-p${d}x${i}`;
        const author = i % 3 === 0 ? { login: `email:${email(i)}`, name: email(i), account_id: account }
          : i % 3 === 1 ? { login: `h${d}x${i}`, name: `h${d}x${i}`, account_id: account }
            : { login: `h${d}x${i}`, name: `h${d}x${i}` };
        return { id: `c${d}x${i}`, text: `note ${i}`, created: '2026-11-01T00:00:00.000Z', version: 1, author };
      })));
    }
    const read = async (m) => {
      const r = await m.default.fetch(req('/api/me/comments?offset=0', { cookie }), big, { waitUntil() {} });
      return { status: r.status, body: await r.json() };
    };
    assert((await read(warm)).body.items.length === 1440, 'the big page did not seed');
    const cold = await loadWorker();
    return { big, read: () => read(cold), cookie };
  }
  const countKv = async (kv, fn) => {
    const n = { total: 0 };
    const own = {};
    for (const op of ['get', 'getWithMetadata', 'put', 'delete', 'list']) {
      own[op] = kv[op];
      kv[op] = function counted(...args) { n.total += 1; n[op] = (n[op] || 0) + 1; return own[op].apply(this, args); };
    }
    try { return { out: await fn(), n }; } finally { Object.assign(kv, own); }
  };

  await t('a full page of the feed costs one page of lookups, not one per doc', async () => {
    const { big, read } = await bigFeed();
    const { out, n } = await countKv(big.META, read);
    assert(out.status === 200 && out.body.items.length === 1440, `${out.status} ${out.body.items && out.body.items.length}`);
    console.log(`    KV operations: ${n.total} ${JSON.stringify(n)}`);
    assert(n.total <= 240, `KV operations ${n.total}`);
    assert(!JSON.stringify(out.body).includes('@people.example'), 'a hidden address');
    const keys = out.body.items.map((item) => item.author.key).filter((k) => k.startsWith('email-alias:'));
    assert(keys.length === 480 && new Set(keys).size === 480, `aliases ${keys.length}`);
  });

  await t('past the page\'s lookup limit an invited address is aliased, not shown; a deleted account\'s never is', async () => {
    const { big, read, cookie } = await bigFeed({ invited: 10 });
    const { out, n } = await countKv(big.META, read);
    console.log(`    KV operations: ${n.total}`);
    assert(n.total <= 260, `KV operations ${n.total}`);
    const shown = new Set(JSON.stringify(out.body).match(/p\d+x\d+@people\.example/g) || []);
    assert(shown.size === 20, `addresses shown ${shown.size}`);
    for (const item of out.body.items) {
      const m = item.author.key.match(/^email:(.+)$/);
      if (m) assert(shown.has(m[1]), item.author.key);
    }
    // Those same people's accounts are deleted: gone from the page.
    for (const email of shown) {
      const hash = require('crypto').createHmac('sha256', 'tdoc-deleted-identity-v1\0test-alias-secret').update(`email:${email}`).digest('hex');
      await big.META.put(`account-deleted-identity:${hash}`, JSON.stringify({ at: '2026-11-02T00:00:00.000Z' }));
    }
    const after = await (await loadWorker()).default.fetch(req('/api/me/comments?offset=0', { cookie }), big, { waitUntil() {} });
    assert(after.status === 200 && !(await after.text()).includes('@people.example'), 'a deleted account\'s address is shown');
  });

  await t('long comments: both feeds show what the doc page shows, for the owner, a joined viewer and a team member', async () => {
    const m = await loadWorker();
    const e = makeEnv(m.CommentsStore, { TDOC_EMAIL_ALIAS_SECRET: 'test-alias-secret' });
    const ask = async (path, opts = {}) => {
      const r = await m.default.fetch(req(path, opts), e, { waitUntil() {} });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const [olga, pete, mia] = [await sessionFor(e, 'olga'), await sessionFor(e, 'pete'), await sessionFor(e, 'mia')];
    const ADDRESS = 'zed@longdomain.example';
    // The address straddles the 2000th character at every cut inside it.
    const texts = Array.from({ length: ADDRESS.length + 2 }, (_, i) => `${'x'.repeat(2000 - 2 - i)} @${ADDRESS} end`);
    const made = (await ask('/api/teams', { method: 'POST', cookie: olga, body: { name: 'T' } })).body.team;
    await ask('/api/team/join', { method: 'POST', cookie: mia, body: { token: made.invite_url.split('/').pop() } });
    const rows = (slug) => JSON.stringify(texts.map((text, i) => ({
      id: `${slug}-${i}`, text, created: '2026-11-01T00:00:00.000Z', version: 1,
      author: { login: 'quinn', name: i ? 'quinn' : `${'n'.repeat(92)}@longdomain.example` },
      replies: [{ id: `${slug}-r${i}`, text, created: '2026-11-01T00:00:00.000Z', author: { login: 'quinn', name: 'quinn' } }],
    })));
    await seedDoc(e, 'mine', 'olga');
    const space = (await ask('/api/feedback/connect', { method: 'POST', cookie: olga, body: { origin: 'https://shop.example' } })).body.slug;
    await ask('/api/doc/access', { method: 'PATCH', cookie: olga, body: { slug: space, access: { visibility: 'private', commenting: 'signed_in', allowed_users: ['pete'] } } });
    const joined = await ask('/api/feedback/connect', { method: 'POST', cookie: pete, body: { origin: 'https://shop.example', slug: space } });
    assert(joined.status === 200 && joined.body.slug === space, `pete joins ${joined.status} ${JSON.stringify(joined.body)}`);
    await seedDoc(e, 'team-doc', 'olga', { workspace_id: made.id, access: { visibility: 'private', team: true, commenting: 'signed_in', allowed_users: [] } });
    for (const slug of ['mine', space, 'team-doc']) await e.META.put(`comments:${slug}`, rows(slug));
    const feeds = [
      ['owner, My docs', '/api/me/comments?offset=0', olga, ['mine', space]],
      ['joined viewer, My docs', '/api/me/comments?offset=0', pete, [space]],
      ['team member, team feed', `/api/team/comments?id=${made.id}`, mia, ['team-doc']],
      ['team admin, team feed', `/api/team/comments?id=${made.id}`, olga, ['team-doc']],
    ];
    for (const [who, path, cookie, slugs] of feeds) {
      const { status, body } = await ask(path, { cookie });
      assert(status === 200, `${who} ${status}`);
      for (const slug of slugs) {
        const got = body.items.filter((item) => item.slug === slug);
        assert(got.length === texts.length * 2, `${who} ${slug}: ${got.length} rows`);
        assert(got.every((item) => item.text.length <= 2000 && item.author.name.length <= 100), `${who}: not cut`);
        assert(!/@longd/.test(JSON.stringify(got)) && !/@zed@/.test(JSON.stringify(got)), `${who} ${slug}: part of an address`);
        assert(got.some((item) => / @zed end$/.test(item.text)), `${who} ${slug}: the local part as on the doc page`);
        const page = await ask(`/api/comments?slug=${slug}&version=all`, { cookie });
        for (const thread of page.body) assert(got.find((item) => item.id === thread.id).text === thread.text.slice(0, 2000), `${who} ${slug}: differs from the doc page`);
      }
    }
  });

  // One doc of Olga's, its thread rows as given, read through a worker of its
  // own (cold caches) with KV reads that can be made to fail.
  const ALIAS_SECRET = 'test-alias-secret';
  const hmacHex = (key, text) => require('crypto').createHmac('sha256', key).update(text).digest('hex');
  const tombKey = (email) => `account-deleted-identity:${hmacHex(`tdoc-deleted-identity-v1\0${ALIAS_SECRET}`, `email:${email}`)}`;
  async function oneDoc({ threads, invited = [], gone = [], team = false }) {
    const seedMod = await loadWorker();
    const e = makeEnv(seedMod.CommentsStore, { TDOC_EMAIL_ALIAS_SECRET: ALIAS_SECRET });
    const cookie = await sessionFor(e, 'olga');
    const kid = hmacHex(`tdoc-identity-kid\0${ALIAS_SECRET}`, 'kid').slice(0, 16);
    await e.META.put('account-identity-key', JSON.stringify({ name: 'TDOC_EMAIL_ALIAS_SECRET', kid }));
    for (const email of gone) await e.META.put(tombKey(email), JSON.stringify({ at: '2026-11-02T00:00:00.000Z' }));
    let teamId = '';
    if (team) teamId = (await (await seedMod.default.fetch(req('/api/teams', { method: 'POST', cookie, body: { name: 'T' } }), e, { waitUntil() {} })).json()).team.id;
    await seedDoc(e, 'one', 'olga', { access: { visibility: 'private', commenting: 'signed_in', allowed_users: invited } });
    if (team) await seedDoc(e, 'team-one', 'olga', { workspace_id: teamId, access: { visibility: 'private', team: true, commenting: 'signed_in', allowed_users: invited } });
    const created = '2026-11-01T00:00:00.000Z';
    for (const slug of team ? ['one', 'team-one'] : ['one']) {
      await e.META.put(`comments:${slug}`, JSON.stringify(threads.map((x, i) => ({
        id: `t${i}`, created, version: 1, text: 'note', ...x,
        replies: (x.replies || []).map((y, j) => ({ id: `t${i}r${j}`, created, ...y })),
      }))));
    }
    const get = e.META.get;
    const kv = { failing: null };
    e.META.get = function read(k) { if (kv.failing && kv.failing(String(k))) return Promise.reject(new Error('KV is down')); return get.call(this, k); };
    const client = (m) => async (path) => {
      const r = await m.default.fetch(req(path, { cookie }), e, { waitUntil() {} });
      return { status: r.status, text: await r.text() };
    };
    return { client, kv, teamId, fresh: async () => client(await loadWorker()) };
  }
  const FEED = '/api/me/comments?offset=0';

  await t('the reader\'s own words: a deleted account\'s address does not show, as on the doc page; past the lookup limit none does', async () => {
    const own = { login: 'olga', name: 'olga' };
    const reply = (text) => ({ author: own, agent_status: 'applied', text });
    const one = await oneDoc({ gone: ['gone3@corp.example'], threads: [{ author: own, replies: [reply('ask @gone3@corp.example or @live@corp.example now')] }] });
    const ask = await one.fresh();
    const feed = await ask(FEED);
    assert(feed.status === 200 && JSON.parse(feed.text).items.length === 2, `feed ${feed.status} ${feed.text.slice(0, 200)}`);
    assert(/ask @gone3 or @live@corp\.example now/.test(feed.text), `own words ${feed.text}`);
    const page = await ask('/api/comments?slug=one&version=all');
    assert(/ask @gone3 or @live@corp\.example now/.test(page.text), `doc page ${page.text}`);
    const many = Array.from({ length: 30 }, (_, i) => `live${i}@corp.example`);
    const big = await oneDoc({ threads: [{ author: own, replies: [reply(many.map((m) => `@${m}`).join(' '))] }] });
    const shown = new Set((await (await big.fresh())(FEED)).text.match(/live\d+@corp\.example/g) || []);
    assert(shown.size === 20, `own addresses shown ${shown.size}`);
  });

  await t('an address whose deletion check cannot be read is hidden, the failure is not remembered, and another route\'s failed read changes nothing', async () => {
    const A = 'ann@corp.example';
    const threads = [{ author: { login: `email:${A}`, name: A } }];
    const isTomb = (k) => k.startsWith('account-deleted-identity:');
    const isPin = (k) => k === 'account-identity-key';
    for (const [what, failing] of [['tombstone', isTomb], ['key pin', isPin]]) {
      const live = await oneDoc({ invited: [A], threads });
      const ask = await live.fresh();
      live.kv.failing = failing;
      const down = await ask(FEED);
      assert(down.status === 200 && !down.text.includes('@corp.example'), `${what} read failed: ${down.text}`);
      live.kv.failing = null;
      assert((await ask(FEED)).text.includes(`email:${A}`), `${what}: the failure was remembered`);
      // The doc page reads (and may remember) the same records another way.
      const dead = await oneDoc({ invited: [A], gone: [A], threads });
      const poisoned = await dead.fresh();
      dead.kv.failing = failing;
      const page = await poisoned('/api/comments?slug=one&version=all');
      assert(page.status === 200, `doc page ${page.status}`);
      dead.kv.failing = null;
      const after = await poisoned(FEED);
      assert(after.status === 200 && !after.text.includes('@corp.example'), `${what}: another route's failed read shows it`);
    }
  });

  await t('long names: read quickly in both feeds, and no part of an address in them', async () => {
    const names = [
      `x@${'.'.repeat(40000)} `,
      `${'n'.repeat(40000)} zed@shop.example`,
      `zed@shop.example ${'n'.repeat(40000)}`,
      `by zed@shop.example ${'n'.repeat(200)}`,
      ...Array.from({ length: 24 }, (_, i) => `${'n'.repeat(80 + i)}@longdomain.example`),
      ...Array.from({ length: 24 }, (_, i) => `${'n'.repeat(80 + i)} zed@longdomain.example and more words after it`),
      `@${'n'.repeat(200)}`,
    ];
    const threads = names.flatMap((name) => [{ author: { login: 'quinn', name } }, { author: { login: 'bot', kind: 'agent', name } }]);
    const one = await oneDoc({ threads, team: true });
    const ask = await one.fresh();
    for (const path of [FEED, `/api/team/comments?id=${one.teamId}`]) {
      const started = process.hrtime.bigint();
      const feed = await ask(path);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const items = JSON.parse(feed.text).items;
      assert(feed.status === 200 && items.length === threads.length, `${path} ${feed.status} ${items.length}`);
      console.log(`    ${path.split('?')[0]}: ${Math.round(ms)} ms`);
      assert(ms < 1000, `${path} took ${Math.round(ms)} ms`);
      for (const item of items) {
        assert(item.author.name && item.author.name.length <= 100, `name ${item.author.name.length}`);
        assert(!/@(shop|longd)/.test(item.author.name) && !/@l/.test(item.author.name), `part of an address: ${item.author.name}`);
      }
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
