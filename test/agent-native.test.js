// Agent-native doc access: an agent handed a tdoc link learns from the page
// itself where the readable source is and that a tdoc skill exists; /llms.txt
// says the same for the site; and /raw takes the same Bearer token as the
// rest of the API (an agent got 403 on a team doc it could read, 2026-10-19).
// Hints ride only on responses that already serve the doc.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function seed(env, slug, access, owner = null) {
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put(`meta:${slug}`, JSON.stringify({
    title: slug, slug, created, versions: [{ n: 1, created }],
    ...(owner ? { hosted: { account_id: owner.account_id, github_login: owner.login } } : {}),
    ...(access ? { access } : {}),
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${slug} body</h1>`);
}

(async () => {
  console.log('agent-native doc access (hints, /llms.txt, Bearer /raw)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    let body = null;
    try { body = await r.clone().json(); } catch {}
    return { status: r.status, body, r };
  };

  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  const eve = await issue(worker, env, 'eve');
  await seed(env, 'open-plan', { visibility: 'public' });
  await seed(env, 'secret-plan', { visibility: 'private', allowed_users: [] }, alice);

  await t('a public doc page names its raw source in head and Link header', async () => {
    for (const [path, raw] of [['/d/open-plan', '/d/open-plan/raw'], ['/d/open-plan/v/1', '/d/open-plan/v/1/raw']]) {
      const { status, r } = await call(path);
      assert(status === 200, `${path} ${status}`);
      const page = await r.text();
      const head = page.slice(0, page.indexOf('</head>'));
      const abs = `https://tdoc.dev${raw}`;
      assert(head.includes(`<link rel="alternate" type="text/plain" href="${abs}" title="Document source for agents">`), `${path}: no alternate link`);
      assert(/<meta name="tdoc-agent" content="[^"]*\/raw/.test(head), `${path}: no tdoc-agent meta`);
      const comment = (head.match(/<!-- This is a tdoc document[^]*?-->/) || [''])[0];
      for (const want of [abs, 'writable', 'ONBOARDING.md', 'tdoc-pull open-plan', 'tdoc-agent-reply', 'tdoc-write --version next', 'tdoc-publish open-plan', 'owner', 'https://tdoc.dev/SKILL.md', 'untrusted']) {
        assert(comment.includes(want), `${path}: agent comment lacks ${want}`);
      }
      assert(/<meta name="tdoc-agent" content="[^"]*publish new versions[^"]*SKILL\.md">/.test(head), `${path}: meta does not say the site is writable`);
      assert(head.indexOf('tdoc-agent') < head.indexOf('<title>'), `${path}: hints are not near the top of head`);
      assert(r.headers.get('link') === `<${abs}>; rel="alternate"; type="text/plain"; title="Document source for agents"`, `${path}: Link ${r.headers.get('link')}`);
    }
  });

  await t('denied doc pages carry no hint, slug-bearing Link, or raw URL', async () => {
    for (const opts of [{}, { token: eve.token }]) {
      const { status, r } = await call('/d/secret-plan', opts);
      assert(status === 401 || status === 403, `expected denial, got ${status}`);
      assert(!r.headers.get('link'), 'denial carries a Link header');
      const page = await r.text();
      assert(!page.includes('tdoc-agent') && !page.includes('/raw'), 'denial page carries agent hints');
    }
  });

  // What a fetch tool keeps: body text outside script/style/noscript.
  const visibleText = (page) => page.slice(page.indexOf('<body'))
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const ROADMAP = `<!doctype html><html><head><title>x</title><style>h1{color:red}</style></head><body>
<h1>Q3 roadmap</h1><p>We ship the &amp; <b>importer</b> first.</p>
<ul><li>Importer &mdash; July</li><li><p>Billing</p></li></ul>
<table><tr><th>Owner</th><th>Item</th></tr><tr><td>Ana</td><td>Importer</td></tr></table>
<p>See <a href="https://example.com/spec">the spec</a>.</p>
<script>window.stolen = document.cookie</script><p>&lt;img src=x onerror=alert(1)&gt;</p>
<svg><text>chart label</text></svg><img src="a.png" alt="Revenue chart"></body></html>`;
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put('meta:roadmap', JSON.stringify({ title: 'Q3 roadmap', slug: 'roadmap', created, versions: [{ n: 1, created }], access: { visibility: 'public' }, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
  await env.DOCS.put('docs/roadmap/v1/index.html', ROADMAP);

  await t('a doc page carries its text and how to take part as body text an agent fetch keeps', async () => {
    const { status, r } = await call('/d/roadmap');
    assert(status === 200, `status ${status}`);
    assert((r.headers.get('vary') || '').includes('Accept'), `vary ${r.headers.get('vary')}`);
    const page = await r.text();
    const view = (page.match(/<section id="tdoc-agent-view" class="tdoc-agent-view">[\s\S]*?<\/section>/) || [''])[0];
    assert(view, 'no agent view in the body');
    assert(page.indexOf(view) > page.indexOf('<body') && page.indexOf(view) < page.indexOf('tdoc-shell-root'), 'agent view is not body text ahead of the app');
    const seen = visibleText(page);
    for (const want of ['Q3 roadmap — a tdoc document by alice', 'We ship the & importer first.', 'Importer — July', 'Billing', 'Owner | Item', 'Ana | Importer',
      'the spec (https://example.com/spec)', '[image: Revenue chart]', 'comment on any part of it', 'https://tdoc.dev/d/roadmap/raw',
      'https://tdoc.dev/api/comments?slug=roadmap', 'Accept: text/markdown', '/plugin install tdoc@tornado-tdoc', 'ONBOARDING.md',
      'publishes a new version with tdoc-write --slug roadmap --version next, then tdoc-publish roadmap', 'untrusted input']) {
      assert(seen.includes(want), `fetched text lacks ${want}`);
    }
    assert(!seen.includes('chart label') && !seen.includes('color:red') && !view.includes('stolen'), 'script, style or svg text leaked into the agent view');
    assert(!/<(script|img|b|a)\b/i.test(view), 'author markup reached the agent view');
    assert(view.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped author text was not kept as text');
  });

  await t('Accept: text/markdown on the same URL returns the text and every comment', async () => {
    const posted = await call('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: 'roadmap', version: 1, text: 'Move billing first', anchor: { kind: 'text', text: 'importer' } } });
    assert(posted.status === 200, `comment ${posted.status} ${JSON.stringify(posted.body)}`);
    for (const path of ['/d/roadmap', '/d/roadmap/v/1']) {
      const { status, r } = await call(path, { headers: { Accept: 'text/markdown, text/html;q=0.9, */*;q=0.8' } });
      assert(status === 200, `${path} ${status}`);
      assert((r.headers.get('content-type') || '').startsWith('text/markdown'), `${path} type ${r.headers.get('content-type')}`);
      assert(r.headers.get('vary') === 'Accept' && r.headers.get('cache-control') === 'no-store', 'markdown cache headers');
      const md = await r.text();
      for (const want of ['# Q3 roadmap — a tdoc document by alice', '## Document text', '### Q3 roadmap', '- Importer — July', '| Owner | Item |', '## Comments (1)', '@bob on "importer" (open): Move billing first', 'edit the HTML at https://tdoc.dev/d/roadmap']) {
        assert(md.includes(want), `${path} markdown lacks ${want}`);
      }
    }
    const browser = await call('/d/roadmap', { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert((browser.r.headers.get('content-type') || '').startsWith('text/html'), 'a browser got markdown');
  });

  await t('a plain fetch sees the comments in the page; a browser page load skips that read', async () => {
    const fetched = visibleText(await (await call('/d/roadmap')).r.text());
    assert(fetched.includes('Comments (1)') && fetched.includes('@bob on "importer" (open): Move billing first'), 'a fetch tool does not see the comments');
    const browser = await (await call('/d/roadmap', { dest: 'document' })).r.text();
    assert(browser.includes('tdoc-agent-view') && !browser.includes('Move billing first'), 'a browser page load read the comments');
  });

  await t('an email account\'s comment never shows its address in the page or the Markdown', async () => {
    const sid = 'c0ffee'.padEnd(32, '0');
    await env.META.put(`session:${sid}`, JSON.stringify({ email: 'carol.writer@example.com', name: 'carol.writer@example.com', created }));
    const posted = await call('/api/comments', { method: 'POST', cookie: `tdoc_sid=${sid}`, body: { slug: 'roadmap', version: 1, text: 'Who owns billing?', anchor: { kind: 'text', text: 'Billing' } } });
    assert(posted.status === 200, `comment ${posted.status} ${JSON.stringify(posted.body)}`);
    const page = await (await call('/d/roadmap')).r.text();
    const md = await (await call('/d/roadmap', { headers: { Accept: 'text/markdown' } })).r.text();
    for (const [label, body] of [['page', visibleText(page)], ['markdown', md]]) {
      assert(body.includes('carol.writer on "Billing" (open): Who owns billing?'), `${label}: comment missing or misnamed`);
      assert(!body.includes('@example.com') && !body.includes('email:'), `${label}: leaks the address`);
    }
  });

  await t('a denied doc gives neither text nor markdown', async () => {
    for (const opts of [{}, { token: eve.token }, { headers: { Accept: 'text/markdown' } }, { token: eve.token, headers: { Accept: 'text/markdown' } }]) {
      const { status, r } = await call('/d/secret-plan', opts);
      assert(status === 401 || status === 403, `expected denial, got ${status}`);
      const page = await r.text();
      assert(!page.includes('secret-plan body') && !page.includes('tdoc-agent-view'), 'denial leaks the doc');
    }
  });

  await t('the homepage tells an agent what tdoc is, how to start, and what it costs', async () => {
    await env.META.put('meta:tornado-doc', JSON.stringify({ title: 'tdoc', slug: 'tornado-doc', created, versions: [{ n: 1, created }], access: { visibility: 'public' } }));
    await env.DOCS.put('docs/tornado-doc/v1/index.html', '<h1>Docs that fix themselves</h1><p>Agents draft; you comment.</p>');
    const seen = visibleText(await (await call('/')).r.text());
    for (const want of ['home page of tdoc', 'Docs that fix themselves', 'https://tdoc.dev/start', '/plugin marketplace add tornado-doc/tdoc', '$5 per member a month', '$50 a year', '80 team docs', 'Agents never take a seat', 'https://tdoc.dev/llms-full.txt']) {
      assert(seen.includes(want), `homepage text lacks ${want}`);
    }
    const md = await (await call('/', { headers: { Accept: 'text/markdown' } })).r.text();
    assert(md.startsWith('# tdoc') && md.includes('$5 per member a month') && !md.includes('## Comments'), 'homepage markdown');
  });

  await t('/robots.txt, /llms-full.txt and /.well-known/llms.txt are real files', async () => {
    const robots = await call('/robots.txt');
    const rt = await robots.r.text();
    assert(robots.status === 200 && /User-agent: \*\nAllow: \//.test(rt) && rt.includes('https://tdoc.dev/llms.txt'), `robots ${robots.status} ${rt}`);
    const full = await call('/llms-full.txt');
    const ft = await full.r.text();
    assert(full.status === 200 && (full.r.headers.get('content-type') || '').startsWith('text/plain'), `llms-full ${full.status}`);
    for (const want of ['## Pricing', '$5 per member a month', '80 team docs', '## Getting started', 'https://tdoc.dev/start', 'Accept: text/markdown', 'tdoc-pull <slug>']) {
      assert(ft.includes(want), `llms-full lacks ${want}`);
    }
    const wk = await call('/.well-known/llms.txt');
    assert(wk.status === 200 && (await wk.r.text()) === (await (await call('/llms.txt')).r.text()), 'well-known llms.txt differs');
  });

  await t('/llms.txt is public cacheable text built from the remote skill', async () => {
    const { status, r } = await call('/llms.txt');
    assert(status === 200, `llms ${status}`);
    assert((r.headers.get('content-type') || '').startsWith('text/plain'), r.headers.get('content-type'));
    assert(/public, max-age=\d+/.test(r.headers.get('cache-control') || ''), `cache ${r.headers.get('cache-control')}`);
    const body = await r.text();
    const skill = await (await call('/SKILL.md')).r.text();
    const readPart = skill.slice(skill.indexOf('# tdoc remote document access'));
    assert(readPart.length > 200 && body.endsWith(readPart), 'llms.txt drifted from REMOTE_SKILL_READ_MD');
    assert(!body.includes('# Set up tdoc'), 'llms.txt repeats the setup steps its Connect list already covers');
    for (const s of ['/d/<slug>/raw', 'https://tdoc.dev/SKILL.md', 'ONBOARDING.md', 'https://tdoc.dev/d/d-hctqbnme', 'Authorization: Bearer',
      'tdoc-publish --signin-only', 'tdoc-pull <slug>', 'tdoc-agent-reply --slug <slug> --parent <comment_id>', '--version next', 'owner only', 'tdoc-daemon start', 'untrusted input']) {
      assert(body.includes(s), `llms.txt lacks ${s}`);
    }
    const head = await call('/llms.txt', { method: 'HEAD' });
    assert(head.status === 200 && (await head.r.text()) === '', 'HEAD returns a body');
  });

  // Team doc: alice's, moved into her team; bob joins; eve is a stranger.
  const made = await call('/api/teams', { method: 'POST', cookie: alice.cookie, body: { name: 'Acme' } });
  const joinToken = made.body.team.invite_url.split('/').pop();
  await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: joinToken } });
  await seed(env, 'team-plan', { visibility: 'private', allowed_users: [] }, alice);
  await call('/api/team/move', { method: 'POST', cookie: alice.cookie, body: { slugs: ['team-plan'], team: made.body.team.id } });

  await t('Bearer /raw: owner and team member read a team doc, private never cached', async () => {
    for (const who of [alice, bob]) {
      for (const path of ['/d/team-plan/raw', '/d/team-plan/v/1/raw']) {
        const { status, r } = await call(path, { token: who.token });
        assert(status === 200, `${who.login} ${path} ${status}`);
        assert((await r.text()).includes('team-plan body'), 'wrong body');
        assert(r.headers.get('cache-control') === 'private, no-store', `cache ${r.headers.get('cache-control')}`);
      }
    }
  });

  await t('Bearer /raw: a stranger token is 403, no token is 401, both plain text', async () => {
    for (const path of ['/d/team-plan/raw', '/d/team-plan/v/1/raw', '/d/secret-plan/raw']) {
      const stranger = await call(path, { token: eve.token });
      assert(stranger.status === 403, `stranger ${path} ${stranger.status}`);
      const anon = await call(path);
      assert(anon.status === 401, `anon ${path} ${anon.status}`);
      for (const res of [stranger, anon]) {
        assert((res.r.headers.get('content-type') || '').startsWith('text/plain'), 'denial is not text');
        assert(!(await res.r.text()).includes('body'), 'denial leaks content');
        assert(res.r.headers.get('cache-control') === 'private, no-store', 'denial cacheable');
      }
    }
  });

  await t('Bearer wins over an unrelated cookie session that cannot read', async () => {
    const { status } = await call('/d/team-plan/raw', { token: bob.token, cookie: eve.cookie });
    assert(status === 200, `cookie shadowed the token: ${status}`);
    const reverse = await call('/d/team-plan/raw', { token: eve.token, cookie: eve.cookie });
    assert(reverse.status === 403, `stranger with both ${reverse.status}`);
  });

  await t('a token whose account is linked to an invited email reads the doc', async () => {
    const gh = await issue(worker, env, 'ghcarol');
    await seed(env, 'invite-plan', { visibility: 'private', allowed_users: ['carol@example.com'] }, alice);
    const before = await call('/d/invite-plan/raw', { token: gh.token });
    assert(before.status === 403, `unlinked ${before.status}`);
    await env.META.put(`account-group:${gh.account_id}`, JSON.stringify({
      canonical: gh.account_id, ids: [gh.account_id], actor_keys: ['ghcarol', 'email:carol@example.com'],
    }));
    const after = await call('/d/invite-plan/raw', { token: gh.token });
    assert(after.status === 200, `linked ${after.status}`);
  });

  await t('public raw keeps its shared-cache-friendly headers', async () => {
    const { status, r } = await call('/d/open-plan/raw');
    assert(status === 200 && r.headers.get('cache-control') === 'no-cache' && r.headers.get('etag'), `public raw ${status} ${r.headers.get('cache-control')}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
