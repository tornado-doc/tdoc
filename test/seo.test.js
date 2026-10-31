// What tdoc says to search engines and fetch tools that run no script:
// /sitemap.xml (site pages + Public docs only), robots.txt's Sitemap line,
// the server-rendered /@handle profile (Public docs only, escaped, canonical
// on the claimed handle), a doc's meta description without its title said
// twice, and schema.org JSON-LD (home page, Public docs only, escaped).
// Privacy is the point: nothing that is not Public may be named anywhere.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const PUBLIC = { visibility: 'public', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] };
const C1 = '2026-03-01T10:00:00.000Z';
const C2 = '2026-04-02T11:00:00.000Z';

async function seed(env, slug, { owner = null, access = PUBLIC, extra = {}, title = slug, html = null, metadata } = {}) {
  const meta = {
    title, slug, created: C1, versions: [{ n: 1, created: C1 }, { n: 2, created: C2 }],
    ...(owner ? { hosted: { account_id: owner.account_id, github_login: owner.login } } : {}),
    ...(access ? { access } : {}),
    ...extra,
  };
  await env.META.put(`meta:${slug}`, JSON.stringify(meta), metadata ? { metadata } : undefined);
  for (const n of [1, 2]) await env.DOCS.put(`docs/${slug}/v${n}/index.html`, html || `<h1>${title}</h1><p>Body of ${slug}.</p>`);
}

function ldBlocks(page) {
  const out = [];
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page))) out.push(m[1]);
  return out;
}

