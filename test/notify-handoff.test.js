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

  // ---- the agent behaviour manifest ----
  // Registered on the Raft App, so a 404 here means Login with Raft cannot
  // work at all. It was missed in the first pass and the App was registered
  // pointing at it, which is exactly the failure this test exists to catch.
  await t('the manifest is served as JSON at the registered well-known path', async () => {
    const env = makeEnv(mod.CommentsStore, { RAFT_CLIENT_ID: 'tdoc-7a927d' });
    const r = await worker.fetch(req('/.well-known/raft-agent-manifest.json'), env, {});
    assert(r.status === 200, `manifest ${r.status}`);
    // The CLI refuses a manifest that is not application/json, so the
    // content-type is part of the contract, not a detail.
    assert(/application\/json/.test(r.headers.get('content-type') || ''), `content-type: ${r.headers.get('content-type')}`);
    const m = await r.json();
    assert(m.schema === 'raft-agent-manifest.v0', `schema: ${m.schema}`);
    assert(m.auth && m.auth.type === 'login_with_raft', 'auth type');
    assert(m.service === 'tdoc-7a927d', `service should follow the registered client key, got ${m.service}`);
    assert(m.execution && m.execution.base_url === 'https://tdoc.dev', `base_url: ${m.execution && m.execution.base_url}`);
    assert(Array.isArray(m.actions), 'actions must be an array even while empty');
  });

  await t('the manifest carries no credential', async () => {
    const env = makeEnv(mod.CommentsStore, { RAFT_CLIENT_ID: 'tdoc-7a927d', RAFT_CLIENT_SECRET: 'super_secret_value' });
    const body = await (await worker.fetch(req('/.well-known/raft-agent-manifest.json'), env, {})).text();
    assert(!body.includes('super_secret_value'), 'the manifest is public — a secret must never reach it');
  });

  // ---- the agent session carries no authority ----
  //
  // Agent sign-in skips the OIDC state check, so this cookie can be issued to
  // a browser that was walked onto the callback. That is only tolerable while
  // holding it buys nothing. These are the tests that keep it worthless: if
  // one of them starts failing because the cookie "works", the sign-in path
  // has quietly become a login-CSRF hole.
  const AGENT_COOKIE = 'tdoc_agent_sid=aa11bb22';
  async function withAgentSession(env, body = {}) {
    await env.META.put('agent-session:aa11bb22', JSON.stringify({
      provider: 'raft', server_id: 'S1', agent_sub: 'uuid-a', agent_name: 'xiaocc', ...body,
    }));
    return AGENT_COOKIE;
  }

  await t('the agent cookie alone cannot hand comments to an agent', async () => {
    const { env, slug, commentId } = await seed();
    const cookie = await withAgentSession(env);
    const r = await worker.fetch(req('/api/notify/handoff', {
      method: 'POST', cookie, body: { slug, comment_ids: [commentId], recipient: target },
    }), env, {});
    assert(r.status === 401 || r.status === 403, `agent cookie drove a handoff (${r.status}) — it must carry no authority`);
  });

  await t('the agent cookie alone cannot bind itself to an account', async () => {
    const { env } = await seed();
    const cookie = await withAgentSession(env);
    const r = await worker.fetch(req('/api/notify/link', { method: 'POST', cookie, body: {} }), env, {});
    assert(r.status === 401, `linking without the upload token returned ${r.status}; both credentials are required`);
  });

  await t('the agent cookie alone cannot read a private doc', async () => {
    const { env, token, slug } = await seed();
    await worker.fetch(req('/api/doc/access', {
      method: 'PATCH', token, body: { slug, access: { visibility: 'private' } },
    }), env, {});
    const cookie = await withAgentSession(env);
    const r = await worker.fetch(req(`/d/${slug}/v/1`, { cookie }), env, {});
    assert(r.status === 403 || r.status === 401 || r.status === 404,
      `a private doc answered ${r.status} to a bare agent cookie`);
  });

  await t('with the upload token as well, the agent session does bind', async () => {
    const { env, token, slug } = await seed();
    const cookie = await withAgentSession(env);
    const r = await worker.fetch(req('/api/notify/link', { method: 'POST', token, cookie, body: {} }), env, {});
    const body = await r.json();
    assert(r.status === 200 && body.ok, `link with both credentials failed: ${r.status} ${JSON.stringify(body)}`);
    assert(body.target.agent_sub === 'uuid-a', 'bound the agent that signed in');
    const targets = await (await worker.fetch(req(`/api/notify/targets?slug=${slug}`, { token }), env, {})).json();
    assert(targets.default && targets.default.source === 'account', 'it became the account fallback');
  });

  // ---- why the button is disabled ----
  // The UI renders a sentence from `reason`, so a wrong reason is a wrong
  // sentence shown to a person. Only report what is actually known.
  await t('no recipient reports a reason the UI can render', async () => {
    const { env, token, slug } = await seed();
    const r = await (await worker.fetch(req(`/api/notify/targets?slug=${slug}`, { token }), env, {})).json();
    assert(r.default === null, 'nobody is bound yet');
    assert(r.reason === 'no_agent_bound', `reason: ${r.reason}`);
  });

  await t('a bound recipient reports no reason at all', async () => {
    const { env, token, slug } = await seed();
    await link(env, token, { link_code: await pendingLink(env, 'lk_reason') });
    const r = await (await worker.fetch(req(`/api/notify/targets?slug=${slug}`, { token }), env, {})).json();
    assert(r.default && r.reason === null, `expected a recipient and no reason, got ${JSON.stringify(r.reason)}`);
  });

  // ---- the Raft wire format ----
  //
  // Every earlier test stubbed delivery out, so three wire-level bugs shipped
  // and only surfaced against the live API: the request leg was addressed by
  // server id instead of slug (404), the response was read as `request_id`
  // when it is `requestId` (undefined sent onward), and the resource was built
  // from our stored id rather than the one the API returns. These drive the
  // provider against a recorded transcript so the shape is pinned.
  const realFetch = globalThis.fetch;
  function stubRaft(handler) {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      const r = handler(url, body);
      return r || realFetch(input, init);
    };
    return calls;
  }
  const RAFT_ENV = { RAFT_CLIENT_ID: 'tdoc-7a927d', RAFT_CLIENT_SECRET: 'sec', RAFT_API_BASE: 'https://api.raft.test' };
  const fullTarget = { provider: 'raft', server_id: 'srv-uuid', server_slug: 'acme', agent_sub: 'uuid-a', agent_name: 'xiaocc' };

  async function seedWith(env) {
    const tok = await issue(worker, env, 'owner');
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: 'wire-doc', version: 1, html: '<h1>d</h1><p>a sentence to comment on</p>' },
    }), env, {});
    const reader = await putSession(env, 'reader');
    const c = await (await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug: 'wire-doc', version: 1, text: 'x', anchor: { kind: 'text', text: 'a sentence' } },
    }), env, {})).json();
    return { token: tok.token, commentId: c.id };
  }

  await t('the access request is addressed by server SLUG, not id', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    const { token, commentId } = await seedWith(env);
    const calls = stubRaft((url) => {
      if (url.endsWith('/api/oauth/requests/agent')) return Response.json({ requestId: 'rq1', agent: { serverId: 'srv-uuid' } });
      if (url.endsWith('/api/oauth/token')) return Response.json({ access_token: 'at' });
      if (url.endsWith('/api/oauth/agent-events')) return Response.json({ ok: true });
      return null;
    });
    try {
      const r = await (await worker.fetch(req('/api/notify/handoff', {
        method: 'POST', token, body: { slug: 'wire-doc', comment_ids: [commentId], recipient: fullTarget },
      }), env, {})).json();
      assert(r.delivery.status === 'delivered', `delivery: ${JSON.stringify(r.delivery)}`);
      const reqCall = calls.find(c => c.url.endsWith('/api/oauth/requests/agent'));
      assert(reqCall.body.serverSlug === 'acme', `sent serverSlug=${reqCall.body.serverSlug}; the uuid here is a 404`);
      assert(reqCall.body.scopes.includes('agent:notification:write'), 'scope');
    } finally { globalThis.fetch = realFetch; }
  });

  await t('requestId is read camelCase and the resource uses the returned serverId', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    const { token, commentId } = await seedWith(env);
    const calls = stubRaft((url) => {
      // The API answers with a DIFFERENT serverId than we stored; the resource
      // must follow the API, not our record.
      if (url.endsWith('/api/oauth/requests/agent')) return Response.json({ requestId: 'rq-real', agent: { serverId: 'srv-from-api' } });
      if (url.endsWith('/api/oauth/token')) return Response.json({ access_token: 'at' });
      if (url.endsWith('/api/oauth/agent-events')) return Response.json({ ok: true });
      return null;
    });
    try {
      await worker.fetch(req('/api/notify/handoff', {
        method: 'POST', token, body: { slug: 'wire-doc', comment_ids: [commentId], recipient: fullTarget },
      }), env, {});
      const tokCall = calls.find(c => c.url.endsWith('/api/oauth/token'));
      assert(tokCall.body.request_id === 'rq-real', `request_id: ${tokCall.body.request_id}`);
      assert(tokCall.body.resource === 'urn:raft:server:srv-from-api:agent-inbound', `resource: ${tokCall.body.resource}`);
      assert(tokCall.body.grant_type === 'urn:slock:grant-type:agent_request', 'grant_type');
    } finally { globalThis.fetch = realFetch; }
  });

  await t('a target with no slug fails clearly instead of 404-ing', async () => {
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    const { token, commentId } = await seedWith(env);
    const r = await (await worker.fetch(req('/api/notify/handoff', {
      method: 'POST', token,
      body: { slug: 'wire-doc', comment_ids: [commentId], recipient: { ...fullTarget, server_slug: undefined } },
    }), env, {})).json();
    assert(r.delivery.error === 'target_missing_server_slug', `error: ${r.delivery.error}`);
  });

  // ---- following a doc is earned, not configured ----
  // touchDocAgent existed but nothing called it, so "the follow-up agent
  // continues automatically" was true of the design and false of the build.
  // These call the real routes with an agent session attached.
  await t('publishing a version makes you the doc\'s follow-up agent', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const cookie = await withAgentSession(env);
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token, cookie,
      body: { slug: 'follow-doc', version: 1, html: '<h1>d</h1><p>a sentence here</p>' },
    }), env, {});
    const t2 = await (await worker.fetch(req('/api/notify/targets?slug=follow-doc', { token: tok.token }), env, {})).json();
    assert(t2.default && t2.default.source === 'doc', `expected a doc-level agent, got ${JSON.stringify(t2.default)}`);
    assert(t2.default.agent_sub === 'uuid-a', `wrong agent: ${t2.default.agent_sub}`);
  });

  await t('answering a comment does the same', async () => {
    const { env, token, slug, commentId } = await seed();
    const cookie = await withAgentSession(env);
    await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token, cookie,
      body: { slug, parent_id: commentId, text: 'done', status: 'applied', applied_in: 1, agent_login: 'claude' },
    }), env, {});
    const t2 = await (await worker.fetch(req(`/api/notify/targets?slug=${slug}`, { token }), env, {})).json();
    assert(t2.default && t2.default.source === 'doc', `expected a doc-level agent, got ${JSON.stringify(t2.default)}`);
  });

  await t('publishing without a Raft identity binds nobody and still succeeds', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: 'plain-doc', version: 1, html: '<h1>d</h1><p>a sentence here</p>' },
    }), env, {});
    assert(up.status === 200, `publish must not depend on having a Raft identity: ${up.status}`);
    const t2 = await (await worker.fetch(req('/api/notify/targets?slug=plain-doc', { token: tok.token }), env, {})).json();
    assert(t2.default === null && t2.reason === 'no_agent_bound', `expected nobody bound, got ${JSON.stringify(t2)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
