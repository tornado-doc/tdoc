// Recycled identifiers must not inherit an account.
//
// Two things a person controls can change hands, and both were load-bearing
// keys here:
//
//   - a GitHub login. Renaming frees the old name for anyone to register.
//     tdoc keyed accounts on `hosted-account:<login>`, so the stranger who
//     took the freed name signed in and got the original owner's documents.
//     No vendor involved — this was live.
//   - an email address. A company reassigns a departed employee's mailbox;
//     the new holder verifies it at any provider and, if an address alone
//     proves identity, walks into the account it used to point at.
//
// The fix is the identifier providers guarantee is immutable and never
// reissued: GitHub's numeric user id, an OIDC issuer's `sub`. Stored under
// `account-idp:<provider>:<sub>` and checked FIRST; the email index survives
// as the hint that merges a new provider into an existing account, used once
// and then superseded by the link.
//
// Run with: node test/identity-recycling.test.js

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ISSUER = 'https://issuer.example';
const OIDC_ENV = {
  OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec', OIDC_LABEL: 'Email',
};

const realFetch = globalThis.fetch;
// Stubs both providers: GitHub (/user, /user/emails) and the OIDC issuer.
function stubProviders({ ghLogin, ghId, ghEmail, oidcSub, oidcEmail, clerkExternal, calls }) {
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('github.com/login/oauth/access_token')) return Response.json({ access_token: 'gho' });
    if (url.includes('api.github.com/user/emails')) {
      return Response.json(ghEmail ? [{ email: ghEmail, primary: true, verified: true }] : []);
    }
    if (url.includes('api.github.com/user')) {
      return Response.json({ login: ghLogin, id: ghId, name: ghLogin, avatar_url: '' });
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, userinfo_endpoint: `${ISSUER}/u`,
      });
    }
    if (url === `${ISSUER}/t`) return Response.json({ access_token: 'at' });
    if (url === `${ISSUER}/u`) {
      return Response.json({ sub: oidcSub, email: oidcEmail, email_verified: true, name: 'Person' });
    }
    if (url.startsWith('https://api.clerk.com/v1/users/')) {
      if (calls) calls.clerkApi = (calls.clerkApi || 0) + 1;
      if (!clerkExternal) return Response.json({ external_accounts: [] });
      return Response.json({ external_accounts: [
        { provider: 'oauth_github', provider_user_id: String(clerkExternal.id), username: clerkExternal.username },
      ] });
    }
    return realFetch(input, init);
  };
}

function sessionFrom(env, res) {
  const m = (res.headers.get('set-cookie') || '').match(/tdoc_sid=([a-f0-9]+)/);
  if (!m) return null;
  return { sid: m[1], ...JSON.parse(env.META.map.get(`session:${m[1]}`)) };
}

async function githubSignIn(worker, env) {
  const r = await worker.fetch(req('/api/auth/device/poll', {
    method: 'POST', body: { device_code: 'dc' },
  }), env, {});
  const data = await r.json();
  assert(data.ok === true, `github sign-in failed: ${JSON.stringify(data)}`);
  return sessionFrom(env, r);
}

async function oidcSignIn(worker, env) {
  const login = await worker.fetch(req('/api/auth/oidc/login?return=%2F'), env, {});
  const state = ((login.headers.get('set-cookie') || '').match(/tdoc_oidcst=([a-f0-9]+)/) || [])[1];
  const cb = await worker.fetch(new Request(
    `https://tdoc.dev/auth/oidc/callback?code=c&state=${state}`,
    { headers: { Cookie: `tdoc_oidcst=${state}` } },
  ), env, {});
  assert(cb.status >= 300 && cb.status < 400, `oidc callback: ${cb.status} ${await cb.clone().text()}`);
  return sessionFrom(env, cb);
}

