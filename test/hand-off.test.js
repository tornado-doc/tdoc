// One door from the comment composer: POST /api/docs/<slug>/hand-off, whose
// Ask only box decides edit or answer (Julie, 2026-10-24).
//   edit      authorship decides: the owner to their own agent; members to
//             the team agent only on a doc the team agent wrote; nobody on a
//             doc somebody else's personal agent wrote
//   ask only  an answer, never an edit: the commenter's own agent, the doc's
//             team agent for a member (no tdoc AI quota spent), or tdoc AI
//             (anyone, within their free answers). Never somebody else's
//             personal agent.
//             only_me keeps it private; Make public posts it later.
// Run with: node test/hand-off.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
const MODEL = 'https://model.invalid/v1';

(async () => {
  console.log('hand-off: edit or ask only');
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    modelCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'tdoc AI says: billing first.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  const call = async (path, opts) => {
    const r = await worker.fetch(req(path, opts), env, {});
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const origin = { Origin: 'https://tdoc.dev' };
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const carl = await issue(worker, env, 'carl');
  for (const who of [bob, carl]) await env.META.delete(`account-terminal:${who.account_id}`);
  const html = (slug, v) => `<h1>${slug}</h1><p>${slug} v${v}: a sentence to comment on</p>`;
  const upload = (token, slug, version) => call('/api/upload', { method: 'POST', token, body: { slug, version, html: html(slug, version), meta: { title: slug } } });
  const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name: 'Acme' } })).body.team;
  await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  for (const slug of ['agent-doc', 'julies-doc']) {
    await upload(julie.token, slug, 1);
    await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: [slug] } });
  }
  await upload(julie.token, 'personal', 1);
  const added = (await call('/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: team.id, name: 'acme-bot' } })).body;
  const agentToken = (await call('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'acme-box' } })).body.token;
  await call('/api/notify/local/register', { method: 'POST', token: agentToken, body: { device: 'acme-box', clis: ['claude'] } });
  assert((await upload(agentToken, 'agent-doc', 2)).status === 200, 'the team agent writes agent-doc');
  await call('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'juliesmac', clis: ['claude'] } });

  const comment = async (who, slug, text) => (await call('/api/comments', { method: 'POST', cookie: who.cookie, headers: origin, body: { slug, version: 1, text, anchor: { kind: 'text', text: 'a sentence' } } })).body.id;
  const handOff = (who, slug, body, headers = origin) => call(`/api/docs/${slug}/hand-off`, { method: 'POST', cookie: who.cookie, headers, body });
  const mine = async (who, slug) => (await call(`/api/docs/${slug}/my-agent`, { cookie: who.cookie })).body;
  const teamTarget = (await mine(bob, 'agent-doc')).team_agents[0];

  await t('a member sees the team agent to ask on the team\'s docs; tdoc AI is offered to everyone', async () => {
    assert(teamTarget && teamTarget.team_agent.name === 'acme-bot', JSON.stringify(teamTarget));
    const onTeamDoc = await mine(bob, 'julies-doc');
    assert(onTeamDoc.team_agents.length === 1 && onTeamDoc.tdoc_ai === true, JSON.stringify(onTeamDoc));
    const reader = await mine(carl, 'personal');
    assert(reader.team_agents.length === 0 && reader.tdoc_ai === true, JSON.stringify(reader));
  });

  await t('edit: a member hands a comment to the team agent on the doc it wrote, not on one Julie\'s agent wrote', async () => {
    const c1 = await comment(bob, 'agent-doc', 'add last week');
    const ok = await handOff(bob, 'agent-doc', { ask_only: false, comment_id: c1, recipient: teamTarget });
    assert(ok.status === 200 && ok.body.handoff_id, ok.text);
    const c2 = await comment(bob, 'julies-doc', 'add last week');
    const no = await handOff(bob, 'julies-doc', { ask_only: false, comment_id: c2, recipient: teamTarget });
    assert(no.status === 403 && no.body.error === 'written_by_other', no.text);
    const ai = await handOff(bob, 'agent-doc', { ask_only: false, comment_id: c1, recipient: { tdoc_ai: true } });
    assert(ai.status === 400, `tdoc AI as an editor: ${ai.status}`);
  });

  let askId = null;
  await t('ask only: a member asks the team agent on Julie\'s doc; it answers in the thread, signed by it; no tdoc AI spent', async () => {
    const before = modelCalls;
    const c = await comment(bob, 'julies-doc', 'why billing first?');
    const r = await handOff(bob, 'julies-doc', { ask_only: true, comment_id: c, question: 'why billing first?', recipient: teamTarget });
    assert(r.status === 200 && r.body.ask && r.body.ask.team_agent, r.text);
    askId = r.body.ask.ask_id;
    const pending = (await call('/api/notify/local/pending?device=acme-box', { token: agentToken })).body.pending;
    const job = pending.find((p) => p.ask_id === askId);
    assert(job && job.kind === 'ask' && job.comment_id === c, JSON.stringify(pending));
    // Bob's own (and Julie's) daemons never see it.
    assert(!(await call('/api/notify/local/pending?device=juliesmac', { token: julie.token })).text.includes(askId), "julie's daemon would run it");
    // Somebody else's token finds nothing to answer.
    assert((await call('/api/agent/ask-reply', { method: 'POST', token: julie.token, body: { slug: 'julies-doc', ask_id: askId, text: 'x' } })).status === 404, 'julie answered the team agent question');
    const ack = await call('/api/agent/ask-ack', { method: 'POST', token: agentToken, body: { slug: 'julies-doc', ask_id: askId } });
    assert(ack.status === 200, ack.text);
    const ans = await call('/api/agent/ask-reply', { method: 'POST', token: agentToken, body: { slug: 'julies-doc', ask_id: askId, text: 'TEAM-ANSWER', agent_login: 'claude' } });
    assert(ans.status === 200 && ans.body.reply_id, ans.text);
    const list = (await call('/api/comments?slug=julies-doc&version=1', { cookie: julie.cookie })).body;
    const reply = (list.find((x) => x.id === c).replies || []).find((x) => x.id === ans.body.reply_id);
    assert(reply && reply.author.team_agent && reply.author.name === 'acme-bot' && /team agent/.test(reply.author.owner.display), JSON.stringify(reply && reply.author));
    assert(modelCalls === before, 'tdoc AI ran');
    assert(!(await call('/api/notify/local/pending?device=acme-box', { token: agentToken })).body.pending.some((p) => p.ask_id === askId), 'still queued');
    // The answer run edits nothing: the doc is still Julie's v1.
    const meta = JSON.parse(env.META.map.get('meta:julies-doc'));
    assert(meta.versions.length === 1, 'an answer published a version');
  });

  await t("ask only never reaches somebody else's personal agent", async () => {
    const julies = (await mine(julie, 'julies-doc')).agents[0];
    const c = await comment(bob, 'julies-doc', 'q');
    const r = await handOff(bob, 'julies-doc', { ask_only: true, comment_id: c, question: 'q', recipient: julies });
    assert(r.status === 403 && r.body.error === 'not_your_agent', r.text);
    const outsider = await handOff(carl, 'personal', { ask_only: true, only_me: true, question: 'q', recipient: teamTarget });
    assert(outsider.status === 403 || outsider.status === 401, `a non-member asked the team agent: ${outsider.status}`);
  });

  await t('tdoc AI answers anyone within their free answers, even beside a team agent', async () => {
    const c = await comment(bob, 'julies-doc', 'q2');
    const r = await handOff(bob, 'julies-doc', { ask_only: true, comment_id: c, question: 'q2', recipient: { tdoc_ai: true } });
    assert(r.status === 200 && r.body.reply && r.body.reply.author.name === 'tdoc AI', r.text);
    const priv = await handOff(carl, 'personal', { ask_only: true, only_me: true, question: 'why?', passage: { text: 'a sentence' }, recipient: { tdoc_ai: true } });
    assert(priv.status === 200 && priv.body.ask_id && priv.body.answer, priv.text);
  });

  await t('only me with the team agent: private until Make public, then signed by the team agent', async () => {
    const r = await handOff(bob, 'julies-doc', { ask_only: true, only_me: true, question: 'private?', recipient: teamTarget });
    assert(r.status === 200 && !r.body.ask.comment_id, r.text);
    await call('/api/agent/ask-reply', { method: 'POST', token: agentToken, body: { slug: 'julies-doc', ask_id: r.body.ask.ask_id, text: 'PRIVATE-TEAM' } });
    assert(!(await call('/api/comments?slug=julies-doc&version=1', { cookie: julie.cookie })).text.includes('PRIVATE-TEAM'), 'public before Make public');
    const c = await comment(bob, 'julies-doc', 'private?');
    const pub = await call('/api/docs/julies-doc/my-agent/publish', { method: 'POST', cookie: bob.cookie, headers: origin, body: { ask_id: r.body.ask.ask_id, comment_id: c } });
    assert(pub.status === 200 && pub.body.reply.author.team_agent && pub.body.reply.text === 'PRIVATE-TEAM', pub.text);
  });

  await t('the door needs our Origin and a comment unless only me', async () => {
    assert((await handOff(bob, 'julies-doc', { ask_only: true, question: 'q', recipient: teamTarget }, {})).status === 403, 'no Origin');
    assert((await handOff(bob, 'julies-doc', { ask_only: true, question: 'q', recipient: teamTarget })).status === 400, 'no comment_id');
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
