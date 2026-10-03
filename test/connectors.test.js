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
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = String(input && input.url || input);
  if (u.startsWith('https://raft.test/')) {
    const path = new URL(u).pathname;
    const body = path.endsWith('openid-configuration')
      ? { issuer: 'https://raft.test', authorization_endpoint: 'https://raft.test/oauth/authorize', token_endpoint: 'https://raft.test/api/oauth/token', userinfo_endpoint: 'https://raft.test/api/oauth/userinfo' }
      : path.endsWith('/token') ? { access_token: 'at-human', token_type: 'Bearer' }
      : path.endsWith('/userinfo') ? { sub: 'human-1', type: 'human', preferred_username: 'julie' }
      : path.endsWith('/serverinfo') ? { id: 'S9', slug: 'julies-server', name: 'Julie' }
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
    await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S1/agent-b', 'X-Tdoc-Raft-Agent-Name': encodeURIComponent('小c') });
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
    assert(raft.server_slug === 'acme' && raft.agents.length === 1, JSON.stringify(raft));
    const rm = await worker.fetch(post('/api/me/connectors/remove', ctx.owner.cookie, { provider: 'raft', server_id: 'S1' }), ctx.env, {});
    assert(rm.status === 200, `remove ${rm.status}`);
    const r = await targetsOf(ctx);
    assert(!r.default || r.default.provider === 'webhook', `a disconnected server still routes: ${JSON.stringify(r.default)}`);
    await replyAs(ctx, { 'X-Tdoc-Raft-Agent': 'S1/agent-c', 'X-Tdoc-Raft-Agent-Name': 'gamma' });
    const again = await targetsOf(ctx);
    assert(!again.default || again.default.provider === 'webhook', `new agent on the disconnected server claimed: ${JSON.stringify(again.default)}`);
  });

  const RAFT = { RAFT_CLIENT_ID: 'tdoc-x', RAFT_CLIENT_SECRET: 's', RAFT_OIDC_ISSUER: 'https://raft.test', RAFT_API_BASE: 'https://raft.test' };
  async function connectRaft(env, cookie, otherCookie) {
    const start = await worker.fetch(req('/api/me/connectors/raft/start', { cookie }), env, {});
    const loc = new URL(start.headers.get('Location'));
    const state = loc.searchParams.get('state');
    const stateCookie = (start.headers.get('Set-Cookie') || '').split(';')[0];
    const back = await worker.fetch(req(`/auth/raft/callback?code=c1&state=${state}`, { cookie: `${otherCookie || cookie}; ${stateCookie}` }), env, {});
    return { start, back };
  }

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
