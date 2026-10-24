// Send to my agent: a signed-in reader who can view a doc hands a question
// about it to an agent on THEIR OWN account. The owner's agents, the doc's
// agents and anyone else's are out of reach; the answer comes back on the
// reader's own token and is shown to that reader alone.
//
// What this pins down:
//   - the tier the reader's entry shows: none / online / offline (daemon not
//     running, or a terminal that can publish and cannot be woken)
//   - reader → own agent: queued in the reader's own daemon index, never the
//     owner's; a webhook gets the question and the private-answer line
//   - reader → somebody else's agent: refused (403), nothing queued; the
//     owner's Send to agent route stays closed to readers
//   - the answer: only the account that asked may post it, on its own token;
//     only that reader sees it -- not another reader, not the owner, not the
//     comment list, not the owner's handoff list
//   - a daemon run that ends without an answer is reported failed
//   - review fixes: a send must carry our Origin; questions are stored per
//     reader, so one reader cannot evict another's; a rate limit and a cap
//     on open questions; an asker who lost access still drains the queue;
//     scoped tokens stay out; deleting the doc deletes its questions
//
// Run with: node test/reader-agent-ask.test.js

const { loadWorker, makeEnv, req, issue, putSession } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  console.log('send to my agent (reader handoff)');
  const mod = await loadWorker();
  const worker = mod.default;

  const call = async (env, path, opts) => {
    const r = await worker.fetch(req(path, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  async function seed() {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const owner = await issue(worker, env, 'owner');
    const reader = await issue(worker, env, 'reader');
    const other = await issue(worker, env, 'other');
    const up = await call(env, '/api/upload', { method: 'POST', token: owner.token, body: { slug: 'plan', version: 1, html: '<h1>Plan</h1><p>Billing ships first. Then search.</p>' } });
    assert(up.status === 200, `upload ${up.status}`);
    return { env, owner, reader, other };
  }
  const register = (env, token, device) => call(env, '/api/notify/local/register', { method: 'POST', token, body: { device, clis: ['claude'] } });
  const state = (env, who) => call(env, '/api/docs/plan/my-agent', { cookie: who.cookie });
  const ORIGIN = { Origin: 'https://tdoc.dev' };
  const send = (env, who, body) => call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body });
  const pendingFor = async (env, who, device) => (await call(env, `/api/notify/local/pending?device=${device}`, { token: who.token })).body.pending;
  const PASSAGE = { text: 'Billing ships first', context_before: '', context_after: '. Then search.', occurrence: 0, occurrences: 1, rect: { top: 1 } };

  await t('browser readers only: signed out 401, an Authorization header 403, a doc they cannot read 403', async () => {
    const { env, reader, owner } = await seed();
    assert((await call(env, '/api/docs/plan/my-agent')).status === 401, 'signed out');
    const bearer = await call(env, '/api/docs/plan/my-agent', { cookie: reader.cookie, token: reader.token });
    assert(bearer.status === 403 && bearer.body.error === 'browser_session_required', JSON.stringify(bearer.body));
    await env.META.put('meta:secret', JSON.stringify({ title: 's', slug: 'secret', created: '2026-01-01', versions: [{ n: 1 }], access: { visibility: 'private', allowed_users: ['owner'] }, hosted: { account_id: owner.account_id } }));
    const denied = await call(env, '/api/docs/secret/my-agent', { cookie: reader.cookie });
    assert(denied.status === 403, `private doc: ${denied.status}`);
  });

  await t('tier: none with nothing connected, offline with a paired terminal or a silent daemon, online with a running one', async () => {
    const { env, reader } = await seed();
    // Minting a token pairs a terminal; start from an account that never has.
    await env.META.delete(`account-terminal:${reader.account_id}`);
    let r = await state(env, reader);
    assert(r.status === 200 && r.body.tier === 'none' && r.body.agent === null && r.body.asks.length === 0, JSON.stringify(r.body));
    await env.META.put(`account-terminal:${reader.account_id}`, '1');
    r = await state(env, reader);
    assert(r.body.tier === 'offline' && r.body.helper_href, `paired terminal: ${JSON.stringify(r.body)}`);
    await register(env, reader.token, 'readerbox');
    r = await state(env, reader);
    assert(r.body.tier === 'online' && r.body.agent.provider === 'local' && r.body.agent.device === 'readerbox', JSON.stringify(r.body));
    await env.META.put(`local-agents-seen:${reader.account_id}`, JSON.stringify({ readerbox: new Date(Date.now() - 31 * 60000).toISOString() }));
    r = await state(env, reader);
    assert(r.body.tier === 'offline' && r.body.agent === null && r.body.agents.length === 1, `silent daemon: ${JSON.stringify(r.body)}`);
    const refused = await send(env, reader, { question: 'What ships first?' });
    assert(refused.status === 409 && refused.body.error === 'agent_offline', JSON.stringify(refused.body));
  });

  await t("reader → own agent: queued in the reader's own daemon index with the passage, never the owner's", async () => {
    const { env, owner, reader } = await seed();
    await register(env, owner.token, 'ownerbox');
    await register(env, reader.token, 'readerbox');
    const r = await send(env, reader, { question: 'What ships first?', passage: PASSAGE });
    assert(r.status === 200 && r.body.ok, JSON.stringify(r.body));
    const ask = r.body.ask;
    assert(ask.recipient.device === 'readerbox' && ask.delivery.status === 'queued', JSON.stringify(ask));
    assert(ask.passage.text === 'Billing ships first' && !('rect' in ask.passage), JSON.stringify(ask.passage));
    const mine = await pendingFor(env, reader, 'readerbox');
    assert(mine.length === 1 && mine[0].kind === 'ask' && mine[0].ask_id === ask.ask_id && mine[0].question === 'What ships first?' && mine[0].selection === 'Billing ships first', JSON.stringify(mine));
    assert(mine[0].by === reader.account_id, 'queued by the reader');
    assert((await pendingFor(env, owner, 'ownerbox')).length === 0, "nothing reached the owner's daemon");
  });

  await t("reader → someone else's agent: refused, nothing queued, and the owner's Send to agent stays closed", async () => {
    const { env, owner, reader, other } = await seed();
    await register(env, owner.token, 'ownerbox');
    await register(env, other.token, 'otherbox');
    await register(env, reader.token, 'readerbox');
    for (const device of ['ownerbox', 'otherbox']) {
      const r = await send(env, reader, { question: 'Do my work', recipient: { provider: 'local', device, cli: 'claude' } });
      assert(r.status === 403 && r.body.error === 'not_your_agent', `${device}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const forged = await send(env, reader, { question: 'x', recipient: { provider: 'raft', server_id: 'srv', agent_sub: 'someone' } });
    assert(forged.status === 403, `made-up recipient: ${forged.status}`);
    assert((await pendingFor(env, owner, 'ownerbox')).length === 0 && (await pendingFor(env, other, 'otherbox')).length === 0, 'nothing queued for anyone else');
    const c = await call(env, '/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug: 'plan', version: 1, text: 'hi', anchor: { kind: 'text', text: 'Billing' } } });
    const handoff = await call(env, '/api/notify/handoff', { method: 'POST', cookie: reader.cookie, body: { slug: 'plan', comment_ids: [c.body.id] } });
    assert(handoff.status === 401 || handoff.status === 403, `reader reached the owner's handoff: ${handoff.status}`);
    // An explicit pick among the reader's own agents is fine.
    const own = await send(env, reader, { question: 'ok', recipient: { provider: 'local', device: 'readerbox', cli: 'claude' } });
    assert(own.status === 200 && own.body.ask.recipient.device === 'readerbox', JSON.stringify(own.body));
  });

  await t('the answer: only the asking account may post it, and only the asker ever sees it', async () => {
    const { env, owner, reader, other } = await seed();
    await register(env, reader.token, 'readerbox');
    const { ask } = (await send(env, reader, { question: 'What ships first?', passage: PASSAGE })).body;
    const answer = (who, text = 'PRIVATE-ANSWER-MARKER') => call(env, '/api/agent/ask-reply', { method: 'POST', token: who.token, body: { slug: 'plan', ask_id: ask.ask_id, text, agent_login: 'claude', agent_name: 'Claude' } });
    for (const who of [owner, other]) {
      const r = await answer(who, 'injected');
      assert(r.status === 404 && r.body.error === 'ask_not_found', `${who.login}: ${r.status}`);
    }
    const cookieOnly = await call(env, '/api/agent/ask-reply', { method: 'POST', cookie: reader.cookie, body: { slug: 'plan', ask_id: ask.ask_id, text: 'x' } });
    assert(cookieOnly.status === 401, `a browser session answered: ${cookieOnly.status}`);
    const ack = await call(env, '/api/agent/ask-ack', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: ask.ask_id } });
    assert(ack.status === 200 && ack.body.acked_at, JSON.stringify(ack.body));
    const ok = await answer(reader);
    assert(ok.status === 200 && ok.body.ok, JSON.stringify(ok.body));
    const mine = (await state(env, reader)).body.asks;
    assert(mine.length === 1 && mine[0].answer.text === 'PRIVATE-ANSWER-MARKER' && mine[0].answer.agent.name === 'Claude' && mine[0].passage.text === 'Billing ships first', JSON.stringify(mine));
    assert((await pendingFor(env, reader, 'readerbox')).length === 0, 'answered: off the daemon queue');
    // Nobody else sees it: another reader, the owner, the comments, the handoffs.
    assert((await state(env, other)).body.asks.length === 0, 'another reader sees it');
    assert((await state(env, owner)).body.asks.length === 0, 'the owner sees it');
    const comments = await call(env, '/api/comments?slug=plan&version=1', { cookie: owner.cookie });
    assert(!JSON.stringify(comments.body).includes('PRIVATE-ANSWER-MARKER') && !JSON.stringify(comments.body).includes('What ships first?'), 'leaked into comments');
    const handoffs = await call(env, '/api/notify/handoffs?slug=plan', { cookie: owner.cookie });
    assert(handoffs.status === 200 && !JSON.stringify(handoffs.body).includes(ask.ask_id), "leaked into the owner's handoffs");
    const page = await worker.fetch(req('/d/plan', { cookie: other.cookie }), env, {});
    assert(!(await page.text()).includes('PRIVATE-ANSWER-MARKER'), 'leaked into the page');
  });

  await t('the asker must still be able to read the doc when the answer comes back', async () => {
    const { env, owner, reader } = await seed();
    await register(env, reader.token, 'readerbox');
    const { ask } = (await send(env, reader, { question: 'q' })).body;
    const meta = JSON.parse(await env.META.get('meta:plan'));
    await env.META.put('meta:plan', JSON.stringify({ ...meta, access: { visibility: 'private', allowed_users: ['owner'] } }));
    const r = await call(env, '/api/agent/ask-reply', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: ask.ask_id, text: 'late' } });
    assert(r.status === 403 && r.body.error === 'access_denied', `${r.status} ${JSON.stringify(r.body)}`);
    assert(owner, 'owner exists');
  });

  await t('a daemon run that ends without an answer is reported failed and leaves the queue', async () => {
    const { env, reader } = await seed();
    await register(env, reader.token, 'readerbox');
    const { ask } = (await send(env, reader, { question: 'q' })).body;
    const done = await call(env, '/api/agent/ask-done', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: ask.ask_id, error: 'exit 1' } });
    assert(done.status === 200 && done.body.answered === false, JSON.stringify(done.body));
    const mine = (await state(env, reader)).body.asks[0];
    assert(mine.delivery.status === 'failed' && mine.delivery.error === 'agent_run_failed' && !mine.answer, JSON.stringify(mine));
    assert((await pendingFor(env, reader, 'readerbox')).length === 0, 'still queued');
  });

  await t("a webhook on the reader's account gets the question and the private-answer line", async () => {
    const { env, reader } = await seed();
    const sub = 'wh_' + 'a'.repeat(20);
    await env.META.put(`account-notify:${reader.account_id}`, JSON.stringify([{ provider: 'webhook', agent_sub: sub, url: 'https://hook.example/tdoc', agent_name: 'my bot' }]));
    await env.META.put(`notify-webhook-secret:${sub}`, 'secret');
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (u, init = {}) => { sent.push({ url: String(u), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
    try {
      const r = await send(env, reader, { question: 'What ships first?', passage: PASSAGE });
      assert(r.status === 200 && r.body.ask.delivery.status === 'delivered', JSON.stringify(r.body));
      assert(!('url' in r.body.ask.recipient), 'the webhook URL is not echoed');
      assert(sent.length === 1 && sent[0].url === 'https://hook.example/tdoc', JSON.stringify(sent));
      const p = sent[0].body;
      assert(p.kind === 'ask' && p.slug === 'plan' && p.ask_id === r.body.ask.ask_id && p.question === 'What ships first?' && p.selection === 'Billing ships first', JSON.stringify(p));
      assert(p.instruction.startsWith('Read https://tdoc.dev/d/plan and answer: What ships first?') && p.instruction.includes(`--ask ${p.ask_id}`), p.instruction);
    } finally { globalThis.fetch = realFetch; }
  });

  await t('a signed-in reader with no account yet sees tier none and cannot send', async () => {
    const { env } = await seed();
    const cookie = await putSession(env, 'newcomer');
    const r = await call(env, '/api/docs/plan/my-agent', { cookie });
    assert(r.status === 200 && r.body.tier === 'none', JSON.stringify(r.body));
    const s = await call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie, headers: ORIGIN, body: { question: 'q' } });
    assert(s.status === 409 && s.body.error === 'agent_not_connected', JSON.stringify(s.body));
  });

  await t('sending needs our Origin (or a same-origin fetch): a missing or foreign Origin is refused', async () => {
    const { env, reader } = await seed();
    await register(env, reader.token, 'readerbox');
    const none = await call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: reader.cookie, body: { question: 'q' } });
    assert(none.status === 403 && none.body.error === 'cross_origin', `no Origin: ${none.status}`);
    const foreign = await call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: reader.cookie, headers: { Origin: 'https://evil.example' }, body: { question: 'q' } });
    assert(foreign.status === 403, `foreign Origin: ${foreign.status}`);
    const fetchSite = await call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: reader.cookie, headers: { 'Sec-Fetch-Site': 'same-origin' }, body: { question: 'q' } });
    assert(fetchSite.status === 200, `same-origin fetch: ${fetchSite.status}`);
    assert((await pendingFor(env, reader, 'readerbox')).length === 1, 'only the same-origin send was queued');
  });

  await t("one reader's questions never push out another's; open questions and sends per hour are capped", async () => {
    const { env, reader, other } = await seed();
    await register(env, reader.token, 'readerbox');
    await register(env, other.token, 'otherbox');
    const mine = (await send(env, reader, { question: 'A private q' })).body.ask;
    await call(env, '/api/agent/ask-reply', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: mine.ask_id, text: 'A answer' } });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await send(env, other, { question: `spam ${i}` })).status);
    assert(codes.filter((c) => c === 200).length === 5 && codes.slice(5).every((c) => c === 429), `open-question cap: ${codes}`);
    // Answer them as they come, so only the hourly budget is left to stop it.
    const answerAll = async () => {
      for (const a of (await state(env, other)).body.asks) if (!a.answer) await call(env, '/api/agent/ask-reply', { method: 'POST', token: other.token, body: { slug: 'plan', ask_id: a.ask_id, text: 'ok' } });
    };
    let sent = 5;
    let limited = null;
    for (let i = 0; i < 30 && !limited; i++) {
      await answerAll();
      const r = await send(env, other, { question: `more ${i}` });
      if (r.status === 200) sent++; else limited = r;
    }
    assert(limited && limited.status === 429 && limited.body.error === 'rate_limited' && sent === 20, `hourly budget: sent ${sent}, ${limited && limited.status}`);
    const after = (await state(env, reader)).body.asks;
    assert(after.length === 1 && after[0].answer.text === 'A answer', `the reader's question was evicted: ${JSON.stringify(after)}`);
    const again = await call(env, '/api/agent/ask-reply', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: mine.ask_id, text: 'again' } });
    assert(again.status === 200, `the reader can still answer: ${again.status}`);
  });

  await t('an asker who lost access: done still clears it, and the next poll drops what is left', async () => {
    const { env, reader } = await seed();
    await register(env, reader.token, 'readerbox');
    const a = (await send(env, reader, { question: 'one' })).body.ask;
    const b = (await send(env, reader, { question: 'two' })).body.ask;
    const meta = JSON.parse(await env.META.get('meta:plan'));
    await env.META.put('meta:plan', JSON.stringify({ ...meta, access: { visibility: 'private', allowed_users: ['owner'] } }));
    const ack = await call(env, '/api/agent/ask-ack', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: a.ask_id } });
    assert(ack.status === 403, `ack after access lost: ${ack.status}`);
    const done = await call(env, '/api/agent/ask-done', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: a.ask_id, error: 'x' } });
    assert(done.status === 200, `done after access lost: ${done.status}`);
    const left = await pendingFor(env, reader, 'readerbox');
    assert(left.length === 0, `still queued: ${JSON.stringify(left.map((x) => x.ask_id))}`);
    const raw = JSON.parse(await env.META.get(`local-pending:${reader.account_id}`));
    assert(!raw.some((e) => e.handoff_id === b.ask_id), 'the unreadable question stayed in the index');
    // And a deleted doc the same way.
    await env.META.put('meta:plan', JSON.stringify(meta));
    await send(env, reader, { question: 'three' });
    await env.META.delete('meta:plan');
    assert((await pendingFor(env, reader, 'readerbox')).length === 0, 'a question on a deleted doc stays queued');
  });

  await t('a workspace-scoped token cannot answer or poll questions on a doc outside its workspaces', async () => {
    const { env, reader } = await seed();
    await register(env, reader.token, 'readerbox');
    const { ask } = (await send(env, reader, { question: 'q' })).body;
    // The reader's own connection, ticked for My docs only: somebody else's
    // doc is outside it.
    const scoped = 'tdoc_scopedreadertoken0000000000000000';
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(scoped).digest('hex');
    const base = JSON.parse(await env.META.get(`hosted-token:${crypto.createHash('sha256').update(reader.token).digest('hex')}`));
    await env.META.put(`hosted-token:${hash}`, JSON.stringify({ ...base, scope: { me: true, teams: [] } }));
    for (const route of ['ask-reply', 'ask-ack']) {
      const r = await call(env, `/api/agent/${route}`, { method: 'POST', token: scoped, body: { slug: 'plan', ask_id: ask.ask_id, text: 'x' } });
      assert(r.status === 403 && r.body.error === 'token_scope', `${route}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    // A scoped token may poll its own queue (a team agent's daemon does), but
    // a question on a doc outside its workspaces is not on it, and stays
    // queued for the account's wider token.
    const poll = await call(env, '/api/notify/local/pending?device=readerbox', { token: scoped });
    assert(poll.status === 200 && !poll.body.pending.length, `pending with a scoped token: ${poll.status} ${JSON.stringify(poll.body)}`);
    const wide = await call(env, '/api/notify/local/pending?device=readerbox', { token: reader.token });
    assert(wide.body.pending.some((h) => h.ask_id === ask.ask_id), `the scoped poll dropped it: ${JSON.stringify(wide.body)}`);
    assert(!(await state(env, reader)).body.asks[0].answer, 'answered through a scoped token');
  });

  await t("deleting the doc deletes readers' questions and its handoffs; the slug starts clean", async () => {
    const { env, owner, reader } = await seed();
    await register(env, reader.token, 'readerbox');
    await send(env, reader, { question: 'q' });
    await env.META.put('handoffs:plan', '[{"handoff_id":"h_1"}]');
    await env.META.put('agent-asks:plan-two:x', '[]');
    const del = await call(env, '/api/doc?slug=plan', { method: 'DELETE', token: owner.token });
    assert(del.status === 200, `delete ${del.status} ${JSON.stringify(del.body)}`);
    const left = [...env.META.map.keys()].filter((k) => k.startsWith('agent-asks:plan:') || k === 'handoffs:plan');
    assert(left.length === 0, `left behind: ${left}`);
    assert(env.META.map.has('agent-asks:plan-two:x'), 'another doc with a longer slug lost its questions');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
