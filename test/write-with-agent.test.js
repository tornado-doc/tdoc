// New › Write with your agent (flag writeWithAgent): one sentence becomes a
// private placeholder doc, the sentence its owner's comment, and that comment
// is handed to one of the owner's own push agents through Send to agent.
//   - GET /api/write-with-agent/agents lists only the caller's push agents
//     (Raft, webhook, local), without anything removed or a webhook address;
//   - POST refuses: no session, a token, another origin, an empty or too long
//     sentence, an agent that is not the caller's (another account's, or one
//     made up), and more than WRITE_WITH_AGENT_PER_HOUR an hour;
//   - the doc is private and the caller's, its v1 is escaped scaffolding, and
//     the handoff names the picked agent and carries the sentence.
// Run with: node test/write-with-agent.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ORIGIN = { Origin: 'https://tdoc.dev' };
const LOCAL = { provider: 'local', device: 'mbp', cli: 'claude' };
const LOCAL_PICK = { provider: 'local', server_id: 'mbp', agent_sub: 'mbp_claude' };
const OTHERS = { provider: 'local', device: 'evilbox', cli: 'codex' };

(async () => {
  console.log('write with your agent');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, o = {}) => { const r = await worker.fetch(req(p, o), env, {}); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const julie = await issue(worker, env, 'julie');
  const mallory = await issue(worker, env, 'mallory');
  await env.META.put(`account-notify:${julie.account_id}`, JSON.stringify([LOCAL]));
  await env.META.put(`account-notify:${mallory.account_id}`, JSON.stringify([OTHERS]));
  const write = (body, { cookie = julie.cookie, headers = ORIGIN, token } = {}) => call('/api/write-with-agent', { method: 'POST', cookie, token, headers, body });

  await t('lists only the caller\'s own push agents', async () => {
    const r = await call('/api/write-with-agent/agents', { cookie: julie.cookie });
    assert(r.status === 200, `${r.status}`);
    assert(r.body.agents.length === 1 && r.body.agents[0].provider === 'local' && r.body.agents[0].agent_sub === 'mbp_claude', JSON.stringify(r.body));
    assert((await call('/api/write-with-agent/agents', {})).status === 401, 'signed out');
  });

  let made = null;
  await t('one sentence: a private placeholder doc, the request comment, sent to the picked agent', async () => {
    const r = await write({ prompt: '  A packing list for <b>Iceland</b> in March  ', kind: 'doc', recipient: LOCAL_PICK });
    assert(r.status === 200 && r.body.ok && r.body.sent, `${r.status} ${JSON.stringify(r.body)}`);
    made = r.body;
    const meta = JSON.parse(await env.META.get(`doc:${made.slug}`) || 'null')
      || JSON.parse(await env.META.get(`meta:${made.slug}`) || 'null');
    const html = await (await env.DOCS.get(`docs/${made.slug}/v1/index.html`)).text();
    assert(html.includes('&lt;b&gt;Iceland&lt;/b&gt;') && !html.includes('<b>Iceland'), 'the sentence is not escaped in v1');
    assert(html.includes('Your agent is writing this doc.'), 'no anchor line');
    assert(meta && meta.access && meta.access.visibility === 'private', `not private: ${JSON.stringify(meta && meta.access)}`);
    const handoffs = JSON.parse(await env.META.get(`handoffs:${made.slug}`) || '[]');
    assert(handoffs.length === 1, `handoffs ${handoffs.length}`);
    const h = handoffs[0];
    assert(h.recipient && h.recipient.provider === 'local' && h.recipient.agent_sub === 'mbp_claude', JSON.stringify(h.recipient));
    assert(h.comment_ids[0] === made.comment_id, 'handoff not on the request comment');
    assert(/Iceland/.test(h.instruction) && new RegExp(made.slug).test(h.instruction), h.instruction);
    const comments = await call(`/api/comments?slug=${made.slug}&version=all`, { cookie: julie.cookie });
    const c = comments.body.find((x) => x.id === made.comment_id);
    assert(c && c.text === 'A packing list for <b>Iceland</b> in March' && c.handoff_status !== 'note', JSON.stringify(c));
  });

  await t('the doc is not readable by another account', async () => {
    const r = await call(`/api/comments?slug=${made.slug}&version=all`, { cookie: mallory.cookie });
    assert(r.status === 403 || r.status === 404 || r.status === 401, `${r.status}`);
  });

  await t('refuses an agent that is not the caller\'s', async () => {
    const r = await write({ prompt: 'x', recipient: { provider: 'local', server_id: 'evilbox', agent_sub: 'evilbox_codex' } });
    assert(r.status === 403 && r.body.error === 'agent_not_yours', `${r.status} ${JSON.stringify(r.body)}`);
    const made2 = await write({ prompt: 'x', recipient: { provider: 'raft', server_id: 'S9', agent_sub: 'zz', agent_name: 'zz' } });
    assert(made2.status === 403, `made-up raft ${made2.status}`);
    const hook = await write({ prompt: 'x', recipient: { provider: 'webhook', agent_sub: 'wh_0123456789abcdef', url: 'https://evil.example/in' } });
    assert(hook.status === 403, `made-up webhook ${hook.status}`);
  });

  await t('refuses no session, a token, another origin', async () => {
    assert((await write({ prompt: 'x', recipient: LOCAL_PICK }, { cookie: null })).status === 401, 'no session');
    assert((await write({ prompt: 'x', recipient: LOCAL_PICK }, { cookie: null, token: julie.token })).status === 401, 'token');
    assert((await write({ prompt: 'x', recipient: LOCAL_PICK }, { headers: { Origin: 'https://evil.example' } })).status === 403, 'origin');
  });

  await t('refuses an empty or too long sentence, or no agent', async () => {
    assert((await write({ prompt: ' ​ ', recipient: LOCAL_PICK })).status === 400, 'empty');
    const long = await write({ prompt: 'x'.repeat(501), recipient: LOCAL_PICK });
    assert(long.status === 400 && long.body.error === 'prompt_too_long', `${long.status}`);
    assert((await write({ prompt: 'x' })).status === 400, 'no recipient');
  });

  await t('rate-limited per account', async () => {
    let last = null;
    for (let i = 0; i < 12; i++) {
      last = await write({ prompt: `doc ${i}`, recipient: LOCAL_PICK });
      if (last.status === 429) break;
    }
    assert(last.status === 429 && last.body.error === 'rate_limited', `${last.status} ${JSON.stringify(last.body)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
