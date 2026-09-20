// Owner-only publisher pulse: /api/admin/publishers
const path = require('path');
const {
  loadWorker, makeEnv, req, putSession,
} = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function seed(env, slug, { owner, accountId, created, updated }) {
  const meta = {
    title: slug,
    slug,
    created,
    versions: [
      { n: 1, created },
      ...(updated && updated !== created ? [{ n: 2, created: updated }] : []),
    ],
    hosted: { account_id: accountId, github_login: owner },
  };
  await env.META.put(`meta:${slug}`, JSON.stringify(meta));
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('admin publisher stats');

  await t('forbids anonymous and non-owner sessions', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    const anon = await worker.fetch(req('/api/admin/publishers'), env, {});
    assert(anon.status === 403, `anon ${anon.status}`);
    const cookie = await putSession(env, 'alice');
    const other = await worker.fetch(req('/api/admin/publishers', { cookie }), env, {});
    assert(other.status === 403, `non-owner ${other.status}`);
  });

  await t('owner session counts external vs internal publishers in the window', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    await seed(env, 'ext-old', {
      owner: 'alice', accountId: 'acct_alice',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
    });
    await seed(env, 'ext-recent', {
      owner: 'bob', accountId: 'acct_bob',
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-10T00:00:00.000Z',
    });
    await seed(env, 'ext-repeat-a', {
      owner: 'carol', accountId: 'acct_carol',
      created: '2026-08-01T00:00:00.000Z',
      updated: '2026-09-05T00:00:00.000Z',
    });
    await seed(env, 'ext-repeat-b', {
      owner: 'carol', accountId: 'acct_carol',
      created: '2026-09-06T00:00:00.000Z',
      updated: '2026-09-06T00:00:00.000Z',
    });
    await seed(env, 'internal-doc', {
      owner: 'yayashuxue', accountId: 'acct_julie',
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-15T00:00:00.000Z',
    });
    const cookie = await putSession(env, 'julie');
    const r = await worker.fetch(req('/api/admin/publishers?days=30', { cookie }), env, {});
    assert(r.status === 200, `status ${r.status}`);
    const body = await r.json();
    assert(body.ok === true, 'ok');
    assert(body.scanned_docs === 5, `scanned ${body.scanned_docs}`);
    assert(body.external.accounts_with_docs === 3, `ext accounts ${body.external.accounts_with_docs}`);
    assert(body.external.publishers_in_window === 2, `ext window ${body.external.publishers_in_window}`); // bob + carol
    // 30d back from ~Sep 20 → Aug 21. bob first=Sep 1 (in); carol first=Aug 1 (out).
    assert(body.external.first_publish_in_window === 1, `first in window ${body.external.first_publish_in_window}`);
    assert(body.external.repeat_publishers_in_window === 1, `repeat ${body.external.repeat_publishers_in_window}`);
    assert(body.internal.publishers_in_window === 1, 'internal julie counted separately');
    assert(body.external_publishers_in_window.some((p) => p.login === 'bob'), 'lists bob');
    assert(body.external_publishers_in_window.some((p) => p.login === 'carol' && p.docs === 2), 'lists carol with 2 docs');
    assert(!body.external_publishers_in_window.some((p) => p.login === 'yayashuxue'), 'internal excluded from external list');
  });

  await t('upload token can read the same pulse', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie', TDOC_UPLOAD_TOKEN: 'sekret' });
    await seed(env, 'tok-doc', {
      owner: 'dave', accountId: 'acct_dave',
      created: '2026-09-10T00:00:00.000Z',
      updated: '2026-09-10T00:00:00.000Z',
    });
    const r = await worker.fetch(req('/api/admin/publishers?days=30', { token: 'sekret' }), env, {});
    assert(r.status === 200, `token status ${r.status}`);
    const body = await r.json();
    assert(body.external.publishers_in_window === 1, 'dave counted via token');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
