// Switching GitHub accounts, one account per person, Sign-in methods (#58).
//
// Sign-in on tdoc.dev runs tdoc -> Clerk (OIDC) -> GitHub. Clerk keeps one
// user per person, but tdoc's own GitHub doors resolved accounts only by the
// GitHub numeric id index, which accounts born through Clerk never had, so
// those doors minted a second, empty account. This suite pins:
//
//   1. every door maps one person to one account (the Clerk path now writes
//      account-idp:github; the first-party door falls back to the verified
//      email; no pointer to another account is ever overwritten)
//   2. on a host with the provider seat, GitHub sign-in goes through it
//   3. after Sign out the Clerk sign-in stops once: sign out of github.com
//   4. Settings -> Sign-in methods: connect (GitHub's account picker),
//      disconnect, and the refusals
//   5. none of it, nor the backfill, makes account A's docs B's
//   6. the backfill (dry run / write) and the read-only duplicate scan
//
// Run with: node test/github-account-switch.test.js

const path = require('path');
const { pathToFileURL } = require('url');
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ISSUER = 'https://issuer.example';
const SEAT = {
  OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec', OIDC_LABEL: 'Email',
  CLERK_SECRET_KEY: 'sk_test_stub', GITHUB_CLIENT_ID: 'Ov23test', GITHUB_CLIENT_SECRET: 'ghsec',
};
// The first-party GitHub doors reopened beside the seat, to prove the
// mapping holds even through them.
const OPEN = { ...SEAT, GITHUB_DIRECT_SIGNIN: '1' };
const ORIGIN = { Origin: 'https://tdoc.dev' };

const realFetch = globalThis.fetch;
function stubProviders({ ghLogin, ghId, ghEmail, ghEmails, oidcSub, oidcEmail, clerkExternal }) {
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('github.com/login/oauth/access_token')) return Response.json({ access_token: 'gho' });
    if (url.includes('api.github.com/user/emails')) {
      return Response.json(ghEmails || (ghEmail ? [{ email: ghEmail, primary: true, verified: true }] : []));
    }
    if (url.includes('api.github.com/user')) return Response.json({ login: ghLogin, id: ghId, name: ghLogin, avatar_url: '' });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, userinfo_endpoint: `${ISSUER}/u` });
    }
    if (url === `${ISSUER}/t`) return Response.json({ access_token: 'at' });
    if (url === `${ISSUER}/u`) return Response.json({ sub: oidcSub, email: oidcEmail, email_verified: true, name: 'Person' });
    if (url.startsWith('https://api.clerk.com/v1/users/')) {
      return Response.json({ external_accounts: clerkExternal
        ? [{ provider: 'oauth_github', provider_user_id: String(clerkExternal.id), username: clerkExternal.username }]
        : [] });
    }
    return realFetch(input, init);
  };
}
const clerkGithub = (sub, email, id, username) => stubProviders({ oidcSub: sub, oidcEmail: email, clerkExternal: { id, username } });
const clerkEmail = (sub, email) => stubProviders({ oidcSub: sub, oidcEmail: email });
const nativeGithub = (login, id, email) => stubProviders({ ghLogin: login, ghId: id, ghEmail: email });

function sessionFrom(env, res) {
  const m = (res.headers.get('set-cookie') || '').match(/tdoc_sid=([a-f0-9]+)/);
  return m ? { sid: m[1], cookie: `tdoc_sid=${m[1]}`, ...JSON.parse(env.META.map.get(`session:${m[1]}`)) } : null;
}

async function clerkSignIn(worker, env) {
  const login = await worker.fetch(req('/api/auth/oidc/login?return=%2F'), env, {});
  const state = ((login.headers.get('set-cookie') || '').match(/tdoc_oidcst=([a-f0-9]+)/) || [])[1];
  assert(state, `no oidc state: ${login.status}`);
  const cb = await worker.fetch(new Request(`https://tdoc.dev/auth/oidc/callback?code=c&state=${state}`,
    { headers: { Cookie: `tdoc_oidcst=${state}` } }), env, {});
  assert(cb.status === 302, `oidc callback: ${cb.status}`);
  return sessionFrom(env, cb);
}

async function nativeSignIn(worker, env) {
  const login = await worker.fetch(req('/api/auth/web/login?return=%2F'), env, {});
  const state = ((login.headers.get('set-cookie') || '').match(/tdoc_oauth=([a-f0-9]+)/) || [])[1];
  assert(state, `no oauth state: ${login.status} ${login.headers.get('location')}`);
  const cb = await worker.fetch(new Request(`https://tdoc.dev/auth/github/callback?code=c&state=${state}`,
    { headers: { Cookie: `tdoc_oauth=${state}` } }), env, {});
  assert(cb.status === 302, `github callback: ${cb.status}`);
  return sessionFrom(env, cb);
}

async function claimAccount(worker, env, sid) {
  const start = await (await worker.fetch(req('/api/cli/pair/start', { method: 'POST', body: {} }), env, {})).json();
  const ap = await worker.fetch(req('/api/cli/pair/approve', { method: 'POST', cookie: `tdoc_sid=${sid}`, body: { user_code: start.user_code } }), env, {});
  assert(ap.status === 200, `approve: ${ap.status}`);
  const poll = await (await worker.fetch(req('/api/cli/pair/poll', {
    method: 'POST', body: { user_code: start.user_code, pair_secret: start.pair_secret },
  }), env, {})).json();
  assert(poll.ok === true, `poll: ${JSON.stringify(poll)}`);
  return poll;
}

