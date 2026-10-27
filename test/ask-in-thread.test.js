// Ask AI is commenting: a comment (or reply) that asks — the composer's Ask
// AI toggle or @AI — posts as usual, and the answer arrives as an ordinary
// reply in that thread, visible to everyone who can see the comment and
// signed by whoever answered. Two answerers live on the server:
//   - tdoc AI (POST /api/docs/<slug>/ask with comment_id): free answers per
//     account, the reply signed "tdoc AI" acting for the asker
//   - the commenter's own agent (POST /api/docs/<slug>/my-agent with
//     comment_id): queued for THEIR agent only; its answer, on their own
//     token, becomes the reply, signed by that agent and naming them
// What this pins down: only the comment's own author may ask on it, and only
// with our Origin; one answer per human turn; the quota and its "connect your
// agent" way out; another account's token can never answer; the #814 rules
// (own agent only, no doc edits) still hold.
// Run with: node test/ask-in-thread.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const MODEL = 'https://model.invalid/v1';

(async () => {
  console.log('Ask AI in a comment: the answer is a reply in the thread');
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    modelCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Billing ships first because invoices block renewals.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, path, opts) => {
    const r = await worker.fetch(req(path, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const ORIGIN = { Origin: 'https://tdoc.dev' };
  async function seed(extra = {}) {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL, ...extra });
    const owner = await issue(worker, env, 'owner');
    const reader = await issue(worker, env, 'reader');
    const other = await issue(worker, env, 'other');
    const up = await call(env, '/api/upload', { method: 'POST', token: owner.token, body: { slug: 'plan', version: 1, html: '<h1>Plan</h1><p>Billing ships first. Then search.</p>' } });
    assert(up.status === 200, `upload ${up.status}`);
    const posted = await call(env, '/api/comments', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { slug: 'plan', version: 1, text: 'Why does billing ship first? @⁠AI', anchor: { kind: 'text', text: 'Billing ships first' } } });
    assert(posted.status === 200 && posted.body.id, `comment ${posted.status} ${JSON.stringify(posted.body)}`);
    return { env, owner, reader, other, commentId: posted.body.id };
  }
  const thread = async (env, who, id) => {
    const r = await call(env, '/api/comments?slug=plan&version=1', { cookie: who.cookie });
    const list = Array.isArray(r.body) ? r.body : r.body.comments;
    return list.find((c) => c.id === id);
  };
  const askAi = (env, who, commentId, headers = ORIGIN) => call(env, '/api/docs/plan/ask', { method: 'POST', cookie: who.cookie, headers, body: { question: 'Why does billing ship first?', selection: 'Billing ships first', comment_id: commentId } });

  await t('tdoc AI answers as a reply under the comment, signed tdoc AI for the asker, seen by everyone', async () => {
    const { env, owner, reader, other, commentId } = await seed();
    const r = await askAi(env, reader, commentId);
    assert(r.status === 200 && r.body.reply && r.body.remaining === 4, JSON.stringify(r.body));
    assert(!('answer' in r.body), 'a thread answer is not also returned privately');
    for (const who of [reader, owner, other]) {
      const c = await thread(env, who, commentId);
      const reply = (c.replies || []).find((x) => x.id === r.body.reply.id);
      assert(reply, `${who.login} cannot see the answer`);
      assert(reply.text.includes('invoices block renewals'), reply.text);
      assert(reply.author.kind === 'agent' && reply.author.name === 'tdoc AI' && reply.author.login === 'tdoc-ai', JSON.stringify(reply.author));
      assert(reply.author.owner && reply.author.owner.key === 'reader', `acts for the asker: ${JSON.stringify(reply.author.owner)}`);
    }
  });

  await t("only the comment's author may ask on it, with our Origin; a reply is a place to ask too", async () => {
    const { env, owner, reader, other, commentId } = await seed();
    const before = modelCalls;
    const notMine = await askAi(env, other, commentId);
    assert(notMine.status === 403 && notMine.body.error === 'not_your_comment', JSON.stringify(notMine.body));
    const ownerToo = await askAi(env, owner, commentId);
    assert(ownerToo.status === 403, `even the doc owner cannot ask on somebody else's comment: ${ownerToo.status}`);
    const noOrigin = await askAi(env, reader, commentId, {});
    assert(noOrigin.status === 403 && noOrigin.body.error === 'cross_origin', JSON.stringify(noOrigin.body));
    const missing = await askAi(env, reader, 'c_nope');
    assert(missing.status === 404, `missing comment ${missing.status}`);
    assert(modelCalls === before, 'the model ran for a refused ask');
    // A reply that asks: the answer hangs under the reply.
    const reply = await call(env, '/api/comments', { method: 'POST', cookie: other.cookie, headers: ORIGIN, body: { slug: 'plan', version: 1, parent_id: commentId, text: 'And search? @⁠AI' } });
    const r = await askAi(env, other, reply.body.id);
    assert(r.status === 200 && r.body.reply.parent_id === reply.body.id, JSON.stringify(r.body));
  });

  await t('one answer per human turn: asking again before anyone speaks gives the question back', async () => {
    const { env, reader, commentId } = await seed();
    const first = await askAi(env, reader, commentId);
    assert(first.status === 200 && first.body.remaining === 4, JSON.stringify(first.body));
    const again = await askAi(env, reader, commentId);
    assert(again.status === 200 && again.body.skipped && again.body.remaining === 4, JSON.stringify(again.body));
    const c = await thread(env, reader, commentId);
    assert((c.replies || []).filter((x) => x.author.login === 'tdoc-ai').length === 1, 'answered twice');
  });

  await t('used up: 429 with the way to connect an agent, and nothing posted', async () => {
    const { env, reader, commentId } = await seed({ ASK_FREE_LIMIT: '1' });
    const other = await call(env, '/api/comments', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { slug: 'plan', version: 1, text: 'And search?', anchor: { kind: 'text', text: 'Then search' } } });
    assert((await askAi(env, reader, commentId)).status === 200, 'first answer');
    const r = await askAi(env, reader, other.body.id);
    assert(r.status === 429 && r.body.error === 'ask_limit' && r.body.connect_href === '/start', JSON.stringify(r.body));
    const c = await thread(env, reader, other.body.id);
    assert(!(c.replies || []).length, 'posted past the limit');
  });

  await t("the commenter's own agent: queued for them only, its answer is a reply signed by it and naming them", async () => {
    const { env, owner, reader, other, commentId } = await seed();
    await call(env, '/api/notify/local/register', { method: 'POST', token: reader.token, body: { device: 'readerbox', clis: ['claude'] } });
    const send = (who, id) => call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body: { question: 'Why does billing ship first?', comment_id: id } });
    // Somebody else's comment: refused before anything is queued.
    await call(env, '/api/notify/local/register', { method: 'POST', token: other.token, body: { device: 'otherbox', clis: ['claude'] } });
    const refused = await send(other, commentId);
    assert(refused.status === 403 && refused.body.error === 'not_your_comment', JSON.stringify(refused.body));
    const sent = await send(reader, commentId);
    assert(sent.status === 200 && sent.body.ask.comment_id === commentId, JSON.stringify(sent.body));
    const pending = (await call(env, '/api/notify/local/pending?device=readerbox', { token: reader.token })).body.pending;
    assert(pending.length === 1 && pending[0].kind === 'ask' && pending[0].comment_id === commentId, JSON.stringify(pending));
    assert(!(await call(env, '/api/notify/local/pending?device=otherbox', { token: other.token })).body.pending.length, "queued on another reader's daemon");
    // Another account's token finds nothing to answer.
    const injected = await call(env, '/api/agent/ask-reply', { method: 'POST', token: owner.token, body: { slug: 'plan', ask_id: sent.body.ask.ask_id, text: 'injected' } });
    assert(injected.status === 404, `owner answered the reader's question: ${injected.status}`);
    const ok = await call(env, '/api/agent/ask-reply', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: sent.body.ask.ask_id, text: 'THREAD-ANSWER: invoices block renewals.', agent_login: 'claude', agent_name: 'Claude' } });
    assert(ok.status === 200 && ok.body.reply_id, JSON.stringify(ok.body));
    for (const who of [reader, owner, other]) {
      const c = await thread(env, who, commentId);
      const reply = (c.replies || []).find((x) => x.id === ok.body.reply_id);
      assert(reply && reply.text.startsWith('THREAD-ANSWER'), `${who.login} cannot see the answer`);
      assert(reply.author.kind === 'agent' && reply.author.provider === 'local' && reply.author.owner && reply.author.owner.key === 'reader', JSON.stringify(reply.author));
    }
    const mine = (await call(env, '/api/docs/plan/my-agent', { cookie: reader.cookie })).body.asks;
    assert(mine[0].reply_id === ok.body.reply_id, JSON.stringify(mine[0]));
    assert(!(await call(env, '/api/notify/local/pending?device=readerbox', { token: reader.token })).body.pending.length, 'still queued');
    // Answer-only: the reader's token still cannot write the doc.
    const edit = await call(env, '/api/upload', { method: 'POST', token: reader.token, body: { slug: 'plan', version: 2, html: '<h1>Hijacked</h1>' } });
    assert(edit.status === 403, `the reader's agent could publish: ${edit.status}`);
  });

  await t('a webhook agent asked in a comment is told its answer is a reply under the comment', async () => {
    const { env, reader, commentId } = await seed();
    const sub = 'wh_' + 'a'.repeat(20);
    await env.META.put(`account-notify:${reader.account_id}`, JSON.stringify([{ provider: 'webhook', agent_sub: sub, url: 'https://hook.example/tdoc', agent_name: 'my bot' }]));
    await env.META.put(`notify-webhook-secret:${sub}`, 'secret');
    const before = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (u, init = {}) => { sent.push({ url: String(u), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
    try {
      const r = await call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { question: 'Why?', comment_id: commentId } });
      assert(r.status === 200 && r.body.ask.delivery.status === 'delivered', JSON.stringify(r.body));
      const p = sent[0].body;
      assert(p.comment_id === commentId && p.instruction.includes('reply under the person') && !p.instruction.includes('Answer only the person who asked'), p.instruction);
    } finally { globalThis.fetch = before; }
  });

  await t('Only me, then Make public: the kept answer goes under the asker\'s new comment, signed tdoc AI; once only, theirs only', async () => {
    const { env, reader, other, commentId } = await seed();
    const priv = await call(env, '/api/docs/plan/ask', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { question: 'Private: why billing?', selection: 'Billing ships first' } });
    assert(priv.status === 200 && priv.body.ask_id && priv.body.answer, JSON.stringify(priv.body));
    const before = await thread(env, reader, commentId);
    assert(!JSON.stringify(before).includes('invoices block renewals'), 'a private answer reached the comments');
    const publish = (who, body) => call(env, '/api/docs/plan/ask/publish', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body });
    // The question goes up as the asker's comment first; the answer hangs under it.
    const q = await call(env, '/api/comments', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { slug: 'plan', version: 1, text: 'Private: why billing?', anchor: { kind: 'text', text: 'Billing ships first' } } });
    assert((await publish(other, { ask_id: priv.body.ask_id, comment_id: q.body.id })).status === 403, "another account published onto the reader's comment");
    const theirs = await call(env, '/api/comments', { method: 'POST', cookie: other.cookie, headers: ORIGIN, body: { slug: 'plan', version: 1, text: 'mine' } });
    assert((await publish(other, { ask_id: priv.body.ask_id, comment_id: theirs.body.id })).status === 404, "another account found the reader's private answer");
    const ok = await publish(reader, { ask_id: priv.body.ask_id, comment_id: q.body.id });
    assert(ok.status === 200 && ok.body.reply && ok.body.reply.author.name === 'tdoc AI' && ok.body.reply.text.includes('invoices block renewals'), JSON.stringify(ok.body));
    const seen = await thread(env, other, q.body.id);
    assert((seen.replies || []).some((r) => r.id === ok.body.reply.id), 'another reader cannot see the published answer');
    const twice = await publish(reader, { ask_id: priv.body.ask_id, comment_id: q.body.id });
    assert(twice.status === 409 && twice.body.error === 'already_public', JSON.stringify(twice.body));
    const noOrigin = await call(env, '/api/docs/plan/ask/publish', { method: 'POST', cookie: reader.cookie, body: { ask_id: priv.body.ask_id, comment_id: q.body.id } });
    assert(noOrigin.status === 403, `publish without our Origin: ${noOrigin.status}`);
  });

  await t("Only me with the reader's own agent, then Make public: its kept answer becomes the reply, signed by it", async () => {
    const { env, owner, reader } = await seed();
    await call(env, '/api/notify/local/register', { method: 'POST', token: reader.token, body: { device: 'readerbox', clis: ['claude'] } });
    const sent = await call(env, '/api/docs/plan/my-agent', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { question: 'Private to my agent?' } });
    assert(sent.status === 200 && !sent.body.ask.comment_id, JSON.stringify(sent.body));
    const publish = (body) => call(env, '/api/docs/plan/my-agent/publish', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body });
    const q = await call(env, '/api/comments', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { slug: 'plan', version: 1, text: 'Private to my agent?' } });
    const early = await publish({ ask_id: sent.body.ask.ask_id, comment_id: q.body.id });
    assert(early.status === 409 && early.body.error === 'not_answered', JSON.stringify(early.body));
    await call(env, '/api/agent/ask-reply', { method: 'POST', token: reader.token, body: { slug: 'plan', ask_id: sent.body.ask.ask_id, text: 'PRIVATE-THEN-PUBLIC', agent_login: 'claude', agent_name: 'Claude' } });
    assert(!JSON.stringify(await thread(env, owner, q.body.id)).includes('PRIVATE-THEN-PUBLIC'), 'public before Make public');
    const ok = await publish({ ask_id: sent.body.ask.ask_id, comment_id: q.body.id });
    assert(ok.status === 200 && ok.body.reply.text === 'PRIVATE-THEN-PUBLIC' && ok.body.reply.author.owner.key === 'reader' && ok.body.reply.author.provider === 'local', JSON.stringify(ok.body));
    assert(JSON.stringify(await thread(env, owner, q.body.id)).includes('PRIVATE-THEN-PUBLIC'), 'the owner cannot see it after Make public');
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
