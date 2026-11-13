// A handoff's clock is a story, not a single stamp: when it was SENT (the
// press, before the provider call), when it was first DELIVERED (kept across
// resends), when the agent said it was ON IT, when the first agent REPLY
// landed, and when the agent first PUBLISHED a version. Before this the
// record had only `at` (after the send) and `delivery.at` (overwritten by
// every resend), and the card could not say any of the rest.

const { loadWorker, makeEnv, req, issue, putSession } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const LOCAL_CLAUDE = { provider: 'local', device: 'mbp', cli: 'claude' };
const LOCAL_CLAUDE_NORM = { provider: 'local', server_id: 'mbp', agent_sub: 'mbp_claude', device: 'mbp', cli: 'claude', agent_name: 'claude on mbp' };
const AGENT_B = { provider: 'raft', server_id: 'S1', agent_sub: 'b2', server_slug: 's1', agent_name: 'agent-b' };

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const owner = await issue(worker, env, 'owner');
  const call = async (path, opts) => { const r = await worker.fetch(req(path, opts), env, {}); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  console.log('handoff timestamps');

  const up = await call('/api/upload', {
    method: 'POST', token: owner.token,
    body: { slug: 'doc', version: 1, html: '<h1>d</h1><p>a sentence to comment on</p>' },
  });
  assert(up.status === 200, `upload ${up.status}`);
  await env.META.put(`account-notify:${owner.account_id}`, JSON.stringify([LOCAL_CLAUDE, AGENT_B]));
  const reader = await putSession(env, 'reader');
  env.__commentReaderCookie = reader;
  const mkComment = async (text) => {
    const c = await call('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug: 'doc', version: 1, text, anchor: { kind: 'text', text: 'a sentence' } },
    });
    assert(c.status === 200, `comment ${c.status}`);
    return c.body.id;
  };
  const commentId = await mkComment('fix this');
  // A second thread handed to a different agent, created before any reply so
  // the last-word gate does not skip it.
  const commentId2 = await mkComment('also this one');

  const send = (comment_id, recipient) => call('/api/notify/handoff', {
    method: 'POST', token: owner.token,
    body: { slug: 'doc', comment_ids: [comment_id], recipient, instruction: 'fix it' },
  });
  const records = async () => JSON.parse(await env.META.get('handoffs:doc') || '[]');
  const byId = async (id) => (await records()).find((h) => h.handoff_id === id);

  let handoffId = null;
  let otherHandoffId = null;

  await t('sending stamps the press time and the first delivery time', async () => {
    const r = await send(commentId, LOCAL_CLAUDE);
    assert(r.status === 200 && r.body.ok, `handoff ${r.status}: ${JSON.stringify(r.body)}`);
    handoffId = r.body.handoff_id;
    const h = await byId(handoffId);
    assert(h.at, 'no send time recorded');
    assert(h.delivery && h.delivery.status === 'queued', `delivery: ${JSON.stringify(h.delivery)}`);
    assert(h.delivery.first_at, 'no first-delivery time recorded');
    assert(h.delivery.at, 'no delivery time recorded');
    assert(h.at <= h.delivery.at, `send ${h.at} is after delivery ${h.delivery.at}`);
    const r2 = await send(commentId2, AGENT_B);
    assert(r2.status === 200 && r2.body.ok, `handoff2 ${r2.status}: ${JSON.stringify(r2.body)}`);
    otherHandoffId = r2.body.handoff_id;
  });

  await t('resending keeps the first delivery time and the original send time', async () => {
    const aged = {
      ...(await byId(handoffId)),
      at: '2026-01-01T00:00:00.000Z',
      delivery: { status: 'queued', at: '2026-01-01T00:00:01.000Z', first_at: '2026-01-01T00:00:00.500Z' },
    };
    await env.META.put('handoffs:doc', JSON.stringify([
      aged,
      ...(await records()).filter((h) => h.handoff_id !== handoffId),
    ]));
    const r = await call('/api/notify/handoff/resend', {
      method: 'POST', token: owner.token, body: { slug: 'doc', handoff_id: handoffId },
    });
    assert(r.status === 200 && r.body.ok, `resend ${r.status}: ${JSON.stringify(r.body)}`);
    const h = await byId(handoffId);
    assert(h.at === '2026-01-01T00:00:00.000Z', `send time moved: ${h.at}`);
    assert(h.delivery.first_at === '2026-01-01T00:00:00.500Z', `first delivery moved: ${JSON.stringify(h.delivery)}`);
    assert(h.delivery.at !== '2026-01-01T00:00:01.000Z', 'resend did not update the last-attempt time');
  });

  await t('the first agent reply is stamped on the handoff, once', async () => {
    const r1 = await call('/api/agent/reply', {
      method: 'POST', token: owner.token,
      body: { slug: 'doc', parent_id: commentId, text: 'On it, fixing.', status: 'partial' },
    });
    assert(r1.status === 200, `reply ${r1.status}: ${JSON.stringify(r1.body)}`);
    const h1 = await byId(handoffId);
    assert(h1.first_reply_at, 'first reply not recorded on the handoff');
    const stamped = h1.first_reply_at;
    // A person speaks, the agent answers again: the stamp keeps the FIRST.
    await call('/api/comments', {
      method: 'POST', cookie: reader,
      body: { slug: 'doc', version: 1, parent_id: commentId, text: 'also the title' },
    });
    const r2 = await call('/api/agent/reply', {
      method: 'POST', token: owner.token,
      body: { slug: 'doc', parent_id: commentId, text: 'Title too.', status: 'answered' },
    });
    assert(r2.status === 200, `reply2 ${r2.status}: ${JSON.stringify(r2.body)}`);
    const h2 = await byId(handoffId);
    assert(h2.first_reply_at === stamped, `first reply moved: ${stamped} -> ${h2.first_reply_at}`);
  });

  await t('publishing a version stamps only the handoff addressed to that agent', async () => {
    const up2 = await call('/api/upload', {
      method: 'POST', token: owner.token,
      headers: { 'X-Tdoc-Agent': 'local/mbp/mbp_claude' },
      body: { slug: 'doc', version: 2, html: '<h1>d2</h1><p>a sentence to comment on, edited</p>' },
    });
    assert(up2.status === 200, `upload2 ${up2.status}: ${JSON.stringify(up2.body)}`);
    const mine = await byId(handoffId);
    assert(mine.first_version_at, 'publish not recorded on the addressed handoff');
    const other = await byId(otherHandoffId);
    assert(!other.first_version_at, 'another agent\'s handoff was stamped by this publish');
    // And once: a third version does not move it.
    const stamped = mine.first_version_at;
    await call('/api/upload', {
      method: 'POST', token: owner.token,
      headers: { 'X-Tdoc-Agent': 'local/mbp/mbp_claude' },
      body: { slug: 'doc', version: 3, html: '<h1>d3</h1><p>a sentence to comment on, edited again</p>' },
    });
    assert((await byId(handoffId)).first_version_at === stamped, 'first publish moved');
  });

  await t('an unattributed publish stamps nothing', async () => {
    await env.META.put('handoffs:doc', JSON.stringify([
      ...(await records()),
      { handoff_id: 'h_open3', at: new Date().toISOString(), recipient: LOCAL_CLAUDE_NORM, comment_ids: ['cx'], delivery: { status: 'queued', at: new Date().toISOString() } },
    ]));
    const up3 = await call('/api/upload', {
      method: 'POST', token: owner.token,
      body: { slug: 'doc', version: 4, html: '<h1>d4</h1><p>more edits</p>' },
    });
    assert(up3.status === 200, `upload3 ${up3.status}`);
    const h = await byId('h_open3');
    assert(!h.first_version_at, 'a publish nobody could be named for was stamped on the handoff');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