const idpOwner = (env, id) => (JSON.parse(env.META.map.get(`account-idp:github:${id}`) || 'null') || {}).account_id;

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const ops = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'identity-ops.mjs')).href);
  const quiet = console.log;
  const warn = console.warn;
  const conflicts = [];
  console.log = (...a) => { if (!(typeof a[0] === 'string' && a[0].startsWith('{"type":"tdoc_product_event"'))) quiet(...a); };
  console.warn = (...a) => {
    if (typeof a[0] === 'string' && a[0].includes('tdoc_identity_conflict')) { conflicts.push(JSON.parse(a[0])); return; }
    warn(...a);
  };
  const call = async (env, p, o) => worker.fetch(req(p, o), env, {});

  console.log('one person, one account, through every door');

  await t('first-party GitHub, twice: same account', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    nativeGithub('ann', 301, 'ann@x.com');
    const acct = (await claimAccount(worker, env, (await nativeSignIn(worker, env)).sid)).account_id;
    assert((await nativeSignIn(worker, env)).account_id === acct, 'second sign-in lost the account');
  });

  await t('first-party GitHub, then Clerk+GitHub, then first-party again: same account', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    nativeGithub('bea', 302, 'bea@x.com');
    const acct = (await claimAccount(worker, env, (await nativeSignIn(worker, env)).sid)).account_id;
    clerkGithub('user_bea', 'bea@x.com', 302, 'bea');
    const viaClerk = await clerkSignIn(worker, env);
    assert(viaClerk.account_id === acct && viaClerk.login === 'bea', JSON.stringify(viaClerk));
    nativeGithub('bea', 302, 'bea@x.com');
    assert((await nativeSignIn(worker, env)).account_id === acct, 'first-party door lost the account');
  });

  await t('Clerk+GitHub, twice: same account', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    clerkGithub('user_cai', 'cai@x.com', 303, 'cai');
    const acct = (await claimAccount(worker, env, (await clerkSignIn(worker, env)).sid)).account_id;
    assert((await clerkSignIn(worker, env)).account_id === acct, 'second sign-in lost the account');
  });

  await t('Clerk+GitHub, then first-party GitHub: same account (the Clerk mint now writes the GitHub id index)', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    clerkGithub('user_dee', 'dee@x.com', 304, 'dee');
    const acct = (await claimAccount(worker, env, (await clerkSignIn(worker, env)).sid)).account_id;
    assert(idpOwner(env, 304) === acct, 'Clerk-born account has no account-idp:github index');
    assert(JSON.parse(env.META.map.get(`account-github:${acct}`)).sub === '304', 'no reverse index');
    nativeGithub('dee', 304, 'dee@x.com');
    const viaNative = await nativeSignIn(worker, env);
    assert(viaNative.account_id === acct, `first-party door: ${viaNative.account_id} != ${acct}`);
    assert((await claimAccount(worker, env, viaNative.sid)).account_id === acct, 'mint made a second account');
  });

  // The shape every Clerk-born account had before this change.
  const preFixClerkAccount = (env) => {
    env.META.map.set('hosted-account:eve', JSON.stringify({ account_id: 'acct_eve000000', github_login: 'eve', email: 'eve@x.com', created: '2026-09-01T00:00:00Z' }));
    env.META.map.set('account-email:eve@x.com', JSON.stringify({ account_id: 'acct_eve000000', created: '2026-09-01T00:00:00Z' }));
  };

  await t('an older Clerk-born account (no GitHub id index) is found by the first-party door through its verified email, not duplicated', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    preFixClerkAccount(env);
    nativeGithub('eve', 305, 'eve@x.com');
    const s = await nativeSignIn(worker, env);
    const minted = await claimAccount(worker, env, s.sid);
    assert(minted.account_id === 'acct_eve000000', `duplicated: ${minted.account_id}`);
    assert(idpOwner(env, 305) === 'acct_eve000000', 'index not written to the existing account');
    assert(JSON.parse(env.META.map.get('hosted-account:eve')).account_id === 'acct_eve000000', 'handle pointer moved');
  });

  await t('an older Clerk-born account heals on its next Clerk sign-in', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    preFixClerkAccount(env);
    clerkGithub('user_eve', 'eve@x.com', 305, 'eve');
    const s = await clerkSignIn(worker, env);
    assert(s.account_id === 'acct_eve000000' && s.github_id === '305', JSON.stringify(s));
    assert(idpOwner(env, 305) === 'acct_eve000000', 'Clerk sign-in did not write the GitHub id index');
  });

  await t('a verified email does not attach a GitHub id to an account already linked to a different one, and no pointer is overwritten', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    nativeGithub('fay', 306, 'shared@corp.com');
    const fay = (await claimAccount(worker, env, (await nativeSignIn(worker, env)).sid)).account_id;
    conflicts.length = 0;
    // A different GitHub user later verifies the same (reassigned) mailbox
    // and wears the name fay renamed away from.
    nativeGithub('fay', 307, 'shared@corp.com');
    const other = await nativeSignIn(worker, env);
    assert(other.account_id !== fay, 'email hint attached a second GitHub id');
    const minted = (await claimAccount(worker, env, other.sid)).account_id;
    assert(minted !== fay, 'mint attached to the other account');
    assert(idpOwner(env, 306) === fay, 'original index changed');
    assert(JSON.parse(env.META.map.get('hosted-account:fay')).account_id === fay, 'handle pointer overwritten');
    assert(conflicts.some((c) => c.kind === 'handle_points_elsewhere'), 'conflict not logged');
    assert(!JSON.stringify(conflicts).includes('@'), 'conflict log carries an email');
  });

  console.log('provider seat: GitHub sign-in goes through Clerk');

  await t('the first-party GitHub door redirects to the provider sign-in, keeping the return path', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    const r = await call(env, '/api/auth/web/login?return=%2Fd%2Fx');
    assert(r.status === 302 && r.headers.get('location') === '/api/auth/oidc/login?prompt=login&return=%2Fd%2Fx', r.headers.get('location'));
  });

  await t('the device-code door is shut (the CLI pairs instead)', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    const r = await call(env, '/api/auth/device/start', { method: 'POST', body: {} });
    assert(r.status === 410 && (await r.json()).error === 'github_signin_moved', `device start ${r.status}`);
    const p = await call(env, '/api/auth/device/poll', { method: 'POST', body: { device_code: 'x' } });
    assert(p.status === 410, `device poll ${p.status}`);
  });

  await t('the feedback connect page offers no separate GitHub button', async () => {
    const { bootData } = require('./helpers/worker-harness');
    const doors = async (env) => bootData(await (await call(env, '/feedback/connect?origin=https%3A%2F%2Fapp.example.com')).text(), '__TDOC_APP_BOOT__').doors;
    const seat = await doors(makeEnv(mod.CommentsStore, SEAT));
    assert(seat.oidc === true && seat.web === false, JSON.stringify(seat));
    const open = await doors(makeEnv(mod.CommentsStore, OPEN));
    assert(open.web === true, `reopened door not offered: ${JSON.stringify(open)}`);
  });

  await t('a host without the seat keeps its own GitHub door, with GitHub\'s account picker', async () => {
    const env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'Ov23test', GITHUB_CLIENT_SECRET: 'ghsec' });
    const r = await call(env, '/api/auth/web/login?return=%2Fme');
    const loc = new URL(r.headers.get('location'));
    assert(loc.origin + loc.pathname === 'https://github.com/login/oauth/authorize', loc.href);
    assert(loc.searchParams.get('prompt') === 'select_account', loc.href);
  });

  console.log('sign out, then sign in as someone else');

  const location = (r) => r.headers.get('location') || '';

  await t('sign out leaves a short-lived switch marker beside clearing the session', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    const cookie = await putSession(env, 'ann');
    const r = await call(env, '/api/auth/logout', { method: 'POST', cookie });
    const set = r.headers.get('set-cookie') || '';
    assert(/tdoc_sid=;/.test(set), set);
    assert(/tdoc_switch=1;[^,]*HttpOnly;[^,]*Max-Age=1800/.test(set), set);
  });

  await t('the first sign-in after sign out says to sign out of github.com, with a way to continue', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    const r = await call(env, '/api/auth/oidc/login?prompt=login&return=%2Fd%2Fx', { cookie: 'tdoc_switch=1' });
    assert(r.status === 200, `expected the notice page, got ${r.status} ${location(r)}`);
    const page = await r.text();
    assert(page.includes('https://github.com/logout') && /different GitHub account/.test(page), 'no github.com/logout guidance');
    assert(page.includes('continue=1') && page.includes('%2Fd%2Fx'), 'continue link lost the return path');
  });

  await t('"Sign in with another account" (switch=1) shows the same notice', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    const r = await call(env, '/api/auth/oidc/login?prompt=login&switch=1&return=%2F');
    assert(r.status === 200 && (await r.text()).includes('https://github.com/logout'), `status ${r.status}`);
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
    const links = src.match(/label: 'Sign in with another account', href: `[^`]*`/g) || [];
    assert(links.length >= 2 && links.every((l) => l.includes('switch=1')), links.join('\n'));
  });

  await t('continue goes on to the provider and clears the marker; a plain sign-in is never interrupted', async () => {
    stubProviders({});
    const env = makeEnv(mod.CommentsStore, SEAT);
    const r = await call(env, '/api/auth/oidc/login?prompt=login&continue=1&return=%2F', { cookie: 'tdoc_switch=1' });
    assert(r.status === 302 && location(r).startsWith(`${ISSUER}/a?`), `${r.status} ${location(r)}`);
    assert(/tdoc_switch=; Path=\/; Max-Age=0/.test(r.headers.get('set-cookie') || ''), 'marker not cleared');
    const plain = await call(env, '/api/auth/oidc/login?return=%2F');
    assert(plain.status === 302 && location(plain).startsWith(`${ISSUER}/a?`), `plain sign-in interrupted: ${plain.status}`);
  });

  console.log('Settings -> Sign-in methods');

  const methods = async (env, cookie) => (await call(env, '/api/me/sign-in-methods', { cookie })).json();
  // Start Connect, then come back from GitHub as `gh`.
  const connect = async (env, s, gh) => {
    const start = await call(env, '/api/me/sign-in-methods/github/connect', { method: 'POST', cookie: s.cookie, headers: ORIGIN, body: { return: '/me?view=settings' } });
    const body = await start.json();
    if (start.status !== 200) return { start, body };
    const state = ((start.headers.get('set-cookie') || '').match(/tdoc_oauth=([a-f0-9]+)/) || [])[1];
    nativeGithub(gh.login, gh.id, null);
    const cb = await worker.fetch(new Request(`https://tdoc.dev/auth/github/callback?code=c&state=${state}`,
      { headers: { Cookie: `tdoc_oauth=${state}; ${s.cookie}` } }), env, {});
    return { start, body, cb };
  };

  await t('lists the linked email and GitHub account; disconnect is offered while email remains', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    clerkGithub('user_gia', 'gia@x.com', 401, 'gia');
    const s = await clerkSignIn(worker, env);
    await claimAccount(worker, env, s.sid);
    const m = await methods(env, s.cookie);
    assert(m.emails.length === 1 && m.emails[0] === 'gia@x.com', JSON.stringify(m));
    assert(m.github && m.github.id === '401' && m.github.login === 'gia' && /avatars\.githubusercontent\.com\/u\/401/.test(m.github.avatar_url), JSON.stringify(m.github));
    assert(m.can_disconnect_github === true && m.connect_available === false, JSON.stringify(m));
  });

  await t('connect goes through GitHub\'s account picker and links the chosen account to the signed-in one', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    clerkEmail('user_hal', 'hal@x.com');
    const s = await clerkSignIn(worker, env);
    const acct = (await claimAccount(worker, env, s.sid)).account_id;
    const before = await methods(env, s.cookie);
    assert(!before.github && before.connect_available, JSON.stringify(before));
    const { start, body, cb } = await connect(env, s, { login: 'hal-gh', id: 402 });
    const auth = new URL(body.url);
    assert(start.status === 200 && auth.searchParams.get('prompt') === 'select_account', body.url);
    assert(cb.status === 302 && location(cb) === '/me?view=settings&connected=github', `${cb.status} ${location(cb)}`);
    assert(idpOwner(env, 402) === acct, 'not linked to the signed-in account');
    const after = await methods(env, s.cookie);
    assert(after.github && after.github.login === 'hal-gh', JSON.stringify(after));
    const sess = JSON.parse(env.META.map.get(`session:${s.sid}`));
    assert(!sess.login, 'connect changed the session login');
    // ...and that GitHub account now signs in to this account through Clerk.
    clerkGithub('user_hal_gh', 'hal-gh@users.example', 402, 'hal-gh');
    assert((await clerkSignIn(worker, env)).account_id === acct, 'connected GitHub does not reach the account');
  });

  await t('connect refuses a GitHub account that is linked to a different account', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    clerkGithub('user_ivy', 'ivy@x.com', 403, 'ivy');
    const ivy = (await claimAccount(worker, env, (await clerkSignIn(worker, env)).sid)).account_id;
    clerkEmail('user_jo', 'jo@x.com');
    const jo = await clerkSignIn(worker, env);
    const joAcct = (await claimAccount(worker, env, jo.sid)).account_id;
    const { cb } = await connect(env, jo, { login: 'ivy', id: 403 });
    assert(cb.status === 409, `expected refusal, got ${cb.status}`);
    assert(/linked to a different tdoc account/.test(await cb.text()), 'refusal does not say why');
    assert(idpOwner(env, 403) === ivy, 'index moved');
    assert(!env.META.map.has(`account-github:${joAcct}`), 'linked anyway');
  });

  await t('sign-in methods are browser-session, same-origin only', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    clerkEmail('user_kai', 'kai@x.com');
    const s = await clerkSignIn(worker, env);
    const tok = await claimAccount(worker, env, s.sid);
    const cross = await call(env, '/api/me/sign-in-methods/github/connect', { method: 'POST', cookie: s.cookie, headers: { Origin: 'https://evil.example' }, body: {} });
    assert(cross.status === 403, `cross-origin ${cross.status}`);
    const noOrigin = await call(env, '/api/me/sign-in-methods/github/disconnect', { method: 'POST', cookie: s.cookie, body: {} });
    assert(noOrigin.status === 403, `no origin ${noOrigin.status}`);
    const bearer = await call(env, '/api/me/sign-in-methods', { token: tok.token });
    assert(bearer.status === 403, `bearer ${bearer.status}`);
    const anon = await call(env, '/api/me/sign-in-methods');
    assert(anon.status === 401, `anonymous ${anon.status}`);
  });

  await t('disconnect removes the link and a later Clerk sign-in does not put it back', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    clerkGithub('user_lea', 'lea@x.com', 404, 'lea');
    const s = await clerkSignIn(worker, env);
    const acct = (await claimAccount(worker, env, s.sid)).account_id;
    const r = await call(env, '/api/me/sign-in-methods/github/disconnect', { method: 'POST', cookie: s.cookie, headers: ORIGIN, body: {} });
    assert(r.status === 200, `disconnect ${r.status}`);
    assert(!idpOwner(env, 404) && !env.META.map.has(`account-github:${acct}`), 'link not removed');
    const again = await clerkSignIn(worker, env);
    assert(again.account_id === acct, 'email sign-in lost the account');
    assert(!idpOwner(env, 404), 'Clerk sign-in re-linked a disconnected GitHub account');
    assert(!(await methods(env, again.cookie)).github, 'still listed');
  });

  await t('disconnect is refused when GitHub is the only way in', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    nativeGithub('max', 405, null);
    const s = await nativeSignIn(worker, env);
    await claimAccount(worker, env, s.sid);
    const m = await methods(env, s.cookie);
    assert(m.github && !m.emails.length && m.can_disconnect_github === false, JSON.stringify(m));
    const r = await call(env, '/api/me/sign-in-methods/github/disconnect', { method: 'POST', cookie: s.cookie, headers: ORIGIN, body: {} });
    assert(r.status === 409 && (await r.json()).error === 'last_sign_in_method', `status ${r.status}`);
    assert(idpOwner(env, 405), 'link removed anyway');
  });

  console.log('account A\'s docs never become account B\'s');

  await t('through Clerk sign-in, first-party sign-in, connect, disconnect and the backfill', async () => {
    const env = makeEnv(mod.CommentsStore, { ...OPEN, TDOC_OWNER: 'operator' });
    // A: email-only account with a private doc. A2: GitHub account with one.
    clerkEmail('user_ann', 'ann@a.com');
    const a = await clerkSignIn(worker, env);
    const aTok = await claimAccount(worker, env, a.sid);
    clerkGithub('user_ann2', 'ann2@a.com', 501, 'ann2');
    const a2 = await clerkSignIn(worker, env);
    const a2Tok = await claimAccount(worker, env, a2.sid);
    const priv = { visibility: 'private', commenting: 'invited', history_visibility: 'owner', allowed_users: [] };
    for (const [slug, tok] of [['a-doc', aTok.token], ['a2-doc', a2Tok.token]]) {
      const up = await call(env, '/api/upload', { method: 'POST', token: tok, body: { slug, version: 1, html: '<p>a</p>', meta: { title: slug, access: priv } } });
      assert(up.status === 200, `upload ${slug} ${up.status}`);
    }
    const isolated = async (cookie, who) => {
      const me = await (await call(env, '/api/me', { cookie })).json();
      const slugs = (me.docs || []).map((d) => d.slug);
      assert(!slugs.includes('a-doc') && !slugs.includes('a2-doc'), `${who} lists A's docs: ${slugs}`);
      for (const slug of ['a-doc', 'a2-doc']) {
        const read = await call(env, `/d/${slug}/v/1`, { cookie });
        assert(read.status === 403, `${who} read ${slug}: ${read.status}`);
        const del = await call(env, `/api/doc?slug=${slug}`, { method: 'DELETE', cookie, headers: ORIGIN });
        assert(del.status !== 200, `${who} deleted ${slug}`);
      }
    };
    // B through Clerk (email, then GitHub) and through the first-party door.
    clerkEmail('user_bob', 'bob@b.com');
    const bEmail = await clerkSignIn(worker, env);
    await claimAccount(worker, env, bEmail.sid);
    await isolated(bEmail.cookie, 'B via Clerk email');
    clerkGithub('user_bob2', 'bob2@b.com', 601, 'bob2');
    const bGh = await clerkSignIn(worker, env);
    await claimAccount(worker, env, bGh.sid);
    await isolated(bGh.cookie, 'B via Clerk GitHub');
    nativeGithub('bob2', 601, 'bob2@b.com');
    await isolated((await nativeSignIn(worker, env)).cookie, 'B via first-party GitHub');
    // B tries to connect A2's GitHub (refused), connects its own, disconnects it.
    const refused = await connect(env, bEmail, { login: 'ann2', id: 501 });
    assert(refused.cb.status === 409, `connect of A's GitHub: ${refused.cb.status}`);
    await isolated(bEmail.cookie, 'B after a refused connect');
    const ok = await connect(env, bEmail, { login: 'bob-other', id: 602 });
    assert(ok.cb.status === 302, `connect ${ok.cb.status}`);
    await isolated(bEmail.cookie, 'B after connect');
    const off = await call(env, '/api/me/sign-in-methods/github/disconnect', { method: 'POST', cookie: bEmail.cookie, headers: ORIGIN, body: {} });
    assert(off.status === 200, `disconnect ${off.status}`);
    await isolated(bEmail.cookie, 'B after disconnect');
    // The backfill, run over all of it.
    const kv = { list: async (p) => [...env.META.map.keys()].filter((k) => k.startsWith(p)), get: async (k) => env.META.map.get(k) ?? null, put: async (k, v) => env.META.map.set(k, v) };
    const clerk = { getUser: async () => null, usersByEmail: async () => [] };
    await ops.applyWrites(kv, (await ops.planClerkGithubBackfill({ kv, clerk })).writes);
    await isolated(bEmail.cookie, 'B after the backfill');
    // The operator fallback (#725) stays shut for account-owned docs.
    await isolated(await putSession(env, 'operator'), 'the operator');
    // And A still owns both.
    assert((await call(env, '/d/a-doc/v/1', { cookie: a.cookie })).status === 200, 'A lost its doc');
    assert((await call(env, '/d/a2-doc/v/1', { cookie: a2.cookie })).status === 200, 'A2 lost its doc');
  });

  console.log('backfill and duplicate scan');

  const kvOf = (env) => ({
    list: async (p) => [...env.META.map.keys()].filter((k) => k.startsWith(p)),
    get: async (k) => env.META.map.get(k) ?? null,
    put: async (k, v) => env.META.map.set(k, v),
  });

  await t('the backfill plans the missing index from Clerk, skips conflicts, and writes only when asked', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    preFixClerkAccount(env); // eve: handle record, no id
    env.META.map.set('account-idp:oidc:user_oli', JSON.stringify({ account_id: 'acct_oli000000' }));
    env.META.map.set('account-idp:oidc:user_pat', JSON.stringify({ account_id: 'acct_pat000000' }));
    env.META.map.set('account-idp:github:902', JSON.stringify({ account_id: 'acct_someone00' }));
    const users = {
      user_oli: { external_accounts: [{ provider: 'oauth_github', provider_user_id: '901', username: 'oli' }] },
      user_pat: { external_accounts: [{ provider: 'oauth_github', provider_user_id: '902', username: 'pat' }] },
    };
    const clerk = {
      getUser: async (id) => users[id] || null,
      usersByEmail: async (e) => (e === 'eve@x.com' ? [{ external_accounts: [{ provider: 'oauth_github', provider_user_id: '903', username: 'eve' }] }] : []),
    };
    const kv = kvOf(env);
    const before = new Map(env.META.map);
    const plan = await ops.planClerkGithubBackfill({ kv, clerk });
    assert(env.META.map.size === before.size && [...before].every(([k, v]) => env.META.map.get(k) === v), 'dry run wrote');
    assert(plan.counts.planned === 2 && plan.counts.conflicts === 1, JSON.stringify(plan.counts));
    assert(JSON.stringify(plan.conflicts[0].account_ids) === JSON.stringify(['acct_pat000000', 'acct_someone00']), JSON.stringify(plan.conflicts));
    // What the CLI prints: counts, conflicts, and account / GitHub ids per write.
    const printed = JSON.stringify({ counts: plan.counts, conflicts: plan.conflicts, writes: plan.writes.map((w) => [w.key.split(':')[0], w.account_id, w.github_id, w.source]) });
    assert(!printed.includes('@'), 'printed output carries an email');
    await ops.applyWrites(kv, plan.writes);
    assert(idpOwner(env, 901) === 'acct_oli000000' && idpOwner(env, 903) === 'acct_eve000000', 'index not written');
    assert(idpOwner(env, 902) === 'acct_someone00', 'conflicting index overwritten');
    nativeGithub('eve', 903, 'other@x.com');
    assert((await nativeSignIn(worker, env)).account_id === 'acct_eve000000', 'backfilled account not found by id');
    const rerun = await ops.planClerkGithubBackfill({ kv, clerk });
    assert(rerun.counts.planned === 0, `not idempotent: ${JSON.stringify(rerun.counts)}`);
  });

  await t('the duplicate scan reports splits and mis-owned docs, read-only, with account ids only', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    const put = (k, v) => env.META.map.set(k, JSON.stringify(v));
    put('hosted-account:dup', { account_id: 'acct_d1', email: 'dup@x.com', identities: [{ provider: 'github', sub: '700' }] });
    put('account-idp:github:700', { account_id: 'acct_d2', handle: 'dup' });
    put('account-email:dup@x.com', { account_id: 'acct_d3' });
    put('account-group:acct_g1', { canonical: 'acct_g2', ids: ['acct_g1', 'acct_g2'] });
    put('account-group:acct_g2', { canonical: 'acct_g2', ids: ['acct_g1', 'acct_g2'] });
    put('hosted-account:grp', { account_id: 'acct_g1', email: 'grp@x.com' });
    put('account-email:grp@x.com', { account_id: 'acct_g2' });
    put('meta:orphan', { hosted: { account_id: 'acct_gone' } });
    put('meta:merged', { hosted: { account_id: 'acct_g1' } });
    put('meta:dupdoc', { hosted: { account_id: 'acct_d1' } });
    put('meta:fine', { hosted: { account_id: 'acct_g2' } });
    const before = new Map(env.META.map);
    const kv = kvOf(env);
    const report = await ops.scanAccountDuplicates({ kv: { list: kv.list, get: kv.get } });
    assert([...before].every(([k, v]) => env.META.map.get(k) === v) && env.META.map.size === before.size, 'scan wrote');
    const c = report.counts;
    assert(c.github_id_split === 1 && c.email_split === 1, JSON.stringify(c));
    assert(c.handle_vs_github_index_mismatch === 1, JSON.stringify(c));
    assert(c.docs_owner_unknown === 1 && c.docs_owner_merged === 1 && c.docs_owner_in_duplicate_set === 1, JSON.stringify(c));
    assert(JSON.stringify(report.github_id_split) === JSON.stringify([['acct_d1', 'acct_d2']]), JSON.stringify(report.github_id_split));
    const out = JSON.stringify(report);
    assert(!out.includes('@') && !out.includes('dup@') && !/"dup"|"grp"/.test(out), 'report leaks an email or handle');
  });

  console.log('security review fixes');

  // An account linked before #58: GitHub id indexed, no reverse key.
  const preFixNativeAccount = (env) => {
    env.META.map.set('hosted-account:vic', JSON.stringify({ account_id: 'acct_vic000000', github_login: 'vic', email: 'vic@x.com', identities: [{ provider: 'github', sub: '800', handle: 'vic' }] }));
    env.META.map.set('account-idp:github:800', JSON.stringify({ account_id: 'acct_vic000000' }));
    env.META.map.set('account-email:vic@x.com', JSON.stringify({ account_id: 'acct_vic000000' }));
  };

  await t('[1] another GitHub user with the verified email of an older GitHub-linked account (no reverse key) does not take it over', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    preFixNativeAccount(env);
    nativeGithub('mallory', 801, 'vic@x.com');
    const s = await nativeSignIn(worker, env);
    const me = await (await call(env, '/api/me', { cookie: s.cookie })).json();
    assert(s.account_id !== 'acct_vic000000', 'sign-in resolved to the victim');
    const minted = (await claimAccount(worker, env, s.sid)).account_id;
    assert(minted !== 'acct_vic000000', 'mint attached to the victim');
    assert(idpOwner(env, 801) !== 'acct_vic000000', 'index points at the victim');
    assert(Array.isArray(me.docs), 'me');
  });

  await t('[1] only the PRIMARY verified GitHub address is used', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    preFixClerkAccount(env); // eve, Clerk-born shape
    stubProviders({ ghLogin: 'eve', ghId: 811, ghEmails: [
      { email: 'new@x.com', primary: true, verified: false },
      { email: 'eve@x.com', primary: false, verified: true },
    ] });
    const s = await nativeSignIn(worker, env);
    assert(!s.email, `a secondary address was taken: ${s.email}`);
    assert((await claimAccount(worker, env, s.sid)).account_id !== 'acct_eve000000', 'attached through a secondary address');
  });

  await t('[2] after Disconnect and a different Connect, a Clerk sign-in does not restore the old GitHub link or handle', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    clerkGithub('user_lea', 'lea@x.com', 404, 'lea');
    const s = await clerkSignIn(worker, env);
    const acct = (await claimAccount(worker, env, s.sid)).account_id;
    const fresh = await clerkSignIn(worker, env); // caches github_id/handle on the oidc link
    assert((await call(env, '/api/me/sign-in-methods/github/disconnect', { method: 'POST', cookie: fresh.cookie, headers: ORIGIN, body: {} })).status === 200, 'disconnect');
    const linked = await connect(env, fresh, { login: 'lea-work', id: 777 });
    assert(linked.cb.status === 302, `connect ${linked.cb.status}`);
    clerkGithub('user_lea', 'lea@x.com', 404, 'lea');
    const again = await clerkSignIn(worker, env);
    assert(again.account_id === acct, 'lost the account');
    assert(!idpOwner(env, 404), 'disconnected GitHub id re-linked');
    assert(again.login !== 'lea', 'disconnected handle restored on the session');
    assert(JSON.parse(env.META.map.get(`account-github:${acct}`)).sub === '777', 'connected GitHub replaced');
  });

  // Starts tdoc's own GitHub sign-in and returns the callback response.
  const nativeCallback = async (env) => {
    const login = await call(env, '/api/auth/web/login?return=%2F');
    const state = ((login.headers.get('set-cookie') || '').match(/tdoc_oauth=([a-f0-9]+)/) || [])[1];
    return worker.fetch(new Request(`https://tdoc.dev/auth/github/callback?code=c&state=${state}`, { headers: { Cookie: `tdoc_oauth=${state}` } }), env, {});
  };

  await t('[3][N2] a disconnected GitHub id signing in through tdoc\'s own door is refused with a clear message: no re-link, no empty second account', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    clerkGithub('user_nia', 'nia@x.com', 410, 'nia');
    const s = await clerkSignIn(worker, env);
    await claimAccount(worker, env, s.sid);
    assert((await call(env, '/api/me/sign-in-methods/github/disconnect', { method: 'POST', cookie: s.cookie, headers: ORIGIN, body: {} })).status === 200, 'disconnect');
    nativeGithub('nia', 410, 'nia@x.com');
    const before = [...env.META.map.keys()].filter((k) => k.startsWith('session:')).length;
    const cb = await nativeCallback(env);
    assert(cb.status === 403, `expected refusal, got ${cb.status}`);
    assert(/was disconnected from your tdoc account/.test(await cb.text()), 'refusal does not say why');
    assert([...env.META.map.keys()].filter((k) => k.startsWith('session:')).length === before, 'a session was created');
    assert(!idpOwner(env, 410), 'GitHub id linked to some account');
    const dev = await call(env, '/api/auth/device/poll', { method: 'POST', body: { device_code: 'dc' } });
    const body = await dev.json();
    assert(dev.status === 403 && body.error === 'github_disconnected', `device poll ${dev.status} ${JSON.stringify(body)}`);
    // A session that already carries the id cannot mint around it either.
    const sneaky = await putSession(env, 'nia');
    const sid = sneaky.split('=')[1];
    env.META.map.set(`session:${sid}`, JSON.stringify({ login: 'nia', email: 'nia@x.com', idp: { provider: 'github', sub: '410' }, created: new Date().toISOString() }));
    const mint = await call(env, '/api/hosted/token', { method: 'POST', cookie: sneaky, body: { label: 'x' } });
    assert(mint.status !== 200, `minted: ${mint.status}`);
    assert(!idpOwner(env, 410), 'mint linked the disconnected id');
  });

  await t('[3] Disconnect is not offered on a host with no email sign-in', async () => {
    const env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'Ov23test', GITHUB_CLIENT_SECRET: 'ghsec' });
    nativeGithub('oz', 412, 'oz@x.com');
    const s = await nativeSignIn(worker, env);
    await claimAccount(worker, env, s.sid);
    const m = await methods(env, s.cookie);
    assert(m.github && m.emails.length === 1 && m.can_disconnect_github === false, JSON.stringify(m));
    const r = await call(env, '/api/me/sign-in-methods/github/disconnect', { method: 'POST', cookie: s.cookie, headers: ORIGIN, body: {} });
    assert(r.status === 409, `disconnect ${r.status}`);
  });

  await t('[4] a non-Clerk OIDC host keeps tdoc\'s GitHub door, and its sign-out note names no third party', async () => {
    stubProviders({});
    const env = makeEnv(mod.CommentsStore, { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec', GITHUB_CLIENT_ID: 'Ov23test', GITHUB_CLIENT_SECRET: 'ghsec' });
    const web = await call(env, '/api/auth/web/login?return=%2F');
    assert(location(web).startsWith('https://github.com/login/oauth/authorize'), location(web));
    const dev = await call(env, '/api/auth/device/start', { method: 'POST', body: {} });
    assert(dev.status !== 410, 'device door shut on a non-Clerk host');
    const page = await (await call(env, '/api/auth/oidc/login?switch=1&return=%2F')).text();
    assert(!page.includes('github.com/logout') && /sign-in provider/.test(page), 'GitHub-specific note on a non-Clerk host');
    const clerkByIssuer = makeEnv(mod.CommentsStore, { OIDC_ISSUER: 'https://clerk.example.dev', OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec', GITHUB_CLIENT_ID: 'Ov23test', GITHUB_CLIENT_SECRET: 'ghsec' });
    assert(location(await call(clerkByIssuer, '/api/auth/web/login?return=%2F')).startsWith('/api/auth/oidc/login'), 'Clerk issuer not recognised');
  });

  await t('[5] the activate page signs in through the provider seat before any device-code dialog', async () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'shell', 'src', 'activate-page.jsx'), 'utf8');
    const fn = src.slice(src.indexOf('const signIn = () => {'), src.indexOf('setSignInOpen(true);', src.indexOf('const signIn = () => {')));
    assert(fn.indexOf('boot.oidcAuth') >= 0 && fn.indexOf('boot.oidcAuth') < fn.indexOf('boot.webAuth'), 'signIn does not prefer the seat');
  });

  await t('[6] a @handle invite is not mailed when the handle pointer and the GitHub id index disagree', async () => {
    const sent = [];
    const env = makeEnv(mod.CommentsStore, { EMAIL: { send: async (m) => { sent.push(m); } } });
    env.META.map.set('meta:plan', JSON.stringify({ title: 'Plan', created: '2026-01-01T00:00:00Z', versions: [{ n: 1, created: '2026-01-01T00:00:00Z' }], hosted: { account_id: 'acct_owner0000', github_login: 'olivia' } }));
    env.META.map.set('session:feedface01', JSON.stringify({ login: 'olivia', name: 'Olivia', account_id: 'acct_owner0000', created: new Date().toISOString() }));
    env.META.map.set('hosted-account:hank', JSON.stringify({ account_id: 'acct_hank00000', email: 'hank@x.com', identities: [{ provider: 'github', sub: '900' }] }));
    env.META.map.set('account-idp:github:900', JSON.stringify({ account_id: 'acct_other0000' }));
    env.META.map.set('hosted-account:ida', JSON.stringify({ account_id: 'acct_ida000000', email: 'ida@x.com', identities: [{ provider: 'github', sub: '901' }] }));
    env.META.map.set('account-idp:github:901', JSON.stringify({ account_id: 'acct_ida000000' }));
    const r = await worker.fetch(req('/api/doc/access', { method: 'PATCH', cookie: 'tdoc_sid=feedface01', body: { slug: 'plan', access: { visibility: 'private', allowed_users: ['hank', 'ida'] } } }), env, {});
    assert(r.status === 200, `patch ${r.status}`);
    const to = sent.map((m) => m.to);
    assert(!to.includes('hank@x.com'), 'mailed the address behind a disagreeing handle pointer');
    assert(to.includes('ida@x.com'), `consistent handle not mailed: ${JSON.stringify(to)}`);
  });

  await t('[7] the backfill writes neither account when two claim one GitHub id, and skips keys changed since the plan', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    env.META.map.set('account-idp:oidc:user_q1', JSON.stringify({ account_id: 'acct_q1' }));
    env.META.map.set('account-idp:oidc:user_q2', JSON.stringify({ account_id: 'acct_q2' }));
    env.META.map.set('account-idp:oidc:user_r', JSON.stringify({ account_id: 'acct_r' }));
    const users = {
      user_q1: { external_accounts: [{ provider: 'oauth_github', provider_user_id: '950', username: 'q' }] },
      user_q2: { external_accounts: [{ provider: 'oauth_github', provider_user_id: '950', username: 'q' }] },
      user_r: { external_accounts: [{ provider: 'oauth_github', provider_user_id: '951', username: 'r' }] },
    };
    const kv = kvOf(env);
    const plan = await ops.planClerkGithubBackfill({ kv, clerk: { getUser: async (id) => users[id], usersByEmail: async () => [] } });
    const both = plan.conflicts.find((c) => c.kind === 'github_id_claimed_by_two_accounts');
    assert(both && JSON.stringify(both.account_ids) === JSON.stringify(['acct_q1', 'acct_q2']), JSON.stringify(plan.conflicts));
    assert(!plan.writes.some((w) => w.github_id === '950'), 'wrote a contested id');
    // A sign-in links 951 elsewhere between plan and apply.
    env.META.map.set('account-idp:github:951', JSON.stringify({ account_id: 'acct_signed_in' }));
    const res = await ops.applyWrites(kv, plan.writes);
    assert(res.skipped.includes('account-idp:github:951'), JSON.stringify(res));
    assert(idpOwner(env, 951) === 'acct_signed_in', 'overwrote the concurrent link');
    assert(!env.META.map.has('identity-reverse-index:complete'), 'marker written despite a skip');
  });

  await t('[7] the backfill writes reverse keys for older links, then the marker that lets the worker trust them', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    preFixNativeAccount(env);
    const kv = kvOf(env);
    const res = await ops.applyWrites(kv, (await ops.planClerkGithubBackfill({ kv, clerk: { getUser: async () => null, usersByEmail: async () => [] } })).writes);
    assert(!res.skipped.length, JSON.stringify(res));
    assert(JSON.parse(env.META.map.get('account-github:acct_vic000000')).sub === '800', 'reverse key missing');
    assert(env.META.map.has('identity-reverse-index:complete'), 'marker missing');
    nativeGithub('mallory', 801, 'vic@x.com');
    const s = await nativeSignIn(worker, env);
    assert((await claimAccount(worker, env, s.sid)).account_id !== 'acct_vic000000', 'takeover after the backfill');
  });

  await t('[8] a lost race for a GitHub id index stands down and is flagged', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    // Another account's write lands between the check and the read-back.
    const realPut = env.META.put.bind(env.META);
    env.META.put = async (k, v, o) => {
      await realPut(k, v, o);
      if (k === 'account-idp:github:960') await realPut(k, JSON.stringify({ account_id: 'acct_racer000' }));
    };
    conflicts.length = 0;
    clerkGithub('user_sam', 'sam@x.com', 960, 'sam');
    const s = await clerkSignIn(worker, env);
    await claimAccount(worker, env, s.sid);
    assert(idpOwner(env, 960) === 'acct_racer000', 'race winner overwritten');
    assert(conflicts.some((c) => c.kind === 'github_index_race' || c.kind === 'idp_index_race'), JSON.stringify(conflicts));
  });

  console.log('re-review additions');

  await t('[N1] the backfill parks accounts it cannot resolve and withholds the completion marker until a clean run', async () => {
    const env = makeEnv(mod.CommentsStore, OPEN);
    // Handle-only record Clerk cannot resolve (no Clerk user with that GitHub).
    env.META.map.set('hosted-account:quin', JSON.stringify({ account_id: 'acct_quin00000', github_login: 'quin', email: 'quin@x.com' }));
    env.META.map.set('account-email:quin@x.com', JSON.stringify({ account_id: 'acct_quin00000' }));
    const kv = kvOf(env);
    const clerk = { getUser: async () => null, usersByEmail: async () => [] };
    const first = await ops.planClerkGithubBackfill({ kv, clerk });
    assert(first.counts.parked === 1, JSON.stringify(first.counts));
    assert(!first.writes.some((w) => w.source === 'marker'), 'marker planned while something was parked');
    await ops.applyWrites(kv, first.writes);
    assert(JSON.parse(env.META.map.get('account-github:acct_quin00000')).unresolved === true, 'no placeholder');
    assert(!env.META.map.has('identity-reverse-index:complete'), 'marker written');
    // Parked: never attached by email, even in the Clerk-born record shape.
    nativeGithub('quin', 980, 'quin@x.com');
    const s = await nativeSignIn(worker, env);
    assert(s.account_id !== 'acct_quin00000', 'email attached a GitHub id to a parked account');
    // A conflict also withholds the marker.
    env.META.map.set('account-idp:oidc:user_c1', JSON.stringify({ account_id: 'acct_c1' }));
    env.META.map.set('account-idp:github:981', JSON.stringify({ account_id: 'acct_c2' }));
    const withConflict = await ops.planClerkGithubBackfill({ kv, clerk: { ...clerk, getUser: async () => ({ external_accounts: [{ provider: 'oauth_github', provider_user_id: '981', username: 'c' }] }) } });
    assert(withConflict.conflicts.length && !withConflict.writes.some((w) => w.source === 'marker'), 'marker planned despite a conflict');
    // Resolved: the next clean run writes it; the earlier park no longer holds it back.
    env.META.map.delete('account-idp:oidc:user_c1');
    const clean = await ops.planClerkGithubBackfill({ kv, clerk });
    assert(clean.counts.already_parked === 1 && clean.writes.some((w) => w.source === 'marker'), JSON.stringify(clean.counts));
    await ops.applyWrites(kv, clean.writes);
    assert(env.META.map.has('identity-reverse-index:complete'), 'marker not written on a clean run');
    // A real link replaces the placeholder.
    clerkGithub('user_quin', 'quin@x.com', 982, 'quin');
    const healed = await clerkSignIn(worker, env);
    assert(healed.account_id === 'acct_quin00000' && idpOwner(env, 982) === 'acct_quin00000', JSON.stringify(healed));
    assert(JSON.parse(env.META.map.get('account-github:acct_quin00000')).sub === '982', 'placeholder not replaced');
  });

  await t('[N3] the Clerk bridge never moves a handle pointer off another account', async () => {
    const env = makeEnv(mod.CommentsStore, SEAT);
    env.META.map.set('hosted-account:pia', JSON.stringify({ account_id: 'acct_other000', github_login: 'pia' }));
    env.META.map.set('account-idp:github:970', JSON.stringify({ account_id: 'acct_pia000000' }));
    conflicts.length = 0;
    clerkGithub('user_pia', 'pia@new.example', 970, 'pia');
    const s = await clerkSignIn(worker, env);
    assert(s.account_id === 'acct_pia000000', JSON.stringify(s));
    assert(JSON.parse(env.META.map.get('hosted-account:pia')).account_id === 'acct_other000', 'handle pointer moved');
    assert(conflicts.some((c) => c.kind === 'handle_points_elsewhere'), JSON.stringify(conflicts));
  });

  await t('[N4] a *.clerk.accounts.dev issuer is Clerk', async () => {
    const env = makeEnv(mod.CommentsStore, { OIDC_ISSUER: 'https://happy-cat-12.clerk.accounts.dev', OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec', GITHUB_CLIENT_ID: 'Ov23test', GITHUB_CLIENT_SECRET: 'ghsec' });
    assert(location(await call(env, '/api/auth/web/login?return=%2F')).startsWith('/api/auth/oidc/login'), 'dev Clerk issuer not recognised');
    const lookalike = makeEnv(mod.CommentsStore, { OIDC_ISSUER: 'https://login.clerk.accounts.dev.example.com', OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec', GITHUB_CLIENT_ID: 'Ov23test', GITHUB_CLIENT_SECRET: 'ghsec' });
    assert(location(await call(lookalike, '/api/auth/web/login?return=%2F')).startsWith('https://github.com/'), 'look-alike issuer treated as Clerk');
  });

  globalThis.fetch = realFetch;
  console.log = quiet;
  console.warn = warn;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
