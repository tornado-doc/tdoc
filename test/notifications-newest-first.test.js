// The bell is what happened, newest first (Julie, 2026-11-18: "everything
// in Notifications is so old"). It used to list every unread row before
// every read one. Since the bell and the doc page share one read state
// (#1060), new activity read on the doc page is read in the bell at once, so
// it sank under weeks-old unread rows: with a page of them (Julie had 44)
// nothing new showed without Load more. Real worker routes:
//  - a new comment and a new reply land at the top of the first page;
//  - read on the doc page, they stay at the top (read is a mark, not a place);
//  - pages walk all rows in time order, no row twice, none lost;
//  - the count is every unread row, whatever the page;
//  - ?filter=unread (My docs' Needs you) lists the unread alone, newest
//    first, across pages -- never a read row, never one missed.
// Run with: node test/notifications-newest-first.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');
const PROSE = '<h1>Plan</h1><p>A sentence to comment on.</p>';

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const DAY = 864e5;
// `n` unread rows two to three weeks old, on another doc: the backlog.
const backlog = (n, { readEvery = 0 } = {}) => Array.from({ length: n }, (_, i) => {
  const at = new Date(Date.now() - 14 * DAY - i * 3600e3).toISOString();
  return {
    id: `n_old_${i}`, kind: ['comment', 'reply', 'mention'][i % 3], group_key: `old:${i}`, slug: 'old-doc', version: 1,
    comment_id: `c_old_${i}`, thread_id: `c_old_${i}`, actor: { login: 'claire', name: 'Claire' }, preview: 'old',
    title: 'Old doc', at, read: readEvery ? i % readEvery === 0 : false, count: 1,
  };
});

(async () => {
  console.log('Bell: newest first; Needs you: unread alone');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, pathname, opts = {}) => {
    const r = await worker.fetch(req(pathname, opts), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  async function seed(rows) {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const owner = await putSession(env, 'owner');
    const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug: 'u-doc', version: 1, html: PROSE } });
    assert(up.status === 200, `upload: ${up.status} ${up.text}`);
    const a = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, body: { slug: 'u-doc', access: { visibility: 'unlisted' } } });
    assert(a.status === 200, `access: ${a.status}`);
    // The backlog joins whatever the setup delivered (none so far).
    const inbox = JSON.parse(await env.META.get('inbox:owner') || '{"items":[]}');
    await env.META.put('inbox:owner', JSON.stringify({ items: [...inbox.items, ...rows] }));
    return { env, owner, bob: await putSession(env, 'bob') };
  }
  const comment = async (env, cookie, text, parent_id) => {
    const body = parent_id ? { slug: 'u-doc', version: 1, parent_id, text } : { slug: 'u-doc', version: 1, text, anchor: { kind: 'text', text: 'A sentence' } };
    const r = await call(env, '/api/comments', { method: 'POST', cookie, body });
    assert(r.status === 200, `comment ${r.status} ${r.text}`);
    return r.body;
  };
  const bell = async (env, cookie, query = '') => {
    const r = await call(env, `/api/notifications${query}`, { cookie });
    assert(r.status === 200, `bell ${r.status} ${r.text}`);
    return r.body;
  };
  const walk = async (env, cookie, filter = '') => {
    const all = [];
    for (let offset = 0, n = 0; n < 20; n += 1) {
      const page = await bell(env, cookie, `?offset=${offset}${filter}`);
      all.push(...page.items);
      offset += page.items.length;
      if (!page.has_more || !page.items.length) return { all, unread: page.unread };
    }
    throw new Error('paging never ended');
  };
  const newestFirst = (rows) => rows.every((row, i) => !i || String(rows[i - 1].at) >= String(row.at));

  await t('a new comment is the first row, above a page of older unread rows; read on the doc page it stays first', async () => {
    const { env, owner, bob } = await seed(backlog(25));
    const c = await comment(env, bob, 'Can we move the launch to Thursday?');
    let page = await bell(env, owner);
    eq(page.items[0].kind, 'comment');
    eq(page.items[0].actor.login, 'bob');
    eq(page.items[0].read, false);
    eq(page.unread, 26);
    // Seen on the doc page: the bell row goes read (#1060) ...
    const seen = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, headers: { Origin: 'https://tdoc.dev' }, body: { slug: 'u-doc', seen: { [c.id]: Date.parse(c.created) } } });
    assert(seen.status === 200, `seen ${seen.status} ${seen.text}`);
    page = await bell(env, owner);
    // ... and is still where the newest activity is.
    eq(page.items[0].comment_id, c.id, 'the row read on the doc page left the top');
    eq(page.items[0].read, true);
    eq(page.unread, 25, 'the count is the unread rows');
    assert(newestFirst(page.items), 'page not newest first');
  });

  await t('a new reply to my comment is the first row', async () => {
    const { env, owner, bob } = await seed(backlog(30));
    const mine = await comment(env, owner, 'my point');
    await comment(env, bob, 'Done, the table is updated.', mine.id);
    const page = await bell(env, owner);
    eq(page.items[0].kind, 'reply');
    eq(page.items[0].preview, 'Done, the table is updated.');
    eq(page.items.length, 20);
    eq(page.has_more, true);
  });

  await t('the pages walk every row once, in time order, read and unread mixed', async () => {
    const rows = backlog(47, { readEvery: 3 });
    const { env, owner } = await seed(rows);
    const { all, unread } = await walk(env, owner);
    eq(all.length, 47);
    eq(new Set(all.map((r) => r.id)).size, 47, 'a row twice');
    assert(newestFirst(all), 'not newest first');
    eq(unread, rows.filter((r) => !r.read).length);
  });

  await t('filter=unread lists the unread rows alone, newest first, across pages (Needs you)', async () => {
    const rows = backlog(47, { readEvery: 3 });
    const { env, owner, bob } = await seed(rows);
    await comment(env, bob, 'A new one');
    const want = rows.filter((r) => !r.read).length + 1;
    const { all, unread } = await walk(env, owner, '&filter=unread');
    eq(all.length, want, 'unread rows missed or extra');
    assert(all.every((r) => !r.read), 'a read row in the unread list');
    assert(newestFirst(all), 'not newest first');
    eq(all[0].actor.login, 'bob');
    eq(unread, want);
    // The plain list still has the read rows.
    eq((await walk(env, owner)).all.length, 48);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
