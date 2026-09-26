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
  const list = async (env, slug) => (await worker.fetch(req(`/api/comments?slug=${slug}&version=1`), env, {})).json();

  await t('an untouched comment has no resolution', async () => {
    const { env, slug } = await seed();
    const [c] = await list(env, slug);
    assert(c.resolution && c.resolution.state === 'none', `state: ${JSON.stringify(c.resolution)}`);
    assert(c.resolution.kind === null, 'nobody resolved it, so there is no actor kind');
  });

  await t('an agent verdict records the agent as the actor', async () => {
    const { env, token, slug, commentId } = await seed();
    await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token,
      body: { slug, parent_id: commentId, text: 'done', status: 'applied', applied_in: 1, agent_login: 'claude' },
    }), env, {});
    const [c] = await list(env, slug);
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
    await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token,
      body: { slug, parent_id: commentId, text: 'done', status: 'applied', applied_in: 1, agent_login: 'claude' },
    }), env, {});
    await worker.fetch(req('/api/comments', {
      method: 'PATCH', cookie: owner, body: { slug, id: commentId, resolved: false },
    }), env, {});
    const [c] = await list(env, slug);
    assert(c.resolution.state === 'reopened', `state: ${c.resolution.state}`);
    assert(c.resolution.kind === 'human', `the reopen was the human's: ${c.resolution.kind}`);
    assert(c.status === 'open', 'and the comment is open again');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
