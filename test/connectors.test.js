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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
