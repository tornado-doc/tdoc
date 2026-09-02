// Phase-1 account groundwork: the email merge key, behaviorally.
//
// The refactor's identity rule is: account_id stays the only canonical
// identity; a verified email is the key that routes different sign-in
// methods to the same account. These tests pin the four properties that
// rule depends on, against worker.js with fake bindings and a stubbed
// GitHub (the only outbound calls the auth routes make):
//
//   1. sign-in never mints an account (a commenter is not a publisher, and
//      hasUsedTdoc reads hosted-account presence as "registered");
//   2. sign-in on an EXISTING account attaches the verified email — index
//      written, record enriched, session carrying account_id + email;
//   3. the index is first-writer-wins — a second account with the same
//      verified email must not steal the key;
//   4. the account record rewrite preserves fields it does not know about
//      (the old fixed-shape rewrite erased anything extra on every login).
//
// Run with: node test/account-email-groundwork.test.js

const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// GitHub stand-in: the device poll exchanges a code, reads /user, and — new
// in phase 1 — reads /user/emails. Everything else falls through to the
// real fetch (none of these tests need it).
const realFetch = globalThis.fetch;
function stubGitHub({ login, emails }) {
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'gho_stub', token_type: 'bearer' });
    }
    if (url.includes('api.github.com/user/emails')) {
      return Response.json(emails);
    }
    if (url.includes('api.github.com/user')) {
      return Response.json({ login, avatar_url: '', name: login });
    }
    return realFetch(input, init);
  };
}

async function devicePoll(worker, env) {
  const r = await worker.fetch(req('/api/auth/device/poll', {
    method: 'POST', body: { device_code: 'stub-device-code' },
  }), env, {});
  return { r, data: await r.json() };
}

function kvJson(env, key) {
  const raw = env.META.map.get(key);
  return raw ? JSON.parse(raw) : null;
}

