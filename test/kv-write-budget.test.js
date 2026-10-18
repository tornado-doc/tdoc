// Repeat actions must not spend Workers KV writes (a daily quota: on the free
// plan 1,000 a day for the whole account, and hitting it made comments 500).
// A comment pays for the recipient's inbox; answering the same person again,
// pulling comments again or loading My docs again pays nothing more.
//
// Run with: node test/kv-write-budget.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('KV write budget for repeat actions');

  const env = makeEnv(mod.CommentsStore);
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const owner = await issue(worker, env, 'owner');
  await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'budget', version: 1, html: '<h1>doc</h1><p>a sentence to comment on</p>' } }), env, ctx);
  await Promise.all(pending.splice(0));
  const reader = await putSession(env, 'reader');

  const writes = [];
  const put = env.META.put.bind(env.META);
  env.META.put = (k, v, o) => { writes.push(k); return put(k, v, o); };
  async function run(r) {
    writes.length = 0;
    const res = await worker.fetch(r, env, ctx);
    await Promise.all(pending.splice(0));
    assert(res.status === 200, `status ${res.status}`);
    return { res, keys: [...writes] };
  }
  const comment = (cookie, body) => req('/api/comments', { method: 'POST', cookie, body: { slug: 'budget', version: 1, ...body } });

  const top = await (await run(comment(reader, { text: 'confusing', anchor: { kind: 'text', text: 'a sentence' } }))).res.json();
  await run(comment(owner.cookie, { parent_id: top.id, text: 'first answer' }));

  await t('answering the same person again writes only their inbox', async () => {
    const { keys } = await run(comment(owner.cookie, { parent_id: top.id, text: 'second answer' }));
    assert(keys.length === 1 && keys[0] === 'inbox:reader', `wrote ${JSON.stringify(keys)}`);
  });

  await t('an agent pulling comments again does not re-stamp onboarding', async () => {
    const pull = () => run(req('/api/comments?slug=budget&version=all', { token: owner.token }));
    await pull();
    const { keys } = await pull();
    assert(!keys.some((k) => k.startsWith('account-onboarding:')), `wrote ${JSON.stringify(keys)}`);
  });

  await t('loading My docs again writes nothing', async () => {
    await run(req('/me', { cookie: owner.cookie }));
    const { keys } = await run(req('/me', { cookie: owner.cookie }));
    assert(keys.length === 0, `wrote ${JSON.stringify(keys)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
