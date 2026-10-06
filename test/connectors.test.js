// Connectors: where an account's handoffs go. Webhook connectors (signed
// POST), the test button, Disconnect that actually stops delivery, and the
// boundaries (browser session only, same origin, own account's targets).

const crypto = require('crypto');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const posts = [];
const raftCalls = [];
// The server's agent directory as Raft's App API would list it; null makes
// the installation token exchange fail (Agent permission still in review).
let directory = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = String(input && input.url || input);
  if (u.startsWith('https://raft.test/')) {
    const path = new URL(u).pathname;
    raftCalls.push({ path, headers: init.headers || {}, body: init.body });
    if (path === '/api/oauth/installation-token') {
      const asked = JSON.parse(init.body || '{}');
      if (!directory || asked.installation_id !== 'inst-1' || !(asked.groups || []).includes('agent')) return new Response('{"error":"forbidden"}', { status: 403 });
      return new Response(JSON.stringify({ access_token: 'inst-tok', expires_in: 3600 }), { status: 200 });
    }
    if (path === '/api/app-installation/agents') {
      const auth = (init.headers || {}).Authorization;
      if (auth !== 'Bearer inst-tok') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ agents: directory }), { status: 200 });
    }
    const body = path.endsWith('openid-configuration')
      ? { issuer: 'https://raft.test', authorization_endpoint: 'https://raft.test/oauth/authorize', token_endpoint: 'https://raft.test/api/oauth/token', userinfo_endpoint: 'https://raft.test/api/oauth/userinfo' }
      : path.endsWith('/token') ? { access_token: 'at-human', token_type: 'Bearer' }
      : path.endsWith('/userinfo') ? { sub: 'human-1', type: 'human', preferred_username: 'julie' }
      : path.endsWith('/serverinfo') ? { id: 'S9', slug: 'julies-server', name: 'Julie' }
      : path === '/api/oauth/requests/agent' ? { requestId: 'req-1', agent: { serverId: 'S9' } }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.startsWith('https://hooks.example/')) {
    posts.push({ url: u, headers: init.headers || {}, body: init.body });
    return new Response('ok', { status: u.endsWith('/fail') ? 500 : 200 });
  }
  return realFetch(input, init);
};

