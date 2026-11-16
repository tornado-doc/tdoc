// One read state: the bell (per-person inbox rows) and a doc's read state
// (thread-seen, comments core) move together.
//  - a thread marked seen reads its bell rows, reactions included;
//  - a bell row read (click, Needs you's check, Mark all read) marks the
//    threads it covers seen, and My docs' agent-reply notes on them go;
//  - rows left unread although their thread was already seen are read when
//    the bell loads (lazy reconcile), with bounded reads;
//  - opening a doc marks nothing by itself.
// Run with: node test/notification-read-unify.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');
const SAME_ORIGIN = { Origin: 'https://tdoc.dev' };
const PROSE = '<h1>Plan</h1><p>A sentence to comment on.</p>';

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, pathname, opts = {}) => {
    const r = await worker.fetch(req(pathname, opts), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };

  async function seed(slugs = ['u-doc']) {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const owner = await putSession(env, 'owner');
    for (const slug of slugs) {
      const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug, version: 1, html: PROSE } });
      assert(up.status === 200, `upload ${slug}: ${up.status} ${up.text}`);
      const a = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, body: { slug, access: { visibility: 'unlisted' } } });
      assert(a.status === 200, `access ${slug}: ${a.status}`);
    }
    return { env, owner, token: tok.token };
  }
  const comment = async (env, cookie, slug, text, parent_id) => {
    const body = parent_id ? { slug, version: 1, parent_id, text } : { slug, version: 1, text, anchor: { kind: 'text', text: 'A sentence' } };
    const r = await call(env, '/api/comments', { method: 'POST', cookie, body });
    assert(r.status === 200, `comment ${r.status} ${r.text}`);
    return r.body;
  };
  const bell = async (env, cookie) => (await call(env, '/api/notifications', { cookie })).body;
  const unreadRows = async (env, cookie, slug) => (await bell(env, cookie)).items.filter((i) => !i.read && (!slug || i.slug === slug));
  // The person's thread-seen record, keyed as handleThreadSeen keys it: by
  // account when they have one, else by actor key.
  const seenKey = async (env, slug, login) => {
    const rec = JSON.parse(await env.META.get(`hosted-account:${login}`) || 'null');
    return `thread-seen:${slug}:${rec && rec.account_id ? `a:${rec.account_id}` : `k:${login}`}`;
  };
  const putSeen = async (env, slug, login, seen) => env.META.put(await seenKey(env, slug, login), JSON.stringify(seen));
  const seenOf = async (env, cookie, slug) => (await call(env, `/api/comments/seen?slug=${slug}`, { cookie })).body.seen;

  console.log('thread seen -> bell');

  // The owner's thread, Bob reacts to it: one reaction row.
  async function reacted() {
    const fx = await seed();
    const bob = await putSession(fx.env, 'bob');
    const mine = await comment(fx.env, fx.owner, 'u-doc', 'my point');
    const other = await comment(fx.env, fx.owner, 'u-doc', 'another point');
    const r = await call(fx.env, '/api/reactions', { method: 'POST', cookie: bob, body: { slug: 'u-doc', comment_id: mine.id, emoji: '👍', version: 1 } });
    assert(r.status === 200, `react ${r.status} ${r.text}`);
    const rows = await unreadRows(fx.env, fx.owner, 'u-doc');
    eq(rows.map((i) => i.kind), ['reaction']);
    return { ...fx, mine, other, reactedAt: Date.parse(rows[0].at) };
  }
  const postSeen = (env, cookie, body) => call(env, '/api/comments/seen', { method: 'POST', cookie, body: { slug: 'u-doc', ...body } });

  await t('a reaction row goes read when the page shows its thread after it came; another thread does not take it', async () => {
    const { env, owner, mine, other } = await reacted();
    await postSeen(env, owner, { seen: { [other.id]: Date.parse(other.created) }, viewed: { [other.id]: Date.now() } });
    eq((await unreadRows(env, owner, 'u-doc')).length, 1, 'seeing another thread read it');
    await postSeen(env, owner, { seen: { [mine.id]: Date.parse(mine.created) }, viewed: { [mine.id]: Date.now() } });
    eq((await unreadRows(env, owner, 'u-doc')).length, 0, 'seeing its thread did not read it');
  });

  await t('a re-sync of an older mark (no `viewed`) never reads a reaction row, even after the record expired', async () => {
    const { env, owner, mine } = await reacted();
    // The page's pull pushes what its cache holds ahead of the server: the
    // record expired (180-day TTL) or was never written.
    await postSeen(env, owner, { seen: { [mine.id]: Date.parse(mine.created) } });
    eq((await unreadRows(env, owner, 'u-doc')).length, 1, 'a re-sync read the reaction');
    // A second re-push of the same mark (nothing newer): still nothing.
    await postSeen(env, owner, { seen: { [mine.id]: Date.parse(mine.created) } });
    eq((await unreadRows(env, owner, 'u-doc')).length, 1, 'a repeated re-sync read the reaction');
  });

  await t('a look from before the reaction (a mark retried after a 429) does not read it; `viewed` outside `seen` is ignored', async () => {
    const { env, owner, mine, other, reactedAt } = await reacted();
    // The view happened, the POST was refused, and it is sent again later
    // carrying the time of that view -- before the reaction.
    await postSeen(env, owner, { seen: { [mine.id]: Date.parse(mine.created) }, viewed: { [mine.id]: reactedAt - 5000 } });
    eq((await unreadRows(env, owner, 'u-doc')).length, 1, 'an earlier look read a later reaction');
    await postSeen(env, owner, { seen: { [other.id]: Date.parse(other.created) + 1 }, viewed: { [mine.id]: Date.now() } });
    eq((await unreadRows(env, owner, 'u-doc')).length, 1, 'a `viewed` id not in `seen` counted');
  });

  await t('opening a doc (reading its seen map) marks nothing read', async () => {
    const { env, owner } = await seed();
    const reader = await putSession(env, 'reader');
    await comment(env, reader, 'u-doc', 'question one');
    await comment(env, reader, 'u-doc', 'question two');
    eq((await seenOf(env, owner, 'u-doc')), {});
    const c = await call(env, '/api/comments?slug=u-doc', { cookie: owner });
    assert(c.status === 200, `comments ${c.status}`);
    eq((await unreadRows(env, owner, 'u-doc')).length, 1, 'the grouped row is still unread');
  });

  console.log('bell -> thread seen');

  await t('clicking a bell row marks its thread seen up to that activity; Needs you\'s agent note on it goes too', async () => {
    const { env, owner } = await seed();
    const reader = await putSession(env, 'reader');
    const root = await comment(env, owner, 'u-doc', 'thoughts?');
    const reply = await comment(env, reader, 'u-doc', 'looks fine', root.id);
    const [row] = await unreadRows(env, owner, 'u-doc');
    assert(row && row.kind === 'reply', JSON.stringify(row));
    // An agent answered in the same thread earlier: Needs you carries it.
    await env.META.put('agent-unread:owner', JSON.stringify({ items: [{ slug: 'u-doc', thread: root.id, at: root.created }] }));
    const read = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { ids: [row.id] }, headers: SAME_ORIGIN });
    assert(read.status === 200, `read ${read.status} ${read.text}`);
    eq(await seenOf(env, owner, 'u-doc'), { [root.id]: Date.parse(reply.created) });
    eq(await env.META.get('agent-unread:owner'), null, 'the agent note was not cleared');
  });

  await t('Needs you\'s check on a doc (slug) and Mark all read mark every covered thread seen, raising never lowering', async () => {
    const { env, owner } = await seed(['u-a', 'u-b']);
    const alice = await putSession(env, 'alice');
    const bob = await putSession(env, 'bob');
    const a1 = await comment(env, alice, 'u-a', 'first');
    const a2 = await comment(env, bob, 'u-a', 'second');
    const b1 = await comment(env, alice, 'u-b', 'elsewhere');
    // A later mark already held for a1 stays.
    await putSeen(env, 'u-a', 'owner', { [a1.id]: Date.parse(a1.created) + 60_000 });
    let r = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { slug: 'u-a' }, headers: SAME_ORIGIN });
    assert(r.status === 200, `slug read ${r.status}`);
    eq(await seenOf(env, owner, 'u-a'), { [a1.id]: Date.parse(a1.created) + 60_000, [a2.id]: Date.parse(a2.created) });
    eq(await seenOf(env, owner, 'u-b'), {}, 'another doc was marked');
    r = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { all: true }, headers: SAME_ORIGIN });
    assert(r.status === 200, `all read ${r.status}`);
    eq(await seenOf(env, owner, 'u-b'), { [b1.id]: Date.parse(b1.created) });
  });

  await t('a read from another site changes neither the bell nor the read state', async () => {
    const { env, owner } = await seed();
    const reader = await putSession(env, 'reader');
    await comment(env, reader, 'u-doc', 'hello');
    const r = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { all: true }, headers: { Origin: 'https://evil.example' } });
    eq(r.status, 403);
    eq(await seenOf(env, owner, 'u-doc'), {});
    eq((await unreadRows(env, owner, 'u-doc')).length, 1);
  });

  await t('every inbox a person has (linked email key): a seen thread reads its row there, a bell read there marks the thread', async () => {
    const { env } = await seed();
    const reader = await putSession(env, 'reader');
    const sid = 'ab'.repeat(16);
    await env.META.put(`session:${sid}`, JSON.stringify({ login: 'owner', email: 'Owner@Example.com', name: 'Owner', created: new Date().toISOString() }));
    const cookie = `tdoc_sid=${sid}`;
    const c1 = await comment(env, reader, 'u-doc', 'one');
    const c2 = await comment(env, reader, 'u-doc', 'two');
    const mention = (id, c) => ({ id, kind: 'mention', group_key: `mention:${c.id}`, slug: 'u-doc', version: 1, comment_id: c.id, thread_id: c.id, thread_at: { [c.id]: c.created }, at: c.created, read: false, count: 1 });
    await env.META.put('inbox:email:owner@example.com', JSON.stringify({ items: [mention('n_m2', c2), mention('n_m1', c1)] }));
    await call(env, '/api/comments/seen', { method: 'POST', cookie, body: { slug: 'u-doc', seen: { [c1.id]: Date.parse(c1.created) } } });
    const stored = JSON.parse(await env.META.get('inbox:email:owner@example.com'));
    eq(stored.items.map((i) => [i.id, i.read]), [['n_m2', false], ['n_m1', true]]);
    const r = await call(env, '/api/notifications/read', { method: 'POST', cookie, body: { ids: ['n_m2'] }, headers: SAME_ORIGIN });
    assert(r.status === 200, `read ${r.status}`);
    eq((await seenOf(env, cookie, 'u-doc'))[c2.id], Date.parse(c2.created));
  });

  console.log('lazy reconcile when the bell loads');

  await t('rows whose threads were seen before the sync existed go read when the bell opens', async () => {
    const { env, owner } = await seed(['u-a', 'u-b']);
    const reader = await putSession(env, 'reader');
    const a = await comment(env, reader, 'u-a', 'old and seen');
    const b = await comment(env, reader, 'u-b', 'never seen');
    // The thread-seen record written long ago, without touching the bell.
    await putSeen(env, 'u-a', 'owner', { [a.id]: Date.parse(a.created) });
    const before = JSON.parse(await env.META.get('inbox:owner'));
    eq(before.items.filter((i) => !i.read).length, 2);
    const page = await bell(env, owner);
    eq(page.unread, 1, 'the seen thread\'s row still counts');
    eq(page.items.filter((i) => !i.read).map((i) => i.slug), ['u-b']);
    const stored = JSON.parse(await env.META.get('inbox:owner'));
    eq(stored.items.filter((i) => !i.read).map((i) => i.slug), ['u-b'], 'not written back');
    void b;
  });

  await t('a legacy grouped row (no thread list) is read only when every comment it covers is seen', async () => {
    const { env, owner } = await seed();
    const alice = await putSession(env, 'alice');
    const bob = await putSession(env, 'bob');
    const a = await comment(env, alice, 'u-doc', 'one');
    const b = await comment(env, bob, 'u-doc', 'two');
    // Strip the thread list, as rows stored before it existed look.
    const inbox = JSON.parse(await env.META.get('inbox:owner'));
    for (const i of inbox.items) { delete i.thread_at; delete i.threads_capped; }
    eq(inbox.items[0].count, 2);
    await env.META.put('inbox:owner', JSON.stringify(inbox));
    await putSeen(env, 'u-doc', 'owner', { [b.id]: Date.parse(b.created) });
    env.META.gets.length = 0;
    eq((await bell(env, owner)).unread, 1, 'one thread unseen: stays unread');
    // The other thread is then read on the page (a seen POST): the check
    // the bell already finished starts again.
    await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'u-doc', seen: { [a.id]: Date.parse(a.created) } } });
    eq((await bell(env, owner)).unread, 0, 'both seen: read');
  });

  await t('a newer comment folded into a seen row keeps it unread', async () => {
    const { env, owner } = await seed();
    const reader = await putSession(env, 'reader');
    const a = await comment(env, reader, 'u-doc', 'first');
    await putSeen(env, 'u-doc', 'owner', { [a.id]: Date.parse(a.created) });
    // A second comment lands on the grouped row before the bell checks it.
    const b = await comment(env, reader, 'u-doc', 'second');
    eq((await bell(env, owner)).unread, 1, 'the new comment was swallowed');
    void b;
  });

  await t('cost: nothing unread reads no read state; many docs read at most 10 records', async () => {
    const slugs = Array.from({ length: 12 }, (_, n) => `u-c${n}`);
    const { env, owner } = await seed(slugs);
    const reader = await putSession(env, 'reader');
    for (const slug of slugs) await comment(env, reader, slug, `on ${slug}`);
    env.META.gets.length = 0;
    await bell(env, owner);
    const seenReads = env.META.gets.filter((k) => k.startsWith('thread-seen:')).length;
    assert(seenReads > 0 && seenReads <= 10, `thread-seen reads: ${seenReads}`);
    await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { all: true }, headers: SAME_ORIGIN });
    env.META.gets.length = 0;
    await bell(env, owner);
    eq(env.META.gets.filter((k) => k.startsWith('thread-seen:')).length, 0, 'read state read with nothing unread');
  });

  await t('an inbox already checked is not read again until a new row comes; then it is', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'poller');
    const poller = await putSession(env, 'poller');
    await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug: 'u-poll', version: 1, html: PROSE } });
    await call(env, '/api/doc/access', { method: 'PATCH', cookie: poller, body: { slug: 'u-poll', access: { visibility: 'unlisted' } } });
    const reader = await putSession(env, 'reader');
    const a = await comment(env, reader, 'u-poll', 'genuinely unread');
    eq((await call(env, '/api/notifications/unread', { cookie: poller })).body.unread, 1);
    const checked = JSON.parse(await env.META.get('inbox:poller')).seen_checked;
    assert(checked && checked.complete && checked.at, `no progress kept: ${JSON.stringify(checked)}`);
    for (const path of ['/api/notifications/unread', '/api/notifications']) {
      env.META.gets.length = 0;
      await call(env, path, { cookie: poller });
      eq(env.META.gets.filter((k) => k.startsWith('thread-seen:')).length, 0, `${path} re-read an inbox already checked`);
    }
    // Seen elsewhere meanwhile, then a new row: the next poll checks again.
    await putSeen(env, 'u-poll', 'poller', { [a.id]: Date.parse(a.created) });
    const b = await comment(env, reader, 'u-poll', 'and another');
    await putSeen(env, 'u-poll', 'poller', { [a.id]: Date.parse(a.created), [b.id]: Date.parse(b.created) });
    eq((await call(env, '/api/notifications/unread', { cookie: poller })).body.unread, 0, 'a new row did not start a new check');
  });

  await t('more docs than one pass covers: later passes move on to the rest instead of re-reading the first', async () => {
    const slugs = Array.from({ length: 14 }, (_, n) => `u-r${n}`);
    const { env, owner } = await seed(slugs);
    const reader = await putSession(env, 'reader');
    const made = [];
    for (const slug of slugs) made.push(await comment(env, reader, slug, `on ${slug}`));
    // Only the oldest doc's thread was seen: past the first pass's 10 docs.
    await putSeen(env, slugs[0], 'owner', { [made[0].id]: Date.parse(made[0].created) });
    const reads = [];
    for (let n = 0; n < 3; n++) {
      env.META.gets.length = 0;
      await call(env, '/api/notifications/unread', { cookie: owner });
      reads.push(env.META.gets.filter((k) => k.startsWith('thread-seen:')).length);
    }
    eq(reads, [10, 4, 0], 'thread-seen reads per pass');
    eq((await unreadRows(env, owner)).map((i) => i.slug).includes(slugs[0]), false, 'the oldest seen doc never reached');
  });

  await t('legacy rows past the comment-read cap, or whose comment was deleted, do not starve the others', async () => {
    const slugs = Array.from({ length: 5 }, (_, n) => `u-l${n}`);
    const { env, owner } = await seed(slugs);
    const alice = await putSession(env, 'alice');
    const bob = await putSession(env, 'bob');
    const pairs = [];
    for (const slug of slugs) pairs.push([await comment(env, alice, slug, 'one'), await comment(env, bob, slug, 'two')]);
    const inbox = JSON.parse(await env.META.get('inbox:owner'));
    for (const i of inbox.items) { delete i.thread_at; delete i.threads_capped; }
    await env.META.put('inbox:owner', JSON.stringify(inbox));
    for (const [n, slug] of slugs.entries()) {
      const [x, y] = pairs[n];
      await putSeen(env, slug, 'owner', { [x.id]: Date.parse(x.created), [y.id]: Date.parse(y.created) });
    }
    // The newest doc's first comment is deleted: its row cannot be decided.
    const del = await call(env, `/api/comments?slug=${slugs[4]}&id=${pairs[4][0].id}`, { method: 'DELETE', cookie: alice });
    assert(del.status === 200, `delete ${del.status} ${del.text}`);
    await call(env, '/api/notifications/unread', { cookie: owner });
    await call(env, '/api/notifications/unread', { cookie: owner });
    const left = (await unreadRows(env, owner)).map((i) => i.slug);
    eq(left, [slugs[4]], 'docs past the cap were starved');
  });

  console.log('authorization');

  await t('a feedback token can neither read the bell nor write read state through it', async () => {
    const { env, owner } = await seed();
    const reader = await putSession(env, 'reader');
    const c = await comment(env, reader, 'u-doc', 'hello');
    const sid = (owner.match(/tdoc_sid=([a-f0-9]+)/) || [])[1];
    for (const site of [true, false]) {
      const token = `fb_${(site ? 'a' : 'b').repeat(48)}`;
      await env.META.put(`feedback:token:${token}`, JSON.stringify({ sid, slug: 'u-doc', origin: 'https://site.example', site }));
      const r = await call(env, '/api/notifications/read', { method: 'POST', body: { all: true }, headers: { ...SAME_ORIGIN, Authorization: `Bearer ${token}` } });
      eq(r.status, 403, `${site ? 'site' : 'widget'} token read the bell`);
    }
    eq(await seenOf(env, owner, 'u-doc'), {}, 'a token wrote the read state');
    eq((await unreadRows(env, owner, 'u-doc')).map((i) => i.comment_id), [c.id]);
  });

  console.log('one lane per read-state record');

  await t('a bell read and a seen POST at once both land', async () => {
    const { env, owner } = await seed();
    const reader = await putSession(env, 'reader');
    const mine = await comment(env, owner, 'u-doc', 'mine');
    const theirs = await comment(env, reader, 'u-doc', 'theirs');
    const [row] = await unreadRows(env, owner, 'u-doc');
    await Promise.all([
      call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { ids: [row.id] }, headers: SAME_ORIGIN }),
      postSeen(env, owner, { seen: { [mine.id]: Date.parse(mine.created) } }),
    ]);
    const got = await seenOf(env, owner, 'u-doc');
    eq(Object.keys(got).sort(), [mine.id, theirs.id].sort(), `a write was lost: ${JSON.stringify(got)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
