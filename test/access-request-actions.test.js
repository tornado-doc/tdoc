// An access request is answered from the notification: Approve adds the
// person and tells them, Ignore closes it; the owner's row records which
// (Julie, 2026-10-14: the notification only deep-linked, nothing to do).
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function seed(env) {
  env.META.map.set('meta:plan', JSON.stringify({
    title: 'Quarterly plan', created: '2026-01-01T00:00:00Z',
    versions: [{ n: 1, created: '2026-01-01T00:00:00Z' }],
    hosted: { account_id: 'acct_owner0000', github_login: 'olivia' },
    access: { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
  }));
  env.META.map.set('session:feedface01', JSON.stringify({ login: 'olivia', name: 'Olivia', email: 'olivia@example.com', account_id: 'acct_owner0000', created: new Date().toISOString() }));
  env.META.map.set('session:cafebabe01', JSON.stringify({ login: 'petra', name: 'Petra', email: 'petra@example.com', created: new Date().toISOString() }));
  env.META.map.set('session:cafebabe02', JSON.stringify({ login: 'quinn', name: 'Quinn', email: 'quinn@example.com', created: new Date().toISOString() }));
  return { owner: 'tdoc_sid=feedface01', petra: 'tdoc_sid=cafebabe01', quinn: 'tdoc_sid=cafebabe02' };
}
const ask = (worker, env, cookie) => worker.fetch(req('/api/doc/request-access', { method: 'POST', cookie, body: { slug: 'plan' } }), env, {});
const answer = (worker, env, cookie, requester, action) => worker.fetch(req('/api/doc/access-request', { method: 'POST', cookie, body: { slug: 'plan', requester, action } }), env, {});
const notes = async (worker, env, cookie) => (await (await worker.fetch(req('/api/notifications', { cookie }), env, {})).json()).items;

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('access requests answered from the notification');

  await t('each requester gets a row with the doc title and who is asking', async () => {
    const env = makeEnv(mod.CommentsStore);
    const c = seed(env);
    await ask(worker, env, c.petra);
    await ask(worker, env, c.quinn);
    const rows = (await notes(worker, env, c.owner)).filter((i) => i.kind === 'access_request');
    assert(rows.length === 2, JSON.stringify(rows));
    assert(rows.every((r) => r.title === 'Quarterly plan'), 'title missing');
    assert(rows.map((r) => r.requester).sort().join(',') === 'petra,quinn', JSON.stringify(rows.map((r) => r.requester)));
  });

  await t('Approve adds the person, tells them, and closes the owner row', async () => {
    const env = makeEnv(mod.CommentsStore);
    const c = seed(env);
    await ask(worker, env, c.petra);
    const r = await answer(worker, env, c.owner, 'petra', 'approve');
    const body = await r.json();
    assert(r.status === 200 && body.resolved === 'approved', `${r.status} ${JSON.stringify(body)}`);
    const meta = JSON.parse(env.META.map.get('meta:plan'));
    assert(meta.access.allowed_users.includes('petra'), JSON.stringify(meta.access));
    const theirs = await notes(worker, env, c.petra);
    assert(theirs.some((i) => i.kind === 'access_granted' && i.slug === 'plan' && i.actor && i.actor.login === 'olivia'), JSON.stringify(theirs));
    const row = (await notes(worker, env, c.owner)).find((i) => i.kind === 'access_request');
    assert(row.resolved === 'approved' && row.read === true, JSON.stringify(row));
  });

  await t('Ignore closes the row without granting anything', async () => {
    const env = makeEnv(mod.CommentsStore);
    const c = seed(env);
    await ask(worker, env, c.petra);
    await answer(worker, env, c.owner, 'petra', 'ignore');
    const meta = JSON.parse(env.META.map.get('meta:plan'));
    assert(!meta.access.allowed_users.includes('petra'), 'ignore granted access');
    const row = (await notes(worker, env, c.owner)).find((i) => i.kind === 'access_request');
    assert(row.resolved === 'ignored', JSON.stringify(row));
    assert(!(await notes(worker, env, c.petra)).some((i) => i.kind === 'access_granted'), 'ignore told them they were granted');
  });

  await t('only the owner can answer', async () => {
    const env = makeEnv(mod.CommentsStore);
    const c = seed(env);
    await ask(worker, env, c.petra);
    const r = await answer(worker, env, c.quinn, 'petra', 'approve');
    assert(r.status === 401 || r.status === 403, `stranger answered: ${r.status}`);
    const meta = JSON.parse(env.META.map.get('meta:plan'));
    assert(!meta.access.allowed_users.includes('petra'), 'a stranger granted access');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
