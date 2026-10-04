const assert = require('node:assert/strict');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

(async () => {
  const mod = await loadWorker(), worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  const key = `account-onboarding:${alice.account_id}`;
  const original = { started: 'yesterday', agent_connected: 'yesterday', first_doc: 'real-doc', revised: 'today' };
  await env.META.put(key, JSON.stringify(original));
  const set = (body, cookie = alice.cookie, headers = {}) => worker.fetch(req('/api/onboarding/step', {
    method: 'PUT', cookie, headers, body,
  }), env, {});
  const read = async cookie => (await (await worker.fetch(req('/api/onboarding', { cookie }), env, {})).json()).record;
  for (const step of ['connect', 'create', 'comment', 'revise', 'notify']) {
    assert.equal((await set({ step, done: true })).status, 200);
  }
  let record = await read(alice.cookie);
  assert.equal(Object.keys(record.manual_steps).length, 5);
  for (const [key, value] of Object.entries(original)) assert.equal(record[key], value);
  assert.equal(record.notify_connected, undefined, 'manual Raft completion does not create a connection');
  assert.equal(record.notify_setup_skipped, undefined, 'manual completion is not a skip event');
  assert.equal((await read(bob.cookie)).manual_steps, undefined, 'completion is account scoped');
  assert.equal((await set({ step: 'connect', done: false })).status, 200);
  record = await read(alice.cookie);
  assert.equal(record.manual_steps.connect, false);
  assert.equal(record.agent_connected, original.agent_connected, 'undo leaves actual milestones intact');
  for (const body of [{ step: 'revised', done: true }, { step: '__proto__', done: true }, { step: 'notify', done: 'true' }, { step: 'create' }]) {
    assert.equal((await set(body)).status, 400);
  }
  assert.equal((await set({ step: 'notify', done: true }, '')).status, 401);
  assert.equal((await set({ step: 'notify', done: true }, alice.cookie, { Origin: 'https://other.test' })).status, 403);
  assert.deepEqual(await read(alice.cookie), record, 'rejected writes do not change progress');
  console.log('PASS manual tutorial steps: persistence, undo, account isolation, validation and CSRF');
})().catch(error => { console.error(error); process.exitCode = 1; });
