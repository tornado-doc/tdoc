// Write with tdoc AI (New menu, flag writeWithTdocAi): one sentence, tdoc AI
// drafts the doc server-side and it is published as v1, private, owned by
// the person who asked.
//   - browser sessions only, same-site writes, signed in;
//   - dev mode (or a PR preview) only, held on the server: 404 otherwise;
//   - off without the tdoc AI key (503), like Ask this doc;
//   - the sentence is capped; a few drafts per window per account;
//   - the Ask this doc free allowance is charged first and given back when
//     the model or the create fails; out of it, nothing is created;
//   - the model's answer is Markdown and every character of it is escaped:
//     a <script> or an on* handler in it is text on the page, never markup.
// The chat-completions endpoint is mocked; nothing leaves the process.
// Run with: node test/write-with-ai.test.js

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ORIGIN = 'https://tdoc.dev';

(async () => {
  console.log('write with tdoc AI');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  env.TDOC_EMAIL_ALIAS_SECRET = 'test-alias-secret';
  env.TDOC_DEBUG_ACCOUNTS = 'dev.writer@example.com';
  env.ASK_API_KEY = 'test-key';
  env.ASK_FREE_LIMIT = '3';

  const calls = [];
  let reply = () => ({ status: 200, body: { choices: [{ message: { content: '# Packing list for Iceland\n\n## Clothes\n\n- Wool layers\n- Rain shell\n\n| Item | Count |\n| --- | --- |\n| Socks | 5 |' } }] } });
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    const r = reply();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const session = async (email, sid) => {
    await env.META.put(`session:${sid}`, JSON.stringify({ email, name: email, created: '2026-01-01T00:00:00.000Z' }));
    return `tdoc_sid=${sid}`;
  };
  const dev = await session('dev.writer@example.com', 'de'.repeat(16));
  const plain = await session('plain.reader@example.com', 'ab'.repeat(16));
  const write = (cookie, body, headers = { Origin: ORIGIN }) => call('/api/write-with-ai', { method: 'POST', cookie, headers, body });
  const docCount = async () => (await env.META.list({ prefix: 'meta:' })).keys.length;

  await t('signed out: 401; a token: refused', async () => {
    assert((await write(null, { prompt: 'x' })).status === 401);
    const r = await call('/api/write-with-ai', { method: 'POST', token: 'tdoc_x', headers: { Origin: ORIGIN }, body: { prompt: 'x' } });
    assert(r.status === 403 || r.status === 401, `token ${r.status}`);
  });

  await t('not in dev mode: the route does not exist', async () => {
    const r = await write(plain, { prompt: 'A packing list' });
    assert(r.status === 404, `${r.status}`);
    assert(!calls.length, 'the model ran');
  });

  await t('cross-site or Origin-less writes are refused', async () => {
    assert((await write(dev, { prompt: 'x' }, { Origin: 'https://evil.example' })).status === 403);
    assert((await write(dev, { prompt: 'x' }, {})).status === 403);
    assert(!calls.length, 'the model ran');
  });

  await t('empty or too long a sentence: 400, nothing charged', async () => {
    assert((await write(dev, { prompt: '   ' })).status === 400);
    const long = await write(dev, { prompt: 'x'.repeat(501) });
    assert(long.status === 400 && long.body.error === 'prompt_too_long', `${long.status} ${long.text}`);
    const left = await call('/api/write-with-ai', { cookie: dev });
    assert(left.status === 200 && left.body.remaining === 3, JSON.stringify(left.body));
  });

  let slug = null;
  await t('one sentence publishes v1, private, owned by the person who asked', async () => {
    const r = await write(dev, { prompt: 'A packing list for a week in Iceland, mail me at me@x.com' });
    assert(r.status === 200 && r.body.ok, `${r.status} ${r.text}`);
    slug = r.body.slug;
    assert(r.body.version === 1 && r.body.url === `/d/${slug}/v/1`);
    assert(r.body.title === 'Packing list for Iceland', r.body.title);
    assert(r.body.remaining === 2, `remaining ${r.body.remaining}`);
    const meta = JSON.parse(await env.META.get(`meta:${slug}`));
    assert(meta.access.visibility === 'private', JSON.stringify(meta.access));
    assert(meta.hosted && meta.hosted.account_id, 'no owner stamped');
    assert(meta.versions.length === 1 && meta.created_from === 'tdoc-ai');
    const html = await (await env.DOCS.get(`docs/${slug}/v1/index.html`)).text();
    assert(/<h2[^>]*>Clothes<\/h2>/.test(html) && /<table/.test(html), 'markdown not rendered');
    assert(/data-tdoc-aid=/.test(html), 'not stamped like any other version');
    const sent = calls[calls.length - 1].body;
    assert(!JSON.stringify(sent).includes('me@x.com'), 'an address left the worker');
    // Only the owner reads it.
    const other = await call(`/d/${slug}/v/1/raw`, { cookie: plain });
    assert(other.status === 404 || other.status === 403 || other.status === 401, `other reader ${other.status}`);
  });

  await t('model output is never markup: <script> and on* handlers end up as text', async () => {
    reply = () => ({ status: 200, body: { choices: [{ message: { content: '# Hi <img src=x onerror="alert(1)">\n\n<script>alert(document.cookie)</script>\n\n<a href="javascript:alert(2)" onclick="alert(3)">x</a> [y](javascript:alert(4))' } }] } });
    const r = await write(dev, { prompt: 'anything' });
    assert(r.status === 200, `${r.status} ${r.text}`);
    const html = await (await env.DOCS.get(`docs/${r.body.slug}/v1/index.html`)).text();
    assert(!/<script>alert/i.test(html), 'a script tag from the model reached the page');
    assert(!/<img[^>]*onerror/i.test(html) && !/<a[^>]*onclick/i.test(html), 'an on* handler reached the page');
    assert(!/href="javascript:/i.test(html), 'a javascript: link reached the page');
    assert(/&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/.test(html), 'not shown as text');
    assert(!/[<>]/.test(r.body.title), r.body.title);
  });

  await t('out of the free allowance: refused, and no doc is created', async () => {
    reply = () => ({ status: 200, body: { choices: [{ message: { content: '# Third' } }] } });
    // Two used above; the third is the last one (limit 3). A fresh rate
    // window, so the allowance is what stops the fourth.
    for (const k of (await env.META.list({ prefix: 'rl:write-ai:' })).keys) await env.META.delete(k.name);
    assert((await write(dev, { prompt: 'third' })).status === 200);
    const before = await docCount();
    const n = calls.length;
    const r = await write(dev, { prompt: 'fourth' });
    assert(r.status === 429 && r.body.error === 'ask_limit' && r.body.connect_href === '/start', `${r.status} ${r.text}`);
    assert(calls.length === n, 'the model ran past the allowance');
    assert(await docCount() === before, 'a doc was created past the allowance');
  });

  await t('a model failure gives the request back and creates nothing', async () => {
    const other = await session('dev.writer@example.com', 'df'.repeat(16)); // same person, other sign-in
    env.ASK_FREE_LIMIT = '10';
    // A fresh rate window (the limit has its own test below).
    for (const k of (await env.META.list({ prefix: 'rl:write-ai:' })).keys) await env.META.delete(k.name);
    reply = () => ({ status: 500, body: { error: { message: 'down' } } });
    const before = await docCount();
    const left = (await call('/api/write-with-ai', { cookie: other })).body.remaining;
    const r = await write(other, { prompt: 'something' });
    assert(r.status === 502 && r.body.error === 'write_failed', `${r.status} ${r.text}`);
    assert(await docCount() === before, 'a doc was created');
    assert((await call('/api/write-with-ai', { cookie: other })).body.remaining === left, 'the request was not given back');
  });

  await t('rate-limited per account', async () => {
    for (const k of (await env.META.list({ prefix: 'rl:write-ai:' })).keys) await env.META.delete(k.name);
    reply = () => ({ status: 200, body: { choices: [{ message: { content: '# Ok' } }] } });
    let limited = null;
    for (let i = 0; i < 6 && !limited; i++) {
      const r = await write(dev, { prompt: `draft ${i}` });
      if (r.status === 429 && r.body.error === 'rate_limited') limited = r;
    }
    assert(limited && limited.body.retry_after > 0, 'never rate-limited');
  });

  await t('off without the tdoc AI key', async () => {
    delete env.ASK_API_KEY;
    const r = await write(dev, { prompt: 'x' });
    assert(r.status === 503 && r.body.error === 'ask_unavailable', `${r.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