function sessionFromCookie(env, r) {
  const cookie = r.headers.get('set-cookie') || '';
  const m = cookie.match(/tdoc_sid=([a-f0-9]+)/);
  assert(m, `no tdoc_sid in Set-Cookie: ${cookie}`);
  return kvJson(env, `session:${m[1]}`);
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('account email groundwork');

  await t('sign-in never mints an account', async () => {
    const env = makeEnv(mod.CommentsStore);
    stubGitHub({ login: 'spectator', emails: [{ email: 'spec@example.com', primary: true, verified: true }] });
    const { r, data } = await devicePoll(worker, env);
    assert(data.ok === true, `poll failed: ${JSON.stringify(data)}`);
    assert(!env.META.map.has('hosted-account:spectator'),
      'a mere sign-in minted a hosted account — hasUsedTdoc now lies');
    assert(!env.META.map.has('account-email:spec@example.com'),
      'an email index exists for an account that does not');
    const session = sessionFromCookie(env, r);
    assert(session.email === 'spec@example.com', 'session should still carry the verified email');
    assert(!('account_id' in session), 'session claims an account_id no account backs');
  });

  await t('sign-in on an existing account attaches the email key end to end', async () => {
    const env = makeEnv(mod.CommentsStore);
    env.META.map.set('hosted-account:alice', JSON.stringify({
      account_id: 'acct_alice0000', github_login: 'alice', created: '2026-01-01T00:00:00Z',
    }));
    stubGitHub({
      login: 'Alice',
      emails: [
        { email: 'old@example.com', primary: false, verified: true },
        { email: 'Alice@Example.COM', primary: true, verified: true },
      ],
    });
    const { r, data } = await devicePoll(worker, env);
    assert(data.ok === true, `poll failed: ${JSON.stringify(data)}`);
    const idx = kvJson(env, 'account-email:alice@example.com');
    assert(idx && idx.account_id === 'acct_alice0000',
      `index missing/wrong (primary verified email, lowercased): ${JSON.stringify(idx)}`);
    const rec = kvJson(env, 'hosted-account:alice');
    assert(rec.email === 'alice@example.com', `record not enriched: ${JSON.stringify(rec)}`);
    const session = sessionFromCookie(env, r);
    assert(session.account_id === 'acct_alice0000', 'session lacks account_id');
    assert(session.email === 'alice@example.com', 'session lacks email');
  });

  await t('an unverified email attaches nothing', async () => {
    const env = makeEnv(mod.CommentsStore);
    env.META.map.set('hosted-account:mallory', JSON.stringify({
      account_id: 'acct_mallory00', github_login: 'mallory', created: '2026-01-01T00:00:00Z',
    }));
    stubGitHub({ login: 'mallory', emails: [{ email: 'victim@example.com', primary: true, verified: false }] });
    const { data } = await devicePoll(worker, env);
    assert(data.ok === true, `poll failed: ${JSON.stringify(data)}`);
    assert(!env.META.map.has('account-email:victim@example.com'),
      'an UNVERIFIED address wrote the merge key — this is the account-takeover hole');
    assert(!('email' in kvJson(env, 'hosted-account:mallory')), 'record gained an unverified email');
  });

  await t('the email index is first-writer-wins', async () => {
    const env = makeEnv(mod.CommentsStore);
    env.META.map.set('account-email:shared@example.com', JSON.stringify({
      account_id: 'acct_first0000', created: '2026-01-01T00:00:00Z',
    }));
    env.META.map.set('hosted-account:second', JSON.stringify({
      account_id: 'acct_second000', github_login: 'second', created: '2026-01-01T00:00:00Z',
    }));
    stubGitHub({ login: 'second', emails: [{ email: 'shared@example.com', primary: true, verified: true }] });
    const { data } = await devicePoll(worker, env);
    assert(data.ok === true, `poll failed: ${JSON.stringify(data)}`);
    const idx = kvJson(env, 'account-email:shared@example.com');
    assert(idx.account_id === 'acct_first0000',
      `second account stole the key: ${JSON.stringify(idx)}`);
    assert(!('email' in kvJson(env, 'hosted-account:second')),
      'the losing account still claims the email on its record');
  });

  await t('token mint hands a brand-new publisher their email key', async () => {
    // First sign-in of a future publisher: no account yet (test 1 proved none
    // is minted), but the session carries the attested email. The mint at
    // /api/hosted/token is where the account is born — with its key.
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'newpub');
    const sid = cookie.split('=')[1];
    const sess = kvJson(env, `session:${sid}`);
    env.META.map.set(`session:${sid}`, JSON.stringify({ ...sess, email: 'newpub@example.com' }));
    const r = await worker.fetch(req('/api/hosted/token', {
      method: 'POST', cookie, body: { label: 'first' },
    }), env, {});
    const data = await r.json();
    assert(r.status === 200 && data.ok, `mint failed: ${JSON.stringify(data)}`);
    const rec = kvJson(env, 'hosted-account:newpub');
    assert(rec && rec.email === 'newpub@example.com', `minted account lacks email: ${JSON.stringify(rec)}`);
    const idx = kvJson(env, 'account-email:newpub@example.com');
    assert(idx && idx.account_id === rec.account_id, 'index not written at mint');
  });

  await t('a client cannot smuggle an email through the mint body', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'honest'); // session has NO email
    const r = await worker.fetch(req('/api/hosted/token', {
      method: 'POST', cookie, body: { label: 'x', email: 'attacker@example.com', verified_email: 'attacker@example.com' },
    }), env, {});
    assert(r.status === 200, `mint failed: ${r.status}`);
    assert(!env.META.map.has('account-email:attacker@example.com'),
      'a body-supplied email reached the merge key — it must only come from the provider');
    assert(!('email' in kvJson(env, 'hosted-account:honest')), 'body email landed on the record');
  });

  await t('the record rewrite preserves fields it does not know about', async () => {
    const env = makeEnv(mod.CommentsStore);
    env.META.map.set('hosted-account:keeper', JSON.stringify({
      account_id: 'acct_keeper000', github_login: 'keeper', created: '2026-01-01T00:00:00Z',
      email: 'keeper@example.com', identities: [{ provider: 'google', sub: 'g-123' }],
    }));
    stubGitHub({ login: 'keeper', emails: [] }); // no scope yet → no email this time
    const { data } = await devicePoll(worker, env);
    assert(data.ok === true, `poll failed: ${JSON.stringify(data)}`);
    const rec = kvJson(env, 'hosted-account:keeper');
    assert(rec.email === 'keeper@example.com', `email erased by rewrite: ${JSON.stringify(rec)}`);
    assert(Array.isArray(rec.identities) && rec.identities[0].sub === 'g-123',
      `future fields erased by rewrite: ${JSON.stringify(rec)}`);
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
