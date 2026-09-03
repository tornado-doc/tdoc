// The OIDC provider seat, behaviorally — worker.js against a stubbed issuer.
//
// Clerk is the deployment decision, but the seat is spec-shaped: discovery,
// code exchange, userinfo. These tests pin the rules that make the seat
// rug-pull-proof and takeover-proof:
//
//   - unconfigured → the routes bow out and no button flags are advertised;
//   - a verified email mints a session with no login, and the issuer's `sub`
//     is recorded as the authoritative way back to the account (an earlier
//     version refused to store it, calling that lock-in — see below);
//   - an unverified email is refused a session outright;
//   - sign-in resolves an existing account but never mints one;
//   - an OIDC session can approve a pairing, and the redeemed token lands on
//     an email-keyed account that the same email always resolves back to;
//   - that account's docs are browser-manageable via the session's
//     account_id (isDocOwnerSession's canonical-identity path);
//   - CSRF state mismatch is fatal.
//
// Run with: node test/oidc-provider-seat.test.js

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ISSUER = 'https://stub-issuer.example';
const OIDC_ENV = {
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: 'client_stub',
  OIDC_CLIENT_SECRET: 'secret_stub',
  OIDC_LABEL: 'Clerk',
};

const realFetch = globalThis.fetch;
function stubIssuer({ email, verified, name = 'Stub Person', sub = 'user_stub_123' }) {
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
      });
    }
    if (url === `${ISSUER}/oauth/token`) {
      const body = String(init && init.body || '');
      if (!body.includes('client_secret=secret_stub')) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      return Response.json({ access_token: 'at_stub', token_type: 'bearer', id_token: 'unused' });
    }
    if (url === `${ISSUER}/oauth/userinfo`) {
      return Response.json({ sub, email, email_verified: verified, name, picture: '' });
    }
    return realFetch(input, init);
  };
}

// Drive login → callback with a matching state, the way a browser would.
async function signIn(worker, env) {
  const login = await worker.fetch(req('/api/auth/oidc/login?return=%2Factivate'), env, {});
  assert(login.status >= 300 && login.status < 400, `login not a redirect: ${login.status}`);
  const setCookie = login.headers.get('set-cookie') || '';
  const state = (setCookie.match(/tdoc_oidcst=([a-f0-9]+)/) || [])[1];
  assert(state, `no state cookie: ${setCookie}`);
  const cb = await worker.fetch(new Request(
    `https://tdoc.dev/auth/oidc/callback?code=authcode&state=${state}`,
    { headers: { Cookie: `tdoc_oidcst=${state}` } },
  ), env, {});
  return cb;
}

