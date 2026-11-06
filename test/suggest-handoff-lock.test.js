// A handoff with reply_as "suggestions" (Ask/Edit v2, dev mode only) asks an
// agent for suggestions instead of a new version. Only a local Claude run is
// held to that by its allow-list; this pins the server's hold on everyone else:
// while the handoff is open, that agent's publish on that doc is refused with
// suggestions_only_run. propose_edits, replies and reads go on working, the
// person's browser is never refused, and the lock ends: the handoff resolves,
// the agent's suggestions or answers land, or SUGGEST_LOCK_TTL_MS passes.
// An account token that does not say which agent it is counts as the recipient
// (it may well be), except when the recipient is a local daemon, whose scripts
// always say. Team docs and team agents are not on this path.
// Run with: node test/suggest-handoff-lock.test.js
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ORIGIN = { Origin: 'https://tdoc.dev' };
const SERVER = 'server-1';
const WEBHOOK = 'wh_0123456789abcdef';
const REFUSED = 'suggestions_only_run';

(async () => {
  console.log('a suggestions handoff holds its agent to suggestions');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  env.TDOC_EMAIL_ALIAS_SECRET = 'test-alias-secret';
  env.TDOC_DEBUG_ACCOUNTS = 'alice@tdoc.test';
  env.RAFT_CLIENT_ID = 'tdoc-x';
  env.RAFT_CLIENT_SECRET = 's';

  // Raft and the webhook receiver, answered here. `down` fails every delivery.
  let down = false;
  const delivered = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input && input.url ? input.url : input);
    if (down) return new Response('{}', { status: 500 });
    if (u.endsWith('/api/oauth/requests/agent')) return Response.json({ requestId: 'r1', agent: { serverId: SERVER } });
    if (u.endsWith('/api/oauth/token')) return Response.json({ access_token: 't' });
    delivered.push(JSON.parse(init.body));
    return Response.json({ id: 'e1', status: 'queued' });
  };

  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  let sidN = 0;
  const person = async (login) => {
    const sid = (++sidN).toString(16).padStart(32, '0');
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name: login, email: `${login}@tdoc.test`, avatar_url: '', created: new Date().toISOString() }));
    const cookie = `tdoc_sid=${sid}`;
    const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', cookie, body: { label: login } }), env, {});
    const data = await r.json();
    assert(r.status === 200 && data.token, `token ${r.status}`);
    return { ...data, cookie, login };
  };

  const alice = await person('alice');
  const carol = await person('carol');
  const raft = (sub, name) => ({ provider: 'raft', server_id: SERVER, server_slug: 'one', agent_sub: sub, agent_name: name });
  const agentA = raft('agent-a', 'a');
  const agentB = raft('agent-b', 'b');
  const hook = { provider: 'webhook', server_id: 'webhook', agent_sub: WEBHOOK, url: 'https://hook.test/in', agent_name: 'hook' };
  const local = { provider: 'local', server_id: 'macbook', agent_sub: 'macbook_claude', device: 'macbook', cli: 'claude', agent_name: 'macbook' };
  for (const who of [alice, carol]) await env.META.put(`account-notify:${who.account_id}`, JSON.stringify([agentA, agentB, hook, local]));
  await env.META.put(`notify-webhook-secret:${WEBHOOK}`, 'secret');

  const AS_A = { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-a` };
  const AS_B = { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-b` };
  const html = (n, extra = '') => `<h1>Plan</h1><p>Sentence one, version ${n}.</p><p>Sentence two, version ${n}.</p>${extra}`;
  const versionOf = (slug) => Math.max(...JSON.parse(env.META.map.get(`meta:${slug}`)).versions.map((v) => v.n));
  const publish = (who, slug, headers = {}) => {
    const next = versionOf(slug) + 1;
    return call('/api/upload', { method: 'POST', token: who.token, headers, body: { slug, version: next, html: html(next), meta: { title: 'Plan', versions: [{ n: next, created: new Date().toISOString() }] } } });
  };
  let docN = 0;
  const newDoc = async (who = alice) => {
    const slug = `lock-doc-${++docN}`;
    const r = await call('/api/upload', { method: 'POST', token: who.token, body: { slug, version: 1, html: html(1), meta: { title: 'Plan' } } });
    assert(r.status === 200, `seed ${r.status} ${r.text}`);
    return slug;
  };
  const comment = async (who, slug, text = 'fix this') => {
    const r = await call('/api/comments', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body: { slug, version: 1, text, anchor: { kind: 'text', text: 'Sentence one' } } });
    assert(r.status === 200, `comment ${r.status} ${r.text}`);
    return r.body.id;
  };
  const handOff = async (who, slug, ids, recipient, extra = { reply_as: 'suggestions' }) => {
    const r = await call('/api/notify/handoff', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body: { slug, comment_ids: ids, recipient, instruction: 'address this', ...extra } });
    assert(r.status === 200, `handoff ${r.status} ${r.text}`);
    return r.body;
  };
  const propose = (who, slug, edit, headers = {}) => call(`/api/docs/${slug}/suggestions`, { method: 'POST', token: who.token, headers, body: { edits: [edit], agent_login: 'a', agent_name: 'a' } });
  const refused = (r, what) => assert(r.status === 403 && r.body && r.body.error === REFUSED, `${what}: ${r.status} ${r.text}`);
  const landed = (r, what) => assert(r.status === 200, `${what}: ${r.status} ${r.text}`);
  // Date.now moved forward for the length of fn: the TTL is the Durable
  // Object's own clock read, so nothing else needs to know.
  const later = async (ms, fn) => {
    const real = Date.now;
    Date.now = () => real() + ms;
    try { return await fn(); } finally { Date.now = real; }
  };
  const HOUR = 3600 * 1000;

  // ---- who is refused ----

  await t('the handed-to Raft agent cannot publish; a person\'s other agent can', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    const sent = await handOff(alice, slug, [c], agentA);
    assert(sent.reply_as === 'suggestions' && sent.delivery.status === 'delivered', JSON.stringify(sent));
    const r = await publish(alice, slug, AS_A);
    refused(r, 'agent A');
    assert(/propose_edits|tdoc-propose/.test(r.body.message), r.body.message);
    assert(typeof r.body.until === 'string' && Date.parse(r.body.until) > Date.now(), `until: ${r.text}`);
    assert(versionOf(slug) === 1, 'nothing was published');
    landed(await publish(alice, slug, AS_B), 'agent B');
  });

  await t('a token that does not say who it is counts as the recipient, as does a claim that resolves to nobody', async () => {
    const slug = await newDoc();
    await handOff(alice, slug, [await comment(alice, slug)], agentA);
    refused(await publish(alice, slug), 'no identity');
    refused(await publish(alice, slug, { 'X-Tdoc-Raft-Agent': 'not-connected/agent-x' }), 'a claim on a server this account never connected');
    refused(await publish(alice, slug, { 'X-Tdoc-Raft-Agent': 'garbage' }), 'a malformed claim');
  });

  await t('another doc of the same account is not touched', async () => {
    const slug = await newDoc();
    const other = await newDoc();
    await handOff(alice, slug, [await comment(alice, slug)], agentA);
    landed(await publish(alice, other, AS_A), 'agent A on another doc');
    landed(await publish(alice, other), 'no identity on another doc');
  });

  await t('a webhook agent: refused by name and, as it usually sends none, without one', async () => {
    const slug = await newDoc();
    const sent = await handOff(alice, slug, [await comment(alice, slug)], hook);
    assert(sent.delivery.status === 'delivered', JSON.stringify(sent));
    refused(await publish(alice, slug, { 'X-Tdoc-Agent': `webhook/webhook/${WEBHOOK}` }), 'webhook by name');
    refused(await publish(alice, slug), 'webhook without a name');
    landed(await publish(alice, slug, AS_B), 'another agent');
  });

  await t('a local agent: its daemon always says who it is, so only that claim is refused and the person\'s own CLI publishes', async () => {
    const slug = await newDoc();
    await handOff(alice, slug, [await comment(alice, slug)], local);
    refused(await publish(alice, slug, { 'X-Tdoc-Agent': 'local/macbook/macbook_claude' }), 'the daemon\'s agent');
    landed(await publish(alice, slug), 'the person\'s own CLI');
  });

  await t('the preview post is held like a publish; replies, reads and propose_edits are not', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    const c2 = await comment(alice, slug, 'and this');
    await handOff(alice, slug, [c, c2], agentA);
    refused(await call(`/api/docs/${slug}/preview`, { method: 'POST', token: alice.token, headers: AS_A, body: { version: 1, png_base64: 'x' } }), 'preview');
    const read = await call(`/api/comments?slug=${slug}&version=1`, { token: alice.token, headers: AS_A });
    landed(read, 'read comments');
    landed(await call('/api/agent/reply', { method: 'POST', token: alice.token, headers: AS_A, body: { slug, parent_id: c, text: 'On it', status: 'question' } }), 'reply');
    landed(await call('/api/notify/ack', { method: 'POST', token: alice.token, headers: AS_A, body: { slug, handoff_id: (await call(`/api/notify/handoffs?slug=${slug}`, { cookie: alice.cookie })).body.handoffs[0].handoff_id } }), 'ack');
    const p = await propose(alice, slug, { find: 'Sentence two, version 1.', replace: 'Better two.', comment_id: c2 }, AS_A);
    landed(p, 'propose_edits');
  });

  await t('the person in the browser is never refused: save, and accepting a suggestion (which publishes)', async () => {
    const slug = await newDoc();
    const c1 = await comment(alice, slug, 'one');
    const c2 = await comment(alice, slug, 'two');
    await handOff(alice, slug, [c1, c2], agentA);
    const p = await propose(alice, slug, { find: 'Sentence one, version 1.', replace: 'Better one.', comment_id: c1 }, AS_A);
    landed(p, 'propose');
    refused(await publish(alice, slug, AS_A), 'c2 is still open');
    const accepted = await call(`/api/docs/${slug}/suggestions/${p.body.suggestion.id}/accept`, { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: {} });
    landed(accepted, 'accept');
    assert(accepted.body.version === 2, accepted.text);
    refused(await publish(alice, slug, AS_A), 'accepting one suggestion does not lift the other comment');
    landed(await call('/api/doc/versions', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, baseVersion: 2, html: `<!doctype html><html><head><title>Plan</title></head><body>${html(3)}</body></html>` } }), 'browser save');
    assert(versionOf(slug) === 3, 'browser save landed');
  });

  // ---- how it ends ----

  await t('the agent\'s suggestions landing lift it, comment by comment', async () => {
    const slug = await newDoc();
    const c1 = await comment(alice, slug, 'one');
    const c2 = await comment(alice, slug, 'two');
    await handOff(alice, slug, [c1, c2], agentA);
    landed(await propose(alice, slug, { find: 'Sentence one, version 1.', replace: 'Better one.', comment_id: c1 }, AS_A), 'first');
    refused(await publish(alice, slug, AS_A), 'one comment still open');
    landed(await propose(alice, slug, { find: 'Sentence two, version 1.', replace: 'Better two.', comment_id: c2 }, AS_A), 'second');
    landed(await publish(alice, slug, AS_A), 'both landed');
  });

  await t('suggestions with no comment named, and from a token with no identity, lift it (that is how MCP sends them)', async () => {
    const slug = await newDoc();
    await handOff(alice, slug, [await comment(alice, slug), await comment(alice, slug, 'two')], agentA);
    landed(await propose(alice, slug, { find: 'Sentence one, version 1.', replace: 'Better one.' }), 'no comment, no identity');
    landed(await publish(alice, slug, AS_A), 'lifted');
  });

  await t('another agent\'s suggestions do not lift it', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    await handOff(alice, slug, [c], agentA);
    landed(await propose(alice, slug, { find: 'Sentence one, version 1.', replace: 'Better one.', comment_id: c }, AS_B), 'B proposes');
    refused(await publish(alice, slug, AS_A), 'A is still held');
  });

  await t('an answer in the thread lifts that comment; "applied" with nothing published does not', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    await handOff(alice, slug, [c], agentA);
    const claimed = await call('/api/agent/reply', { method: 'POST', token: alice.token, headers: AS_A, body: { slug, parent_id: c, text: 'Done', status: 'applied' } });
    landed(claimed, 'claimed applied');
    assert(claimed.body.downgraded_from === 'applied', claimed.text);
    refused(await publish(alice, slug, AS_A), 'a downgraded "applied" is not an answer');
    const slug2 = await newDoc();
    const c2 = await comment(alice, slug2);
    await handOff(alice, slug2, [c2], agentA);
    landed(await call('/api/agent/reply', { method: 'POST', token: alice.token, headers: AS_B, body: { slug: slug2, parent_id: c2, text: 'Not mine', status: 'answered' } }), 'B answers');
    refused(await publish(alice, slug2, AS_A), 'another agent\'s answer does not lift it');
    const slug3 = await newDoc();
    const c3 = await comment(alice, slug3);
    await handOff(alice, slug3, [c3], agentA);
    landed(await call('/api/agent/reply', { method: 'POST', token: alice.token, headers: AS_A, body: { slug: slug3, parent_id: c3, text: 'It says so in section 2.', status: 'answered' } }), 'A answers');
    landed(await publish(alice, slug3, AS_A), 'answered');
  });

  await t('the handoff resolving lifts it, and a partial resolve only lifts what it names', async () => {
    const slug = await newDoc();
    const c1 = await comment(alice, slug, 'one');
    const c2 = await comment(alice, slug, 'two');
    const sent = await handOff(alice, slug, [c1, c2], agentA);
    landed(await call('/api/notify/resolve', { method: 'POST', token: alice.token, body: { slug, handoff_id: sent.handoff_id, comment_ids: [c1] } }), 'partial');
    refused(await publish(alice, slug, AS_A), 'c2 open');
    landed(await call('/api/notify/resolve', { method: 'POST', token: alice.token, body: { slug, handoff_id: sent.handoff_id } }), 'all');
    landed(await publish(alice, slug, AS_A), 'resolved');
  });

  await t('the person resolving or deleting the comment in the doc lifts it (the way out for a held CLI)', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    await handOff(alice, slug, [c], agentA);
    landed(await call('/api/comments', { method: 'PATCH', cookie: alice.cookie, headers: ORIGIN, body: { slug, id: c, resolved: true, version: 1 } }), 'resolve');
    landed(await publish(alice, slug), 'resolved in the doc');
    const slug2 = await newDoc();
    const c2 = await comment(alice, slug2);
    await handOff(alice, slug2, [c2], agentA);
    landed(await call(`/api/comments?slug=${slug2}&id=${c2}`, { method: 'DELETE', cookie: alice.cookie, headers: ORIGIN }), 'delete');
    landed(await publish(alice, slug2, AS_A), 'deleted in the doc');
  });

  await t('an hour with no answer ends it, for the agent and for the account', async () => {
    const slug = await newDoc();
    await handOff(alice, slug, [await comment(alice, slug)], agentA);
    refused(await later(HOUR - 60000, () => publish(alice, slug, AS_A)), 'just inside the hour');
    await later(HOUR + 1000, async () => {
      landed(await publish(alice, slug), 'no identity, after the hour');
      landed(await publish(alice, slug, AS_A), 'agent A, after the hour');
    });
  });

  await t('a failed delivery holds nobody, and the Resend that lands does', async () => {
    const slug = await newDoc();
    down = true;
    const sent = await handOff(alice, slug, [await comment(alice, slug)], agentA);
    down = false;
    assert(sent.delivery.status === 'failed', JSON.stringify(sent));
    landed(await publish(alice, slug, AS_A), 'never delivered');
    const again = await call('/api/notify/handoff/resend', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, handoff_id: sent.handoff_id } });
    landed(again, 'resend');
    refused(await publish(alice, slug, AS_A), 'delivered now');
    down = true;
    const failed = await call('/api/notify/handoff/resend', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, handoff_id: sent.handoff_id } });
    down = false;
    assert(failed.status === 200 && failed.body.delivery.status === 'failed', failed.text);
    landed(await publish(alice, slug, AS_A), 'a resend that fails holds nobody');
  });

  await t('Resend starts the hour again, only for what is still open', async () => {
    const slug = await newDoc();
    const c1 = await comment(alice, slug, 'one');
    const c2 = await comment(alice, slug, 'two');
    const sent = await handOff(alice, slug, [c1, c2], agentA);
    landed(await call('/api/notify/resolve', { method: 'POST', token: alice.token, body: { slug, handoff_id: sent.handoff_id, comment_ids: [c1] } }), 'partial');
    await later(HOUR - 60000, async () => {
      landed(await call('/api/notify/handoff/resend', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, handoff_id: sent.handoff_id } }), 'resend');
    });
    refused(await later(HOUR + 1000, () => publish(alice, slug, AS_A)), 'past the first hour, inside the second');
    landed(await propose(alice, slug, { find: 'Sentence two, version 1.', replace: 'Better two.', comment_id: c2 }, AS_A), 'c2 lands');
    landed(await publish(alice, slug, AS_A), 'c1 stayed resolved through the resend');
  });

  await t('Resend of a handoff with everything resolved holds nobody', async () => {
    const slug = await newDoc();
    const sent = await handOff(alice, slug, [await comment(alice, slug)], agentA);
    landed(await call('/api/notify/resolve', { method: 'POST', token: alice.token, body: { slug, handoff_id: sent.handoff_id } }), 'resolve');
    landed(await call('/api/notify/handoff/resend', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, handoff_id: sent.handoff_id } }), 'resend');
    landed(await publish(alice, slug, AS_A), 'nothing open');
  });

  await t('Resend after dev mode went off is the plain handoff, and lifts the lock', async () => {
    const slug = await newDoc();
    const sent = await handOff(alice, slug, [await comment(alice, slug)], agentA);
    refused(await publish(alice, slug, AS_A), 'held');
    await env.META.put('dev-mode:alice@tdoc.test', 'off');
    try {
      landed(await call('/api/notify/handoff/resend', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, handoff_id: sent.handoff_id } }), 'resend');
      landed(await publish(alice, slug, AS_A), 'plain now');
    } finally {
      await env.META.delete('dev-mode:alice@tdoc.test');
    }
  });

  await t('sending the comment to another agent moves the hold: the first is free, the second is held', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    await handOff(alice, slug, [c], agentA);
    await handOff(alice, slug, [c], agentB);
    landed(await publish(alice, slug, AS_A), 'A was relieved');
    refused(await publish(alice, slug, AS_B), 'B holds it now');
  });

  await t('a send to another agent that fails leaves the first one held; a plain send to the same agent lifts it', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    await handOff(alice, slug, [c], agentA);
    down = true;
    await handOff(alice, slug, [c], agentB);
    down = false;
    refused(await publish(alice, slug, AS_A), 'B never got it');
    landed(await publish(alice, slug, AS_B), 'B is not held');
    await handOff(alice, slug, [c], agentA, {});
    landed(await publish(alice, slug, AS_A), 'the person asked for a version this time');
  });

  await t('the daemon giving up lifts a local agent\'s lock', async () => {
    const slug = await newDoc();
    const sent = await handOff(alice, slug, [await comment(alice, slug)], local);
    const AS_LOCAL = { 'X-Tdoc-Agent': 'local/macbook/macbook_claude' };
    refused(await publish(alice, slug, AS_LOCAL), 'held');
    landed(await call('/api/notify/local/fail', { method: 'POST', token: alice.token, body: { slug, handoff_id: sent.handoff_id, error: 'gave up' } }), 'fail');
    landed(await publish(alice, slug, AS_LOCAL), 'the run is over');
  });

  await t('an answer-only question still answers only, and wins over this one', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    await handOff(alice, slug, [c], agentA);
    // The owner asking their own agent takes no answer lock, so plant one the
    // way a reader's question does.
    await env.COMMENTS.get(env.COMMENTS.idFromName(slug)).fetch('https://do/answer-locks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op: { kind: 'add', id: 'q_1', lock: { ask_id: 'q_1', asker: alice.account_id, by: alice.account_id, ids: [alice.account_id], until: Date.now() + HOUR } } }) });
    const r = await publish(alice, slug, AS_A);
    assert(r.status === 403 && r.body.error === 'answer_only_run', r.text);
  });

  await t('a suggestions lock is not an answer lock: the reply and propose paths do not read it as one', async () => {
    const slug = await newDoc();
    const c = await comment(alice, slug);
    await handOff(alice, slug, [c], agentA);
    const p = await propose(alice, slug, { find: 'Sentence one, version 1.', replace: 'Better.', comment_id: c });
    assert(p.status === 200, p.text);
  });

  // ---- who is not on this path ----

  await t('not in dev mode: reply_as is dropped, no lock exists, every publish goes through', async () => {
    const slug = await newDoc(carol);
    const c = await comment(carol, slug);
    const sent = await handOff(carol, slug, [c], agentA);
    assert(!sent.reply_as, JSON.stringify(sent));
    landed(await publish(carol, slug, AS_A), 'the agent');
    landed(await publish(carol, slug), 'no identity');
    const state = await env.COMMENTS.get(env.COMMENTS.idFromName(slug)).fetch('https://do/answer-locks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op: { kind: 'list' } }) });
    assert((await state.json()).locks.length === 0, 'a lock was stored for an account not in dev mode');
  });

  await t('a team doc: an admin\'s handoff with reply_as takes no lock', async () => {
    const team = (await call('/api/teams', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { name: 'Acme' } })).body.team;
    const slug = await newDoc();
    landed(await call('/api/team/move', { method: 'POST', token: alice.token, body: { team: team.id, slugs: [slug] } }), 'move');
    const c = await comment(alice, slug);
    const sent = await handOff(alice, slug, [c], local);
    assert(sent.reply_as === 'suggestions', JSON.stringify(sent));
    landed(await publish(alice, slug, { 'X-Tdoc-Agent': 'local/macbook/macbook_claude' }), 'admin\'s agent on a team doc');
    const state = await env.COMMENTS.get(env.COMMENTS.idFromName(slug)).fetch('https://do/answer-locks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op: { kind: 'list' } }) });
    assert((await state.json()).locks.length === 0, 'a lock was stored for a team doc');
  });

  await t('a doc moved to a team while locked is off this path from then on', async () => {
    const team = (await call('/api/teams', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { name: 'Acme two' } })).body.team;
    const slug = await newDoc();
    await handOff(alice, slug, [await comment(alice, slug)], agentA);
    refused(await publish(alice, slug, AS_A), 'personal doc: held');
    landed(await call('/api/team/move', { method: 'POST', token: alice.token, body: { team: team.id, slugs: [slug] } }), 'move');
    landed(await publish(alice, slug, AS_A), 'team doc: authorship decides');
  });

  await t('the words reach the agent: MCP next step, CLI stops, skill says', async () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const src = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
    assert(/suggestions_only_run: '[^']*propose_edits[^']*(do not|Do not)[^']*'/.test(src), 'MCP_REFUSAL_NEXT');
    assert(/const MCP_INSTRUCTIONS = [^\n]*suggestions_only_run/.test(src), 'MCP_INSTRUCTIONS');
    assert(fs.readFileSync(path.join(root, 'bin/tdoc-publish'), 'utf8').includes('"$_qerr" = "suggestions_only_run"'), 'tdoc-publish');
    assert(fs.readFileSync(path.join(root, 'skills/tdoc/SKILL.md'), 'utf8').includes('suggestions_only_run'), 'SKILL.md');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
