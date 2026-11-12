// The agent pulling a doc's comments is it picking up the handoff: tdoc marks
// open handoffs received, so the card stops saying "waiting on agent" while
// the agent works (Julie, 2026-10-13). Nothing in the skill ever called
// /api/notify/ack, so this was the state forever.
//
// Scoped, not blanket (Julie, 2026-11): a pull marks "On it" only the
// handoffs addressed to THAT agent — the one the request names, or any agent
// on the pulling account when it names none. Before this, any token that
// could edit the doc acked every handoff on it, so one agent's read marked
// another agent's batch received.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const AGENT_A = { provider: 'raft', server_id: 'S1', agent_sub: 'a1', server_slug: 's1', agent_name: 'agent-a' };
const AGENT_B = { provider: 'raft', server_id: 'S1', agent_sub: 'b2', server_slug: 's1', agent_name: 'agent-b' };
const LOCAL_CLAUDE = { provider: 'local', device: 'mbp', cli: 'claude' };
// A normalized local target as stored on a handoff recipient.
const LOCAL_CLAUDE_NORM = { provider: 'local', server_id: 'mbp', agent_sub: 'mbp_claude', device: 'mbp', cli: 'claude', agent_name: 'claude on mbp' };
// Somebody else's agent entirely: on no list this account owns.
const FOREIGN = { provider: 'raft', server_id: 'S9', agent_sub: 'z9', server_slug: 's9', agent_name: 'agent-z' };

function handoff(id, recipient, extra = {}) {
  return {
    handoff_id: id,
    at: new Date(Date.now() - 60000).toISOString(),
    recipient,
    comment_ids: [`c_${id}`],
    delivery: { status: 'delivered', at: new Date(Date.now() - 60000).toISOString() },
    ...extra,
  };
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const owner = await issue(worker, env, 'owner');
  const other = await issue(worker, env, 'other');
  const call = async (path, opts) => { const r = await worker.fetch(req(path, opts), env, {}); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  console.log('pull acks handoffs');
  await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'doc', version: 1, html: '<p>x</p>', meta: { access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] } } } });

  // The agents this account has connected: what a bare account-token pull may
  // ack. AGENT_B is connected too — the claim header is what narrows to one.
  await env.META.put(`account-notify:${owner.account_id}`, JSON.stringify([AGENT_A, AGENT_B, LOCAL_CLAUDE]));
  await env.META.put('handoffs:doc', JSON.stringify([
    handoff('h_a', AGENT_A),
    handoff('h_b', AGENT_B),
    handoff('h_local', LOCAL_CLAUDE_NORM),
    handoff('h_foreign', FOREIGN),
    handoff('h_failed', AGENT_A, { delivery: { status: 'failed', error: 'x' } }),
    handoff('h_done', AGENT_A, { acked_at: '2026-01-01T00:00:00.000Z' }),
  ]));
  const list = async () => JSON.parse(await env.META.get('handoffs:doc'));
  const acked = async (id) => (await list()).find((h) => h.handoff_id === id).acked_at || null;

  await t('someone else reading the comments does not mark anything received', async () => {
    const r = await call('/api/comments?slug=doc&version=all', { token: other.token });
    assert(r.status === 200, `read ${r.status}`);
    assert(!(await acked('h_a')), 'a non-writer acked the handoff');
  });

  await t('a bare account-token pull acks only handoffs to its own agents', async () => {
    const r = await call('/api/comments?slug=doc&version=all', { token: owner.token });
    assert(r.status === 200, `read ${r.status}`);
    assert(await acked('h_a'), 'handoff to a connected agent not acked');
    assert(await acked('h_b'), 'second connected agent not acked');
    assert(await acked('h_local'), 'local agent handoff not acked');
    assert(!(await acked('h_foreign')), 'a handoff to somebody else\'s agent was acked');
    assert(!(await acked('h_failed')), 'a failed delivery was marked received');
    assert((await acked('h_done')) === '2026-01-01T00:00:00.000Z', 'first ack was overwritten');
  });

  await t('a pull naming one agent acks only that agent\'s handoffs', async () => {
    await env.META.put('handoffs:doc', JSON.stringify([
      handoff('h_a2', AGENT_A),
      handoff('h_b2', AGENT_B),
      handoff('h_l2', LOCAL_CLAUDE_NORM),
    ]));
    const r = await call('/api/comments?slug=doc&version=all', {
      token: owner.token, headers: { 'X-Tdoc-Raft-Agent': 'S1/a1' },
    });
    assert(r.status === 200, `read ${r.status}`);
    assert(await acked('h_a2'), 'the named agent\'s handoff not acked');
    assert(!(await acked('h_b2')), 'another agent\'s handoff was acked by a pull that named agent-a');
    assert(!(await acked('h_l2')), 'the local agent\'s handoff was acked by a raft pull');
  });

  await t('the local daemon\'s claim narrows to its own cli', async () => {
    await env.META.put('handoffs:doc', JSON.stringify([
      handoff('h_a3', AGENT_A),
      handoff('h_l3', LOCAL_CLAUDE_NORM),
    ]));
    const r = await call('/api/comments?slug=doc&version=all', {
      token: owner.token, headers: { 'X-Tdoc-Agent': 'local/mbp/mbp_claude' },
    });
    assert(r.status === 200, `read ${r.status}`);
    assert(await acked('h_l3'), 'the daemon\'s own handoff not acked');
    assert(!(await acked('h_a3')), 'a raft handoff was acked by the local pull');
  });

  await t('an explicit ack on somebody else\'s handoff is refused', async () => {
    await env.META.put('handoffs:doc', JSON.stringify([handoff('h_f', FOREIGN)]));
    const r = await call('/api/notify/ack', {
      method: 'POST', token: owner.token, body: { slug: 'doc', handoff_id: 'h_f' },
    });
    assert(r.status === 403, `ack ${r.status}: ${JSON.stringify(r.body)}`);
    assert(!(await acked('h_f')), 'foreign handoff acked anyway');
  });

  await t('an explicit ack on the account\'s own handoff still works', async () => {
    await env.META.put('handoffs:doc', JSON.stringify([handoff('h_ok', AGENT_B)]));
    const r = await call('/api/notify/ack', {
      method: 'POST', token: owner.token, body: { slug: 'doc', handoff_id: 'h_ok' },
    });
    assert(r.status === 200 && r.body.ok, `ack ${r.status}: ${JSON.stringify(r.body)}`);
    assert(await acked('h_ok'), 'own handoff not acked');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
