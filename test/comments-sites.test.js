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
  const env = makeEnv(mod.CommentsStore);
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
