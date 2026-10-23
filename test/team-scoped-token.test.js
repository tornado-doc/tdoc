// Team-scoped upload tokens (#65). A reporting agent on a shared machine read
// a doc from one of its person's teams (abby) and posted it into another
// team's channel (BeFreed), because an account token reaches every team its
// person is in. A token narrowed to one team must not read, list, write, move
// or comment outside that team, personal docs included.
//
// Run with: node test/team-scoped-token.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('team-scoped tokens (#65)');
  const origin = { Origin: 'https://tdoc.dev' };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  async function call(env, path, opts) {
    const r = await worker.fetch(req(path, opts), env, ctx);
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  }

  const env = makeEnv(mod.CommentsStore, {});
  const julie = await issue(worker, env, 'julie');
  const mkTeam = async (name) => (await call(env, '/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name } })).body.team;
  const abby = await mkTeam('abby');
  const befreed = await mkTeam('BeFreed');
  const upload = (token, slug, version = 1, access = { visibility: 'private' }) =>
    call(env, '/api/upload', { method: 'POST', token, body: { slug, version, html: `<p>${slug} v${version}</p>`, meta: { title: slug, access } } });
  assert((await upload(julie.token, 'abby-secret')).status === 200, 'abby doc');
  assert((await upload(julie.token, 'befreed-report')).status === 200, 'befreed doc');
  assert((await upload(julie.token, 'personal-notes')).status === 200, 'personal doc');
  assert((await call(env, '/api/team/move', { method: 'POST', token: julie.token, body: { team: abby.id, slugs: ['abby-secret'] } })).status === 200, 'move abby');
  assert((await call(env, '/api/team/move', { method: 'POST', token: julie.token, body: { team: befreed.id, slugs: ['befreed-report'] } })).status === 200, 'move befreed');

  let scoped = null;
  await t('an account token can mint a token narrowed to one of its teams, by name or id', async () => {
    const r = await call(env, '/api/hosted/token/scoped', { method: 'POST', token: julie.token, body: { team: 'befreed', label: 'claire-mac-mini' } });
    assert(r.status === 200 && r.body.token && r.body.scope.team_id === befreed.id, `${r.status} ${r.text}`);
    scoped = r.body.token;
    const who = await call(env, '/api/hosted/whoami', { token: scoped });
    assert(who.status === 200 && who.body.scope_team === befreed.id, who.text);
  });

  await t('the scoped token reads its own team\'s private doc', async () => {
    const r = await call(env, '/d/befreed-report/raw', { token: scoped });
    assert(r.status === 200 && r.text.includes('befreed-report'), `${r.status} ${r.text.slice(0, 120)}`);
  });

  await t('it cannot read another team\'s doc, nor a personal doc, though its person can', async () => {
    for (const slug of ['abby-secret', 'personal-notes']) {
      const r = await call(env, `/d/${slug}/raw`, { token: scoped });
      assert(r.status >= 400 && !r.text.includes(`${slug} v1`), `${slug} leaked: ${r.status} ${r.text.slice(0, 120)}`);
      const full = await call(env, `/d/${slug}/raw`, { token: julie.token });
      assert(full.status === 200, `the account token lost access to ${slug}: ${full.status}`);
    }
  });

  await t('its catalog lists only its team: no other teams, no personal docs', async () => {
    const me = await call(env, '/api/me', { token: scoped });
    assert(me.status === 200, `${me.status} ${me.text.slice(0, 200)}`);
    const slugs = JSON.stringify(me.body);
    assert(!slugs.includes('abby-secret') && !slugs.includes('personal-notes') && !slugs.includes(abby.id), `catalog leaked: ${slugs.slice(0, 400)}`);
    assert(me.body.team_docs.some((row) => row.slug === 'befreed-report'), 'own team doc missing');
    const teams = await call(env, '/api/teams', { token: scoped });
    assert(teams.status === 200 && teams.body.teams.length === 1 && teams.body.teams[0].id === befreed.id, teams.text);
  });

  await t('routes that name another team, or the person\'s own space, are refused', async () => {
    const checks = [
      ['/api/team/comments?id=' + abby.id, {}],
      ['/api/folders?team=' + abby.id, {}],
      ['/api/folders', {}],
      ['/api/teams', { method: 'POST', body: { name: 'Sneaky' } }],
      ['/api/team/move', { method: 'POST', body: { team: abby.id, slugs: ['befreed-report'] } }],
      ['/api/team/move', { method: 'POST', body: { team: null, slugs: ['befreed-report'] } }],
      ['/api/me/tokens', {}],
      ['/api/notify/local/pending', {}],
      ['/api/hosted/token/scoped', { method: 'POST', body: { team: abby.id } }],
    ];
    for (const [path, opts] of checks) {
      const r = await call(env, path, { token: scoped, ...opts });
      assert(r.status === 403 || r.status === 404, `${opts.method || 'GET'} ${path} -> ${r.status} ${r.text.slice(0, 160)}`);
    }
  });

  await t('it publishes new docs straight into its team, and new versions of team docs', async () => {
    const r = await upload(scoped, 'daily-meta-report');
    assert(r.status === 200, `${r.status} ${r.text}`);
    const meta = JSON.parse(env.META.map.get('meta:daily-meta-report'));
    assert(meta.workspace_id === befreed.id && meta.access.team === true, JSON.stringify(meta));
    assert((await upload(scoped, 'befreed-report', 2)).status === 200, 'new version of a team doc refused');
    const back = await call(env, '/d/daily-meta-report/raw', { token: scoped });
    assert(back.status === 200, `its own new doc is unreadable: ${back.status}`);
  });

  await t('it cannot change a doc outside its team, or move a personal doc in', async () => {
    for (const slug of ['abby-secret', 'personal-notes']) {
      const r = await upload(scoped, slug, 2);
      assert(r.status === 403 && r.body.error === 'token_scope', `${slug} v2 -> ${r.status} ${r.text}`);
    }
    const move = await call(env, '/api/team/move', { method: 'POST', token: scoped, body: { team: befreed.id, slugs: ['personal-notes'] } });
    assert(move.status === 403, `moved a personal doc into the team: ${move.status}`);
  });

  await t('it cannot read another team\'s comments', async () => {
    const r = await call(env, '/api/comments?slug=abby-secret', { token: scoped });
    assert(r.status >= 400, `comments of another team's doc: ${r.status} ${r.text.slice(0, 160)}`);
  });

  await t('the account token keeps working everywhere', async () => {
    const me = await call(env, '/api/me', { token: julie.token });
    const all = JSON.stringify(me.body);
    assert(all.includes('abby-secret') && all.includes('personal-notes'), 'account catalog changed');
    assert((await upload(julie.token, 'personal-notes', 2)).status === 200, 'account token cannot publish its own doc');
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