const post = (path, cookie, body, origin = 'https://tdoc.dev') => new Request(`https://tdoc.dev${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify(body || {}),
});

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('connectors');

  async function seed() {
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'cdoc', version: 1, html: '<h1>d</h1><p>hello world</p>' } }), env, {});
    const c = await (await worker.fetch(req('/api/comments', { method: 'POST', cookie: owner.cookie, body: { slug: 'cdoc', version: 1, text: 'fix', anchor: { kind: 'text', text: 'hello' } } }), env, {})).json();
    return { env, owner, commentId: c.id };
  }
  const addHook = async (env, cookie, url = 'https://hooks.example/a', label = 'My bot') =>
    (await worker.fetch(post('/api/me/connectors/webhook', cookie, { url, label }), env, {})).json();

  await t('a webhook connector is added once, its secret shown once', async () => {
    const { env, owner } = await seed();
    for (const url of ['http://hooks.example/a', 'not a url', 'https://u:p@hooks.example/a']) {
      const r = await worker.fetch(post('/api/me/connectors/webhook', owner.cookie, { url }), env, {});
      assert(r.status === 400, `${url} accepted: ${r.status}`);
    }
    const made = await addHook(env, owner.cookie);
    assert(made.ok && /^whsec_/.test(made.secret) && made.target.provider === 'webhook', JSON.stringify(made));
    const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
    assert(list.targets.length === 1 && list.targets[0].agent_name === 'My bot', JSON.stringify(list));
    assert(!JSON.stringify(list).includes(made.secret), 'secret leaked into the list');
  });

  await t('a handoff to a webhook is a signed POST of the handoff payload', async () => {
    const { env, owner, commentId } = await seed();
    const made = await addHook(env, owner.cookie);
    posts.length = 0;
    const r = await (await worker.fetch(req('/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug: 'cdoc', comment_ids: [commentId] } }), env, {})).json();
    assert(r.delivery && r.delivery.status === 'delivered', JSON.stringify(r));
    assert(posts.length === 1, `posts ${posts.length}`);
    const body = JSON.parse(posts[0].body);
    assert(body.type === 'tdoc.handoff' && body.slug === 'cdoc' && body.comment_ids[0] === commentId, posts[0].body);
    const expect = 'sha256=' + crypto.createHmac('sha256', made.secret).update(posts[0].body).digest('hex');
    assert(posts[0].headers['X-Tdoc-Signature'] === expect, 'signature does not verify');
  });

  await t('Send test reaches the connector and reports a failure honestly', async () => {
    const { env, owner } = await seed();
    const good = await addHook(env, owner.cookie);
    const badHook = await addHook(env, owner.cookie, 'https://hooks.example/fail', 'broken');
    const k = (x) => ({ provider: x.target.provider, server_id: x.target.server_id, agent_sub: x.target.agent_sub });
    const g = await (await worker.fetch(post('/api/me/connectors/test', owner.cookie, k(good)), env, {})).json();
    assert(g.delivery.status === 'delivered', JSON.stringify(g));
    const b = await (await worker.fetch(post('/api/me/connectors/test', owner.cookie, k(badHook)), env, {})).json();
    assert(b.delivery.status === 'failed' && b.delivery.error === 'webhook_500', JSON.stringify(b));
  });

  await t('Disconnect stops delivery, even for docs that agent worked on', async () => {
    const { env, owner, commentId } = await seed();
    const made = await addHook(env, owner.cookie);
    const key = { provider: 'webhook', server_id: 'webhook', agent_sub: made.target.agent_sub };
    // The connector also holds a seat on the doc, the way an agent that
    // replied would.
    const reply = await worker.fetch(req('/api/agent/reply', { method: 'POST', token: owner.token, headers: { 'X-Tdoc-Agent': `webhook/webhook/${made.target.agent_sub}` }, body: { slug: 'cdoc', parent_id: commentId, text: 'on it', status: 'partial' } }), env, {});
    assert(reply.status === 200, `reply ${reply.status}`);
    const before = await (await worker.fetch(req('/api/notify/targets?slug=cdoc', { cookie: owner.cookie }), env, {})).json();
    assert(before.default && before.default.source === 'doc', `seat not claimed: ${JSON.stringify(before.default)}`);
    const rm = await worker.fetch(post('/api/me/connectors/remove', owner.cookie, key), env, {});
    assert(rm.status === 200, `remove ${rm.status}`);
    const after = await (await worker.fetch(req('/api/notify/targets?slug=cdoc', { cookie: owner.cookie }), env, {})).json();
    assert(!after.default && after.reason === 'no_agent_bound', `still routed: ${JSON.stringify(after)}`);
  });

  await t('only the account’s own browser session manages connectors', async () => {
    const { env, owner } = await seed();
    const viaToken = await worker.fetch(req('/api/me/connectors', { token: owner.token }), env, {});
    assert(viaToken.status === 401, `token listed connectors: ${viaToken.status}`);
    const cross = await worker.fetch(post('/api/me/connectors/webhook', owner.cookie, { url: 'https://hooks.example/a' }, 'https://evil.example'), env, {});
    assert(cross.status === 403, `cross-site add: ${cross.status}`);
    const other = await issue(worker, env, 'stranger');
    const mine = await addHook(env, owner.cookie);
    const steal = await worker.fetch(post('/api/me/connectors/remove', other.cookie, { provider: 'webhook', server_id: 'webhook', agent_sub: mine.target.agent_sub }), env, {});
    assert(steal.status === 404, `another account removed it: ${steal.status}`);
  });

  await t('an agent naming a connector that is not this account’s claims nothing', async () => {
    const { env, owner, commentId } = await seed();
    const other = await issue(worker, env, 'stranger');
    const theirs = await addHook(env, other.cookie);
    await worker.fetch(req('/api/agent/reply', { method: 'POST', token: owner.token, headers: { 'X-Tdoc-Agent': `webhook/webhook/${theirs.target.agent_sub}` }, body: { slug: 'cdoc', parent_id: commentId, text: 'hi', status: 'partial' } }), env, {});
    const r = await (await worker.fetch(req('/api/notify/targets?slug=cdoc', { cookie: owner.cookie }), env, {})).json();
    assert(!r.default, `a foreign connector took the seat: ${JSON.stringify(r.default)}`);
  });

  // Raft trusts the SERVER: one agent linked from it connects the server, and
  // any agent on it that says who it is takes the seat on docs it works on.
  async function seedRaft() {
    const ctx = await seed();
    await ctx.env.META.put(`account-notify:${ctx.owner.account_id}`, JSON.stringify([
      { provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: 'agent-a', agent_name: 'alpha' },
    ]));
    return ctx;
  }
  const replyAs = (ctx, headers) => worker.fetch(req('/api/agent/reply', { method: 'POST', token: ctx.owner.token, headers, body: { slug: 'cdoc', parent_id: ctx.commentId, text: 'answer', status: 'partial' } }), ctx.env, {});
  const targetsOf = async (ctx) => (await worker.fetch(req('/api/notify/targets?slug=cdoc', { cookie: ctx.owner.cookie }), ctx.env, {})).json();

  await t('an unlinked agent on a connected Raft server takes the seat on its doc', async () => {
    const ctx = await seedRaft();
    const reply = await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S1/agent-b', 'X-Tdoc-Raft-Agent-Name': encodeURIComponent('小c') });
    const posted = await reply.json();
    assert(posted.author.provider === 'raft' && posted.author.handle === '@小c', JSON.stringify(posted.author));
    const r = await targetsOf(ctx);
    assert(r.default && r.default.source === 'doc' && r.default.agent_sub === 'agent-b' && r.default.agent_name === '小c' && r.default.server_slug === 'acme', JSON.stringify(r.default));
  });

  await t('an agent on a server that is not connected claims nothing', async () => {
    const ctx = await seedRaft();
    await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S2/agent-x', 'X-Tdoc-Raft-Agent-Name': 'xavier' });
    const r = await targetsOf(ctx);
    assert(r.default && r.default.source === 'account' && r.default.agent_sub === 'agent-a', JSON.stringify(r.default));
  });

  await t('without its handle an agent cannot be routed, so it claims nothing', async () => {
    const ctx = await seedRaft();
    await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S1/agent-b' });
    const r = await targetsOf(ctx);
    assert(r.default && r.default.agent_sub === 'agent-a', JSON.stringify(r.default));
  });

  await t('the list shows one row per connector; disconnecting a server stops all its agents', async () => {
    const ctx = await seedRaft();
    await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S1/agent-b', 'X-Tdoc-Raft-Agent-Name': 'beta' });
    await addHook(ctx.env, ctx.owner.cookie);
    const list = await (await worker.fetch(req('/api/me/connectors', { cookie: ctx.owner.cookie }), ctx.env, {})).json();
    const kinds = list.connectors.map((c) => c.kind).sort().join(',');
    assert(kinds === 'raft,webhook', `connectors ${kinds}`);
    const raft = list.connectors.find((c) => c.kind === 'raft');
    assert(raft.server_slug === 'acme' && raft.agents.length === 2, JSON.stringify(raft));
    assert(list.default && list.default.agent_name === 'beta', `most recently active agent is not the automatic fallback: ${JSON.stringify(list.default)}`);
    const rm = await worker.fetch(post('/api/me/connectors/remove', ctx.owner.cookie, { provider: 'raft', server_id: 'S1' }), ctx.env, {});
    assert(rm.status === 200, `remove ${rm.status}`);
    const r = await targetsOf(ctx);
    assert(!r.default || r.default.provider === 'webhook', `a disconnected server still routes: ${JSON.stringify(r.default)}`);
    await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S1/agent-c', 'X-Tdoc-Raft-Agent-Name': 'gamma' });
    const again = await targetsOf(ctx);
    assert(!again.default || again.default.provider === 'webhook', `new agent on the disconnected server claimed: ${JSON.stringify(again.default)}`);
  });

  const RAFT = { RAFT_CLIENT_ID: 'tdoc-x', RAFT_CLIENT_SECRET: 's', RAFT_OIDC_ISSUER: 'https://raft.test', RAFT_API_BASE: 'https://raft.test' };
  async function connectRaft(env, cookie, otherCookie, popup = false, { attempt = '', callback = 'code=c1' } = {}) {
    const q = new URLSearchParams();
    if (popup) q.set('popup', '1');
    if (attempt) q.set('attempt', attempt);
    const start = await worker.fetch(req(`/api/me/connectors/raft/start${q.toString() ? `?${q}` : ''}`, { cookie }), env, {});
    const loc = new URL(start.headers.get('Location'));
    const state = loc.searchParams.get('state');
    const stateCookie = (start.headers.get('Set-Cookie') || '').split(';')[0];
    const back = await worker.fetch(req(`/auth/raft/callback?${callback}&state=${state}`, { cookie: `${otherCookie || cookie}; ${stateCookie}` }), env, {});
    return { start, back };
  }
  const attemptOf = async (env, cookie, id) => (await worker.fetch(req(`/api/me/connectors/raft/attempt?id=${id}`, { cookie }), env, {})).json();

  await t('Connect with Raft: one sign-in connects the person\'s server', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    const { start, back } = await connectRaft(env, owner.cookie);
    assert(start.status === 302 && start.headers.get('Location').startsWith('https://raft.test/oauth/authorize'), `start ${start.status}`);
    assert(back.status === 302 && back.headers.get('Location').includes('connected=raft'), `callback ${back.status} ${back.headers.get('Location')}`);
    const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
    const raft = list.connectors.find((c) => c.kind === 'raft');
    assert(raft && raft.server_id === 'S9' && raft.server_slug === 'julies-server', JSON.stringify(list.connectors));
  });

  await t('document popup connect reports success without navigating to Agents', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    const { back } = await connectRaft(env, owner.cookie, null, true);
    const page = await back.text();
    assert(back.status === 200 && /tdoc:raft-connected/.test(page), `popup callback ${back.status}`);
    assert(!/\/me\/agents\?tab=send/.test(page), 'popup callback sent the document away to Agents');
    assert((back.headers.get('Set-Cookie') || '').includes('Max-Age=0'), 'OAuth state cookie was not cleared');
    const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
    assert(list.connectors.some((c) => c.kind === 'raft' && c.server_id === 'S9'), JSON.stringify(list));
  });

  await t('a connect started by one tdoc session cannot finish on another', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    const other = await issue(worker, env, 'stranger');
    const { back } = await connectRaft(env, owner.cookie, other.cookie);
    assert(back.status === 403, `cross-session connect: ${back.status}`);
    const theirs = await (await worker.fetch(req('/api/me/connectors', { cookie: other.cookie }), env, {})).json();
    assert(!theirs.connectors.length, 'the other account got the server');
  });

  await t('after connecting, a default agent is set by handle and receives handoffs', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    await connectRaft(env, owner.cookie);
    const bad = await worker.fetch(post('/api/me/connectors/raft/default', owner.cookie, { server_id: 'NOPE', agent_name: 'x' }), env, {});
    assert(bad.status === 404, `unconnected server: ${bad.status}`);
    const set = await (await worker.fetch(post('/api/me/connectors/raft/default', owner.cookie, { server_id: 'S9', agent_name: '@小c' }), env, {})).json();
    assert(set.ok && set.target.agent_name === '小c' && set.target.server_slug === 'julies-server', JSON.stringify(set));
    await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'rdoc', version: 1, html: '<p>x</p>' } }), env, {});
    const r = await (await worker.fetch(req('/api/notify/targets?slug=rdoc', { cookie: owner.cookie }), env, {})).json();
    assert(r.default && r.default.agent_name === '小c', JSON.stringify(r.default));
  });

  await t('a connected Raft server with no agent yet says so, instead of looking unconnected', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'ndoc', version: 1, html: '<p>x</p>' } }), env, {});
    const before = await (await worker.fetch(req('/api/notify/targets?slug=ndoc', { cookie: owner.cookie }), env, {})).json();
    assert(before.reason === 'no_agent_bound' && !before.raft_servers, `nothing connected yet: ${JSON.stringify(before)}`);
    await connectRaft(env, owner.cookie);
    const connected = await (await worker.fetch(req('/api/notify/targets?slug=ndoc', { cookie: owner.cookie }), env, {})).json();
    assert(!connected.default && connected.reason === 'no_agent_bound', `a server is not a recipient: ${JSON.stringify(connected)}`);
    assert(Array.isArray(connected.raft_servers) && connected.raft_servers.length === 1
      && connected.raft_servers[0].server_id === 'S9' && connected.raft_servers[0].server_slug === 'julies-server', JSON.stringify(connected.raft_servers));
    await worker.fetch(post('/api/me/connectors/raft/default', owner.cookie, { server_id: 'S9', agent_name: 'serena-bot' }), env, {});
    const named = await (await worker.fetch(req('/api/notify/targets?slug=ndoc', { cookie: owner.cookie }), env, {})).json();
    assert(named.default && named.default.agent_name === 'serena-bot' && !named.reason && !named.raft_servers, JSON.stringify(named));
  });

  await t('Send to agent offers every account agent, with the doc\'s last-touched one preselected', async () => {
    const ctx = await seedRaft();
    await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S1/agent-b', 'X-Tdoc-Raft-Agent-Name': 'beta' });
    const r = await targetsOf(ctx);
    assert(r.default && r.default.agent_sub === 'agent-b' && r.default.source === 'doc', `default: ${JSON.stringify(r.default)}`);
    const alpha = (r.candidates || []).find((c) => c.agent_sub === 'agent-a');
    assert(alpha && alpha.source === 'account', `account agent not offered: ${JSON.stringify(r.candidates)}`);
    assert(!(r.candidates || []).some((c) => c.agent_sub === 'agent-b'), 'the preselected agent is listed twice');
    // A fresh comment: the one the agent answered is the person's turn now.
    const fresh = await (await worker.fetch(req('/api/comments', { method: 'POST', cookie: ctx.owner.cookie, body: { slug: 'cdoc', version: 1, text: 'and this', anchor: { kind: 'text', text: 'world' } } }), ctx.env, {})).json();
    const sent = await (await worker.fetch(req('/api/notify/handoff', { method: 'POST', cookie: ctx.owner.cookie, body: { slug: 'cdoc', comment_ids: [fresh.id], recipient: alpha } }), ctx.env, {})).json();
    assert(sent.ok && sent.sent === 1, JSON.stringify(sent));
    const handoffs = await (await worker.fetch(req('/api/notify/handoffs?slug=cdoc', { cookie: ctx.owner.cookie }), ctx.env, {})).json();
    const to = handoffs.handoffs[0] && handoffs.handoffs[0].recipient;
    assert(to && to.agent_sub === 'agent-a', `sent to ${JSON.stringify(to)}`);
    // Picking alpha for this doc makes alpha the doc's agent: the next
    // @agent and Send to agent go to alpha, not back to beta.
    const after = await targetsOf(ctx);
    assert(after.default && after.default.agent_sub === 'agent-a' && after.default.source === 'doc', `the pick did not stick: ${JSON.stringify(after.default)}`);
    assert(after.candidates.some((c) => c.agent_sub === 'agent-b'), 'beta is still offered');
  });

  await t('choosing a known agent as default keeps its identity instead of minting a handle-only one', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    await connectRaft(env, owner.cookie);
    await env.META.put(`account-notify:${owner.account_id}`, JSON.stringify([
      { provider: 'raft', server_id: 'S9', server_slug: 'julies-server', agent_sub: 'uuid-a', agent_name: 'alpha' },
      { provider: 'raft', server_id: 'S9', server_slug: 'julies-server', agent_sub: 'uuid-b', agent_name: 'beta' },
    ]));
    const set = await (await worker.fetch(post('/api/me/connectors/raft/default', owner.cookie, { server_id: 'S9', agent_sub: 'uuid-b' }), env, {})).json();
    assert(set.ok && set.target.agent_sub === 'uuid-b', JSON.stringify(set));
    const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
    assert(list.default.agent_sub === 'uuid-b' && list.targets.length === 2, JSON.stringify(list.targets));
  });

  await t('a popup connect reports waiting, then connected, to the document that started it', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    const other = await issue(worker, env, 'stranger');
    const attempt = 'a'.repeat(32);
    // The document asks before the popup has come back.
    const start = await worker.fetch(req(`/api/me/connectors/raft/start?popup=1&attempt=${attempt}`, { cookie: owner.cookie }), env, {});
    assert(start.status === 302, `start ${start.status}`);
    const waiting = await attemptOf(env, owner.cookie, attempt);
    assert(waiting.status === 'waiting', JSON.stringify(waiting));
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    const stateCookie = (start.headers.get('Set-Cookie') || '').split(';')[0];
    await worker.fetch(req(`/auth/raft/callback?code=c1&state=${state}`, { cookie: `${owner.cookie}; ${stateCookie}` }), env, {});
    const done = await attemptOf(env, owner.cookie, attempt);
    assert(done.status === 'connected' && done.server_slug === 'julies-server', JSON.stringify(done));
    const peek = await attemptOf(env, other.cookie, attempt);
    assert(peek.status === 'unknown', `another account read the attempt: ${JSON.stringify(peek)}`);
  });

  await t('a cancelled popup connect reports failed instead of waiting forever', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT);
    const owner = await issue(worker, env, 'owner');
    const attempt = 'b'.repeat(32);
    const { back } = await connectRaft(env, owner.cookie, null, true, { attempt, callback: 'error=access_denied' });
    assert(back.status === 400, `callback ${back.status}`);
    const r = await attemptOf(env, owner.cookie, attempt);
    assert(r.status === 'failed' && /cancelled/.test(r.message), JSON.stringify(r));
    const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
    assert(!list.connectors.length, 'a cancelled connect connected a server');
  });

  const DIRECTORY = [
    { id: 'id-alpha', handle: 'alpha', display_name: 'Alpha' },
    { id: 'id-beta', handle: 'beta', display_name: 'Beta' },
  ];
  const RAFT_DIR = { ...RAFT, RAFT_INSTALLATION_IDS: JSON.stringify({ S9: 'inst-1' }) };

  await t('Raft\'s agent directory fills the dropdown on a freshly connected server', async () => {
    directory = DIRECTORY;
    try {
      const env = makeEnv(mod.CommentsStore, RAFT_DIR);
      const owner = await issue(worker, env, 'owner');
      await connectRaft(env, owner.cookie);
      await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'ddoc', version: 1, html: '<p>x</p>' } }), env, {});
      const r = await (await worker.fetch(req('/api/notify/targets?slug=ddoc', { cookie: owner.cookie }), env, {})).json();
      assert(!r.default, `nothing is preselected for @agent before a default exists: ${JSON.stringify(r.default)}`);
      const names = (r.candidates || []).map((c) => `${c.agent_name}:${c.agent_sub}:${c.source}:${c.server_slug}`).join(',');
      assert(names === 'alpha:id-alpha:directory:julies-server,beta:id-beta:directory:julies-server', names);
      const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
      const raft = list.connectors.find((c) => c.kind === 'raft');
      assert(raft.agents.map((a) => a.agent_name).join(',') === 'alpha,beta', JSON.stringify(raft.agents));
      assert(!JSON.stringify(list).includes('inst-tok'), 'installation token leaked to the browser');
    } finally { directory = null; }
  });

  await t('choosing a directory agent as default stores its id and replaces a typed handle', async () => {
    directory = DIRECTORY;
    try {
      const env = makeEnv(mod.CommentsStore, RAFT_DIR);
      const owner = await issue(worker, env, 'owner');
      await connectRaft(env, owner.cookie);
      await worker.fetch(post('/api/me/connectors/raft/default', owner.cookie, { server_id: 'S9', agent_name: 'Beta' }), env, {});
      const set = await (await worker.fetch(post('/api/me/connectors/raft/default', owner.cookie, { server_id: 'S9', agent_sub: 'id-beta' }), env, {})).json();
      assert(set.ok && set.target.agent_sub === 'id-beta' && set.target.agent_name === 'beta', JSON.stringify(set));
      const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
      assert(list.default.agent_sub === 'id-beta' && list.targets.length === 1, JSON.stringify(list.targets));
      const raft = list.connectors.find((c) => c.kind === 'raft');
      assert(raft.agents.map((a) => a.agent_sub).join(',') === 'id-beta,id-alpha', `listed twice or missing: ${JSON.stringify(raft.agents)}`);
      const stranger = await worker.fetch(post('/api/me/connectors/raft/default', owner.cookie, { server_id: 'S9', agent_sub: 'id-nobody' }), env, {});
      assert(stranger.status === 400, `an id not in the directory was accepted: ${stranger.status}`);
    } finally { directory = null; }
  });

  await t('the first agent sent to, with no default yet, becomes the default', async () => {
    directory = DIRECTORY;
    try {
      const env = makeEnv(mod.CommentsStore, RAFT_DIR);
      const owner = await issue(worker, env, 'owner');
      await connectRaft(env, owner.cookie);
      await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'fdoc', version: 1, html: '<p>hello</p>' } }), env, {});
      const c = await (await worker.fetch(req('/api/comments', { method: 'POST', cookie: owner.cookie, body: { slug: 'fdoc', version: 1, text: 'fix', anchor: { kind: 'text', text: 'hello' } } }), env, {})).json();
      const r = await (await worker.fetch(req('/api/notify/targets?slug=fdoc', { cookie: owner.cookie }), env, {})).json();
      const beta = r.candidates.find((t) => t.agent_name === 'beta');
      const sent = await (await worker.fetch(req('/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug: 'fdoc', comment_ids: [c.id], recipient: beta } }), env, {})).json();
      assert(sent.ok && sent.delivery.status === 'delivered', JSON.stringify(sent));
      const asked = raftCalls.filter((x) => x.path === '/api/oauth/requests/agent').pop();
      assert(asked && JSON.parse(asked.body).agentName === 'beta', `delivered by handle: ${asked && asked.body}`);
      const after = await (await worker.fetch(req('/api/notify/targets?slug=fdoc', { cookie: owner.cookie }), env, {})).json();
      assert(after.default && after.default.agent_sub === 'id-beta', JSON.stringify(after.default));
      const list = await (await worker.fetch(req('/api/me/connectors', { cookie: owner.cookie }), env, {})).json();
      assert(list.default && list.default.agent_sub === 'id-beta', `not the account default: ${JSON.stringify(list.default)}`);
      assert(after.candidates.some((t) => t.agent_sub === 'id-alpha') && !after.candidates.some((t) => t.agent_sub === 'id-beta'), JSON.stringify(after.candidates));
    } finally { directory = null; }
  });

  await t('while the Agent permission is in review, nothing changes and nothing errors', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_DIR);
    const owner = await issue(worker, env, 'owner');
    await connectRaft(env, owner.cookie);
    await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'pdoc', version: 1, html: '<p>x</p>' } }), env, {});
    const r = await (await worker.fetch(req('/api/notify/targets?slug=pdoc', { cookie: owner.cookie }), env, {})).json();
    assert(r.reason === 'no_agent_bound' && !(r.candidates || []).length && r.raft_servers.length === 1, JSON.stringify(r));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
