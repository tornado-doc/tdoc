// Who resolved a comment — human or agent — kept as a fact rather than inferred.
//
// Julie: both a user and an agent may resolve (a user may also reopen). The bug
// was never that both can write; it was that they wrote one slot, the later
// silently replaced the earlier, and nothing recorded who. These pin the actor.
//
// Run with: node test/resolution-actor.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('who resolved a comment');

  async function seed(slug = 'res-doc') {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug, version: 1, html: '<h1>d</h1><p>a sentence to comment on</p>' },
    }), env, {});
    const reader = await putSession(env, 'reader');
    const c = await (await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug, version: 1, text: 'x', anchor: { kind: 'text', text: 'a sentence' } },
    }), env, {})).json();
    const owner = await putSession(env, 'owner');
    return { env, token: tok.token, owner, slug, commentId: c.id };
  }
  const list = async (env, slug, version = 1) => (await worker.fetch(req(`/api/comments?slug=${slug}&version=${version}`), env, {})).json();
  // An agent's "applied" stands only on a version published after the
  // comment; without one the worker records it as an answer.
  const publishV2 = (env, token, slug) => worker.fetch(req('/api/upload', {
    method: 'POST', token, body: { slug, version: 2, html: '<h1>d</h1><p>a sentence, revised</p>' },
  }), env, {});

  await t('an untouched comment has no resolution', async () => {
    const { env, slug } = await seed();
    const [c] = await list(env, slug);
    assert(c.resolution && c.resolution.state === 'none', `state: ${JSON.stringify(c.resolution)}`);
    assert(c.resolution.kind === null, 'nobody resolved it, so there is no actor kind');
  });

  await t('an agent verdict records the agent as the actor', async () => {
    const { env, token, slug, commentId } = await seed();
    await publishV2(env, token, slug);
    await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token,
      body: { slug, parent_id: commentId, text: 'done', status: 'applied', applied_in: 2, agent_login: 'claude' },
    }), env, {});
    const [c] = await list(env, slug, 2);
    assert(c.resolution.state === 'resolved', `state: ${c.resolution.state}`);
    assert(c.resolution.kind === 'agent', `kind: ${c.resolution.kind}`);
    assert(c.resolution.by === 'claude', `by: ${c.resolution.by}`);
    // resolved_by stays human-only: existing callers read it that way.
    assert(!c.resolved_by, `resolved_by should stay empty for an agent, got ${c.resolved_by}`);
  });

  await t('a human tick records the human, not the agent', async () => {
    const { env, owner, slug, commentId } = await seed();
    const r = await worker.fetch(req('/api/comments', {
      method: 'PATCH', cookie: owner, body: { slug, id: commentId, resolved: true },
    }), env, {});
    assert(r.status === 200, `patch ${r.status}`);
    const [c] = await list(env, slug);
    assert(c.resolution.kind === 'human', `kind: ${c.resolution.kind}`);
    assert(c.resolution.by === 'owner', `by: ${c.resolution.by}`);
  });

  await t('a human reopening an agent-resolved comment records the reopen and the human', async () => {
    const { env, token, owner, slug, commentId } = await seed();
    await publishV2(env, token, slug);
    await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token,
      body: { slug, parent_id: commentId, text: 'done', status: 'applied', applied_in: 2, agent_login: 'claude' },
    }), env, {});
    await worker.fetch(req('/api/comments', {
      method: 'PATCH', cookie: owner, body: { slug, id: commentId, resolved: false, version: 2 },
    }), env, {});
    const [c] = await list(env, slug, 2);
    assert(c.resolution.state === 'reopened', `state: ${c.resolution.state}`);
    assert(c.resolution.kind === 'human', `the reopen was the human's: ${c.resolution.kind}`);
    assert(c.status === 'open', 'and the comment is open again');
  });

  // "Applied" shows ✅ Done. An agent that answered a question without
  // changing the doc used to send it anyway; with no version published after
  // the comment, the worker records the answer it was.
  const agentReply = async (env, token, body) => (await worker.fetch(req('/api/agent/reply', {
    method: 'POST', token, body: { agent_login: 'claude', ...body },
  }), env, {})).json();

  await t('"applied" with no newer version is recorded as answered', async () => {
    const { env, token, slug, commentId } = await seed();
    const r = await agentReply(env, token, { slug, parent_id: commentId, text: 'It means X.', status: 'applied', applied_in: 2 });
    assert(r.verdict === 'answered' && r.downgraded_from === 'applied', `response: ${JSON.stringify(r)}`);
    assert(r.agent_status === 'answered', `reply status: ${r.agent_status}`);
    const [c] = await list(env, slug);
    assert(c.status === 'open', `status: ${c.status}`);
    assert(c.resolution.state !== 'resolved', `state: ${c.resolution.state}`);
    assert(c.replies[0].agent_status === 'answered', `reply: ${c.replies[0].agent_status}`);
  });

  await t('"applied" without --applied-in and no newer version is answered too', async () => {
    const { env, token, slug, commentId } = await seed();
    const r = await agentReply(env, token, { slug, parent_id: commentId, text: 'It means X.', status: 'applied' });
    assert(r.downgraded_from === 'applied', `response: ${JSON.stringify(r)}`);
    const [c] = await list(env, slug);
    assert(c.status === 'open', `status: ${c.status}`);
  });

  await t('"applied" after publishing the next version stays applied', async () => {
    const { env, token, slug, commentId } = await seed();
    await publishV2(env, token, slug);
    const r = await agentReply(env, token, { slug, parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 2 });
    assert(r.agent_status === 'applied' && !('downgraded_from' in r), `response: ${JSON.stringify(r)}`);
    const [c] = await list(env, slug, 2);
    assert(c.status === 'applied', `status: ${c.status}`);
    assert(c.applied_in === 2, `applied_in: ${c.applied_in}`);
  });

  await t('"applied" naming the version the comment was made on is answered', async () => {
    const { env, token, slug, commentId } = await seed();
    await publishV2(env, token, slug);
    const r = await agentReply(env, token, { slug, parent_id: commentId, text: 'Already so.', status: 'applied', applied_in: 1 });
    assert(r.downgraded_from === 'applied', `response: ${JSON.stringify(r)}`);
  });

  await t('a follow-up asked on v2 needs v3 before it is applied', async () => {
    const { env, token, slug, commentId } = await seed();
    await publishV2(env, token, slug);
    await agentReply(env, token, { slug, parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 2 });
    const reader = await putSession(env, 'reader');
    await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader, body: { slug, version: 2, parent_id: commentId, text: 'why this wording?' },
    }), env, {});
    const r = await agentReply(env, token, { slug, parent_id: commentId, text: 'Because Y.', status: 'applied', applied_in: 2 });
    assert(r.downgraded_from === 'applied', `response: ${JSON.stringify(r)}`);
    const [c] = await list(env, slug, 2);
    assert(c.replies.some((x) => x.text === 'Because Y.' && x.agent_status === 'answered'), `replies: ${JSON.stringify(c.replies)}`);
  });

  // In a feedback space the agent fixes the person's app, not the tdoc doc:
  // its "applied" comes with no new version and stays applied.
  await t('"applied" in a feedback space stays applied with no new version', async () => {
    const { env, token, slug, commentId } = await seed();
    const meta = JSON.parse(await env.META.get(`meta:${slug}`));
    await env.META.put(`meta:${slug}`, JSON.stringify({ ...meta, created_from: 'feedback', feedback: { origin: 'https://app.example' } }));
    const r = await agentReply(env, token, { slug, parent_id: commentId, text: 'Fixed the button.', status: 'applied' });
    assert(r.agent_status === 'applied' && !('downgraded_from' in r), `response: ${JSON.stringify(r)}`);
    const [c] = await list(env, slug);
    assert(c.status === 'applied', `status: ${c.status}`);
  });

  await t('"applied" on a product-anchored comment stays applied with no new version', async () => {
    const { env, token, slug } = await seed();
    const reader = await putSession(env, 'reader');
    const c0 = await (await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug, version: 1, text: 'Button does nothing', anchor: { kind: 'product', url: 'https://app.example/dashboard', selector: '#invite' } },
    }), env, {})).json();
    assert(c0.id, `comment: ${JSON.stringify(c0)}`);
    const r = await agentReply(env, token, { slug, parent_id: c0.id, text: 'Fixed the button.', status: 'applied' });
    assert(r.agent_status === 'applied' && !('downgraded_from' in r), `response: ${JSON.stringify(r)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
