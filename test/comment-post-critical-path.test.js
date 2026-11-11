// Posting a comment answers once the comment is saved. What follows it --
// the inbox rows (and the push and email they send), the writer's contacts,
// onboarding stamps, the search reindex, a team backup -- runs after the
// response (ctx.waitUntil), still runs every time, and never holds the
// composer on "Posting…" (Julie, 2026-11-11).
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

// A ctx whose background work is collected, as the runtime does.
function makeCtx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
}

// Writes to keys matching `re` wait until released: a slow KV.
function holdPuts(env, re) {
  const put = env.META.put.bind(env.META);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = [];
  env.META.put = async (k, v, o) => {
    if (re.test(k)) { held.push(k); await gate; }
    return put(k, v, o);
  };
  return { held, release: () => release() };
}

const within = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)),
]);

async function seedDoc(env, slug, owner = 'alice') {
  await env.META.put(`meta:${slug}`, JSON.stringify({
    slug, title: 'Critical path doc', github_login: owner, hosted: { github_login: owner },
    versions: [{ n: 1, created: '2026-11-10T00:00:00Z' }],
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, '<h1>Critical path doc</h1>');
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('comment post critical path');

  await t('the POST answers while the owner\'s inbox write is still in flight; the row lands after', async () => {
    const env = makeEnv(mod.CommentsStore);
    const slug = 'critical-path-comment';
    await seedDoc(env, slug);
    const cookie = await putSession(env, 'bob');
    const slow = holdPuts(env, /^(inbox:|contacts:|onboarding)/);
    const ctx = makeCtx();
    const response = await within(worker.fetch(req('/api/comments', {
      method: 'POST', cookie, body: { slug, version: 1, text: 'Saved first, delivered after.', anchor: null },
    }), env, ctx), 2000);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const made = await response.json();
    assert(made.id && made.text === 'Saved first, delivered after.', `answer is not the comment: ${JSON.stringify(made)}`);
    assert(ctx.pending.length > 0, 'nothing was handed to waitUntil');
    assert(!env.META.map.has('inbox:alice'), 'the inbox row was written before the response');
    slow.release();
    await Promise.all(ctx.pending);
    const inbox = JSON.parse(env.META.map.get('inbox:alice') || 'null');
    assert(inbox && inbox.items.some((row) => row.kind === 'comment' && row.comment_id === made.id),
      `the owner was not notified after the response: ${JSON.stringify(inbox)}`);
  });

  await t('a reply with a mention answers before the mention and reply rows; both land after', async () => {
    const env = makeEnv(mod.CommentsStore);
    const slug = 'critical-path-reply';
    await seedDoc(env, slug);
    const aliceCookie = await putSession(env, 'alice');
    const first = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: aliceCookie, body: { slug, version: 1, text: 'Root thread.', anchor: null },
    }), env, {});
    const root = await first.json();
    const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
    meta.access = { mode: 'public', allowed_users: ['bob', 'carol'] };
    await env.META.put(`meta:${slug}`, JSON.stringify(meta));
    const cookie = await putSession(env, 'bob');
    const slow = holdPuts(env, /^inbox:/);
    const ctx = makeCtx();
    const response = await within(worker.fetch(req('/api/comments', {
      method: 'POST', cookie, body: { slug, version: 1, text: 'Agreed, @carol take a look.', parent_id: root.id },
    }), env, ctx), 2000);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const made = await response.json();
    assert(made.thread_id === root.id, `reply answer lacks its thread: ${JSON.stringify(made)}`);
    assert(slow.held.length === 0 || !env.META.map.has('inbox:alice'), 'an inbox row was written before the response');
    slow.release();
    await Promise.all(ctx.pending);
    const alice = JSON.parse(env.META.map.get('inbox:alice') || 'null');
    const carol = JSON.parse(env.META.map.get('inbox:carol') || 'null');
    assert(alice && alice.items.some((row) => row.kind === 'reply'), 'the parent author was not notified');
    assert(carol && carol.items.some((row) => row.kind === 'mention'), 'the mentioned person was not notified');
  });

  await t('five posts at once naming the same person leave five inbox rows (one lane per inbox)', async () => {
    const env = makeEnv(mod.CommentsStore);
    const slug = 'critical-path-race';
    await seedDoc(env, slug);
    const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
    meta.access = { mode: 'public', allowed_users: ['bob', 'carol'] };
    await env.META.put(`meta:${slug}`, JSON.stringify(meta));
    // A KV read that takes a moment, as Workers KV's does: without a lane,
    // every delivery reads the inbox before any of them writes it.
    const get = env.META.get.bind(env.META);
    env.META.get = async (k) => {
      const value = await get(k);
      if (String(k).startsWith('inbox:')) await new Promise((r) => setTimeout(r, 20));
      return value;
    };
    const cookie = await putSession(env, 'bob');
    const ctxs = [];
    const answers = await Promise.all([0, 1, 2, 3, 4].map((i) => {
      const ctx = makeCtx();
      ctxs.push(ctx);
      return worker.fetch(req('/api/comments', {
        method: 'POST', cookie, body: { slug, version: 1, text: `Thread ${i}: @carol please check.`, anchor: { text: `spot ${i}` } },
      }), env, ctx);
    }));
    assert(answers.every((r) => r.status === 200), `posts: ${answers.map((r) => r.status)}`);
    await Promise.all(ctxs.flatMap((c) => c.pending));
    const carol = JSON.parse(env.META.map.get('inbox:carol') || 'null');
    const rows = (carol && carol.items || []).filter((row) => row.kind === 'mention');
    assert(rows.length === 5, `expected 5 mention rows, got ${rows.length}`);
    const alice = JSON.parse(env.META.map.get('inbox:alice') || 'null');
    // The owner's rows for one doc fold into one, counted.
    const owner = alice && alice.items.find((row) => row.kind === 'comment');
    assert(owner && owner.count === 5, `owner row count: ${JSON.stringify(alice)}`);
  });

  await t('a duplicate post answers with the thread as a fresh post would, not the stored record', async () => {
    const env = makeEnv(mod.CommentsStore);
    const slug = 'critical-path-dup';
    await seedDoc(env, slug);
    // A record stored before the event log (the check matches on its text).
    await env.META.put(`comments:${slug}`, JSON.stringify([{ id: 'c_legacy', author: { login: 'bob', name: 'bob' }, text: 'Twice.', created: new Date().toISOString(), anchor: null, replies: [], version: 1 }]));
    const cookie = await putSession(env, 'bob');
    const again = await (await worker.fetch(req('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: 'Twice.', anchor: null } }), env, {})).json();
    assert(again.duplicate_of === 'c_legacy' && again.id === 'c_legacy', `not marked a duplicate: ${JSON.stringify(again)}`);
    assert(again.text === 'Twice.' && again.status === 'open' && Array.isArray(again.replies), `not a snapshot: ${JSON.stringify(again)}`);
    assert(!('events' in again), 'the stored event log leaked into the answer');
  });

  // A deploy rolling out: the Durable Object may still run the previous
  // code, which answers /serial as a comments op ({ status: 400, unknown_op }),
  // or may not answer at all. The row is then written directly.
  for (const [label, answer] of [
    ['an older CommentsStore (unknown_op)', () => Response.json({ status: 400, body: { error: 'unknown_op' } })],
    ['a lane that throws', () => { throw new Error('DO unavailable'); }],
  ]) {
    await t(`with ${label} the inbox row, contacts and onboarding stamp still land`, async () => {
      const env = makeEnv(class extends mod.CommentsStore {
        async fetch(request) {
          if (new URL(request.url).pathname === '/serial') return answer();
          return super.fetch(request);
        }
      });
      const slug = `critical-path-fallback-${label.length}`;
      await seedDoc(env, slug);
      const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
      meta.access = { mode: 'public', allowed_users: ['bob', 'carol'] };
      await env.META.put(`meta:${slug}`, JSON.stringify(meta));
      const cookie = await putSession(env, 'bob');
      const logged = [];
      const error = console.error;
      console.error = (...args) => { logged.push(args.join(' ')); };
      let response;
      try {
        const ctx = makeCtx();
        response = await worker.fetch(req('/api/comments', {
          method: 'POST', cookie, body: { slug, version: 1, text: 'Rolling out, @carol.', anchor: null },
        }), env, ctx);
        await Promise.all(ctx.pending);
      } finally { console.error = error; }
      assert(response.status === 200, `expected 200, got ${response.status}`);
      const carol = JSON.parse(env.META.map.get('inbox:carol') || 'null');
      assert(carol && carol.items.some((row) => row.kind === 'mention'), 'the mention row was lost');
      const alice = JSON.parse(env.META.map.get('inbox:alice') || 'null');
      assert(alice && alice.items.some((row) => row.kind === 'comment'), 'the owner row was lost');
      assert([...env.META.map.keys()].some((k) => k.startsWith('contacts:')), 'the contact was lost');
      assert(logged.some((line) => line.includes('[serial] lane unavailable')), `fallback not logged: ${logged.join(' | ')}`);
      // The owner's own comment stamps their journey through the same lane.
      const owner = await issue(worker, env, 'alice');
      const ownCtx = makeCtx();
      const own = await worker.fetch(req('/api/comments', {
        method: 'POST', cookie: owner.cookie, body: { slug, version: 1, text: 'My own note.', anchor: null },
      }), env, ownCtx);
      console.error = () => {};
      try { await Promise.all(ownCtx.pending); } finally { console.error = error; }
      assert(own.status === 200, `owner post: ${own.status}`);
      const journey = JSON.parse(env.META.map.get(`account-onboarding:${owner.account_id}`) || 'null');
      assert(journey && journey.commented, `the onboarding stamp was lost: ${JSON.stringify(journey)}`);
    });
  }

  await t('without a request context the follow-up work is awaited, as before', async () => {
    const env = makeEnv(mod.CommentsStore);
    const slug = 'critical-path-no-ctx';
    await seedDoc(env, slug);
    const cookie = await putSession(env, 'bob');
    const response = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie, body: { slug, version: 1, text: 'No ctx here.', anchor: null },
    }), env, {});
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(env.META.map.has('inbox:alice'), 'the inbox row is missing on return');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
