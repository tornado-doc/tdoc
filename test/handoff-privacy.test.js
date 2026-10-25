// Handoff metadata belongs to a comment's author and the document owner.
// Exercise the public comments API and both team handoff APIs directly.
const assert = require('node:assert/strict');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (path, options = {}) => {
    const response = await worker.fetch(req(path, options), env, {});
    return { status: response.status, body: await response.json() };
  };
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const carol = await issue(worker, env, 'carol');
  const teamResponse = await call('/api/teams', {
    method: 'POST', cookie: julie.cookie, headers: { Origin: 'https://tdoc.dev' },
    body: { name: 'Privacy team', invites: ['bob', 'carol'] },
  });
  assert.equal(teamResponse.status, 200);
  const team = teamResponse.body.team;
  const joinCode = team.invite_url.split('/').pop();
  for (const person of [bob, carol]) {
    assert.equal((await call('/api/team/join', { method: 'POST', cookie: person.cookie, body: { token: joinCode } })).status, 200);
  }
  assert.equal((await call('/api/upload', {
    method: 'POST', token: julie.token,
    body: { slug: 'handoff-private-details', version: 1, html: '<h1>Shared report</h1>', meta: { title: 'Shared report', access: { visibility: 'public' } } },
  })).status, 200);
  assert.equal((await call('/api/team/move', {
    method: 'POST', token: julie.token, body: { team: team.id, slugs: ['handoff-private-details'] },
  })).status, 200);
  const comment = async (person, text) => {
    const response = await call('/api/comments', {
      method: 'POST', cookie: person.cookie,
      body: { slug: 'handoff-private-details', version: 1, text, anchor: { kind: 'text', text: 'Shared report' } },
    });
    assert.equal(response.status, 200);
    return response.body.id;
  };
  const bobId = await comment(bob, 'Bob asks for a chart');
  const carolId = await comment(carol, 'Carol asks for a table');
  const agentId = 'ta_1234567890abcdef';
  const agentToken = 'tdoc-team-agent-privacy-token';
  const agentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(agentToken))))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const storedTeam = JSON.parse(await env.META.get(`team:${team.id}`));
  storedTeam.agents = [{ id: agentId, name: 'team agent', token_hash: agentHash }];
  await env.META.put(`team:${team.id}`, JSON.stringify(storedTeam));
  await env.META.put(`hosted-token:${agentHash}`, JSON.stringify({ account_id: agentId, team_agent: { id: agentId, team: team.id } }));
  await env.META.put('handoffs:handoff-private-details', JSON.stringify([{
    handoff_id: 'h_private', at: new Date().toISOString(),
    recipient: { provider: 'raft', agent_name: 'team agent', server_id: 'secret-server' },
    comment_ids: [bobId, carolId], instruction: 'Private instruction about both comments',
    delivery: { status: 'delivered', at: new Date().toISOString() },
    resolved_ids: [carolId], by: agentId, sent_by: julie.account_id,
    team_agent: { id: agentId, name: 'team agent' },
  }]));
  const fields = ['handoff_status', 'handoff_id', 'handoff_at', 'handoff_acked_at', 'handoff_delivery', 'handoff_to'];
  const comments = (opts = {}, version = '1') => call(`/api/comments?slug=handoff-private-details&version=${version}`, opts);
  for (const version of ['1', 'all']) {
    for (const opts of [{}, { cookie: bob.cookie }, { cookie: carol.cookie }, { cookie: julie.cookie }]) {
      const result = await comments(opts, version);
      assert.equal(result.status, 200);
      const viewer = opts.cookie === bob.cookie ? 'bob' : opts.cookie === carol.cookie ? 'carol' : opts.cookie === julie.cookie ? 'julie' : 'anonymous';
      for (const row of result.body) {
        const allowed = viewer === 'julie' || (viewer === 'bob' && row.id === bobId) || (viewer === 'carol' && row.id === carolId);
        for (const field of fields) assert.equal(Object.hasOwn(row, field), allowed, `${viewer} ${version} ${row.id} ${field}`);
      }
    }
  }
  console.log('  ✓ comments API hides all handoff fields from other readers at current and all versions');
  for (const visibility of ['public', 'unlisted']) {
    const meta = JSON.parse(await env.META.get('meta:handoff-private-details'));
    meta.access.visibility = visibility;
    await env.META.put('meta:handoff-private-details', JSON.stringify(meta));
    for (const [token, allowedIds] of [[bob.token, [bobId]], [carol.token, [carolId]], [julie.token, [bobId, carolId]], [agentToken, [bobId, carolId]]]) {
      const result = await comments({ token });
      assert.equal(result.status, 200, `${visibility} token read`);
      for (const row of result.body) {
        assert.equal(Object.hasOwn(row, 'handoff_to'), allowedIds.includes(row.id), `${visibility} token ${row.id}`);
      }
    }
  }
  console.log('  ✓ bearer tokens keep their own or assigned handoff details on public and link-visible docs');

  const bobVisible = (await comments({ cookie: bob.cookie })).body.find((row) => row.id === bobId);
  assert.equal(bobVisible.handoff_resend_allowed, false, 'mixed batch cannot be resent by one member');

  const handoffs = (person) => call('/api/notify/handoffs?slug=handoff-private-details', { cookie: person.cookie });
  const adminList = await handoffs(julie);
  assert.equal(adminList.status, 200);
  assert.deepEqual(adminList.body.handoffs[0].comment_ids, [bobId, carolId]);
  for (const [person, ownId, otherId] of [[bob, bobId, carolId], [carol, carolId, bobId]]) {
    const result = await handoffs(person);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.handoffs[0].comment_ids, [ownId]);
    assert(!JSON.stringify(result.body).includes(otherId));
    assert.equal(result.body.handoffs[0].instruction, '');
    assert(!Object.hasOwn(result.body.handoffs[0], 'by'));
    assert(!Object.hasOwn(result.body.handoffs[0], 'sent_by'));
  }
  console.log('  ✓ handoffs API scopes a mixed batch to each team member’s own comments');

  const foreign = await call('/api/notify/handoff', {
    method: 'POST', cookie: bob.cookie,
    body: { slug: 'handoff-private-details', comment_ids: [bobId, carolId], instruction: 'send both' },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error, 'comment_not_owned');
  assert.equal(JSON.parse(await env.META.get('handoffs:handoff-private-details')).length, 1);
  console.log('  ✓ handoff POST rejects a direct mixed-ID request from a team member');

  const resend = await call('/api/notify/handoff/resend', {
    method: 'POST', cookie: bob.cookie,
    body: { slug: 'handoff-private-details', handoff_id: 'h_private' },
  });
  assert.equal(resend.status, 403);
  assert.equal(resend.body.error, 'comment_not_owned');
  console.log('  ✓ team member cannot resend a mixed batch containing another commenter’s request');

  const prior = JSON.parse(await env.META.get('handoffs:handoff-private-details'));
  await env.META.put('handoffs:handoff-private-details', JSON.stringify([{
    ...prior[0], handoff_id: 'h_bob', comment_ids: [bobId], instruction: 'Bob’s own instruction', resolved_ids: [],
  }, ...prior]));
  const ownBatch = await handoffs(bob);
  assert.equal(ownBatch.body.handoffs[0].instruction, 'Bob’s own instruction');
  assert.equal((await comments({ cookie: bob.cookie })).body.find((row) => row.id === bobId).handoff_resend_allowed, true);
  console.log('  ✓ own-comment batch keeps its instruction and allows resend');

  const unrelatedId = await comment(julie, 'An unrelated agent request');
  await env.META.put('handoffs:handoff-private-details', JSON.stringify([{
    ...prior[0], handoff_id: 'h_other_agent', comment_ids: [unrelatedId], by: 'ta_other_agent',
  }, ...JSON.parse(await env.META.get('handoffs:handoff-private-details'))]));
  const unrelated = (await comments({ token: agentToken })).body.find((row) => row.id === unrelatedId);
  assert.equal(Object.hasOwn(unrelated, 'handoff_to'), false);
  console.log('  ✓ team agent sees only handoffs assigned to its account');
})().catch((error) => { console.error(error); process.exitCode = 1; });
