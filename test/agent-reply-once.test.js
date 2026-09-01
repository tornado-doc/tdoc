// The agent answers a comment once per human turn (#349).
//
// A generation round posts an agent reply on every comment it handled. When a
// human deletes that reply — or rewrites it — the reply disappears from every
// folded view, including the one `tdoc pull` writes to comments.json. The next
// round therefore reads a thread it has never answered and answers it again,
// in the same place, with the same words. Deleting the AI's comment was how
// the human said "handled"; repeating it is the opposite of hearing that.
//
// The event log still holds the reply_added the fold dropped, so the gate reads
// the log. These drive the real route through worker.js with fake bindings.
//
// Run with: node test/agent-reply-once.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('agent answers once per human turn (#349)');

  // A published doc owned by `owner`, with one comment left by `reader`.
  async function seed(slug = 'agent-loop') {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug, version: 1, html: '<h1>doc</h1><p>a sentence to comment on</p>' },
    }), env, {});
    assert(up.status === 200, `upload ${up.status}`);
    const reader = await putSession(env, 'reader');
    const posted = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug, version: 1, text: 'this paragraph is confusing', anchor: { kind: 'text', text: 'a sentence' } },
    }), env, {});
    const comment = await posted.json();
    assert(posted.status === 200, `comment ${posted.status}: ${JSON.stringify(comment)}`);
    return { env, token: tok.token, reader, slug, commentId: comment.id };
  }

  const reply = (worker, env, slug, token, body) => worker.fetch(req('/api/agent/reply', {
    method: 'POST', token, body: { slug, ...body },
  }), env, {});

  const listComments = async (env, slug) => {
    const r = await worker.fetch(req(`/api/comments?slug=${slug}&version=1`), env, {});
    return r.json();
  };

  await t('the first agent reply lands', async () => {
    const { env, token, slug, commentId } = await seed();
    const r = await reply(worker, env, slug, token, {
      parent_id: commentId, text: 'Rewrote the paragraph.', status: 'applied', applied_in: 1, agent_login: 'claude',
    });
    const body = await r.json();
    assert(r.status === 200 && body.id && !body.skipped, `first reply refused: ${JSON.stringify(body)}`);
    const [c] = await listComments(env, slug);
    assert(c.replies.length === 1, `expected 1 reply, got ${c.replies.length}`);
  });

  await t('a second round on an untouched thread is skipped, not posted again [the bug]', async () => {
    const { env, token, slug, commentId } = await seed();
    await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote the paragraph.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const again = await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote the paragraph.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const body = await again.json();
    assert(again.status === 200, `expected a clean skip, got ${again.status}`);
    assert(body.skipped === true && body.reason === 'already_answered',
      `expected already_answered, got ${JSON.stringify(body)}`);
    const [c] = await listComments(env, slug);
    assert(c.replies.length === 1, `the second round posted again: ${c.replies.length} replies`);
  });

  await t('deleting the agent’s reply does not invite it back [the reported bug]', async () => {
    const { env, token, slug, commentId } = await seed();
    const first = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    // The doc owner deletes the agent's reply — the fold drops it, so a pulled
    // comments.json shows a thread with no agent answer at all.
    const ownerCookie = await putSession(env, 'owner');
    const del = await worker.fetch(req(`/api/comments?slug=${slug}&id=${first.id}&version=1`, { method: 'DELETE', cookie: ownerCookie }), env, {});
    assert(del.status === 200, `delete ${del.status}: ${JSON.stringify(await del.json())}`);
    const [folded] = await listComments(env, slug);
    assert(folded.replies.length === 0, 'test setup: the delete should have hidden the reply');

    const again = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    assert(again.skipped === true && again.reason === 'already_answered',
      `the agent re-raised a comment the human had dealt with: ${JSON.stringify(again)}`);
    const [after] = await listComments(env, slug);
    assert(after.replies.length === 0, `the deleted reply came back: ${JSON.stringify(after.replies)}`);
  });

  await t('a human reply re-opens the thread for the agent', async () => {
    const { env, token, reader, slug, commentId } = await seed();
    await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const human = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug, version: 1, text: 'still reads oddly to me', parent_id: commentId },
    }), env, {});
    assert(human.status === 200, `human reply ${human.status}`);
    const again = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Tightened it further.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    assert(again.id && !again.skipped, `the agent should answer a person who wrote back: ${JSON.stringify(again)}`);
  });

  await t('a comment the human deleted outright is never answered', async () => {
    const { env, token, reader, slug, commentId } = await seed();
    const del = await worker.fetch(req(`/api/comments?slug=${slug}&id=${commentId}&version=1`, { method: 'DELETE', cookie: reader }), env, {});
    assert(del.status === 200, `delete ${del.status}`);
    const r = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    assert(r.skipped === true && r.reason === 'comment_deleted',
      `expected comment_deleted, got ${JSON.stringify(r)}`);
  });

  await t('two different agents each get their own first answer', async () => {
    const { env, token, slug, commentId } = await seed();
    const a = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Claude did it.', status: 'applied', applied_in: 1, agent_login: 'claude' })).json();
    const b = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'Codex looked too.', status: 'applied', applied_in: 1, agent_login: 'codex' })).json();
    assert(a.id && !a.skipped, 'first agent was refused');
    assert(b.id && !b.skipped, `a different agent must not inherit another agent's turn: ${JSON.stringify(b)}`);
  });

  await t('force: true is the way to say it on purpose', async () => {
    const { env, token, slug, commentId } = await seed();
    await reply(worker, env, slug, token, { parent_id: commentId, text: 'Rewrote it.', status: 'applied', applied_in: 1, agent_login: 'claude' });
    const forced = await (await reply(worker, env, slug, token, { parent_id: commentId, text: 'And once more.', status: 'applied', applied_in: 1, agent_login: 'claude', force: true })).json();
    assert(forced.id && !forced.skipped, `force should post: ${JSON.stringify(forced)}`);
    const [c] = await listComments(env, slug);
    assert(c.replies.length === 2, `expected both replies, got ${c.replies.length}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
