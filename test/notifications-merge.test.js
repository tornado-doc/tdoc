// The bell reads every actor key a person has. A mention addressed to their
// email landed in inbox:email:<addr> while the bell read only inbox:<handle>,
// so Julie was tagged and never told (2026-10-14).
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const item = (id, at, extra = {}) => ({ id, kind: 'mention', group_key: `mention:${id}`, slug: 'doc', version: 1, comment_id: id, thread_id: id, actor: { login: 'claire' }, preview: 'hi', title: 'Doc', at, read: false, count: 1, ...extra });

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('notifications across linked identities');

  async function seed() {
    const env = makeEnv(mod.CommentsStore);
    const sid = 'ab'.repeat(16);
    await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', email: 'Julie@Example.com', name: 'Julie', created: new Date().toISOString() }));
    await env.META.put('inbox:julie', JSON.stringify({ items: [item('n_handle', '2026-10-14T10:00:00Z')] }));
    await env.META.put('inbox:email:julie@example.com', JSON.stringify({ items: [item('n_email', '2026-10-14T11:00:00Z')] }));
    return { env, cookie: `tdoc_sid=${sid}` };
  }

  await t('the list and the count include the email inbox, newest first', async () => {
    const { env, cookie } = await seed();
    const list = await (await worker.fetch(req('/api/notifications', { cookie }), env, {})).json();
    assert(list.items.map((i) => i.id).join(',') === 'n_email,n_handle', JSON.stringify(list.items.map((i) => i.id)));
    assert(list.unread === 2, `unread ${list.unread}`);
    const count = await (await worker.fetch(req('/api/notifications/unread', { cookie }), env, {})).json();
    assert(count.unread === 2, `badge ${count.unread}`);
  });

  await t('reading one marks it in whichever inbox holds it', async () => {
    const { env, cookie } = await seed();
    const r = await (await worker.fetch(req('/api/notifications/read', { method: 'POST', cookie, body: { ids: ['n_email'] } }), env, {})).json();
    assert(r.unread === 1, `unread ${r.unread}`);
    const stored = JSON.parse(await env.META.get('inbox:email:julie@example.com'));
    assert(stored.items[0].read === true, 'the email inbox was not updated');
  });

  await t('mark all read clears every inbox', async () => {
    const { env, cookie } = await seed();
    const r = await (await worker.fetch(req('/api/notifications/read', { method: 'POST', cookie, body: { all: true } }), env, {})).json();
    assert(r.unread === 0, `unread ${r.unread}`);
    for (const key of ['inbox:julie', 'inbox:email:julie@example.com']) {
      assert(JSON.parse(await env.META.get(key)).items.every((i) => i.read), `${key} still unread`);
    }
  });

  await t('someone else is never handed these inboxes', async () => {
    const { env } = await seed();
    const sid = 'cd'.repeat(16);
    await env.META.put(`session:${sid}`, JSON.stringify({ login: 'bob', email: 'bob@example.com', name: 'Bob', created: new Date().toISOString() }));
    const list = await (await worker.fetch(req('/api/notifications', { cookie: `tdoc_sid=${sid}` }), env, {})).json();
    assert(!list.items.length && list.unread === 0, JSON.stringify(list));
  });

  await t('the same notification held in two inboxes is listed and counted once', async () => {
    const { env, cookie } = await seed();
    await env.META.put('inbox:email:julie@example.com', JSON.stringify({ items: [item('n_handle', '2026-10-14T10:00:00Z')] }));
    const list = await (await worker.fetch(req('/api/notifications', { cookie }), env, {})).json();
    assert(list.items.length === 1 && list.unread === 1, JSON.stringify(list));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
