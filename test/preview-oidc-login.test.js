// A Clerk login on a PR alias completes at the fixed preview Worker host and
// hands the resulting session back to that same alias with a short ticket.
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function t(name, fn) { return fn().then(() => { console.log(`  ✓ ${name}`); pass++; }, (e) => {
  console.log(`  ✗ ${name}\n    ${e.message}`); fail++;
}); }
function assert(value, message) { if (!value) throw new Error(message); }

const ISSUER = 'https://preview-issuer.example';
const BASE = 'tdoc-preview.jyshi1107.workers.dev';
const PR = 'pr-848-tdoc-preview.jyshi1107.workers.dev';
const OTHER_PR = 'pr-849-tdoc-preview.jyshi1107.workers.dev';
const CONFIG = { TDOC_PREVIEW: '1', OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'previewClient_123', OIDC_CLIENT_SECRET: 'test-secret' };
const actualFetch = globalThis.fetch;
function stubIssuer({ verified = true, expectedRedirect = `https://${BASE}/auth/oidc/callback` } = {}) {
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({
      authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo`,
    });
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(init.body);
      assert(body.get('redirect_uri') === expectedRedirect, 'Clerk code exchanged with the wrong callback');
      assert(body.get('client_secret') === 'test-secret', 'preview client secret missing');
      return Response.json({ access_token: 'preview-access-token' });
    }
    if (url === `${ISSUER}/userinfo`) return Response.json({
      sub: 'user_preview', email: 'preview@example.com', email_verified: verified, name: 'Preview User',
    });
    return actualFetch(input, init);
  };
}

async function start(worker, env, path = '/d/conway-life/v/2?tab=comments') {
  const first = await worker.fetch(req(`/api/auth/oidc/login?return=${encodeURIComponent(path)}`, { host: PR }), env, {});
  const browserNonce = ((first.headers.get('set-cookie') || '').match(/tdoc_preview_login=([a-f0-9]{48})/) || [])[1];
  assert(first.status === 302 && browserNonce && !(first.headers.get('set-cookie') || '').includes('tdoc_oidcst'),
    'alias must bind this browser and hand login to base');
  const baseLogin = new URL(first.headers.get('location'));
  assert(baseLogin.origin === `https://${BASE}` && baseLogin.searchParams.get('preview_return') === `https://${PR}${path}`,
    `alias target not preserved: ${baseLogin}`);
  assert(/^[a-f0-9]{64}$/.test(baseLogin.searchParams.get('preview_bind') || ''), 'browser binding hash missing');
  const login = await worker.fetch(new Request(baseLogin), env, {});
  const state = ((login.headers.get('set-cookie') || '').match(/tdoc_oidcst=([a-f0-9]+)/) || [])[1];
  assert(state, 'base login must set the state cookie');
  const auth = new URL(login.headers.get('location'));
  assert(auth.searchParams.get('redirect_uri') === `https://${BASE}/auth/oidc/callback`, 'Clerk must know only one callback');
  assert(auth.searchParams.get('client_id') === CONFIG.OIDC_CLIENT_ID, 'wrong OAuth client');
  return { state, browserNonce };
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('PR preview Clerk sign-in');

  await t('fixed callback hands a verified session to the originating PR exactly once', async () => {
    const env = makeEnv(mod.CommentsStore, CONFIG);
    stubIssuer();
    const { state, browserNonce } = await start(worker, env);
    const callback = await worker.fetch(req(`/auth/oidc/callback?code=clerk-code&state=${state}`, {
      host: BASE, cookie: `tdoc_oidcst=${state}`,
    }), env, {});
    const claimUrl = new URL(callback.headers.get('location'));
    assert(callback.status === 302 && claimUrl.origin === `https://${PR}`, 'callback must return to PR alias');
    assert(claimUrl.pathname === '/auth/preview/claim' && !claimUrl.href.includes('clerk-code'), 'Clerk code leaked to PR alias');
    assert(!(callback.headers.get('set-cookie') || '').includes('tdoc_sid='), 'base must not set the alias session cookie');
    const ticket = claimUrl.searchParams.get('ticket');
    assert(ticket && /^[a-f0-9]{48}$/.test(ticket), 'one-time ticket missing');
    const claim = await worker.fetch(new Request(claimUrl, { headers: { Cookie: `tdoc_preview_login=${browserNonce}` } }), env, {});
    const sid = ((claim.headers.get('set-cookie') || '').match(/tdoc_sid=([a-f0-9]{48})/) || [])[1];
    assert(claim.status === 302 && sid && env.META.map.has(`session:${sid}`), 'alias session not established');
    assert(claim.headers.get('location') === '/d/conway-life/v/2?tab=comments', 'original PR path lost');
    assert((claim.headers.get('set-cookie') || '').includes('tdoc_preview_login=;'), 'browser binding cookie was not cleared');
    const replay = await worker.fetch(new Request(claimUrl, { headers: { Cookie: `tdoc_preview_login=${browserNonce}` } }), env, {});
    assert(replay.status === 410 && !(replay.headers.get('set-cookie') || '').includes('tdoc_sid='), 'ticket replayed');
  });

  await t('foreign domains, ports and encoded host tricks cannot become return targets', async () => {
    const env = makeEnv(mod.CommentsStore, CONFIG);
    for (const target of [
      'https://evil.example/', 'http://' + PR + '/', `https://${PR}.evil.example/`,
      `https://evil.example@${PR}/`, `https://${PR}:444/`, `https://${PR}:443/`, `https://${PR}/#frag`,
      'https://pr-foo-tdoc-preview.jyshi1107.workers.dev/',
      `https://${PR}/.//evil.com`, `https://${PR}/%2e//evil.com`, `https://${PR}/a/..//evil.com`,
    ]) {
      const r = await worker.fetch(req(`/api/auth/oidc/login?preview_return=${encodeURIComponent(target)}`, { host: BASE }), env, {});
      assert(r.status === 400, `accepted ${target}: ${r.status}`);
    }
    const alias = await worker.fetch(req('/api/auth/oidc/login?return=https%3A%2F%2Fevil.example%2F', { host: PR }), env, {});
    assert(new URL(alias.headers.get('location')).searchParams.get('preview_return') === `https://${PR}/`,
      'alias return parameter escaped the PR host');
    for (const path of ['/.//evil.com', '/%2e//evil.com', '/a/..//evil.com']) {
      const r = await worker.fetch(req(`/api/auth/oidc/login?return=${encodeURIComponent(path)}`, { host: PR }), env, {});
      assert(r.status === 400, `alias accepted protocol-relative return ${path}`);
    }
  });

  await t('a ticket belongs to one browser and one PR, then expires after 60 seconds', async () => {
    const env = makeEnv(mod.CommentsStore, CONFIG);
    stubIssuer();
    const { state, browserNonce } = await start(worker, env, '/me');
    const callback = await worker.fetch(req(`/auth/oidc/callback?code=clerk-code&state=${state}`, {
      host: BASE, cookie: `tdoc_oidcst=${state}`,
    }), env, {});
    const claimUrl = new URL(callback.headers.get('location'));
    const ticket = claimUrl.searchParams.get('ticket');
    const noCookie = await worker.fetch(new Request(claimUrl), env, {});
    assert(noCookie.status === 403 && env.META.map.has(`preview-auth-ticket:${ticket}`), 'missing browser cookie consumed ticket');
    const wrongCookie = await worker.fetch(new Request(claimUrl, { headers: { Cookie: `tdoc_preview_login=${'a'.repeat(48)}` } }), env, {});
    assert(wrongCookie.status === 403 && env.META.map.has(`preview-auth-ticket:${ticket}`), 'other browser claimed ticket');
    const wrong = await worker.fetch(req(claimUrl.pathname + claimUrl.search, {
      host: OTHER_PR, cookie: `tdoc_preview_login=${browserNonce}`,
    }), env, {});
    assert(wrong.status === 403 && env.META.map.has(`preview-auth-ticket:${ticket}`), 'other PR consumed the ticket');
    const record = JSON.parse(env.META.map.get(`preview-auth-ticket:${ticket}`));
    record.expiresAt = Date.now() - 1;
    env.META.map.set(`preview-auth-ticket:${ticket}`, JSON.stringify(record));
    const expired = await worker.fetch(new Request(claimUrl, { headers: { Cookie: `tdoc_preview_login=${browserNonce}` } }), env, {});
    assert(expired.status === 410 && !(expired.headers.get('set-cookie') || '').includes('tdoc_sid='), 'expired ticket opened a session');
  });

  await t('a poisoned stored ticket cannot redirect outside the preview', async () => {
    const env = makeEnv(mod.CommentsStore, CONFIG);
    stubIssuer();
    const { state, browserNonce } = await start(worker, env, '/me');
    const callback = await worker.fetch(req(`/auth/oidc/callback?code=clerk-code&state=${state}`, {
      host: BASE, cookie: `tdoc_oidcst=${state}`,
    }), env, {});
    const claimUrl = new URL(callback.headers.get('location'));
    const ticketKey = `preview-auth-ticket:${claimUrl.searchParams.get('ticket')}`;
    const record = JSON.parse(env.META.map.get(ticketKey));
    record.target = `https://${PR}/.//evil.com`;
    env.META.map.set(ticketKey, JSON.stringify(record));
    const claim = await worker.fetch(new Request(claimUrl, {
      headers: { Cookie: `tdoc_preview_login=${browserNonce}` },
    }), env, {});
    assert(claim.status === 403 && !claim.headers.get('location'), 'poisoned ticket caused external navigation');
  });

  await t('unverified email creates no ticket or session', async () => {
    const env = makeEnv(mod.CommentsStore, CONFIG);
    stubIssuer({ verified: false });
    const { state } = await start(worker, env);
    const callback = await worker.fetch(req(`/auth/oidc/callback?code=clerk-code&state=${state}`, {
      host: BASE, cookie: `tdoc_oidcst=${state}`,
    }), env, {});
    assert(callback.status === 403 && ![...env.META.map.keys()].some(k => k.startsWith('preview-auth-ticket:')), 'unverified identity received a ticket');
  });

  await t('production OIDC still uses its own callback and session cookie', async () => {
    const env = makeEnv(mod.CommentsStore, { ...CONFIG, TDOC_PREVIEW: '0' });
    stubIssuer({ expectedRedirect: 'https://tdoc.dev/auth/oidc/callback' });
    const login = await worker.fetch(req('/api/auth/oidc/login?return=%2Fme'), env, {});
    const state = ((login.headers.get('set-cookie') || '').match(/tdoc_oidcst=([a-f0-9]+)/) || [])[1];
    assert(state && new URL(login.headers.get('location')).searchParams.get('redirect_uri') === 'https://tdoc.dev/auth/oidc/callback',
      'production callback changed');
    const callback = await worker.fetch(req(`/auth/oidc/callback?code=clerk-code&state=${state}`, {
      cookie: `tdoc_oidcst=${state}`,
    }), env, {});
    assert(callback.status === 302 && (callback.headers.get('set-cookie') || '').includes('tdoc_sid='), 'production session changed');
    const previewParam = await worker.fetch(req(`/api/auth/oidc/login?preview_return=${encodeURIComponent(`https://${PR}/`)}`), env, {});
    assert(previewParam.status === 400, 'production accepted preview return');
    const claim = await worker.fetch(req('/auth/preview/claim?ticket=' + 'a'.repeat(48), { host: PR }), env, {});
    assert(claim.status === 404, 'non-preview Worker exposed ticket claim');
  });

  globalThis.fetch = actualFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
