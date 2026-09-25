// Handing comments to an agent (P0 of the tdoc × Raft notification design).
//
// The rules this pins down, all of which came out of review rather than from
// the first draft:
//   - Driving an agent needs the doc owner's session or upload token. A reader
//     who may comment still may not make somebody's agent do work, and that is
//     structural (no token) rather than a policy we could get wrong.
//   - A comment nobody handed over is a NOTE, not queued work.
//   - A failed delivery is a recorded handoff with a marker, never a retry.
//   - One handoff addresses one agent: handing the same batch to two agents
//     forks two versions off one base and the merge lands back on the human.
//
// Run with: node test/notify-handoff.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('handing comments to an agent');

  async function seed(slug = 'notify-doc') {
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
      body: { slug, version: 1, text: 'this is confusing', anchor: { kind: 'text', text: 'a sentence' } },
    }), env, {});
    const comment = await posted.json();
    assert(posted.status === 200, `comment ${posted.status}`);
    return { env, token: tok.token, reader, slug, commentId: comment.id };
  }

  const target = { provider: 'raft', server_id: 'S1', agent_sub: 'uuid-a', agent_name: 'xiaocc' };
  const handoff = (env, slug, token, body) => worker.fetch(req('/api/notify/handoff', {
    method: 'POST', token, body: { slug, ...body },
  }), env, {});
  const listComments = async (env, slug) => {
    const r = await worker.fetch(req(`/api/comments?slug=${slug}&version=1`), env, {});
    return r.json();
  };

  await t('an untouched comment is a note, not queued work', async () => {
    const { env, slug } = await seed();
    const [c] = await listComments(env, slug);
    assert(c.handoff_status === 'note', `expected note, got ${c.handoff_status}`);
    assert(c.handoff_id === null, 'a note has no handoff');
  });

  await t('a reader who can comment cannot hand work to an agent', async () => {
    const { env, slug, reader, commentId } = await seed();
    const r = await worker.fetch(req('/api/notify/handoff', {
      method: 'POST', cookie: reader,
      body: { slug, comment_ids: [commentId], recipient: target },
    }), env, {});
    assert(r.status === 401 || r.status === 403, `reader got ${r.status}, expected a refusal`);
  });

  await t('the owner hands a comment over and it flips to sent', async () => {
    const { env, slug, token, commentId } = await seed();
    const r = await handoff(env, slug, token, { comment_ids: [commentId], recipient: target, instruction: 'fix it' });
    const body = await r.json();
    assert(r.status === 200 && body.ok, `handoff ${r.status}: ${JSON.stringify(body)}`);
    assert(body.sent === 1, `sent ${body.sent}`);
    const [c] = await listComments(env, slug);
    assert(c.handoff_status === 'sent', `expected sent, got ${c.handoff_status}`);
    assert(c.handoff_id === body.handoff_id, 'comment carries its handoff id');
  });

  await t('an unconfigured provider fails the delivery but still records the handoff', async () => {
    const { env, slug, token, commentId } = await seed();
    const body = await (await handoff(env, slug, token, { comment_ids: [commentId], recipient: target })).json();
    assert(body.delivery.status === 'failed', 'no Raft credentials configured, so it cannot have been delivered');
    assert(body.delivery.error === 'provider_not_configured', `error was ${body.delivery.error}`);
    const list = await (await worker.fetch(req(`/api/notify/handoffs?slug=${slug}`, { token }), env, {})).json();
    assert(list.handoffs.length === 1, 'a failed delivery is still a handoff on the record');
    assert(list.handoffs[0].delivery.status === 'failed', 'and it remembers that it failed');
  });

  await t('handing over with nobody bound is a recorded failure, not a crash', async () => {
    const { env, slug, token, commentId } = await seed();
    const body = await (await handoff(env, slug, token, { comment_ids: [commentId] })).json();
    assert(body.ok === true, 'still a 200 — the handoff happened, the delivery did not');
    assert(body.delivery.error === 'no_recipient', `error was ${body.delivery.error}`);
  });

  await t('an unknown provider is rejected rather than silently dropped', async () => {
    const { env, slug, token, commentId } = await seed();
    const body = await (await handoff(env, slug, token, {
      comment_ids: [commentId], recipient: { provider: 'not-a-provider', server_id: 'S1', agent_sub: 'x' },
    })).json();
    assert(body.delivery.error === 'no_recipient', `expected the bad target to resolve to nobody, got ${body.delivery.error}`);
  });

  await t('the agent resolves the handoff and the comment stops being work', async () => {
    const { env, slug, token, commentId } = await seed();
    const h = await (await handoff(env, slug, token, { comment_ids: [commentId], recipient: target })).json();
    const r = await worker.fetch(req('/api/notify/resolve', {
      method: 'POST', token, body: { slug, handoff_id: h.handoff_id, comment_ids: [commentId] },
    }), env, {});
    const body = await r.json();
    assert(r.status === 200 && body.resolved === 1, `resolve ${r.status}: ${JSON.stringify(body)}`);
    const [c] = await listComments(env, slug);
    assert(c.handoff_status === 'resolved', `expected resolved, got ${c.handoff_status}`);
  });

  await t('resolving only some of a batch leaves the rest sent', async () => {
    const { env, slug, token, commentId, reader } = await seed();
    const second = await (await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug, version: 1, text: 'and this one too', anchor: { kind: 'text', text: 'to comment on' } },
    }), env, {})).json();
    const h = await (await handoff(env, slug, token, { comment_ids: [commentId, second.id], recipient: target })).json();
    assert(h.sent === 2, `sent ${h.sent}`);
    await worker.fetch(req('/api/notify/resolve', {
      method: 'POST', token, body: { slug, handoff_id: h.handoff_id, comment_ids: [commentId] },
    }), env, {});
    const list = await listComments(env, slug);
    const first = list.find(c => c.id === commentId);
    const rest = list.find(c => c.id === second.id);
    assert(first.handoff_status === 'resolved', `first ${first.handoff_status}`);
    assert(rest.handoff_status === 'sent', `second should still be waiting, got ${rest.handoff_status}`);
  });

  await t('a resend reuses the handoff id so the agent is not woken twice', async () => {
    const { env, slug, token, commentId } = await seed();
    const h = await (await handoff(env, slug, token, { comment_ids: [commentId], recipient: target })).json();
    const again = await (await worker.fetch(req('/api/notify/handoff/resend', {
      method: 'POST', token, body: { slug, handoff_id: h.handoff_id },
    }), env, {})).json();
    assert(again.handoff_id === h.handoff_id, 'a resend is the same handoff, not a new one');
    const list = await (await worker.fetch(req(`/api/notify/handoffs?slug=${slug}`, { token }), env, {})).json();
    assert(list.handoffs.length === 1, 'and it does not pile up a second record');
  });

  await t('resending a handoff that does not exist is a 404', async () => {
    const { env, slug, token } = await seed();
    const r = await worker.fetch(req('/api/notify/handoff/resend', {
      method: 'POST', token, body: { slug, handoff_id: 'h_nope' },
    }), env, {});
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  // ---- linking an agent to an account ----
  // The link code and the upload token are deliberately different credentials.
  // These pin that neither one alone gets anywhere.
  async function pendingLink(env, code = 'lk_test', body = {}) {
    await env.META.put(`raft-link:${code}`, JSON.stringify({
      provider: 'raft', server_id: 'S1', agent_sub: 'uuid-a', agent_name: 'xiaocc', ...body,
    }));
    return code;
  }
  const link = (env, token, body) => worker.fetch(req('/api/notify/link', { method: 'POST', token, body }), env, {});

  await t('a link code plus an account token binds the agent as a fallback recipient', async () => {
    const { env, token, slug } = await seed();
    const code = await pendingLink(env);
    const r = await link(env, token, { link_code: code });
    const body = await r.json();
    assert(r.status === 200 && body.ok, `link ${r.status}: ${JSON.stringify(body)}`);
    assert(body.target.agent_sub === 'uuid-a', 'the bound target is the agent that signed in');
    // A doc nobody has touched now resolves to the account fallback.
    const targets = await (await worker.fetch(req(`/api/notify/targets?slug=${slug}`, { token }), env, {})).json();
    assert(targets.default && targets.default.source === 'account', `expected the account fallback, got ${JSON.stringify(targets.default)}`);
  });

  await t('a link code alone is worthless without a token', async () => {
    const { env } = await seed();
    const code = await pendingLink(env);
    const r = await worker.fetch(req('/api/notify/link', { method: 'POST', body: { link_code: code } }), env, {});
    assert(r.status === 401, `expected 401 without a token, got ${r.status}`);
    assert(await env.META.get(`raft-link:${code}`), 'a refused attempt must not burn the code');
  });

  await t('a token alone cannot invent an agent that never signed in', async () => {
    const { env, token } = await seed();
    const r = await link(env, token, { link_code: 'lk_never_issued' });
    assert(r.status === 404, `expected 404 for an unissued code, got ${r.status}`);
  });

  await t('a link code is single use', async () => {
    const { env, token } = await seed();
    const code = await pendingLink(env);
    assert((await link(env, token, { link_code: code })).status === 200, 'first redemption works');
    const again = await link(env, token, { link_code: code });
    assert(again.status === 404, `a redeemed code must not work twice, got ${again.status}`);
  });

  await t('relinking the same agent does not duplicate it', async () => {
    const { env, token } = await seed();
    await link(env, token, { link_code: await pendingLink(env, 'lk_a') });
    const body = await (await link(env, token, { link_code: await pendingLink(env, 'lk_b') })).json();
    assert(body.targets === 1, `expected one target, got ${body.targets}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
