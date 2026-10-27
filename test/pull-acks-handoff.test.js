// The agent pulling a doc's comments is it picking up the handoff: tdoc marks
// open handoffs received, so the card stops saying "waiting on agent" while
// the agent works (Julie, 2026-10-13). Nothing in the skill ever called
// /api/notify/ack, so this was the state forever.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const owner = await issue(worker, env, 'owner');
  const other = await issue(worker, env, 'other');
  const call = async (path, opts) => { const r = await worker.fetch(req(path, opts), env, {}); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  console.log('pull acks handoffs');
  await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'doc', version: 1, html: '<p>x</p>', meta: { access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] } } } });
  const at = new Date(Date.now() - 60000).toISOString();
  await env.META.put('handoffs:doc', JSON.stringify([
    { handoff_id: 'h_open', at, comment_ids: ['c1'], delivery: { status: 'delivered' } },
    { handoff_id: 'h_failed', at, comment_ids: ['c2'], delivery: { status: 'failed', error: 'x' } },
    { handoff_id: 'h_done', at, comment_ids: ['c3'], delivery: { status: 'delivered' }, acked_at: '2026-01-01T00:00:00.000Z' },
  ]));
  const list = async () => JSON.parse(await env.META.get('handoffs:doc'));

  await t('someone else reading the comments does not mark anything received', async () => {
    const r = await call('/api/comments?slug=doc&version=all', { token: other.token });
    assert(r.status === 200, `read ${r.status}`);
    assert(!(await list()).find((h) => h.handoff_id === 'h_open').acked_at, 'a non-writer acked the handoff');
  });

  await t('the doc owner agent pulling the comments marks open handoffs received', async () => {
    const r = await call('/api/comments?slug=doc&version=all', { token: owner.token });
    assert(r.status === 200, `read ${r.status}`);
    const hs = await list();
    assert(hs.find((h) => h.handoff_id === 'h_open').acked_at, 'open handoff not acked');
    assert(!hs.find((h) => h.handoff_id === 'h_failed').acked_at, 'a failed delivery was marked received');
    assert(hs.find((h) => h.handoff_id === 'h_done').acked_at === '2026-01-01T00:00:00.000Z', 'first ack was overwritten');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
