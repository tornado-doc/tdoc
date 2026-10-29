// A new doc published with `tdoc-publish --team <name>` from an account-level
// token lands in that team at once, so a full My docs (the personal hosted
// doc quota) never refuses a doc meant for a team. The team is resolved
// among the account's own teams only; the team's plan limit applies instead.
//
// Run with: node test/team-publish-personal-quota.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const STRIPE = { TDOC_TEAM_FREE_DOCS: '2', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_MONTHLY: 'price_month', STRIPE_PRICE_YEARLY: 'price_year', STRIPE_WEBHOOK_SECRET: 'whsec_test' };

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('team publish vs personal doc quota');
  const origin = { Origin: 'https://tdoc.dev' };
  // Index bookkeeping runs in waitUntil; let it finish so counts read it.
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
  async function call(env, path, opts) {
    const r = await worker.fetch(req(path, opts), env, ctx);
    while (pending.length) await Promise.allSettled(pending.splice(0));
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  }
  const upload = (env, token, slug, extra = {}) => call(env, '/api/upload', {
    method: 'POST', token,
    body: { slug, version: extra.version || 1, html: `<p>${slug}</p>`, meta: { title: slug }, ...(extra.team ? { team: extra.team } : {}), ...(extra.team_default ? { team_default: extra.team_default } : {}) },
  });
  const metaOf = (env, slug) => { const raw = env.META.map.get(`meta:${slug}`); return raw ? JSON.parse(raw) : null; };

  // julie: My docs full (cap 1), member of Crew; bob owns Other.
  async function setup(extra = {}) {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_MAX_DOCS: '1', ...extra });
    const julie = await issue(worker, env, 'julie');
    const bob = await issue(worker, env, 'bob');
    const crew = (await call(env, '/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name: 'Crew' } })).body.team;
    const other = (await call(env, '/api/teams', { method: 'POST', cookie: bob.cookie, headers: origin, body: { name: 'Other' } })).body.team;
    assert((await upload(env, julie.token, 'personal-1')).status === 200, 'first personal doc');
    return { env, julie, bob, crew, other };
  }

  await t('My docs at its cap + --team of a team the account is in: 200, the doc is in the team', async () => {
    const { env, julie, crew } = await setup();
    for (const team of [crew.name, crew.id]) {
      const slug = `for-crew-${team === crew.id ? 'id' : 'name'}`;
      const r = await upload(env, julie.token, slug, { team });
      assert(r.status === 200 && r.body.team === crew.id && r.body.new_doc === true, `${r.status} ${r.text}`);
      const meta = metaOf(env, slug);
      assert(meta.workspace_id === crew.id && meta.access.team === true, JSON.stringify(meta));
      // The CLI's move to the same team afterwards is a no-op.
      const mv = await call(env, '/api/team/move', { method: 'POST', token: julie.token, body: { team: crew.id, slugs: [slug] } });
      assert(mv.status === 200 && metaOf(env, slug).workspace_id === crew.id, `move ${mv.status} ${mv.text}`);
    }
    // Later versions of the team doc publish as before.
    assert((await upload(env, julie.token, 'for-crew-name', { version: 2, team: crew.name })).status === 200, 'v2 refused');
  });

  await t('a doc moved into a team no longer counts toward My docs (Julie saw 200/200 with 65 personal docs)', async () => {
    const { env, julie, crew } = await setup();
    // At the cap of 1: a second personal doc is refused.
    assert((await upload(env, julie.token, 'second')).status === 403, 'second personal doc should be refused at the cap');
    const mv = await call(env, '/api/team/move', { method: 'POST', token: julie.token, body: { team: crew.id, slugs: ['personal-1'] } });
    assert(mv.status === 200 && metaOf(env, 'personal-1').workspace_id === crew.id, `move ${mv.status} ${mv.text}`);
    const r = await upload(env, julie.token, 'second');
    assert(r.status === 200 && !metaOf(env, 'second').workspace_id, `after the move: ${r.status} ${r.text}`);
  });

  await t('the default team (team_default) is still the CLI\'s to apply for an account token', async () => {
    const { env, julie, crew } = await setup();
    const r = await upload(env, julie.token, 'by-default', { team_default: crew.id });
    assert(r.status === 403 && r.body.error === 'quota_docs', `${r.status} ${r.text}`);
  });

  await t('My docs at its cap + no team: 403 quota_docs, as before', async () => {
    const { env, julie } = await setup();
    const r = await upload(env, julie.token, 'no-team');
    assert(r.status === 403 && r.body.error === 'quota_docs' && !metaOf(env, 'no-team'), `${r.status} ${r.text}`);
  });

  await t('--team naming a team the account is not in: no team landing (My docs, its quota applies)', async () => {
    const { env, julie, other } = await setup();
    for (const team of [other.id, other.name, 'nope']) {
      const r = await upload(env, julie.token, `foreign-${team}`.toLowerCase().replace(/[^a-z0-9-]/g, ''), { team });
      assert(r.status === 403 && r.body.error === 'quota_docs', `${team}: ${r.status} ${r.text}`);
    }
    const roomy = await setup({ TDOC_HOSTED_MAX_DOCS: '5' });
    const r = await upload(roomy.env, roomy.julie.token, 'foreign-roomy', { team: roomy.other.id });
    assert(r.status === 200 && r.body.team === null && !metaOf(roomy.env, 'foreign-roomy').workspace_id, `${r.status} ${r.text}`);
    assert(!JSON.stringify(metaOf(roomy.env, 'foreign-roomy')).includes(roomy.other.id), 'foreign team id stored');
  });

  await t('a free team at its doc limit: --team is 402 team_plan_required, nothing written', async () => {
    const { env, julie, crew } = await setup(STRIPE);
    assert((await upload(env, julie.token, 'crew-1', { team: crew.id })).status === 200, 'crew-1');
    assert((await upload(env, julie.token, 'crew-2', { team: crew.id })).status === 200, 'crew-2');
    const r = await upload(env, julie.token, 'crew-3', { team: crew.id });
    assert(r.status === 402 && r.body.error === 'team_plan_required' && !metaOf(env, 'crew-3'), `${r.status} ${r.text}`);
  });

  await t('the provider (admin) token ignores team hints', async () => {
    const { env, crew } = await setup({ TDOC_UPLOAD_TOKEN: 'admin-secret' });
    const r = await upload(env, 'admin-secret', 'admin-doc', { team: crew.id });
    assert(r.status === 200 && !(metaOf(env, 'admin-doc') || {}).workspace_id, `${r.status} ${r.text}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