(async () => {
  console.log('SEO: sitemap, robots, profile SSR, descriptions, JSON-LD');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    return { status: r.status, r, text: await r.text() };
  };
  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');

  // The home page and one site page, Public as on tdoc.dev.
  await seed(env, 'tornado-doc', { title: 'Tornado' });
  await seed(env, 'tdoc-pricing', { title: 'Pricing' });
  // Listed: Public, chosen explicitly.
  await seed(env, 'alice-public', { owner: alice });
  await seed(env, 'bob-public', { owner: bob });
  // Never listed.
  await seed(env, 'alice-link', { owner: alice, access: { ...PUBLIC, visibility: 'unlisted' } });
  await seed(env, 'alice-signin', { owner: alice, access: { ...PUBLIC, visibility: 'unlisted', signin_required: true } });
  await seed(env, 'alice-private', { owner: alice, access: { ...PUBLIC, visibility: 'private', allowed_users: ['bob'] } });
  await seed(env, 'alice-team', { owner: alice, extra: { workspace_id: 'team-x' } });
  await seed(env, 'alice-feedback', { owner: alice, extra: { created_from: 'feedback', feedback: { origin: 'https://example.com' } } });
  await seed(env, 'alice-trashed', { owner: alice, extra: { trashed_at: '2026-05-01T00:00:00.000Z', trashed_by: 'alice' } });
  await seed(env, 'alice-deleted', { owner: alice, extra: { trashed_at: '2026-05-01T00:00:00.000Z', account_deleted_at: '2026-05-01T00:00:00.000Z' } });
  // Legacy record with no access field: world-readable for back-compat, but
  // nobody chose to list it.
  await seed(env, 'alice-legacy', { owner: alice, access: null });
  // An index record that claims Public over a private doc: the full record wins.
  await seed(env, 'alice-index-lies', { owner: alice, access: { ...PUBLIC, visibility: 'private' }, metadata: { v: 1, p: 1, a: alice.account_id, u: C2 } });

  const NEVER = ['alice-link', 'alice-signin', 'alice-private', 'alice-team', 'alice-feedback', 'alice-trashed', 'alice-deleted', 'alice-legacy', 'alice-index-lies'];

  await t('/sitemap.xml lists site pages and Public docs with lastmod, nothing else', async () => {
    const { status, r, text } = await call('/sitemap.xml');
    assert(status === 200, `status ${status}`);
    assert((r.headers.get('content-type') || '').startsWith('application/xml'), r.headers.get('content-type'));
    assert(/^public, max-age=\d+$/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
    assert(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && text.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), 'not a sitemap');
    for (const loc of ['https://tdoc.dev/', 'https://tdoc.dev/pricing', 'https://tdoc.dev/feedback', 'https://tdoc.dev/d/alice-public', 'https://tdoc.dev/d/bob-public']) {
      assert(text.includes(`<loc>${loc}</loc>`), `missing ${loc}`);
    }
    assert(text.includes(`<loc>https://tdoc.dev/d/alice-public</loc><lastmod>${C2}</lastmod>`), 'lastmod is the latest version');
    for (const slug of NEVER) assert(!text.includes(slug), `${slug} leaked into the sitemap`);
    // Site pages are listed by their address, never again as /d/<slug>.
    assert(!text.includes('/d/tornado-doc') && !text.includes('/d/tdoc-pricing'), 'site page listed twice');
    // Site pages that were never published are not listed.
    assert(!text.includes('/privacy') && !text.includes('/templates') && !text.includes('/start'), 'unpublished site page listed');
  });

  const flip = async (slug, visibility) => {
    const r = await worker.fetch(req('/api/doc/access', { method: 'PATCH', cookie: alice.cookie, body: { slug, access: { visibility } } }), env, {});
    assert(r.status === 200, `PATCH ${slug} ${r.status} ${await r.text()}`);
  };
  const expire = async () => {
    const stored = JSON.parse(env.META.map.get('sitemap:v1:tdoc.dev'));
    stored.built_at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await env.META.put('sitemap:v1:tdoc.dev', JSON.stringify(stored));
  };

  await t('a doc made Public joins at the next hourly build; one leaving Public leaves at once', async () => {
    try {
      // Through the real API: the record and its index move together.
      await flip('alice-link', 'public');
      assert(env.META.metadata.get('meta:alice-link').p === 1, 'public doc not stamped p=1');
      let text = (await call('/sitemap.xml')).text;
      assert(!text.includes('/d/alice-link'), 'a new Public doc did not wait for the stored copy to age');
      await expire();
      text = (await call('/sitemap.xml')).text;
      assert(text.includes('<loc>https://tdoc.dev/d/alice-link</loc>'), 'newly Public doc missing after the hour');
      // Leaving Public voids the stored copy: gone on the next fetch.
      await flip('alice-public', 'unlisted');
      assert(env.META.metadata.get('meta:alice-public').p === 0, 'unlisted doc not stamped p=0');
      assert(env.META.map.has('sitemap:delisted-at'), 'no de-listing stamp');
      text = (await call('/sitemap.xml')).text;
      assert(!text.includes('alice-public'), 'doc made link-only still listed within the hour');
      for (const slug of NEVER.filter((x) => x !== 'alice-link')) assert(!text.includes(slug), `${slug} leaked after rebuild`);
      // So does making it private.
      await flip('alice-link', 'private');
      text = (await call('/sitemap.xml')).text;
      assert(!text.includes('alice-link'), 'doc made private still listed');
    } finally {
      await flip('alice-link', 'unlisted');
      await flip('alice-public', 'public');
      await expire();
    }
  });

  await t('a carried entry is dropped as soon as its index disagrees, even without a re-read', async () => {
    await call('/sitemap.xml');
    // A record turned private behind the worker's back (no de-listing
    // stamp) but with an index that says so: never listed on a stale verdict.
    const raw = JSON.parse(env.META.map.get('meta:bob-public'));
    await env.META.put('meta:bob-public', JSON.stringify({ ...raw, access: { ...PUBLIC, visibility: 'private' } }), { metadata: { v: 1, p: 0, u: C2 } });
    await expire();
    const text = (await call('/sitemap.xml', {})).text;
    assert(!text.includes('bob-public'), 'carried over a doc whose index says not public');
    await env.META.put('meta:bob-public', JSON.stringify(raw));
    await expire();
  });

  await t('a build made just after a de-listing is not kept for the hour (KV lag)', async () => {
    // A build within the margin may have read the doc before the write
    // reached it; it is replaced on the next fetch, not served for an hour.
    await env.META.put('sitemap:delisted-at', new Date(Date.now() - 1000).toISOString());
    await call('/sitemap.xml');
    const first = JSON.parse(env.META.map.get('sitemap:v1:tdoc.dev')).built_at;
    await new Promise((r) => setTimeout(r, 5));
    await call('/sitemap.xml');
    assert(JSON.parse(env.META.map.get('sitemap:v1:tdoc.dev')).built_at !== first, 'a build inside the margin counted as fresh');
    // Past the margin, the stored build is fresh again.
    await env.META.put('sitemap:delisted-at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
    await call('/sitemap.xml');
    const settled = JSON.parse(env.META.map.get('sitemap:v1:tdoc.dev')).built_at;
    await call('/sitemap.xml');
    assert(JSON.parse(env.META.map.get('sitemap:v1:tdoc.dev')).built_at === settled, 'a settled build was not reused');
  });

  await t('a legacy record found unlisted is read once, not on every build', async () => {
    await call('/sitemap.xml');
    assert(JSON.parse(env.META.map.get('sitemap:v1:tdoc.dev')).unlisted.includes('alice-legacy'), 'legacy verdict not remembered');
    await expire();
    env.META.gets.length = 0;
    const text = (await call('/sitemap.xml')).text;
    assert(!text.includes('alice-legacy'), 'legacy doc listed');
    assert(!env.META.gets.includes('meta:alice-legacy'), 'legacy record read again');
    assert(!env.META.gets.includes('meta:alice-private') && !env.META.gets.includes('meta:alice-team'), 'a doc the index rules out was read');
    assert(env.META.gets.includes('meta:alice-public'), 'Public doc not re-checked against its record');
  });

  await t('robots.txt adds the Sitemap line and keeps every rule', async () => {
    const { status, text } = await call('/robots.txt');
    assert(status === 200, `status ${status}`);
    assert(text.includes('\nSitemap: https://tdoc.dev/sitemap.xml\n'), text);
    assert(text.includes('User-agent: *\nAllow: /\nDisallow: /api/auth/\n'), 'rules changed');
    assert((text.match(/^(User-agent|Allow|Disallow):/gm) || []).length === 3, 'a rule was added or removed');
  });

  // Profiles: alice pins everything; only Public docs may appear.
  await env.META.put(`account-profile:${alice.account_id}`, JSON.stringify({
    account_id: alice.account_id, handle: 'alice-writes', bio: 'Writes "docs" <b>&</b> things',
    pins: ['alice-public', 'alice-evil', ...NEVER],
  }));
  await env.META.put('hosted-handle:alice-writes', JSON.stringify({ account_id: alice.account_id, github_login: 'alice' }));
  await seed(env, 'alice-evil', { owner: alice, title: '</script><script>alert(1)</script> & "quotes"' });

  await t('/@handle server-renders name, Public docs, description, canonical and OG', async () => {
    const { status, text } = await call('/@alice-writes');
    assert(status === 200, `status ${status}`);
    const head = text.slice(0, text.indexOf('</head>'));
    const ssr = text.slice(text.indexOf('<div id="tdoc-app-root">'), text.indexOf('</div>', text.indexOf('<div id="tdoc-app-root">')));
    assert(head.includes('<link rel="canonical" href="https://tdoc.dev/@alice-writes">'), 'canonical');
    assert(head.includes('<meta property="og:url" content="https://tdoc.dev/@alice-writes">'), 'og:url');
    assert(/<meta name="description" content="[^"]*Public docs by @alice-writes on tdoc/.test(head), 'description');
    assert(head.includes('<meta property="og:title" content="@alice-writes · tdoc">') && head.includes('<meta property="og:type" content="profile">'), 'og');
    assert(ssr.includes('<h1>@alice-writes</h1>'), 'name');
    assert(ssr.includes('<a href="https://tdoc.dev/d/alice-public">alice-public</a>'), 'public doc missing');
    for (const slug of NEVER) assert(!text.includes(slug), `${slug} leaked into the profile page`);
    // Escaped everywhere: bio and a hostile title.
    assert(ssr.includes('Writes &quot;docs&quot; &lt;b&gt;&amp;&lt;/b&gt; things'), 'bio not escaped');
    assert(ssr.includes('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'), 'title not escaped');
    assert(!text.includes('</script><script>alert(1)'), 'a title closed a script block');
  });

  await t('the owner viewing their own profile still gets only Public docs in the HTML', async () => {
    const { status, text } = await call('/@alice-writes', { cookie: alice.cookie });
    assert(status === 200, `status ${status}`);
    const ssr = text.slice(text.indexOf('<div id="tdoc-app-root">'), text.indexOf('<script', text.indexOf('<div id="tdoc-app-root">')));
    assert(ssr.includes('/d/alice-public'), 'public doc missing for owner');
    for (const slug of NEVER) assert(!ssr.includes(slug), `${slug} in the owner's server-rendered list`);
  });

  await t('the profile JSON lists no team, feedback or legacy pin', async () => {
    const { text } = await call('/@alice-writes', { headers: { Accept: 'application/json' } });
    const data = JSON.parse(text);
    const slugs = data.docs.map((d) => d.slug);
    assert(slugs.includes('alice-public'), 'public pin missing');
    for (const slug of NEVER) assert(!slugs.includes(slug), `${slug} in the public profile JSON`);
  });

  await t('a GitHub login aliasing a claimed handle points its canonical at the claimed one', async () => {
    const { status, text } = await call('/@alice');
    assert(status === 200, `status ${status}`);
    assert(text.includes('<title>@alice-writes · tdoc</title>'), 'title');
    assert(text.includes('<link rel="canonical" href="https://tdoc.dev/@alice-writes">'), 'alias canonical');
  });

  // Doc pages: description without the title twice, JSON-LD only for Public.
  const CONNECT = '<!doctype html><html><head><title>Connect tdoc to ChatGPT</title></head><body><h1>Connect tdoc to ChatGPT</h1><p>Four steps, about a minute.</p></body></html>';
  await seed(env, 'connect-chatgpt', { owner: alice, title: 'Connect tdoc to ChatGPT', html: CONNECT });
  // A description stored at publish by the old code, title and all.
  await seed(env, 'old-desc', { owner: alice, title: 'Quarterly plan', extra: { preview: { description: 'Quarterly plan Quarterly plan The numbers first.', description_v: 2 } } });

  await t('a doc meta description does not repeat its title', async () => {
    for (const [slug, lead] of [['connect-chatgpt', 'Four steps, about a minute.'], ['old-desc', 'The numbers first.']]) {
      const { status, text } = await call(`/d/${slug}`);
      assert(status === 200, `${slug} ${status}`);
      const desc = (text.match(/<meta name="description" content="([^"]*)"/) || [])[1];
      assert(desc === lead, `${slug}: ${desc}`);
    }
    const shell = require('../server/shell.js');
    assert(shell.stripLeadingTitle('Planning ahead', 'Plan') === 'Planning ahead', 'cut inside a word');
    assert(shell.descriptionFromHtml(CONNECT, 180, 'Connect tdoc to ChatGPT') === 'Four steps, about a minute.', 'publish-time description');
  });

  await t('a Public doc page carries Article JSON-LD, safely escaped', async () => {
    const { text } = await call('/d/alice-evil');
    const blocks = ldBlocks(text);
    assert(blocks.length === 1, `blocks ${blocks.length}`);
    assert(!/<\/script|<script|<!--/i.test(blocks[0]), `unescaped markup in JSON-LD: ${blocks[0]}`);
    const ld = JSON.parse(blocks[0]);
    assert(ld['@type'] === 'Article' && ld['@context'] === 'https://schema.org', 'type');
    assert(ld.headline === '</script><script>alert(1)</script> & "quotes"', `headline ${ld.headline}`);
    assert(ld.datePublished === C1 && ld.dateModified === C2, `dates ${ld.datePublished} ${ld.dateModified}`);
    assert(ld.author && ld.author.name === '@alice-writes' && ld.author.url === 'https://tdoc.dev/@alice-writes', JSON.stringify(ld.author));
    assert(ld.url === 'https://tdoc.dev/d/alice-evil', ld.url);
    assert(!text.includes('</script><script>alert(1)'), 'a title closed a script block');
  });

  await t('no JSON-LD on a doc that is not Public, even for its owner', async () => {
    for (const slug of ['alice-link', 'alice-signin', 'alice-private', 'alice-team', 'alice-legacy']) {
      for (const opts of [{}, { cookie: alice.cookie }]) {
        const { status, text } = await call(`/d/${slug}`, opts);
        if (status !== 200) continue;
        assert(!ldBlocks(text).length && !text.includes('schema.org'), `${slug} (${opts.cookie ? 'owner' : 'anonymous'}) has JSON-LD`);
      }
    }
    const { status, text } = await call('/d/alice-private', { cookie: alice.cookie });
    assert(status === 200 && !text.includes('ld+json'), `owner private page ${status}`);
  });

  await t('the home page carries SoftwareApplication JSON-LD; other site pages none', async () => {
    const home = await call('/');
    const blocks = ldBlocks(home.text);
    assert(blocks.length === 1, `home blocks ${blocks.length}`);
    const ld = JSON.parse(blocks[0]);
    assert(ld['@type'] === 'SoftwareApplication' && ld.url === 'https://tdoc.dev/' && ld.offers && ld.offers.price === '0', JSON.stringify(ld));
    assert(!ldBlocks((await call('/pricing')).text).length, '/pricing has JSON-LD');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
