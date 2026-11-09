// "Seen up to" per person per thread on the server (/api/comments/seen):
// the read state the doc page, the space page and the feedback widget share.
// Authorized exactly like reading the comments; no cross-doc reads; nobody
// who cannot read the comments learns which threads exist.
// Run with: node test/thread-seen-api.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const APP = 'http://localhost:3000';
const OTHER_APP = 'http://localhost:5173';

(async () => {
  console.log('thread seen: server-side read state, authorized like the comments');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (pathname, opts) => {
    const r = await worker.fetch(req(pathname, opts), mod.__env || opts.env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };

  async function setup() {
    const env = makeEnv(mod.CommentsStore);
    const f = (pathname, opts = {}) => call(pathname, { ...opts, env });
    const julie = await putSession(env, 'julie');
    const space = (await f('/api/feedback/connect', { method: 'POST', cookie: julie, body: { origin: APP } })).body;
    const other = (await f('/api/feedback/connect', { method: 'POST', cookie: julie, body: { origin: OTHER_APP } })).body;
    const anchor = (url) => ({ kind: 'product', url: `${url}/`, selector: '#x', tag: 'button', text: 'x' });
    const c1 = (await f('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'one', anchor: anchor(APP) } })).body;
    const c2 = (await f('/api/comments', { method: 'POST', token: other.token, body: { slug: other.slug, version: 1, text: 'two', anchor: anchor(OTHER_APP) } })).body;
    assert(c1 && c1.id && c2 && c2.id, `comments not made: ${JSON.stringify([c1, c2])}`);
    return { env, f, julie, space, other, c1: c1.id, c2: c2.id };
  }
  const seenGet = (f, slug, auth) => f(`/api/comments/seen?slug=${encodeURIComponent(slug)}`, auth);
  const seenPost = (f, slug, seen, auth) => f('/api/comments/seen', { method: 'POST', body: { slug, seen }, ...auth });

  await t('a reader keeps their own map; the widget token and the tdoc cookie see the same one', async () => {
    const { f, julie, space, c1 } = await setup();
    const empty = await seenGet(f, space.slug, { token: space.token });
    assert(empty.status === 200 && JSON.stringify(empty.body.seen) === '{}', `empty: ${empty.status} ${empty.text}`);
    const stamp = Date.parse('2026-11-01T10:00:00Z');
    const posted = await seenPost(f, space.slug, { [c1]: stamp }, { token: space.token });
    assert(posted.status === 200 && posted.body.seen[c1] === stamp, `post: ${posted.status} ${posted.text}`);
    // Read in the widget, read on the space's tdoc page (cookie).
    const viaCookie = await seenGet(f, space.slug, { cookie: julie });
    assert(viaCookie.status === 200 && viaCookie.body.seen[c1] === stamp, `cookie view: ${viaCookie.text}`);
    // And the reverse: a later mark on tdoc is what the widget reads.
    await seenPost(f, space.slug, { [c1]: stamp + 5000 }, { cookie: julie });
    const viaToken = await seenGet(f, space.slug, { token: space.token });
    assert(viaToken.body.seen[c1] === stamp + 5000, `token view: ${viaToken.text}`);
    // Never backwards.
    const older = await seenPost(f, space.slug, { [c1]: stamp }, { cookie: julie });
    assert(older.body.seen[c1] === stamp + 5000, 'an older mark lowered the record');
  });

  await t('only threads the doc holds are kept: no ids from another doc, no made-up ids, no future stamps', async () => {
    const { f, julie, space, c1, c2 } = await setup();
    const far = Date.now() + 365 * 86400000;
    const r = await seenPost(f, space.slug, { [c2]: 1000, c_made_up_1: 1000, '../x': 5, [c1]: far }, { cookie: julie });
    assert(r.status === 200, `post: ${r.status}`);
    assert(!(c2 in r.body.seen) && !('c_made_up_1' in r.body.seen) && !('../x' in r.body.seen), `kept: ${JSON.stringify(r.body.seen)}`);
    assert(r.body.seen[c1] <= Date.now() + 60_000, 'a stamp from the future was kept as is');
    const otherDoc = await seenGet(f, space.slug, { cookie: julie });
    assert(!(c2 in otherDoc.body.seen), 'another doc\'s thread leaked into this map');
  });

  await t('a feedback token reaches only its own doc\'s map', async () => {
    const { f, space, other, c2 } = await setup();
    const read = await seenGet(f, other.slug, { token: space.token });
    assert(read.status === 403 && read.body.error === 'feedback_token_scope', `cross read: ${read.status} ${read.text}`);
    const write = await seenPost(f, other.slug, { [c2]: 1000 }, { token: space.token });
    assert(write.status === 403 && write.body.error === 'feedback_token_scope', `cross write: ${write.status} ${write.text}`);
    // Same answers as the comments themselves.
    const comments = await f(`/api/comments?slug=${other.slug}&version=1`, { token: space.token });
    assert(comments.status === read.status && comments.body.error === read.body.error, 'answered unlike the comments');
  });

  await t('someone who cannot read the comments is refused exactly as the comments refuse them, and learns nothing about ids', async () => {
    const { env, f, space, c1 } = await setup();
    const bob = await putSession(env, 'bob');
    const comments = await f(`/api/comments?slug=${space.slug}&version=1`, { cookie: bob });
    assert(comments.status === 403, `bob reads the comments: ${comments.status}`);
    const get = await seenGet(f, space.slug, { cookie: bob });
    const real = await seenPost(f, space.slug, { [c1]: 1000 }, { cookie: bob });
    const fake = await seenPost(f, space.slug, { c_does_not_exist: 1000 }, { cookie: bob });
    for (const r of [get, real, fake]) {
      assert(r.status === comments.status && r.body.error === comments.body.error, `answered unlike the comments: ${r.status} ${r.text}`);
    }
    assert(real.text === fake.text, 'a real thread id and a made-up one were answered differently');
    // Signed out: the comments' answer, too.
    const anonComments = await f(`/api/comments?slug=${space.slug}&version=1`, {});
    const anon = await seenPost(f, space.slug, { [c1]: 1000 }, {});
    assert(anon.status === anonComments.status && anon.body.error === anonComments.body.error, `anon: ${anon.status} vs ${anonComments.status}`);
    // A doc that does not exist answers like one that does and is closed.
    const missing = await seenGet(f, 'no-such-doc-here', { cookie: bob });
    const missingComments = await f('/api/comments?slug=no-such-doc-here&version=1', { cookie: bob });
    assert(missing.status === missingComments.status, `missing: ${missing.status} vs ${missingComments.status}`);
    // Julie's record is untouched by any of it.
    const mine = await seenGet(f, space.slug, { token: space.token });
    assert(JSON.stringify(mine.body.seen) === '{}', `julie's map changed: ${mine.text}`);
  });

  await t('each reader has their own record; an agent token has none', async () => {
    const { env, f, julie, space, c1 } = await setup();
    // Open the space to signed-in readers, so bob may read it.
    const meta = JSON.parse(await env.META.get(`meta:${space.slug}`));
    meta.access = { ...(meta.access || {}), visibility: 'public' };
    await env.META.put(`meta:${space.slug}`, JSON.stringify(meta));
    const bob = await putSession(env, 'bob');
    assert((await f(`/api/comments?slug=${space.slug}&version=1`, { cookie: bob })).status === 200, 'bob cannot read the public space');
    await seenPost(f, space.slug, { [c1]: 7000 }, { cookie: bob });
    const bobs = await seenGet(f, space.slug, { cookie: bob });
    const julies = await seenGet(f, space.slug, { cookie: julie });
    assert(bobs.body.seen[c1] === 7000 && !(c1 in julies.body.seen), `shared records: ${bobs.text} / ${julies.text}`);
    // Signed out on a public doc: nobody to keep it for.
    const anon = await seenGet(f, space.slug, {});
    assert(anon.status === 401 && anon.body.error === 'sign_in_required', `anon: ${anon.status} ${anon.text}`);
    // An agent's upload token reads comments; it has no read state.
    const agent = await issue(worker, env, 'julie');
    const viaAgent = await seenGet(f, space.slug, { token: agent.token });
    assert(viaAgent.status === 401 || viaAgent.status === 403, `agent token: ${viaAgent.status} ${viaAgent.text}`);
  });

  await t('an oversized body is refused before it is read; a write past the hourly budget gets 429', async () => {
    const { f, julie, space, c1 } = await setup();
    const big = { slug: space.slug, seen: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`c_pad_${String(i).padStart(10, '0')}`, 1])) };
    const r = await f('/api/comments/seen', { method: 'POST', cookie: julie, body: big });
    assert(r.status === 413 && r.body.error === 'body_too_large', `big: ${r.status} ${r.text}`);
    let last = null;
    for (let i = 1; i <= 241; i++) {
      last = await seenPost(f, space.slug, { [c1]: 1000 + i }, { cookie: julie });
      if (last.status !== 200) break;
    }
    assert(last.status === 429 && last.body.error === 'rate_limited', `budget: ${last.status} ${last.text}`);
  });

  await t('a POST that raises nothing reads no comments and writes nothing; a KV refusal is a 503, not a 500', async () => {
    const { env, f, julie, space, c1 } = await setup();
    await seenPost(f, space.slug, { [c1]: 5000 }, { cookie: julie });
    const put = env.META.put.bind(env.META);
    let puts = 0;
    env.META.put = async (key, ...rest) => { if (/^(thread-seen|rl):/.test(String(key))) puts++; return put(key, ...rest); };
    const idFromName = env.COMMENTS.idFromName.bind(env.COMMENTS);
    let reads = 0;
    env.COMMENTS.idFromName = (name) => { reads++; return idFromName(name); };
    const same = await seenPost(f, space.slug, { [c1]: 5000 }, { cookie: julie });
    const older = await seenPost(f, space.slug, { [c1]: 10 }, { cookie: julie });
    assert(same.status === 200 && older.status === 200 && same.body.seen[c1] === 5000, `no-op answers: ${same.text} ${older.text}`);
    assert(puts === 0, `${puts} KV writes for a POST that raised nothing`);
    assert(reads === 0, `${reads} comment reads for a POST that raised nothing`);
    env.COMMENTS.idFromName = idFromName;
    env.META.put = async (key, ...rest) => { if (String(key).startsWith('thread-seen:')) { const e = new Error('KV PUT failed: 429 Too Many Requests'); throw e; } return put(key, ...rest); };
    const refused = await seenPost(f, space.slug, { [c1]: 9000 }, { cookie: julie });
    env.META.put = put;
    assert(refused.status === 503 && refused.body.error === 'seen_unavailable', `kv refusal: ${refused.status} ${refused.text}`);
  });

  await t('a site (SDK) token reads its holder\'s read state but never writes it', async () => {
    const { env, f, space, c1 } = await setup();
    const rec = JSON.parse(await env.META.get(`feedback:token:${space.token}`));
    const siteToken = `fb_${'cd'.repeat(24)}`;
    await env.META.put(`feedback:token:${siteToken}`, JSON.stringify({ ...rec, site: true }));
    const read = await seenGet(f, space.slug, { token: siteToken });
    assert(read.status === 200, `site GET: ${read.status} ${read.text}`);
    const write = await seenPost(f, space.slug, { [c1]: 1000 }, { token: siteToken });
    assert(write.status === 403 && write.body.error === 'feedback_token_scope', `site POST: ${write.status} ${write.text}`);
  });

  await t('a POST names the ids the doc does not hold, and only those', async () => {
    const { f, julie, space, c1, c2 } = await setup();
    const r = await seenPost(f, space.slug, { [c1]: 1000, [c2]: 1000, c_gone_x: 1000 }, { cookie: julie });
    assert(r.status === 200, `post: ${r.status} ${r.text}`);
    assert(JSON.stringify([...r.body.unknown].sort()) === JSON.stringify([c2, 'c_gone_x'].sort()), `unknown: ${r.text}`);
    assert(r.body.seen[c1] === 1000, 'the real thread was not kept');
  });

  await t('when the account group cannot be read, the endpoint says 503, not another record', async () => {
    const { env, f, julie, space, c1 } = await setup();
    // A session tied to an account, whose group record cannot be read.
    const sid = 'f'.repeat(32);
    await env.META.put(`session:${sid}`, JSON.stringify({ ...JSON.parse(await env.META.get(`session:${julie.split('=')[1]}`)), account_id: 'acct_unreadable' }));
    const get = env.META.get.bind(env.META);
    let armed = false;
    env.META.get = async (key, ...rest) => { if (armed && String(key).startsWith('account-group:acct_unreadable')) throw new Error('KV down'); return get(key, ...rest); };
    armed = true;
    const r = await seenGet(f, space.slug, { cookie: `tdoc_sid=${sid}` });
    const w = await seenPost(f, space.slug, { [c1]: 1000 }, { cookie: `tdoc_sid=${sid}` });
    env.META.get = get;
    assert([r.status, w.status].every((s) => s === 503 || s === 401 || s === 403), `group unavailable: ${r.status} ${w.status} ${r.text}`);
    assert(r.status !== 200 && w.status !== 200, 'answered from a record it could not be sure of');
  });

  await t('a chunked body past 64 KB is refused without being read to the end', async () => {
    const { env, julie, space } = await setup();
    const enc = new TextEncoder();
    const head = enc.encode(`{"slug":"${space.slug}","seen":{"x":"`);
    let sentBytes = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sentBytes > 1024 * 1024) { controller.close(); return; }
        const chunk = sentBytes === 0 ? head : new Uint8Array(16 * 1024).fill(97);
        sentBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const r = await worker.fetch(new Request('https://tdoc.dev/api/comments/seen', { method: 'POST', headers: { Cookie: julie, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' }), env, {});
    const body = await r.json();
    assert(r.status === 413 && body.error === 'body_too_large', `chunked: ${r.status} ${JSON.stringify(body)}`);
    assert(sentBytes < 256 * 1024, `read ${sentBytes} bytes of a body past the cap`);
  });

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
