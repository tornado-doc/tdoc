const assert = require('node:assert/strict');
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

(async () => {
  const mod = await loadWorker(), worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const { token } = await issue(worker, env, 'owner');
  const reader = await putSession(env, 'reader');
  const slug = 'reply-activity';
  const call = async (url, options) => {
    const response = await worker.fetch(req(url, options), env, {});
    assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
    return response.json();
  };
  const upload = version => call('/api/upload', { method: 'POST', token,
    body: { slug, version, html: `<h1>Version ${version}</h1><p>Original sentence.</p>` } });
  await upload(2);
  const comment = await call('/api/comments', { method: 'POST', cookie: reader,
    body: { slug, version: 2, text: 'Please revise this.', anchor: { kind: 'text', text: 'Original sentence.' } } });
  const untouched = await call('/api/comments', { method: 'POST', cookie: reader,
    body: { slug, version: 2, text: 'A separate request.', anchor: null } });
  await env.META.put(`handoffs:${slug}`, JSON.stringify([{
    handoff_id: 'h1', at: new Date().toISOString(), comment_ids: [comment.id, untouched.id],
    delivery: { status: 'delivered' },
  }]));
  const reply = await call('/api/agent/reply', { method: 'POST', token,
    body: { slug, parent_id: comment.id, text: 'Updated in v3.', status: 'applied', applied_in: 3 } });
  await upload(3);
  const old = (await call(`/api/comments?slug=${slug}&version=2`)).find(c => c.id === comment.id);
  assert.equal(old.status, 'open', 'v2 must not claim the v3 fix is in its text');
  assert.equal(old.replies.length, 0, 'historical reply text stays version-scoped');
  assert.equal(old.applied_in, undefined);
  assert.equal(old.thread_activity.agent_at, reply.created, 'v2 sees that its agent has replied');
  assert.equal(old.thread_activity.human_at, comment.created);
  assert.equal(old.handoff_status, 'sent', 'activity is separate from handoff bookkeeping');
  const pending = (await call(`/api/comments?slug=${slug}&version=2`)).find(c => c.id === untouched.id);
  assert.equal(pending.thread_activity.agent_at, null, 'one reply cannot complete another thread');
  const latest = (await call(`/api/comments?slug=${slug}&version=3`)).find(c => c.id === comment.id);
  assert.equal(latest.status, 'applied');
  assert.equal(latest.replies[0].text, 'Updated in v3.');
  assert.equal(latest.thread_activity.agent_at, old.thread_activity.agent_at);
  const followup = await call('/api/comments', { method: 'POST', cookie: reader,
    body: { slug, version: 3, parent_id: comment.id, text: 'Please adjust the wording too.' } });
  const olderAgain = (await call(`/api/comments?slug=${slug}&version=2`)).find(c => c.id === comment.id);
  assert.equal(olderAgain.thread_activity.human_at, followup.created);
  assert.equal(olderAgain.replies.length, 0, 'activity never rewrites the historical conversation');
  console.log('PASS reply activity: v3 reply reaches v2 status; historical content and other threads stay independent');
})().catch(error => { console.error(error); process.exitCode = 1; });