function sessionFrom(env, response) {
  const cookie = response.headers.get('set-cookie') || '';
  const m = cookie.match(/tdoc_sid=([a-f0-9]+)/);
  if (!m) return null;
  const raw = env.META.map.get(`session:${m[1]}`);
  return raw ? { sid: m[1], ...JSON.parse(raw) } : null;
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('oidc provider seat');

  await t('unconfigured: routes bow out, no button is advertised', async () => {
    const env = makeEnv(mod.CommentsStore);
    const r = await worker.fetch(req('/api/auth/oidc/login'), env, {});
    assert(r.status >= 300 && r.status < 400 && (r.headers.get('location') || '').includes('notice=signin'),
      `expected the polite bounce, got ${r.status}`);
    const page = await worker.fetch(req('/activate'), env, {});
    const html = await page.text();
    assert(html.includes('"oidcAuth":false'), 'unconfigured host still advertises the button');
  });

  await t('a verified email becomes a session keyed on the stable sub, not the address', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    stubIssuer({ email: 'Person@Example.COM', verified: true });
    const cb = await signIn(worker, env);
    assert(cb.status >= 300 && cb.status < 400, `callback: ${cb.status} ${await cb.clone().text()}`);
    const session = sessionFrom(env, cb);
    assert(session && session.email === 'person@example.com', `session: ${JSON.stringify(session)}`);
    assert(!('login' in session) || session.login == null, 'OIDC session must not fake a login');
    assert(session.oidc === true, 'session not marked oidc');
    // The session carries the identity so a later mint can link it. Storing
    // `sub` was previously forbidden here on the theory that a vendor's id in
    // our data is lock-in; that had it backwards. Lock-in is about who owns
    // the ACCOUNT — account_id is ours, and every doc hangs off it. `sub` is
    // just the one identifier a provider promises never changes and never
    // reuses, which an email address explicitly is not: hand a departed
    // employee's mailbox to someone new and, without it, they inherit the
    // docs. Drop the provider and this index is dead weight, nothing more.
    assert(session.idp && session.idp.sub === 'user_stub_123',
      `session must carry the provider identity: ${JSON.stringify(session)}`);
    // Still resolve-don't-mint: no account, and so no index of either kind.
    assert(!env.META.map.has('account-email:person@example.com'), 'sign-in minted an account');
    assert(![...env.META.map.keys()].some((k) => k.startsWith('account-idp:')),
      'sign-in wrote an idp index for an account that does not exist');
  });

  await t('an unverified email is refused a session', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    stubIssuer({ email: 'victim@example.com', verified: false });
    const cb = await signIn(worker, env);
    assert(cb.status === 403, `expected 403, got ${cb.status}`);
    assert(!(cb.headers.get('set-cookie') || '').includes('tdoc_sid='), 'a session was minted for an unverified email');
  });

  await t('OIDC session approves a pairing; the token lands on an email-keyed account', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    stubIssuer({ email: 'maker@example.com', verified: true, name: 'Maker' });
    const cb = await signIn(worker, env);
    const session = sessionFrom(env, cb);
    const cookie = `tdoc_sid=${session.sid}`;
    const startR = await worker.fetch(req('/api/cli/pair/start', { method: 'POST', body: { label: 'first-doc' } }), env, {});
    const startD = await startR.json();
    const okR = await worker.fetch(req('/api/cli/pair/approve', { method: 'POST', cookie, body: { user_code: startD.user_code } }), env, {});
    const okD = await okR.json();
    assert(okD.ok === true, `approve: ${okR.status} ${JSON.stringify(okD)}`);
    const pollR = await worker.fetch(req('/api/cli/pair/poll', { method: 'POST', body: { user_code: startD.user_code, pair_secret: startD.pair_secret } }), env, {});
    const pollD = await pollR.json();
    assert(pollD.ok === true && String(pollD.token).startsWith('tdoc_'), `poll: ${JSON.stringify(pollD)}`);
    const rec = JSON.parse(env.META.map.get('account-email:maker@example.com') || 'null');
    assert(rec && rec.account_id === pollD.account_id, `email account missing: ${JSON.stringify(rec)}`);
    assert(!('github_login' in (pollD || {})) || !pollD.github_login, 'an email-born account claims a github_login');
    // The token must actually publish.
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: pollD.token,
      body: { slug: 'oidc-doc', version: 1, html: '<h1>hi</h1>' },
    }), env, {});
    assert(up.status === 200, `upload with email-account token: ${up.status} ${await up.clone().text()}`);
    // And a FRESH sign-in with the same email resolves the same account.
    const cb2 = await signIn(worker, env);
    const session2 = sessionFrom(env, cb2);
    assert(session2.account_id === pollD.account_id, `second sign-in lost the account: ${JSON.stringify(session2)}`);
  });

  await t("the email-born account's docs are browser-manageable via account_id", async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    stubIssuer({ email: 'owner@example.com', verified: true });
    // Publish through pairing…
    const cb = await signIn(worker, env);
    const session = sessionFrom(env, cb);
    const cookie = `tdoc_sid=${session.sid}`;
    const startD = await (await worker.fetch(req('/api/cli/pair/start', { method: 'POST', body: {} }), env, {})).json();
    await worker.fetch(req('/api/cli/pair/approve', { method: 'POST', cookie, body: { user_code: startD.user_code } }), env, {});
    const pollD = await (await worker.fetch(req('/api/cli/pair/poll', { method: 'POST', body: { user_code: startD.user_code, pair_secret: startD.pair_secret } }), env, {})).json();
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: pollD.token,
      body: { slug: 'owned-by-email', version: 1, html: '<h1>mine</h1>' },
    }), env, {});
    // …then mutate access with the SESSION cookie (a second sign-in, so the
    // session carries account_id) — the owner path that used to be
    // GitHub-login-shaped.
    const cb2 = await signIn(worker, env);
    const s2 = sessionFrom(env, cb2);
    const patch = await worker.fetch(req('/api/doc/access', {
      method: 'PATCH', cookie: `tdoc_sid=${s2.sid}`,
      body: { slug: 'owned-by-email', access: { visibility: 'unlisted' } },
    }), env, {});
    assert(patch.status === 200, `owner PATCH via account_id failed: ${patch.status} ${await patch.clone().text()}`);
  });

  await t('a state mismatch is fatal', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    stubIssuer({ email: 'person@example.com', verified: true });
    const cb = await worker.fetch(new Request(
      'https://tdoc.dev/auth/oidc/callback?code=authcode&state=aaaaaaaaaaaaaaaa',
      { headers: { Cookie: 'tdoc_oidcst=bbbbbbbbbbbbbbbb' } },
    ), env, {});
    assert(cb.status === 400, `expected 400, got ${cb.status}`);
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
