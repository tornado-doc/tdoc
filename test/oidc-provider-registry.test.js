// The OIDC provider registry — worker.js against stubbed issuers.
//
// Sign-in providers are entries in OIDC_PROVIDERS; the login/callback routes,
// state handling and code exchange are shared. These tests pin the Raft entry
// and the one rule that makes it safe to register:
//
//   - unconfigured → /api/auth/raft/* bows out, exactly like the generic seat;
//   - raft routes use their own state cookie and callback path;
//   - a stateless callback (agent sign-in has no browser) is accepted ONLY
//     when userinfo says type === "agent" — a human identity without state is
//     refused, so the provider never becomes a CSRF-able login;
//   - the generic `oidc` seat still refuses stateless callbacks outright;
//   - both providers can be configured at once without their discovery
//     documents clobbering each other.
//
// Run with: node test/oidc-provider-registry.test.js

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const RAFT = 'https://raft-stub.example';
const OIDC = 'https://oidc-stub.example';
const RAFT_ENV = { RAFT_OIDC_ISSUER: RAFT, RAFT_CLIENT_ID: 'tdoc', RAFT_CLIENT_SECRET: 'raft_secret' };
const OIDC_ENV = { OIDC_ISSUER: OIDC, OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec' };

const realFetch = globalThis.fetch;
let calls = [];
function stubIssuers(userinfo) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    calls.push(url);
    for (const iss of [RAFT, OIDC]) {
      if (url === `${iss}/.well-known/openid-configuration`) {
        return Response.json({
          authorization_endpoint: `${iss}/authorize`,
          token_endpoint: `${iss}/token`,
          userinfo_endpoint: `${iss}/userinfo`,
        });
      }
      if (url === `${iss}/token`) {
        const body = String(init && init.body || '');
        const redirect = new URLSearchParams(body).get('redirect_uri');
        return Response.json({ access_token: `at:${iss}`, redirect });
      }
      if (url === `${iss}/userinfo`) return Response.json(userinfo[iss] || {});
      if (url === `${iss}/api/oauth/serverinfo`) return Response.json({ id: 'S1', slug: 'acme' });
    }
    return realFetch(input, init);
  };
}

