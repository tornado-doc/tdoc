// Remote MCP server + OAuth 2.1 (worker/worker.js, "Remote MCP server").
// AI apps without a terminal connect at /mcp. Sign-in is OAuth 2.1 with
// PKCE on top of tdoc accounts; the tools call the worker's own HTTP routes
// with the caller's token, so every refusal is the HTTP API's.
//   - off unless TDOC_REMOTE_MCP=1 (or a PR preview)
//   - discovery, dynamic registration with strict redirect URIs
//   - authorize: registered redirect only, PKCE S256, scope, resource
//   - consent: same-origin, session-bound CSRF, single use
//   - token: single-use code bound to client + redirect + PKCE verifier,
//     maps to an account token (workspace-scoped when ticks were removed)
//   - the token works at /mcp only; expiry, audience, refresh rotation with
//     replay detection, revocation (RFC 7009 and Settings -> Agents)
//   - MCP: legacy initialize and 2026-07-28 per-request metadata, tools,
//     resources, prompts, refusals (someone else's doc, answer-only lock,
//     workspace scope), rate limit
// Run with: node test/remote-mcp.test.js

const crypto = require('crypto');
const { loadWorker, makeEnv, req, issue, putSession, bootData } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
};
const ORIGIN = 'https://tdoc.dev';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

