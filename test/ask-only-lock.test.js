// "Ask only" in the comment composer and reply box (Julie, 2026-11-08):
// ticked, the hand-off is answer only, and the server holds it, not the box.
// From the moment the question is sent until its answer lands (or the asker
// cancels), the agent asked may not publish, propose suggestions or mark a
// comment applied on this doc.
//   - the doc's owner asking their own agent: held is the agent asked, as it
//     names itself (X-Tdoc-Agent / X-Tdoc-Raft-Agent / MCP raft_agent). The
//     owner's own terminal (a token naming no agent) and their other agents
//     publish freely (Julie, 2026-11-09).
//   - anybody else asking their own agent: every token of their account on
//     this doc, as before.
// Raft, webhook, local daemon; tdoc AI only ever answers and never opens a
// hand-off to edit. Ask only off is the control: the plain edit hand-off.
// Run with: node test/ask-only-lock.test.js
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ORIGIN = { Origin: 'https://tdoc.dev' };
const SERVER = 'server-1';
const MODEL = 'https://model.invalid/v1';
const LOCKED = 'answer_only_run';

(async () => {
  console.log('Ask only: an answer-only hand-off the server holds');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  env.TDOC_EMAIL_ALIAS_SECRET = 'test-alias-secret';
  // Dev mode, so propose_edits is a route at all: the lock must refuse it.
  env.TDOC_DEBUG_ACCOUNTS = 'alice@tdoc.test';
  env.RAFT_CLIENT_ID = 'tdoc-x';
  env.RAFT_CLIENT_SECRET = 's';

  let modelCalls = 0;
  const delivered = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input && input.url ? input.url : input);
    if (u.startsWith(MODEL)) {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: 'tdoc AI: billing ships first.' } }] });
    }
    if (u.endsWith('/api/oauth/requests/agent')) return Response.json({ requestId: 'r1', agent: { serverId: SERVER } });
    if (u.endsWith('/api/oauth/token')) return Response.json({ access_token: 't' });
    delivered.push({ url: u, body: JSON.parse(init.body || '{}') });
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
  const agentA = { provider: 'raft', server_id: SERVER, server_slug: 'one', agent_sub: 'agent-a', agent_name: 'a' };
  const agentB = { provider: 'raft', server_id: SERVER, server_slug: 'one', agent_sub: 'agent-b', agent_name: 'b' };
  await env.META.put(`account-notify:${alice.account_id}`, JSON.stringify([agentA, agentB]));
  const hookR = await call('/api/me/connectors/webhook', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { url: 'https://hook.test/in', label: 'hook' } });
  assert(hookR.status === 200 && hookR.body.target, `webhook ${hookR.status} ${hookR.text}`);
  const reg = await call('/api/notify/local/register', { method: 'POST', token: alice.token, body: { device: 'macbook', clis: ['claude'] } });
  assert(reg.status === 200, `register ${reg.status} ${reg.text}`);

  const html = (n) => `<h1>Plan</h1><p>Sentence one, version ${n}.</p><p>Sentence two, version ${n}.</p>`;
  const versionOf = (slug) => Math.max(...JSON.parse(env.META.map.get(`meta:${slug}`)).versions.map((v) => v.n));
  const publish = (slug, headers = {}) => {
    const next = versionOf(slug) + 1;
    return call('/api/upload', { method: 'POST', token: alice.token, headers, body: { slug, version: next, html: html(next), meta: { title: 'Plan', versions: [{ n: next, created: new Date().toISOString() }] } } });
  };
  let docN = 0;
  const newDoc = async () => {
    const slug = `ask-only-${++docN}`;
    const r = await call('/api/upload', { method: 'POST', token: alice.token, body: { slug, version: 1, html: html(1), meta: { title: 'Plan' } } });
    assert(r.status === 200, `seed ${r.status} ${r.text}`);
    return slug;
  };
  const comment = async (slug, text = 'Why does billing ship first? @agent') => {
    const r = await call('/api/comments', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, version: 1, text, anchor: { kind: 'text', text: 'Sentence one' } } });
    assert(r.status === 200, `comment ${r.status} ${r.text}`);
    return r.body.id;
  };
  // The composer's one door (document-shell askOn / editOn).
  const handOff = (slug, body) => call(`/api/docs/${slug}/hand-off`, { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body });
  const propose = (slug, headers = {}) => call(`/api/docs/${slug}/suggestions`, { method: 'POST', token: alice.token, headers, body: { edits: [{ find: 'Sentence one', replace: 'Line one' }], agent_login: 'a', agent_name: 'a' } });
  const markApplied = (slug, parentId, headers = {}) => call('/api/agent/reply', { method: 'POST', token: alice.token, headers, body: { slug, parent_id: parentId, text: 'Changed it.', status: 'applied', applied_in: versionOf(slug) } });
  const handoffsOn = async (slug) => {
    const r = await call(`/api/notify/handoffs?slug=${slug}`, { cookie: alice.cookie });
    return r.status === 200 ? (r.body.handoffs || []) : [];
  };
  const mine = (await call(`/api/docs/${await newDoc()}/my-agent`, { cookie: alice.cookie })).body;
  const local = ((mine && mine.agents) || []).find((a) => a.provider === 'local');
  const hook = ((mine && mine.agents) || []).find((a) => a.provider === 'webhook');
  const refused = (r, what) => assert(r.status === 403 && r.body && r.body.error === LOCKED, `${what}: ${r.status} ${r.text}`);
  const landed = (r, what) => assert(r.status === 200, `${what}: ${r.status} ${r.text}`);

  const cases = [
    ['Raft', () => agentA, { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-a` }],
    ['webhook', () => hook, { 'X-Tdoc-Agent': `webhook/webhook/${hook.agent_sub}` }],
    ['local daemon', () => local, { 'X-Tdoc-Agent': 'local/macbook/macbook_claude' }],
  ];
  const AS_B = { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-b` };

  await t('the owner\'s own agents are offered (Raft, webhook, local)', async () => {
    assert(local && hook, JSON.stringify(mine));
  });

  for (const [name, recipientOf, as] of cases) {
    await t(`${name}: Ask only on the owner's own doc is answer only; publish, propose and "applied" are refused until the answer lands`, async () => {
      const slug = await newDoc();
      const c = await comment(slug);
      const sent = await handOff(slug, { ask_only: true, comment_id: c, question: 'Why?', recipient: recipientOf() });
      assert(sent.status === 200 && sent.body.ask && sent.body.ask.ask_id, sent.text);
      assert(!(await handoffsOn(slug)).length, 'Ask only opened an edit hand-off');
      refused(await publish(slug, as), 'publish while asked');
      refused(await propose(slug, as), 'propose_edits while asked');
      refused(await markApplied(slug, c, as), 'applied while asked');
      // Only the agent asked: the owner's own terminal and another agent go on.
      landed(await publish(slug), 'the owner\'s own terminal (names no agent)');
      if (name !== 'Raft') landed(await publish(slug, { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-a` }), 'another of the owner\'s agents');
      else landed(await publish(slug, AS_B), 'another of the owner\'s agents');
      // The browser is never held.
      const browser = await call('/api/doc/versions', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { slug, baseVersion: versionOf(slug), html: `<!doctype html><html><head><title>Plan</title></head><body>${html(versionOf(slug) + 1)}</body></html>` } });
      landed(browser, 'the owner\'s browser save');
      // The answer itself goes, as a reply in the thread; then the hold lifts.
      const ans = await call('/api/agent/ask-reply', { method: 'POST', token: alice.token, headers: as, body: { slug, ask_id: sent.body.ask.ask_id, text: 'Invoices block renewals.', agent_login: 'a', agent_name: 'a' } });
      assert(ans.status === 200 && ans.body.reply_id, ans.text);
      landed(await publish(slug, as), 'publish after the answer');
    });
  }

  await t('the asker cancelling lifts the hold', async () => {
    const slug = await newDoc();
    const c = await comment(slug);
    const sent = await handOff(slug, { ask_only: true, comment_id: c, recipient: agentA });
    assert(sent.status === 200, sent.text);
    const AS_A = { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-a` };
    refused(await publish(slug, AS_A), 'held');
    landed(await call(`/api/docs/${slug}/my-agent/cancel`, { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { ask_id: sent.body.ask.ask_id } }), 'cancel');
    landed(await publish(slug, AS_A), 'after cancel');
  });

  await t('Only me (and Ask AI) to the owner\'s own agent is held the same way', async () => {
    const slug = await newDoc();
    const sent = await handOff(slug, { ask_only: true, only_me: true, question: 'Private?', recipient: agentA });
    assert(sent.status === 200 && sent.body.ask, sent.text);
    const AS_A = { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-a` };
    refused(await publish(slug, AS_A), 'held');
    landed(await publish(slug), 'the owner\'s terminal is not');
    landed(await call('/api/agent/ask-reply', { method: 'POST', token: alice.token, body: { slug, ask_id: sent.body.ask.ask_id, text: 'Yes.' } }), 'answer');
    landed(await publish(slug, AS_A), 'after the answer');
  });

  await t('not the owner: a question to their own agent still holds every token of their account on the doc', async () => {
    const slug = await newDoc();
    const bob = await person('bob');
    await env.META.put(`account-notify:${bob.account_id}`, JSON.stringify([{ ...agentA, server_id: 'server-2' }]));
    const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
    meta.access = { visibility: 'public' };
    env.META.map.set(`meta:${slug}`, JSON.stringify(meta));
    const r = await call('/api/comments', { method: 'POST', cookie: bob.cookie, headers: ORIGIN, body: { slug, version: 1, text: 'Why?', anchor: { kind: 'text', text: 'Sentence one' } } });
    assert(r.status === 200, r.text);
    const sent = await call(`/api/docs/${slug}/hand-off`, { method: 'POST', cookie: bob.cookie, headers: ORIGIN, body: { ask_only: true, comment_id: r.body.id, recipient: { ...agentA, server_id: 'server-2' } } });
    assert(sent.status === 200 && sent.body.ask, sent.text);
    const locks = await (await env.COMMENTS.get(env.COMMENTS.idFromName(slug)).fetch('https://do/answer-locks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op: { kind: 'list' } }) })).json();
    const lock = locks.locks.find((l) => l.ask_id === sent.body.ask.ask_id);
    assert(lock && !lock.agent_only && lock.ids.includes(bob.account_id), JSON.stringify(lock));
  });

  await t('tdoc AI: Ask only answers in the thread, opens no hand-off, suggests nothing; it can never be asked to edit', async () => {
    const slug = await newDoc();
    const c = await comment(slug, 'Why billing first? @tdoc AI');
    const before = modelCalls;
    const r = await handOff(slug, { ask_only: true, comment_id: c, recipient: { tdoc_ai: true } });
    assert(r.status === 200 && r.body.reply && r.body.reply.author.login === 'tdoc-ai', r.text);
    assert(modelCalls === before + 1, 'the model ran once');
    assert(!(await handoffsOn(slug)).length, 'a hand-off was opened');
    const sug = await call(`/api/docs/${slug}/suggestions`, { cookie: alice.cookie });
    assert(!(sug.body && (sug.body.suggestions || []).length), `suggestions: ${sug.text}`);
    const edit = await handOff(slug, { ask_only: false, comment_id: c, recipient: { tdoc_ai: true } });
    assert(edit.status === 400 && edit.body.error === 'edit_needs_an_agent', edit.text);
  });

  await t('control, Ask only off: the edit hand-off, and no answer lock', async () => {
    const slug = await newDoc();
    const c = await comment(slug);
    const sent = await handOff(slug, { ask_only: false, comment_id: c, recipient: agentA });
    assert(sent.status === 200 && sent.body.handoff_id, sent.text);
    landed(await publish(slug, { 'X-Tdoc-Raft-Agent': `${SERVER}/agent-a` }), 'the agent edits');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