const cb = (path, cookie) => new Request(`https://tdoc.dev${path}`, cookie ? { headers: { Cookie: cookie } } : {});

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('oidc provider registry');

  await t('unconfigured raft: login and callback bow out', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    for (const path of ['/api/auth/raft/login', '/auth/raft/callback?code=x']) {
      const r = await worker.fetch(req(path), env, {});
      assert(r.status >= 300 && r.status < 400 && (r.headers.get('location') || '').includes('notice=signin'),
        `${path}: expected the polite bounce, got ${r.status}`);
    }
  });

  await t('raft login redirects to the raft issuer with its own callback + state cookie', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    stubIssuers({});
    const r = await worker.fetch(req('/api/auth/raft/login?return=%2Fme'), env, {});
    const loc = new URL(r.headers.get('location'));
    assert(loc.origin + loc.pathname === `${RAFT}/authorize`, `authorize: ${loc}`);
    assert(loc.searchParams.get('redirect_uri') === 'https://tdoc.dev/auth/raft/callback', `redirect_uri: ${loc.searchParams.get('redirect_uri')}`);
    assert(loc.searchParams.get('client_id') === 'tdoc', 'client_id');
    const setCookie = r.headers.get('set-cookie') || '';
    assert(/tdoc_raftst=[a-f0-9]+/.test(setCookie), `state cookie: ${setCookie}`);
    assert(!setCookie.includes('tdoc_oidcst='), 'raft login must not touch the generic seat cookie');
  });

  await t('stateless raft callback with an AGENT identity gets an authority-free agent session', async () => {
    const env = makeEnv(mod.CommentsStore, { ...RAFT_ENV, RAFT_API_BASE: RAFT });
    stubIssuers({ [RAFT]: { sub: 'agent-uuid-a', type: 'agent', name: 'xiaocc' } });
    const r = await worker.fetch(cb('/auth/raft/callback?code=c'), env, {});
    const body = await r.json();
    assert(r.status === 200 && body.ok && body.link_code, `expected a link code, got ${r.status}: ${JSON.stringify(body)}`);
    // Login with Raft IS a service session the caller keeps, so a cookie is
    // required. What keeps a stateless-issued cookie safe is that it carries
    // no authority — pinned in notify-handoff.test.js — not that it is absent.
    const cookie = r.headers.get('set-cookie') || '';
    assert(/tdoc_agent_sid=/.test(cookie), `expected an agent session cookie, got: ${cookie}`);
    assert(!/tdoc_sid=/.test(cookie), 'an agent must never be handed the human account session');
    assert(/HttpOnly/.test(cookie) && /Secure/.test(cookie), `cookie flags: ${cookie}`);
    assert(body.agent.server_id === 'S1', 'the server comes from the issuer, not the agent');
  });

  await t('the agent label prefers the handle over a bio-shaped display name', async () => {
    const env = makeEnv(mod.CommentsStore, { ...RAFT_ENV, RAFT_API_BASE: RAFT });
    stubIssuers({ [RAFT]: {
      sub: 'agent-uuid-a', type: 'agent',
      preferred_username: 'smarter-tdoc-claw',
      // What a Raft agent's `name` actually looks like: a multi-line bio.
      name: 'not just a worker but a orchestrator.\nwill handover tasks.\n\n1. DO NOT SPECIAL FORMAT LINK',
    } });
    const body = await (await worker.fetch(cb('/auth/raft/callback?code=c'), env, {})).json();
    assert(body.agent.agent_name === 'smarter-tdoc-claw', `got ${JSON.stringify(body.agent.agent_name)}`);
  });

  await t('a bio with no handle does not leak a paragraph as the name', async () => {
    const env = makeEnv(mod.CommentsStore, { ...RAFT_ENV, RAFT_API_BASE: RAFT });
    stubIssuers({ [RAFT]: {
      sub: 'agent-uuid-b', type: 'agent',
      name: 'a very long self description that goes on and on and should never be shown as if it were somebody\u2019s name',
    } });
    const body = await (await worker.fetch(cb('/auth/raft/callback?code=c'), env, {})).json();
    assert(body.agent.agent_name === '', `expected empty rather than a bio, got ${JSON.stringify(body.agent.agent_name)}`);
  });

  await t('the server id is taken from the issuer, not from anything the agent said', async () => {
    const env = makeEnv(mod.CommentsStore, { ...RAFT_ENV, RAFT_API_BASE: RAFT });
    // userinfo claims a different server; serverinfo is the only source read.
    stubIssuers({ [RAFT]: { sub: 'agent-uuid-a', type: 'agent', name: 'x', server_id: 'ATTACKER' } });
    const body = await (await worker.fetch(cb('/auth/raft/callback?code=c'), env, {})).json();
    assert(body.agent.server_id === 'S1', `server_id should be S1 from serverinfo, got ${body.agent.server_id}`);
  });

  await t('no serverinfo means no link code — it does not guess', async () => {
    const env = makeEnv(mod.CommentsStore, { ...RAFT_ENV, RAFT_API_BASE: 'https://unreachable.example' });
    stubIssuers({ [RAFT]: { sub: 'agent-uuid-a', type: 'agent', name: 'x' } });
    const r = await worker.fetch(cb('/auth/raft/callback?code=c'), env, {});
    assert(r.status === 502, `expected 502, got ${r.status}`);
  });

  await t('stateless raft callback with a HUMAN identity is refused', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    for (const info of [{ sub: 'u1', type: 'user' }, { sub: 'u2' }, { sub: 'u3', type: 'Agent' }]) {
      stubIssuers({ [RAFT]: info });
      const r = await worker.fetch(cb('/auth/raft/callback?code=c'), env, {});
      assert(r.status === 403, `${JSON.stringify(info)}: expected 403, got ${r.status}`);
      assert(!(r.headers.get('set-cookie') || '').includes('tdoc_sid='), 'a session was minted');
    }
  });

  await t('half-present state on raft is a mismatch, not the agent path', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    stubIssuers({ [RAFT]: { sub: 'agent_1', type: 'agent' } });
    const onlyParam = await worker.fetch(cb('/auth/raft/callback?code=c&state=aaaa'), env, {});
    assert(onlyParam.status === 400, `state without cookie: ${onlyParam.status}`);
    const onlyCookie = await worker.fetch(cb('/auth/raft/callback?code=c', 'tdoc_raftst=aaaa'), env, {});
    assert(onlyCookie.status === 400, `cookie without state: ${onlyCookie.status}`);
    assert(!calls.includes(`${RAFT}/token`), 'a mismatched callback still exchanged the code');
  });

  await t('stateful raft callback (human browser flow) passes the state check', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    stubIssuers({ [RAFT]: { sub: 'u1', type: 'user' } });
    const login = await worker.fetch(req('/api/auth/raft/login'), env, {});
    const state = (login.headers.get('set-cookie').match(/tdoc_raftst=([a-f0-9]+)/) || [])[1];
    const r = await worker.fetch(cb(`/auth/raft/callback?code=c&state=${state}`, `tdoc_raftst=${state}`), env, {});
    assert(r.status === 501, `expected the raft seat, got ${r.status}`);
    assert(!env.META.map.has(`oauthstate:raft:${state}`), 'state was not consumed');
  });

  await t('the generic oidc seat still refuses a stateless callback', async () => {
    const env = makeEnv(mod.CommentsStore, OIDC_ENV);
    stubIssuers({ [OIDC]: { sub: 'a', type: 'agent', email: 'a@example.com', email_verified: true } });
    const r = await worker.fetch(cb('/auth/oidc/callback?code=c'), env, {});
    assert(r.status === 400, `expected 400, got ${r.status}`);
    assert(!calls.includes(`${OIDC}/token`), 'generic seat exchanged a stateless code');
  });

  await t('both providers configured: each uses its own issuer', async () => {
    const env = makeEnv(mod.CommentsStore, { ...RAFT_ENV, ...OIDC_ENV });
    stubIssuers({
      [RAFT]: { sub: 'agent_1', type: 'agent' },
      [OIDC]: { sub: 'h1', email: 'h@example.com', email_verified: true, name: 'H' },
    });
    const a = await worker.fetch(req('/api/auth/oidc/login'), env, {});
    assert(a.headers.get('location').startsWith(`${OIDC}/authorize`), `oidc: ${a.headers.get('location')}`);
    const b = await worker.fetch(req('/api/auth/raft/login'), env, {});
    assert(b.headers.get('location').startsWith(`${RAFT}/authorize`), `raft: ${b.headers.get('location')}`);
    const again = await worker.fetch(req('/api/auth/oidc/login'), env, {});
    assert(again.headers.get('location').startsWith(`${OIDC}/authorize`), 'discovery cache mixed issuers');
    const page = await (await worker.fetch(req('/activate'), env, {})).text();
    assert(page.includes('"oidcAuth":true'), 'generic seat button disappeared');
  });

  await t('unregistered provider ids fall through (no generic /auth/<x>/callback)', async () => {
    const env = makeEnv(mod.CommentsStore, { ...RAFT_ENV, ...OIDC_ENV });
    const r = await worker.fetch(req('/auth/evil/callback?code=c'), env, {});
    assert(!(r.headers.get('location') || '').includes('notice=signin'), 'unknown id was treated as a provider');
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
