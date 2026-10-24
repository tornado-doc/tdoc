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
  const send = (env, who, body) => call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: who.cookie, body });
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
      assert(r.status === 403 && r.body.error === 'not_your_question', `${who.login}: ${r.status}`);
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
    const s = await call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie, body: { question: 'q' } });
    assert(s.status === 409 && s.body.error === 'agent_not_connected', JSON.stringify(s.body));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