// Publish through the pairing flow, which is how an account is born.
async function claimAccount(worker, env, cookie) {
  const start = await (await worker.fetch(req('/api/cli/pair/start', { method: 'POST', body: {} }), env, {})).json();
  const ap = await worker.fetch(req('/api/cli/pair/approve', {
    method: 'POST', cookie, body: { user_code: start.user_code },
  }), env, {});
  assert(ap.status === 200, `approve: ${ap.status} ${await ap.clone().text()}`);
  const poll = await (await worker.fetch(req('/api/cli/pair/poll', {
    method: 'POST', body: { user_code: start.user_code, pair_secret: start.pair_secret },
  }), env, {})).json();
  assert(poll.ok === true, `poll: ${JSON.stringify(poll)}`);
  return poll;
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('recycled identifiers');

  await t('a renamed GitHub login does not hand the account to whoever takes the old name', async () => {
    const env = makeEnv(mod.CommentsStore);
    // Alice, id 111, publishes as @alice.
    stubProviders({ ghLogin: 'alice', ghId: 111, ghEmail: 'alice@corp.com' });
    const alice = await githubSignIn(worker, env);
    const claimed = await claimAccount(worker, env, `tdoc_sid=${alice.sid}`);
    const aliceAccount = claimed.account_id;
    assert(env.META.map.has('account-idp:github:111'), 'no stable index was written at mint');

    // Alice renames to @alice-dev. Same numeric id.
    stubProviders({ ghLogin: 'alice-dev', ghId: 111, ghEmail: 'alice@corp.com' });
    const renamed = await githubSignIn(worker, env);
    assert(renamed.account_id === aliceAccount,
      `a rename lost the account: ${renamed.account_id} != ${aliceAccount}`);

    // Bob registers the freed name @alice. Different numeric id.
    stubProviders({ ghLogin: 'alice', ghId: 999, ghEmail: 'bob@example.com' });
    const bob = await githubSignIn(worker, env);
    assert(bob.account_id !== aliceAccount,
      'the freed handle handed Bob the original owner’s account');
    // Bob publishing gets him his own account, not Alice's.
    const bobClaim = await claimAccount(worker, env, `tdoc_sid=${bob.sid}`);
    assert(bobClaim.account_id !== aliceAccount, 'Bob minted a token against Alice’s account');
  });

  await t('a recycled email address does not inherit the account it used to reach', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    // Alice publishes; her corp address becomes the merge hint.
    stubProviders({ ghLogin: 'alice', ghId: 111, ghEmail: 'alice@corp.com' });
    const alice = await githubSignIn(worker, env);
    const claimed = await claimAccount(worker, env, `tdoc_sid=${alice.sid}`);
    const aliceAccount = claimed.account_id;
    assert(env.META.map.has('account-email:alice@corp.com'), 'email hint missing');

    // She leaves and changes her GitHub address. The stale pointer must be
    // retracted, not left aimed at her documents.
    stubProviders({ ghLogin: 'alice', ghId: 111, ghEmail: 'alice@personal.com' });
    await githubSignIn(worker, env);
    await claimAccount(worker, env, `tdoc_sid=${(await githubSignIn(worker, env)).sid}`);
    assert(!env.META.map.has('account-email:alice@corp.com'),
      'the old address still points at the account after the owner moved off it');
    assert(env.META.map.has('account-email:alice@personal.com'), 'the new address was not indexed');

    // The company gives alice@corp.com to Bob, who verifies it at the OIDC
    // provider. He must land somewhere new.
    stubProviders({ oidcSub: 'user_bob', oidcEmail: 'alice@corp.com' });
    const bob = await oidcSignIn(worker, env);
    assert(bob.account_id !== aliceAccount,
      'a recycled address inherited the previous holder’s account');
  });

  await t('changing your address at the provider keeps your account', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    stubProviders({ oidcSub: 'user_carol', oidcEmail: 'carol@old.com' });
    const first = await oidcSignIn(worker, env);
    const claimed = await claimAccount(worker, env, `tdoc_sid=${first.sid}`);
    const carolAccount = claimed.account_id;
    assert(env.META.map.has('account-idp:oidc:user_carol'), 'no idp link written at mint');

    // Same person, new address at the provider — sub unchanged.
    stubProviders({ oidcSub: 'user_carol', oidcEmail: 'carol@new.com' });
    const second = await oidcSignIn(worker, env);
    assert(second.account_id === carolAccount,
      `an address change lost the account: ${second.account_id} != ${carolAccount}`);
  });

  await t('the email hint still merges a new provider into an existing account, once', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    // Dave publishes via GitHub…
    stubProviders({ ghLogin: 'dave', ghId: 222, ghEmail: 'dave@example.com' });
    const gh = await githubSignIn(worker, env);
    const claimed = await claimAccount(worker, env, `tdoc_sid=${gh.sid}`);
    const daveAccount = claimed.account_id;

    // …then signs in through the OIDC provider with the same verified
    // address. This is the migration path, and it must land on his account.
    stubProviders({ oidcSub: 'user_dave', oidcEmail: 'dave@example.com' });
    const viaOidc = await oidcSignIn(worker, env);
    assert(viaOidc.account_id === daveAccount,
      `the email hint failed to merge: ${viaOidc.account_id} != ${daveAccount}`);

    // After his next mint the link is exact, so the hint is no longer load-
    // bearing for him.
    await claimAccount(worker, env, `tdoc_sid=${viaOidc.sid}`);
    const link = JSON.parse(env.META.map.get('account-idp:oidc:user_dave') || 'null');
    assert(link && link.account_id === daveAccount, `idp link missing: ${JSON.stringify(link)}`);
  });

  await t('an account records how its owner signs in', async () => {
    const env = makeEnv(mod.CommentsStore);
    stubProviders({ ghLogin: 'erin', ghId: 333, ghEmail: 'erin@example.com' });
    const erin = await githubSignIn(worker, env);
    await claimAccount(worker, env, `tdoc_sid=${erin.sid}`);
    const rec = JSON.parse(env.META.map.get('hosted-account:erin'));
    const ids = rec.identities || [];
    assert(ids.length === 1, `identities: ${JSON.stringify(ids)}`);
    assert(ids[0].provider === 'github' && ids[0].sub === '333', JSON.stringify(ids[0]));
    assert(ids[0].handle === 'erin' && ids[0].email === 'erin@example.com', JSON.stringify(ids[0]));
    assert(ids[0].linked_at && ids[0].last_seen, 'link timestamps missing');
  });

  await t('accounts predating the stable index are upgraded on next sign-in', async () => {
    const env = makeEnv(mod.CommentsStore);
    // A legacy record: handle index only, no identities, no idp link.
    env.META.map.set('hosted-account:frank', JSON.stringify({
      account_id: 'acct_frank0000', github_login: 'frank', created: '2026-01-01T00:00:00Z',
    }));
    stubProviders({ ghLogin: 'frank', ghId: 444, ghEmail: 'frank@example.com' });
    const frank = await githubSignIn(worker, env);
    assert(frank.account_id === 'acct_frank0000', 'legacy account was not resolved by handle');
    await claimAccount(worker, env, `tdoc_sid=${frank.sid}`);
    const link = JSON.parse(env.META.map.get('account-idp:github:444') || 'null');
    assert(link && link.account_id === 'acct_frank0000',
      `legacy account was not upgraded: ${JSON.stringify(link)}`);
  });

  await t('a legacy GitHub publisher lands on their account through the provider, no second button', async () => {
    const env = makeEnv(mod.CommentsStore, { ...OIDC_ENV, CLERK_SECRET_KEY: 'sk_test_stub' });
    // The legacy shape: handle index only — published before phase 1, so no
    // email index and no stable id anywhere.
    env.META.map.set('hosted-account:gina', JSON.stringify({
      account_id: 'acct_gina00000', github_login: 'gina', created: '2026-01-01T00:00:00Z',
    }));
    const calls = {};
    stubProviders({ oidcSub: 'user_gina', oidcEmail: 'gina@new-mail.com', clerkExternal: { id: 555, username: 'gina' }, calls });
    const first = await oidcSignIn(worker, env);
    assert(first.account_id === 'acct_gina00000',
      `legacy account not bridged: ${JSON.stringify(first)}`);
    assert(calls.clerkApi === 1, `backend api calls: ${calls.clerkApi}`);
    // The bridge writes the links immediately: the next sign-in must resolve
    // by sub with no backend call at all.
    const second = await oidcSignIn(worker, env);
    assert(second.account_id === 'acct_gina00000', 'second sign-in lost the account');
    assert(calls.clerkApi === 1, `bridge was consulted again: ${calls.clerkApi}`);
    const rec = JSON.parse(env.META.map.get('hosted-account:gina'));
    const provs = (rec.identities || []).map((i) => i.provider).sort();
    assert(JSON.stringify(provs) === JSON.stringify(['github', 'oidc']),
      `both identities should be linked: ${JSON.stringify(rec.identities)}`);
    // The bridged session keeps the verified handle as its login, so the
    // legacy actor key survives: old comments stay hers to edit, handle
    // invites keep matching, @gina still reaches her.
    assert(second.login === 'gina',
      `bridged session lost the handle: ${JSON.stringify(second)}`);
  });

  await t('a token mint on a handle-less session does not erase the bridged handle', async () => {
    const env = makeEnv(mod.CommentsStore, { ...OIDC_ENV, CLERK_SECRET_KEY: 'sk_test_stub' });
    env.META.map.set('hosted-account:gina', JSON.stringify({
      account_id: 'acct_gina00000', github_login: 'gina', created: '2026-01-01T00:00:00Z',
    }));
    stubProviders({ oidcSub: 'user_gina', oidcEmail: 'gina@new-mail.com', clerkExternal: { id: 555, username: 'gina' } });
    await oidcSignIn(worker, env);

    // A session from before the door learned to restore handles: same
    // person, same sub, no login. Its token mint resolves through the email
    // path, which rewrites the idp link — and must not strip the handle the
    // bridge just stored there.
    env.META.map.set('session:feedcafe01', JSON.stringify({
      email: 'gina@new-mail.com', oidc: true, created: new Date().toISOString(),
      account_id: 'acct_gina00000', idp: { provider: 'oidc', sub: 'user_gina' },
    }));
    const claim = await claimAccount(worker, env, 'tdoc_sid=feedcafe01');
    assert(claim.account_id === 'acct_gina00000', `mint left the account: ${JSON.stringify(claim)}`);

    const link = JSON.parse(env.META.map.get('account-idp:oidc:user_gina') || 'null');
    assert(link && link.handle === 'gina', `mint erased the bridged handle: ${JSON.stringify(link)}`);
    // And the sign-in AFTER that mint still restores the handle as login.
    const next = await oidcSignIn(worker, env);
    assert(next.login === 'gina', `sign-in after mint lost the login: ${JSON.stringify(next)}`);
  });

  await t('a sign-in heals an idp link whose handle was stripped', async () => {
    const env = makeEnv(mod.CommentsStore, { ...OIDC_ENV, CLERK_SECRET_KEY: 'sk_test_stub' });
    // The damage the old rewrite left behind: the link still resolves, but
    // the handle the bridge stored is gone.
    env.META.map.set('hosted-account:gina', JSON.stringify({
      account_id: 'acct_gina00000', github_login: 'gina', created: '2026-01-01T00:00:00Z',
      identities: [
        { provider: 'github', sub: '555', handle: 'gina' },
        { provider: 'oidc', sub: 'user_gina' },
      ],
    }));
    env.META.map.set('account-idp:oidc:user_gina', JSON.stringify({
      account_id: 'acct_gina00000', created: '2026-01-01T00:00:00Z',
    }));
    const calls = {};
    stubProviders({ oidcSub: 'user_gina', oidcEmail: 'gina@new-mail.com', clerkExternal: { id: 555, username: 'gina' }, calls });
    const healed = await oidcSignIn(worker, env);
    assert(healed.login === 'gina', `sign-in did not heal the login: ${JSON.stringify(healed)}`);
    const link = JSON.parse(env.META.map.get('account-idp:oidc:user_gina') || 'null');
    assert(link && link.handle === 'gina', `handle not written back: ${JSON.stringify(link)}`);
    // Written back means healed for good: the next sign-in asks nobody.
    const next = await oidcSignIn(worker, env);
    assert(next.login === 'gina', 'healed login did not survive the next sign-in');
    assert(calls.clerkApi === 1, `heal did not persist: ${calls.clerkApi} backend calls`);
  });

  await t('healing never hands a handle to a GitHub id the account does not record', async () => {
    const env = makeEnv(mod.CommentsStore, { ...OIDC_ENV, CLERK_SECRET_KEY: 'sk_test_stub' });
    // gina's account says GitHub id 555 owns the handle; the provider
    // attests this visitor connected a DIFFERENT GitHub account (999)
    // wearing the freed name. The heal must refuse.
    env.META.map.set('hosted-account:gina', JSON.stringify({
      account_id: 'acct_gina00000', github_login: 'gina', created: '2026-01-01T00:00:00Z',
      identities: [{ provider: 'github', sub: '555', handle: 'gina' }],
    }));
    env.META.map.set('account-idp:oidc:user_gina', JSON.stringify({
      account_id: 'acct_gina00000', created: '2026-01-01T00:00:00Z',
    }));
    stubProviders({ oidcSub: 'user_gina', oidcEmail: 'gina@new-mail.com', clerkExternal: { id: 999, username: 'gina' } });
    const s = await oidcSignIn(worker, env);
    assert(!s.login, `a recycled handle was healed onto the session: ${JSON.stringify(s)}`);
    const link = JSON.parse(env.META.map.get('account-idp:oidc:user_gina') || 'null');
    assert(link && !link.handle, `a recycled handle was written back: ${JSON.stringify(link)}`);
  });

  await t('the bridge cannot hand over a handle that a stable id already owns', async () => {
    const env = makeEnv(mod.CommentsStore, { ...OIDC_ENV, CLERK_SECRET_KEY: 'sk_test_stub' });
    // Alice's account, already upgraded: github id 111 owns the handle.
    env.META.map.set('hosted-account:alice', JSON.stringify({
      account_id: 'acct_alice0000', github_login: 'alice', created: '2026-01-01T00:00:00Z',
      identities: [{ provider: 'github', sub: '111', handle: 'alice' }],
    }));
    // Bob renamed his GitHub to the freed "alice" and connected THAT to the
    // provider — the bridge reports handle alice but id 999.
    stubProviders({ oidcSub: 'user_bob', oidcEmail: 'bob@example.com', clerkExternal: { id: 999, username: 'alice' } });
    const bob = await oidcSignIn(worker, env);
    assert(bob.account_id !== 'acct_alice0000',
      'the bridge handed a recycled handle to a different GitHub id');
  });

  await t('without the backend key the bridge stays quiet and nothing breaks', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV); // no CLERK_SECRET_KEY
    env.META.map.set('hosted-account:hank', JSON.stringify({
      account_id: 'acct_hank00000', github_login: 'hank', created: '2026-01-01T00:00:00Z',
    }));
    const calls = {};
    stubProviders({ oidcSub: 'user_hank', oidcEmail: 'hank@x.com', clerkExternal: { id: 777, username: 'hank' }, calls });
    const s1 = await oidcSignIn(worker, env);
    assert(!s1.account_id, 'ungated bridge resolved an account without the key');
    assert(!calls.clerkApi, `backend api was called without a key: ${calls.clerkApi}`);
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
