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
      assert(/<!-- This is a tdoc document\.[^]*tdoc-pull open-plan[^]*https:\/\/tdoc\.dev\/SKILL\.md[^]*ONBOARDING\.md -->/.test(head), `${path}: no agent comment`);
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

  await t('/llms.txt is public cacheable text built from the remote skill', async () => {
    const { status, r } = await call('/llms.txt');
    assert(status === 200, `llms ${status}`);
    assert((r.headers.get('content-type') || '').startsWith('text/plain'), r.headers.get('content-type'));
    assert(/public, max-age=\d+/.test(r.headers.get('cache-control') || ''), `cache ${r.headers.get('cache-control')}`);
    const body = await r.text();
    const skill = await (await call('/SKILL.md')).r.text();
    const skillBody = skill.replace(/^---\n[\s\S]*?\n---\n+/, '');
    assert(body.endsWith(skillBody), 'llms.txt drifted from REMOTE_SKILL_MD');
    for (const s of ['/d/<slug>/raw', 'https://tdoc.dev/SKILL.md', 'ONBOARDING.md', 'https://tdoc.dev/d/d-hctqbnme', 'Authorization: Bearer']) {
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