(async () => {
  console.log('remote MCP server + OAuth');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_REMOTE_MCP: '1' });
  const raw = async (r) => {
    const res = await worker.fetch(r, env, {});
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, text, headers: res.headers };
  };
  const call = (path, opts) => raw(req(path, opts));
  const form = (path, fields, headers = {}) => raw(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  }));
  const origin = { Origin: ORIGIN };

  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const carl = await issue(worker, env, 'carl');

  const register = async (body = {}) => call('/oauth/register', { method: 'POST', body: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], ...body } });
  const authorizeUrl = (client, p, extra = {}) => {
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: 'st8', scope: 'mcp', resource: `${ORIGIN}/mcp`, ...extra });
    for (const [k, v] of Object.entries(extra)) if (v === null) q.delete(k);
    return `/oauth/authorize?${q}`;
  };
  // The whole browser leg: authorize page, Allow, the redirect with a code.
  // A fresh browser session each time: approvals are rate-limited per session.
  const consent = async (who, client, p, { workspaces } = {}) => {
    who = { ...who, cookie: await putSession(env, who.login) };
    const page = await call(authorizeUrl(client, p), { cookie: who.cookie });
    assert(page.status === 200, `authorize page ${page.status} ${page.text.slice(0, 200)}`);
    const boot = bootData(page.text, '__TDOC_APP_BOOT__');
    const ok = await call('/api/oauth/approve', { method: 'POST', cookie: who.cookie, headers: origin, body: { request_id: boot.request_id, csrf: boot.csrf, decision: 'allow', ...(workspaces ? { workspaces } : {}) } });
    assert(ok.status === 200 && ok.body.redirect, `approve ${ok.status} ${ok.text}`);
    return new URL(ok.body.redirect);
  };
  const exchange = (client, code, verifier, extra = {}) => form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id, resource: `${ORIGIN}/mcp`, ...extra });
  const connect = async (who, opts) => {
    const client = (await register()).body;
    const p = pkce();
    const back = await consent(who, client, p, opts);
    const tok = await exchange(client, back.searchParams.get('code'), p.verifier);
    assert(tok.status === 200 && tok.body.access_token, `token ${tok.status} ${tok.text}`);
    return { client, ...tok.body };
  };

  // MCP over HTTP. Modern (2026-07-28) by default; legacy when asked.
  let rpcId = 0;
  const mcp = async (token, method, params = {}, { legacy = false, headers = {}, version = '2026-07-28' } = {}) => {
    const id = ++rpcId;
    const name = method === 'resources/read' ? params.uri : params.name;
    const body = legacy
      ? { jsonrpc: '2.0', id, method, params }
      : { jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } };
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(legacy ? { 'MCP-Protocol-Version': '2025-06-18' } : { 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}) }),
      ...headers,
    };
    return raw(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: h, body: JSON.stringify(body) }));
  };
  const tool = async (token, name, args) => {
    const r = await mcp(token, 'tools/call', { name, arguments: args });
    assert(r.status === 200 && r.body && r.body.result, `${name}: ${r.status} ${r.text.slice(0, 300)}`);
    return r.body.result;
  };

  // ---------------------------------------------------------------- gate
  await t('off by default: no /mcp, no discovery, no OAuth routes', async () => {
    const off = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    for (const path of ['/mcp', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/authorize']) {
      const r = await worker.fetch(req(path), off, {});
      assert(r.status === 404, `${path} ${r.status}`);
    }
    const reg = await worker.fetch(req('/oauth/register', { method: 'POST', body: { redirect_uris: [REDIRECT] } }), off, {});
    assert(reg.status === 404, `register ${reg.status}`);
  });

  // ------------------------------------------------------------ discovery
  await t('protected-resource and authorization-server metadata name /mcp, S256, mcp scope, iss', async () => {
    const pr = await call('/.well-known/oauth-protected-resource/mcp');
    assert(pr.status === 200 && pr.body.resource === `${ORIGIN}/mcp` && pr.body.authorization_servers[0] === ORIGIN, pr.text);
    assert(JSON.stringify(pr.body.scopes_supported) === '["mcp"]', 'scopes');
    const as = await call('/.well-known/oauth-authorization-server');
    assert(as.body.issuer === ORIGIN && as.body.registration_endpoint === `${ORIGIN}/oauth/register`, as.text);
    assert(JSON.stringify(as.body.code_challenge_methods_supported) === '["S256"]', 'PKCE S256 only');
    assert(as.body.authorization_response_iss_parameter_supported === true, 'iss');
    assert(!as.body.grant_types_supported.includes('implicit') && !as.body.response_types_supported.includes('token'), 'no implicit');
  });

  await t('/mcp without a token: 401 with the resource metadata and scope in WWW-Authenticate', async () => {
    const r = await mcp('', 'tools/list');
    const www = r.headers.get('www-authenticate') || '';
    assert(r.status === 401, `status ${r.status}`);
    assert(www.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`) && www.includes('scope="mcp"'), www);
    const bad = await mcp('tdoc_notarealtoken0000000000', 'tools/list');
    assert(bad.status === 401 && /error="invalid_token"/.test(bad.headers.get('www-authenticate') || ''), 'invalid token');
  });

  // -------------------------------------------------------- registration
  await t('registration refuses redirect URIs that are not https or loopback, or carry a fragment', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'cursor://anysphere/cb', 'https://claude.ai/cb#x', 'https://user:pw@claude.ai/cb', 'http://10.0.0.1/cb', '']) {
      const r = await register({ redirect_uris: [uri] });
      assert(r.status === 400 && r.body.error === 'invalid_redirect_uri', `${uri} -> ${r.status} ${r.text}`);
    }
    for (const uri of ['http://127.0.0.1:33418/callback', 'http://localhost:8787/callback', 'http://[::1]:9000/cb', 'https://www.cursor.com/agents/mcp/oauth/callback']) {
      const r = await register({ redirect_uris: [uri] });
      assert(r.status === 201 && /^mcpc_/.test(r.body.client_id), `${uri} -> ${r.status} ${r.text}`);
    }
    const noArr = await register({ redirect_uris: 'https://claude.ai/cb' });
    assert(noArr.status === 400, 'string, not array');
    const implicit = await register({ response_types: ['token'] });
    assert(implicit.status === 400, 'response_types token refused');
  });

  await t('a confidential client gets a secret once, stored hashed', async () => {
    const r = await register({ token_endpoint_auth_method: 'client_secret_post' });
    assert(r.status === 201 && /^tdocs_/.test(r.body.client_secret), r.text);
    const stored = env.META.map.get(`oauth-client:${r.body.client_id}`);
    assert(stored && !stored.includes(r.body.client_secret) && JSON.parse(stored).secret_hash, 'secret stored hashed only');
  });

  // ----------------------------------------------------------- authorize
  await t('authorize: unknown client or unregistered redirect gets an error page, never a redirect', async () => {
    const client = (await register()).body;
    const p = pkce();
    const unknown = await call(authorizeUrl({ client_id: 'mcpc_' + '0'.repeat(32) }, p), { cookie: julie.cookie });
    assert(unknown.status === 400 && !unknown.headers.get('location'), `unknown ${unknown.status}`);
    for (const redirect of ['https://evil.example/cb', `${REDIRECT}/`, `${REDIRECT}?x=1`, 'https://CLAUDE.ai/api/mcp/auth_callback']) {
      const r = await call(authorizeUrl(client, p, { redirect_uri: redirect }), { cookie: julie.cookie });
      assert(r.status === 400 && !r.headers.get('location'), `${redirect} -> ${r.status} ${r.headers.get('location')}`);
    }
  });

  await t('authorize: PKCE S256 required, scope and resource checked; malformed requests get an error page, not a redirect', async () => {
    const client = (await register()).body;
    const p = pkce();
    const cases = [
      [{ code_challenge: null }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ scope: 'mcp admin' }, 'invalid_scope'],
      [{ resource: 'https://evil.example/mcp' }, 'invalid_target'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ];
    for (const [extra, error] of cases) {
      // An error page, never a redirect: anyone can register a client, so
      // redirecting malformed requests would be an open redirector.
      const r = await call(authorizeUrl(client, p, extra), { cookie: julie.cookie });
      assert(r.status === 400 && !r.headers.get('location') && r.text.includes(error), `${JSON.stringify(extra)} -> ${r.status}`);
    }
  });

  await t('authorize signed out: the consent page asks for sign-in and stores nothing', async () => {
    const client = (await register()).body;
    const before = [...env.META.map.keys()].filter((k) => k.startsWith('oauth-req:')).length;
    const r = await call(authorizeUrl(client, pkce()));
    assert(r.status === 200, `status ${r.status}`);
    const boot = bootData(r.text, '__TDOC_APP_BOOT__');
    assert(boot.page === 'oauth-consent' && !boot.identity && !boot.request_id && !boot.csrf, JSON.stringify(boot).slice(0, 200));
    assert(boot.returnTo.startsWith('/oauth/authorize?'), 'returns here after sign-in');
    assert([...env.META.map.keys()].filter((k) => k.startsWith('oauth-req:')).length === before, 'no request record');
    assert(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy') || '') && r.headers.get('x-frame-options') === 'DENY', 'not frameable');
  });

  // ------------------------------------------------------------- consent
  await t('consent: Origin required, CSRF and session bound, single use; Cancel returns access_denied', async () => {
    const client = (await register()).body;
    const p = pkce();
    const page = await call(authorizeUrl(client, p), { cookie: julie.cookie });
    const boot = bootData(page.text, '__TDOC_APP_BOOT__');
    assert(boot.request_id && boot.csrf && boot.client.name === 'Claude' && boot.client.redirect_host === 'claude.ai', JSON.stringify(boot.client));
    const body = { request_id: boot.request_id, csrf: boot.csrf, decision: 'allow' };
    const noOrigin = await call('/api/oauth/approve', { method: 'POST', cookie: julie.cookie, body });
    assert(noOrigin.status === 403, `no Origin ${noOrigin.status}`);
    const crossSite = await call('/api/oauth/approve', { method: 'POST', cookie: julie.cookie, headers: { Origin: 'https://evil.example' }, body });
    assert(crossSite.status === 403, `cross-site ${crossSite.status}`);
    const wrongCsrf = await call('/api/oauth/approve', { method: 'POST', cookie: julie.cookie, headers: origin, body: { ...body, csrf: '0'.repeat(32) } });
    assert(wrongCsrf.status === 403, `csrf ${wrongCsrf.status}`);
    const otherSession = await call('/api/oauth/approve', { method: 'POST', cookie: bob.cookie, headers: origin, body });
    assert(otherSession.status === 403, `another session ${otherSession.status}`);
    const ok = await call('/api/oauth/approve', { method: 'POST', cookie: julie.cookie, headers: origin, body });
    const back = new URL(ok.body.redirect);
    assert(ok.status === 200 && back.searchParams.get('code') && back.searchParams.get('state') === 'st8' && back.searchParams.get('iss') === ORIGIN, ok.text);
    const again = await call('/api/oauth/approve', { method: 'POST', cookie: julie.cookie, headers: origin, body });
    assert(again.status === 404, `replayed approval ${again.status}`);
    const page2 = await call(authorizeUrl(client, p), { cookie: julie.cookie });
    const boot2 = bootData(page2.text, '__TDOC_APP_BOOT__');
    const deny = await call('/api/oauth/approve', { method: 'POST', cookie: julie.cookie, headers: origin, body: { request_id: boot2.request_id, csrf: boot2.csrf, decision: 'deny' } });
    const denied = new URL(deny.body.redirect);
    assert(denied.searchParams.get('error') === 'access_denied' && !denied.searchParams.get('code'), deny.text);
  });

  await t('consent: approvals are rate-limited per session', async () => {
    const client = (await register()).body;
    const cookie = await putSession(env, 'julie');
    let status = 0;
    for (let i = 0; i < 12 && status !== 429; i++) {
      const page = await call(authorizeUrl(client, pkce()), { cookie });
      const boot = bootData(page.text, '__TDOC_APP_BOOT__');
      status = (await call('/api/oauth/approve', { method: 'POST', cookie, headers: origin, body: { request_id: boot.request_id, csrf: boot.csrf, decision: 'deny' } })).status;
    }
    assert(status === 429, `never limited (${status})`);
  });

  // --------------------------------------------------------------- token
  await t('token: the code is single use and bound to its client, redirect URI and PKCE verifier', async () => {
    const client = (await register()).body;
    const other = (await register()).body;
    const p = pkce();
    let code = (await consent(julie, client, p)).searchParams.get('code');
    const wrongVerifier = await exchange(client, code, pkce().verifier);
    assert(wrongVerifier.status === 400 && wrongVerifier.body.error === 'invalid_grant', wrongVerifier.text);
    const burned = await exchange(client, code, p.verifier);
    assert(burned.status === 400 && burned.body.error === 'invalid_grant', 'a failed try burns the code');

    code = (await consent(julie, client, p)).searchParams.get('code');
    const wrongClient = await exchange(other, code, p.verifier);
    assert(wrongClient.status === 400 && wrongClient.body.error === 'invalid_grant', wrongClient.text);

    code = (await consent(julie, client, p)).searchParams.get('code');
    const wrongRedirect = await exchange(client, code, p.verifier, { redirect_uri: 'https://claude.ai/other' });
    assert(wrongRedirect.status === 400 && wrongRedirect.body.error === 'invalid_grant', wrongRedirect.text);

    code = (await consent(julie, client, p)).searchParams.get('code');
    const ok = await exchange(client, code, p.verifier);
    assert(ok.status === 200 && /^tdoc_/.test(ok.body.access_token) && /^tdocr_/.test(ok.body.refresh_token), ok.text);
    assert(ok.body.token_type === 'Bearer' && ok.body.expires_in === 3600 && ok.body.scope === 'mcp', ok.text);
    assert(ok.headers.get('cache-control') === 'no-store', 'no-store');
    const replay = await exchange(client, code, p.verifier);
    assert(replay.status === 400 && replay.body.error === 'invalid_grant', 'code replay');

    code = (await consent(julie, client, p)).searchParams.get('code');
    const expired = env.META.map.get(`oauth-code:${crypto.createHash('sha256').update(code).digest('hex')}`);
    const rec = JSON.parse(expired); rec.expires_at = new Date(Date.now() - 1000).toISOString();
    env.META.map.set(`oauth-code:${crypto.createHash('sha256').update(code).digest('hex')}`, JSON.stringify(rec));
    const late = await exchange(client, code, p.verifier);
    assert(late.status === 400 && late.body.error === 'invalid_grant', 'expired code');
  });

  await t('token: a confidential client must present its secret', async () => {
    const client = (await register({ token_endpoint_auth_method: 'client_secret_basic' })).body;
    const p = pkce();
    let code = (await consent(julie, client, p)).searchParams.get('code');
    const none = await exchange(client, code, p.verifier);
    assert(none.status === 401 && none.body.error === 'invalid_client', none.text);
    code = (await consent(julie, client, p)).searchParams.get('code');
    const basic = 'Basic ' + Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const ok = await form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: REDIRECT }, { Authorization: basic });
    assert(ok.status === 200 && ok.body.access_token, ok.text);
  });

  let julieConn = null;
  await t('the access token is an account token of the approving person, marked mcp, listed in Settings -> Agents', async () => {
    julieConn = await connect(julie);
    const hash = crypto.createHash('sha256').update(julieConn.access_token).digest('hex');
    const rec = JSON.parse(env.META.map.get(`hosted-token:${hash}`));
    assert(rec.account_id === julie.account_id && rec.github_login === 'julie', JSON.stringify(rec));
    assert(rec.oauth && rec.oauth.scope === 'mcp' && rec.oauth.resource === `${ORIGIN}/mcp` && rec.client === 'mcp', JSON.stringify(rec.oauth));
    const list = await call('/api/me/tokens', { cookie: julie.cookie });
    assert(list.body.tokens.some((tk) => tk.id === hash && tk.client === 'mcp' && /Claude/.test(tk.label)), 'listed in Settings -> Agents');
    assert(!JSON.stringify([...env.META.map.values()]).includes(julieConn.access_token), 'no plaintext token stored');
    assert(!JSON.stringify([...env.META.map.values()]).includes(julieConn.refresh_token), 'no plaintext refresh token stored');
  });

  await t('the OAuth token works at /mcp only: the HTTP API refuses it directly', async () => {
    const who = await call('/api/me', { token: julieConn.access_token });
    assert(who.status === 403 && who.body.error === 'token_scope', `${who.status} ${who.text}`);
    const up = await call('/api/upload', { method: 'POST', token: julieConn.access_token, body: { slug: 'direct', version: 1, html: '<p>x</p>' } });
    assert(up.status === 403, `upload ${up.status}`);
    const ok = await mcp(julieConn.access_token, 'tools/list');
    assert(ok.status === 200 && ok.body.result.tools.length === 9, ok.text.slice(0, 200));
  });

  await t('expired or wrong-audience OAuth tokens get 401', async () => {
    const c = await connect(julie);
    const hash = crypto.createHash('sha256').update(c.access_token).digest('hex');
    const rec = JSON.parse(env.META.map.get(`hosted-token:${hash}`));
    env.META.map.set(`hosted-token:${hash}`, JSON.stringify({ ...rec, oauth: { ...rec.oauth, resource: 'https://other.example/mcp' } }));
    assert((await mcp(c.access_token, 'tools/list')).status === 401, 'audience');
    env.META.map.set(`hosted-token:${hash}`, JSON.stringify({ ...rec, oauth: { ...rec.oauth, expires_at: new Date(Date.now() - 1).toISOString() } }));
    const expired = await mcp(c.access_token, 'tools/list');
    assert(expired.status === 401 && /invalid_token/.test(expired.headers.get('www-authenticate')), 'expired');
  });

  await t('refresh rotates both tokens; a replayed refresh token ends the whole grant', async () => {
    const c = await connect(julie);
    const r1 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client.client_id });
    assert(r1.status === 200 && r1.body.access_token !== c.access_token && r1.body.refresh_token !== c.refresh_token, r1.text);
    assert((await mcp(c.access_token, 'tools/list')).status === 401, 'old access token is gone');
    assert((await mcp(r1.body.access_token, 'tools/list')).status === 200, 'new access token works');
    const replay = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client.client_id });
    assert(replay.status === 400 && replay.body.error === 'invalid_grant', replay.text);
    assert((await mcp(r1.body.access_token, 'tools/list')).status === 401, 'replay revoked the live access token');
    const after = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: c.client.client_id });
    assert(after.status === 400, 'and the live refresh token');
    const otherClient = (await register()).body;
    const c2 = await connect(julie);
    const stolen = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c2.refresh_token, client_id: otherClient.client_id });
    assert(stolen.status === 400 && stolen.body.error === 'invalid_grant', 'refresh bound to its client');
  });

  await t('revoke: RFC 7009 endpoint, and removing the connection in Settings -> Agents', async () => {
    const c = await connect(julie);
    const rv = await form('/oauth/revoke', { token: c.refresh_token, client_id: c.client.client_id });
    assert(rv.status === 200, `revoke ${rv.status}`);
    assert((await mcp(c.access_token, 'tools/list')).status === 401, 'access gone with the grant');
    const unknown = await form('/oauth/revoke', { token: 'tdocr_' + '0'.repeat(64), client_id: c.client.client_id });
    assert(unknown.status === 200, 'unknown token: still 200');

    const s = await connect(julie);
    const id = crypto.createHash('sha256').update(s.access_token).digest('hex');
    const del = await call('/api/me/tokens/revoke', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id } });
    assert(del.status === 200, del.text);
    assert((await mcp(s.access_token, 'tools/list')).status === 401, 'revoked in Settings');
    const refresh = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client.client_id });
    assert(refresh.status === 400 && refresh.body.error === 'invalid_grant', 'refresh cannot bring it back');
  });

  await t('Settings: removing a connection after its token rotated still ends it; Remove all ends every grant', async () => {
    const c = await connect(julie);
    const oldId = crypto.createHash('sha256').update(c.access_token).digest('hex');
    const r1 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client.client_id });
    const del = await call('/api/me/tokens/revoke', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: oldId } });
    assert(del.status === 200, `revoke by the listed (rotated) id: ${del.status}`);
    assert((await mcp(r1.body.access_token, 'tools/list')).status === 401, 'current token gone');
    const again = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: c.client.client_id });
    assert(again.status === 400, 'refresh gone');

    const x = await connect(julie);
    // Simulate a listing that missed the newest token: hide it from list().
    const hidden = crypto.createHash('sha256').update(x.access_token).digest('hex');
    const list = env.META.list.bind(env.META);
    env.META.list = async (o) => { const r = await list(o); return { ...r, keys: r.keys.filter((k) => k.name !== `hosted-token:${hidden}`) }; };
    try {
      const all = await call('/api/me/tokens/revoke-all', { method: 'POST', cookie: julie.cookie, headers: origin });
      assert(all.status === 200, all.text);
    } finally { env.META.list = list; }
    assert((await mcp(x.access_token, 'tools/list')).status === 401, 'unlisted live token is ended by the account mark');
    const rx = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: x.refresh_token, client_id: x.client.client_id });
    assert(rx.status === 400, 'and cannot refresh');
    await new Promise((r) => setTimeout(r, 5));
    julieConn = await connect(julie);
    assert((await mcp(julieConn.access_token, 'tools/list')).status === 200, 'a connection made afterwards works');
    julie.token = (await call('/api/hosted/token', { method: 'POST', cookie: julie.cookie, body: { label: 'again' } })).body.token;
  });

  await t('the OAuth token is refused wherever a token is read, not only on /api', async () => {
    const r = await tool(julieConn.access_token, 'create_doc', { title: 'Private one', html: '<p>p</p>', visibility: 'private' });
    const slug = r.structuredContent.slug;
    const direct = await call(`/d/${slug}/raw`, { token: julieConn.access_token });
    assert(direct.status !== 200, `raw with the OAuth token: ${direct.status}`);
    assert((await call(`/d/${slug}/raw`, { token: julie.token })).status === 200, 'the account token still reads it');
  });

  await t('a client registered without refresh_token gets no refresh token', async () => {
    const client = (await register({ grant_types: ['authorization_code'] })).body;
    const p = pkce();
    const back = await consent(julie, client, p);
    const tok = await exchange(client, back.searchParams.get('code'), p.verifier);
    assert(tok.status === 200 && tok.body.access_token && !tok.body.refresh_token, tok.text);
  });

  // ---------------------------------------------------------------- MCP
  await t('legacy clients: initialize negotiates a supported revision, no session id', async () => {
    const r = await mcp(julieConn.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Cursor', version: '1' } }, { legacy: true });
    assert(r.status === 200 && r.body.result.protocolVersion === '2025-06-18' && r.body.result.serverInfo.name === 'tdoc', r.text);
    assert(!r.headers.get('mcp-session-id'), 'stateless');
    const note = await raw(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${julieConn.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }));
    assert(note.status === 202, `notification ${note.status}`);
    const list = await mcp(julieConn.access_token, 'tools/list', {}, { legacy: true });
    assert(list.status === 200 && !('resultType' in list.body.result), 'legacy result shape');
    const get = await raw(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${julieConn.access_token}`, Accept: 'text/event-stream' } }));
    assert(get.status === 405, `GET ${get.status}`);
  });

  await t('2026-07-28: server/discover, header/body checks, unsupported version, unknown method', async () => {
    const d = await mcp(julieConn.access_token, 'server/discover');
    assert(d.status === 200 && d.body.result.resultType === 'complete' && d.body.result.supportedVersions.includes('2026-07-28'), d.text);
    const mismatch = await mcp(julieConn.access_token, 'tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } });
    assert(mismatch.status === 400 && mismatch.body.error.code === -32020, mismatch.text);
    const nameMismatch = await mcp(julieConn.access_token, 'tools/call', { name: 'list_docs', arguments: {} }, { headers: { 'Mcp-Name': 'create_doc' } });
    assert(nameMismatch.status === 400 && nameMismatch.body.error.code === -32020, 'Mcp-Name');
    const old = await mcp(julieConn.access_token, 'tools/list', {}, { version: '1900-01-01' });
    assert(old.status === 400 && old.body.error.code === -32022 && old.body.error.data.supported.includes('2026-07-28'), old.text);
    const unknown = await mcp(julieConn.access_token, 'nope/nothing');
    assert(unknown.status === 404 && unknown.body.error.code === -32601, unknown.text);
    const evil = await mcp(julieConn.access_token, 'tools/list', {}, { headers: { Origin: 'https://evil.example' } });
    assert(evil.status === 403, `Origin ${evil.status}`);
    const sse = await mcp(julieConn.access_token, 'tools/list', {}, { headers: { Accept: 'text/event-stream' } });
    assert(sse.status === 200 && /^event: message\ndata: \{/.test(sse.text), 'SSE response when JSON is not accepted');
  });

  await t('tools/list carries annotations and the authoring contract; resources and prompts serve the guides', async () => {
    const tools = (await mcp(julieConn.access_token, 'tools/list')).body.result.tools;
    const names = tools.map((x) => x.name).sort().join(',');
    assert(names === 'answer_question,create_doc,get_comments,get_doc,list_docs,reply_to_comment,resolve_comment,share_doc,update_doc', names);
    const create = tools.find((x) => x.name === 'create_doc');
    assert(/Voice:/.test(create.description) && /Visuals:/.test(create.description) && /tdoc:\/\/authoring/.test(create.description), 'authoring essentials');
    assert(tools.find((x) => x.name === 'get_doc').annotations.readOnlyHint === true && create.annotations.readOnlyHint === false, 'annotations');
    const reply = tools.find((x) => x.name === 'reply_to_comment');
    assert(/"applied" only when/.test(reply.description) && /"question" when/.test(reply.description), 'status rules');
    const res = (await mcp(julieConn.access_token, 'resources/list')).body.result.resources;
    assert(res.some((r) => r.uri === 'tdoc://authoring/voice.md') && res.some((r) => r.uri === 'tdoc://authoring/style/default.md'), JSON.stringify(res.map((r) => r.uri)));
    const voice = await mcp(julieConn.access_token, 'resources/read', { uri: 'tdoc://authoring/voice.md' });
    assert(/Voice/.test(voice.body.result.contents[0].text), 'voice.md content');
    const escape = await mcp(julieConn.access_token, 'resources/read', { uri: 'tdoc://authoring/../SKILL.md' });
    assert(escape.body.error, 'no path escape');
    const prompts = (await mcp(julieConn.access_token, 'prompts/list')).body.result.prompts.map((p) => p.name).sort().join(',');
    assert(prompts === 'revise_from_comments,write_doc', prompts);
    const wp = await mcp(julieConn.access_token, 'prompts/get', { name: 'write_doc', arguments: { topic: 'onboarding' } });
    assert(/tdoc:\/\/authoring\/voice\.md/.test(wp.body.result.messages[0].content.text), 'prompt points at the guides');
  });

  let julieSlug = null;
  await t('create_doc (markdown) publishes to My docs and returns the link; get_doc reads it back', async () => {
    const r = await tool(julieConn.access_token, 'create_doc', { title: 'Onboarding plan', markdown: '# Onboarding plan\n\nWe cut setup to **one click**.\n\n| step | time |\n|---|---|\n| sign in | 10s |\n\n<script>alert(1)</script>' });
    assert(!r.isError && r.structuredContent.url === `${ORIGIN}/d/onboarding-plan`, JSON.stringify(r));
    julieSlug = r.structuredContent.slug;
    const stored = env.DOCS.map.get(`docs/${julieSlug}/v1/index.html`);
    assert(/<table[ >]/.test(stored) && /<strong>one click<\/strong>/.test(stored) && !/<script>alert/.test(stored), 'markdown rendered, html escaped');
    const meta = JSON.parse(env.META.map.get(`meta:${julieSlug}`));
    assert(meta.hosted.account_id === julie.account_id && meta.versions[0].by === julie.account_id, 'owned by the approver, written by their agent');
    assert(meta.access.visibility === 'unlisted', 'shared by link by default');
    const text = await tool(julieConn.access_token, 'get_doc', { slug: `${ORIGIN}/d/${julieSlug}` });
    assert(!text.isError && /one click/.test(text.content[0].text) && text.structuredContent.version === 1, JSON.stringify(text).slice(0, 300));
    const html = await tool(julieConn.access_token, 'get_doc', { slug: julieSlug, format: 'html' });
    assert(/<main class="wrap">/.test(html.structuredContent.html), 'exact html');
    const again = await tool(julieConn.access_token, 'create_doc', { title: 'Onboarding plan', html: '<p>second</p>' });
    assert(!again.isError && again.structuredContent.slug !== julieSlug && again.structuredContent.slug.startsWith('onboarding-plan-'), 'a taken slug gets a suffix');
  });

  await t('list_docs lists My docs and team docs', async () => {
    const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name: 'Acme' } })).body.team;
    await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
    const td = await tool(julieConn.access_token, 'create_doc', { title: 'Team roadmap', html: '<h1>Roadmap</h1><p>q4</p>', team: 'Acme' });
    assert(!td.isError && td.structuredContent.team === team.id, JSON.stringify(td));
    const list = await tool(julieConn.access_token, 'list_docs', {});
    const slugs = list.structuredContent.docs.map((d) => d.slug);
    assert(slugs.includes(julieSlug) && slugs.includes('team-roadmap'), slugs.join(','));
    assert(list.structuredContent.docs.find((d) => d.slug === 'team-roadmap').team === 'Acme', 'team named');
    const mineOnly = await tool(julieConn.access_token, 'list_docs', { space: 'me' });
    assert(!mineOnly.structuredContent.docs.some((d) => d.slug === 'team-roadmap'), 'space=me');
  });

  await t('comments loop: get_comments, update_doc, reply_to_comment applied, resolve_comment, share_doc', async () => {
    const c = await call('/api/comments', { method: 'POST', cookie: carl.cookie, headers: origin, body: { slug: julieSlug, version: 1, text: 'Say how long sign-in takes', anchor: { kind: 'text', text: 'one click' } } });
    assert(c.status === 200 && c.body.id, c.text);
    const list = await tool(julieConn.access_token, 'get_comments', { slug: julieSlug });
    assert(list.structuredContent.comments.some((x) => x.id === c.body.id && x.anchor === 'one click'), JSON.stringify(list.structuredContent).slice(0, 300));
    const early = await tool(julieConn.access_token, 'reply_to_comment', { slug: julieSlug, comment_id: c.body.id, text: 'Done', status: 'applied', applied_in: 2 });
    assert(!early.isError && early.structuredContent.status === 'answered' && early.structuredContent.downgraded_from === 'applied', 'applied without a new version is recorded as answered');
    await call('/api/comments', { method: 'POST', cookie: carl.cookie, headers: origin, body: { slug: julieSlug, version: 1, parent_id: c.body.id, text: 'Please change the doc' } });
    const up = await tool(julieConn.access_token, 'update_doc', { slug: julieSlug, html: '<h1>Onboarding plan</h1><p>Sign-in takes ten seconds.</p>', summary: 'Say how long sign-in takes' });
    assert(!up.isError && up.structuredContent.version === 2, JSON.stringify(up));
    const reply = await tool(julieConn.access_token, 'reply_to_comment', { slug: julieSlug, comment_id: c.body.id, text: 'Added: ten seconds.', status: 'applied', applied_in: 2 });
    assert(!reply.isError && reply.structuredContent.status === 'applied', JSON.stringify(reply));
    const thread = (await call(`/api/comments?slug=${julieSlug}&version=all`, { token: julie.token })).body.find((x) => x.id === c.body.id);
    const agentReply = thread.replies[thread.replies.length - 1];
    assert(agentReply.author.kind === 'agent' && agentReply.author.login === 'claude', JSON.stringify(agentReply.author));
    const res = await tool(julieConn.access_token, 'resolve_comment', { slug: julieSlug, comment_id: c.body.id });
    assert(!res.isError && res.structuredContent.resolved === false && res.structuredContent.reason === 'not_handed_off', JSON.stringify(res));
    const share = await tool(julieConn.access_token, 'share_doc', { slug: julieSlug, visibility: 'private', invite: ['dana@example.com'] });
    assert(!share.isError && share.structuredContent.access.visibility === 'private' && share.structuredContent.access.allowed_users.includes('dana@example.com'), JSON.stringify(share));
  });

  let bobConn = null;
  await t("refusal: another person's doc (update, share, reply-applied) is refused like the HTTP API", async () => {
    bobConn = await connect(bob);
    const theirs = await tool(julieConn.access_token, 'create_doc', { title: 'Julie only', html: '<p>mine</p>' });
    const slug = theirs.structuredContent.slug;
    const up = await tool(bobConn.access_token, 'update_doc', { slug, html: '<p>bob was here</p>' });
    assert(up.isError && up.structuredContent.error === 'not_doc_owner', JSON.stringify(up));
    const share = await tool(bobConn.access_token, 'share_doc', { slug, visibility: 'public' });
    assert(share.isError && share.structuredContent.error === 'not_doc_owner', JSON.stringify(share));
    const priv = await tool(bobConn.access_token, 'get_doc', { slug: julieSlug });
    assert(priv.isError && priv.structuredContent.error === 'access_denied', `private doc: ${JSON.stringify(priv)}`);
    assert(JSON.parse(env.META.map.get(`meta:${slug}`)).versions.length === 1, 'nothing written');
  });

  await t('refusal: an answer-only question locks the agent out of edits until answer_question lands', async () => {
    const team = JSON.parse(env.META.map.get(`team:${(await call('/api/teams', { cookie: julie.cookie })).body.teams[0].id}`) || 'null')
      || (await call('/api/teams', { cookie: julie.cookie })).body.teams[0];
    const teamId = team.id;
    const made = await tool(julieConn.access_token, 'create_doc', { title: 'Bobs notes', html: '<p>a sentence to ask about</p>', team: 'Acme' });
    const slug = made.structuredContent.slug;
    // Bob's own agent wrote the latest version, so authorship lets his agent edit.
    const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
    meta.versions[meta.versions.length - 1].by = bob.account_id;
    env.META.map.set(`meta:${slug}`, JSON.stringify(meta));
    assert(meta.workspace_id === teamId, 'team doc');
    await call('/api/notify/local/register', { method: 'POST', token: bob.token, body: { device: 'bobbox', clis: ['claude'] } });
    const own = (await call(`/api/docs/${slug}/my-agent`, { cookie: bob.cookie })).body.agents[0];
    assert(own, 'bob has an agent');
    const sent = await call(`/api/docs/${slug}/hand-off`, { method: 'POST', cookie: bob.cookie, headers: origin, body: { ask_only: true, only_me: true, question: 'what is this?', recipient: own } });
    assert(sent.status === 200 && sent.body.ask, sent.text);
    const locked = await tool(bobConn.access_token, 'update_doc', { slug, html: '<p>edited</p>' });
    assert(locked.isError && locked.structuredContent.error === 'answer_only_run' && /answer_question/.test(locked.content[0].text), JSON.stringify(locked));
    const ans = await tool(bobConn.access_token, 'answer_question', { slug, ask_id: sent.body.ask.ask_id, text: 'Notes for the Q4 plan.' });
    assert(!ans.isError, JSON.stringify(ans));
    const after = await tool(bobConn.access_token, 'update_doc', { slug, html: '<p>edited</p>' });
    assert(!after.isError && after.structuredContent.version === 2, JSON.stringify(after));
    const notMine = await tool(carl.token, 'answer_question', { slug, ask_id: sent.body.ask.ask_id, text: 'x' });
    assert(notMine.isError, 'someone else cannot answer it');
  });

  await t('refusal: a workspace-scoped connection (My docs only) cannot reach team docs', async () => {
    const scoped = await connect(julie, { workspaces: ['me'] });
    const hash = crypto.createHash('sha256').update(scoped.access_token).digest('hex');
    assert(JSON.parse(env.META.map.get(`hosted-token:${hash}`)).scope.teams.length === 0, 'token scoped to My docs');
    const list = await tool(scoped.access_token, 'list_docs', {});
    assert(!list.structuredContent.docs.some((d) => d.slug === 'team-roadmap') && list.structuredContent.docs.some((d) => d.slug === julieSlug), 'only My docs');
    const create = await tool(scoped.access_token, 'create_doc', { title: 'Into the team', html: '<p>x</p>', team: 'Acme' });
    assert(create.isError && create.structuredContent.error === 'token_scope', JSON.stringify(create));
    const up = await tool(scoped.access_token, 'update_doc', { slug: 'team-roadmap', html: '<p>x</p>' });
    assert(up.isError && ['token_scope', 'access_denied'].includes(up.structuredContent.error), JSON.stringify(up));
    const own = await tool(scoped.access_token, 'update_doc', { slug: julieSlug, html: '<p>v3</p>' });
    assert(!own.isError, 'its own workspace still works');
  });

  await t('an existing tdoc_ account token works at /mcp for clients without OAuth', async () => {
    const r = await tool(carl.token, 'create_doc', { title: 'Carl via header', html: '<p>hi</p>' });
    assert(!r.isError && r.structuredContent.slug === 'carl-via-header', JSON.stringify(r));
    // ...and keeps working on the HTTP API: only OAuth tokens are /mcp-only.
    assert((await call('/api/me', { token: carl.token })).status === 200, 'account token unchanged');
  });

  await t('rate limit: tool calls per connection per minute', async () => {
    const c = await connect(carl);
    let limited = null;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await tool(c.access_token, 'list_docs', {});
      if (r.isError && r.structuredContent.error === 'rate_limited') limited = i;
    }
    assert(limited === 60, `limited after ${limited}`);
    const other = await tool(julieConn.access_token, 'list_docs', {});
    assert(!other.isError, 'another connection is unaffected');
  });

  await t('audit lines name the step and outcome, never a token, account, client or slug', async () => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try {
      const c = await connect(carl);
      await tool(c.access_token, 'get_doc', { slug: 'carl-via-header' });
      const all = logs.join('\n');
      assert(/"type":"tdoc_oauth"/.test(all) && /"type":"tdoc_mcp"/.test(all), all.slice(0, 300));
      for (const secret of [c.access_token, c.refresh_token, c.client.client_id, carl.account_id, 'carl-via-header']) assert(!all.includes(secret), `leaked ${secret.slice(0, 10)}`);
    } finally { console.log = orig; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
