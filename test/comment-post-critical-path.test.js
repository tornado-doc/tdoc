// Posting a comment answers once the comment is saved. What follows it --
// the inbox rows (and the push and email they send), the writer's contacts,
// onboarding stamps, the search reindex, a team backup -- runs after the
// response (ctx.waitUntil), still runs every time, and never holds the
// composer on "Posting…" (Julie, 2026-11-11).
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');

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
