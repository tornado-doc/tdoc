// The tdoc-owned pairing flow, behaviorally: /api/cli/pair/* + /activate.
//
// This is the CLI sign-in with the provider removed — the worker mints the
// code, the human's browser session approves it, the poll redeems it for an
// upload token. These tests pin the security properties the design doc
// promises (tdoc.dev/d/tdoc-auth-refactor): secret-gated polling with a
// strike cap, session-snapshot approval nothing in a request body can pose
// as, single redemption, registration gating, and rate limits that make
// guessing boring.
//
// Run with: node test/pairing-flow.test.js

const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function start(worker, env, label = 'demo-doc') {
  const r = await worker.fetch(req('/api/cli/pair/start', { method: 'POST', body: { label } }), env, {});
  return { r, data: await r.json() };
}
async function poll(worker, env, user_code, pair_secret) {
  const r = await worker.fetch(req('/api/cli/pair/poll', { method: 'POST', body: { user_code, pair_secret } }), env, {});
  return { r, data: await r.json() };
}
async function approve(worker, env, cookie, user_code) {
  const r = await worker.fetch(req('/api/cli/pair/approve', { method: 'POST', cookie, body: { user_code } }), env, {});
  return { r, data: await r.json() };
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('pairing flow');

  await t('start mints a code and a secret; poll without approval stays pending', async () => {
    const env = makeEnv(mod.CommentsStore);
    const { data } = await start(worker, env);
    assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(data.user_code), `code shape: ${data.user_code}`);
    assert(String(data.pair_secret).startsWith('pairsec_'), 'no pair_secret');
    assert(data.verification_uri.endsWith('/activate'), data.verification_uri);
    assert(data.verification_uri_complete.includes(`code=${data.user_code}`), 'no prefilled uri');
    const p = await poll(worker, env, data.user_code, data.pair_secret);
    assert(p.data.error === 'authorization_pending', `expected pending, got ${JSON.stringify(p.data)}`);
  });

  await t('approve → poll returns a working token exactly once', async () => {
    const env = makeEnv(mod.CommentsStore);
    const { data } = await start(worker, env, 'my-doc');
    const cookie = await putSession(env, 'alice');
    const a = await approve(worker, env, cookie, data.user_code);
    assert(a.data.ok === true && a.data.label === 'my-doc', `approve: ${JSON.stringify(a.data)}`);
    const p1 = await poll(worker, env, data.user_code, data.pair_secret);
    assert(p1.data.ok === true && String(p1.data.token).startsWith('tdoc_'), `redeem: ${JSON.stringify(p1.data)}`);
    assert(p1.data.account_id && p1.data.github_login === 'alice', 'identity fields missing');
    // Replay: the record died with the first redemption.
    const p2 = await poll(worker, env, data.user_code, data.pair_secret);
    assert(p2.data.error === 'expired_token', `replay must fail: ${JSON.stringify(p2.data)}`);
    // And the token actually works against an authenticated route.
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: p1.data.token,
      body: { slug: 'pair-doc', version: 1, html: '<h1>hi</h1>' },
    }), env, {});
    assert(up.status === 200, `minted token rejected: ${up.status} ${await up.clone().text()}`);
  });

  await t("the approver's email becomes the account's merge key", async () => {
    const env = makeEnv(mod.CommentsStore);
    const { data } = await start(worker, env);
    const cookie = await putSession(env, 'carol');
    const sid = cookie.split('=')[1];
    const sess = JSON.parse(env.META.map.get(`session:${sid}`));
    env.META.map.set(`session:${sid}`, JSON.stringify({ ...sess, email: 'carol@example.com' }));
    await approve(worker, env, cookie, data.user_code);
    const p = await poll(worker, env, data.user_code, data.pair_secret);
    assert(p.data.ok === true, JSON.stringify(p.data));
    const idx = JSON.parse(env.META.map.get('account-email:carol@example.com') || 'null');
    assert(idx && idx.account_id === p.data.account_id, 'pairing mint skipped the email key');
  });

  await t('a wrong secret strikes the record and the fifth strike burns it', async () => {
    const env = makeEnv(mod.CommentsStore);
    const { data } = await start(worker, env);
    for (let i = 0; i < 5; i++) {
      const p = await poll(worker, env, data.user_code, 'pairsec_wrong');
      assert(p.data.error === 'expired_token', 'wrong secret must not leak state');
    }
    assert(!env.META.map.has(`pair:${data.user_code}`), 'record survived five strikes');
    // Even the REAL secret is dead now — the code was burned, not locked.
    const p = await poll(worker, env, data.user_code, data.pair_secret);
    assert(p.data.error === 'expired_token', 'burned code answered a poll');
  });

  await t('approve requires a session, and the body cannot pose as one', async () => {
    const env = makeEnv(mod.CommentsStore);
    const { data } = await start(worker, env);
    const anon = await worker.fetch(req('/api/cli/pair/approve', {
      method: 'POST', body: { user_code: data.user_code, login: 'alice', email: 'a@x.com' },
    }), env, {});
    assert(anon.status === 401, `anonymous approve got ${anon.status}`);
    const rec = JSON.parse(env.META.map.get(`pair:${data.user_code}`));
    assert(rec.status === 'pending', 'anonymous request mutated the record');
  });

  await t('a cross-origin page cannot drive approve with an ambient session', async () => {
    const env = makeEnv(mod.CommentsStore);
    const { data } = await start(worker, env);
    const cookie = await putSession(env, 'alice');
    const r = await worker.fetch(new Request('https://tdoc.dev/api/cli/pair/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' },
      body: JSON.stringify({ user_code: data.user_code }),
    }), env, {});
    assert(r.status === 403, `cross-origin approve got ${r.status}`);
  });

  await t('redemption respects the hosted-registration gate', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_REGISTRATION: '0' });
    const { data } = await start(worker, env);
    const cookie = await putSession(env, 'alice');
    await approve(worker, env, cookie, data.user_code);
    const p = await poll(worker, env, data.user_code, data.pair_secret);
    assert(p.r.status === 403 && p.data.error === 'hosted_registration_disabled',
      `gate missing: ${p.r.status} ${JSON.stringify(p.data)}`);
    assert([...env.META.map.keys()].every(k => !k.startsWith('hosted-token:')),
      'a token record exists despite the gate');
  });

  await t('start is rate-limited per IP', async () => {
    const env = makeEnv(mod.CommentsStore);
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const { r } = await start(worker, env);
      if (r.status === 429) { limited = true; break; }
    }
    assert(limited, '25 mints from one IP and no 429');
  });

  await t('lookup names the terminal to a signed-in visitor, and only to one', async () => {
    const env = makeEnv(mod.CommentsStore);
    const { data } = await start(worker, env, 'the-slug');
    const anon = await worker.fetch(req('/api/cli/pair/lookup', {
      method: 'POST', body: { user_code: data.user_code },
    }), env, {});
    assert(anon.status === 401, `anonymous lookup got ${anon.status}`);
    const cookie = await putSession(env, 'alice');
    const r = await worker.fetch(req('/api/cli/pair/lookup', {
      method: 'POST', cookie, body: { user_code: data.user_code },
    }), env, {});
    const d = await r.json();
    assert(d.ok === true && d.label === 'the-slug', JSON.stringify(d));
    assert(!JSON.stringify(d).includes('secret'), 'lookup leaked secret material');
  });

  await t('/activate serves the shell page with a normalized code and no echo of junk', async () => {
    const env = makeEnv(mod.CommentsStore);
    const good = await worker.fetch(req('/activate?code=abcd-2345'), env, {});
    const html = await good.text();
    assert(good.status === 200, `activate got ${good.status}`);
    assert(html.includes('"page":"activate"'), 'not the activate boot');
    assert(html.includes('ABCD-2345'), 'code not normalized into boot');
    const junk = await worker.fetch(req('/activate?code=%3Cscript%3Ealert(1)%3C/script%3E'), env, {});
    const jhtml = await junk.text();
    assert(junk.status === 200, 'junk code must not error');
    assert(!jhtml.includes('<script>alert'), 'unsanitized code echoed');
    assert(jhtml.includes('"code":""'), 'junk code should normalize to empty');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
