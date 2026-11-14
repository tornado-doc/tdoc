// Write with tdoc AI (New menu, flag writeWithTdocAi): one sentence, tdoc AI
// drafts the doc server-side and it is published as v1, private, owned by
// the person who asked.
//   - browser sessions only, same-site writes, signed in;
//   - dev mode (or a PR preview) only, held on the server: 404 otherwise;
//   - off without the tdoc AI key (503), like Ask this doc;
//   - the sentence is capped; a few drafts per window per account;
//   - the Ask this doc free allowance is charged first, WRITE_AI_ASK_UNITS (3)
//     per draft, and given back when the model or the create fails, or when
//     the person watching leaves mid-stream; out of it, nothing is created;
//   - Accept: text/event-stream streams the draft (delta events, then done
//     with the url, or error); without it the answer is one JSON body;
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
  env.ASK_FREE_LIMIT = '9';

  const calls = [];
  let reply = () => ({ status: 200, body: { choices: [{ message: { content: '# Packing list for Iceland\n\n## Clothes\n\n- Wool layers\n- Rain shell\n\n| Item | Count |\n| --- | --- |\n| Socks | 5 |' } }] } });
  // A streamed reply: the pieces as chat-completions SSE, or `raw` lines.
  let streamReply = null;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    const sent = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, body: sent });
    if (sent && sent.stream && streamReply) {
      const { pieces = [], raw = null, delay = 5, status = 200 } = streamReply();
      if (status !== 200) return new Response(JSON.stringify({ error: { message: 'down' } }), { status, headers: { 'Content-Type': 'application/json' } });
      const enc = new TextEncoder();
      const lines = raw || [': OPENROUTER PROCESSING', ...pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p, reasoning: 'scratch' } }] })}`), 'data: [DONE]'];
      const signal = init.signal;
      const body = new ReadableStream({
        async start(c) {
          for (const line of lines) {
            if (signal && signal.aborted) return;
            await new Promise((r) => setTimeout(r, delay));
            try { c.enqueue(enc.encode(`${line}\n\n`)); } catch { return; }
          }
          try { c.close(); } catch {}
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    const r = reply();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  // Server-sent events, read to the end: [{ event, data }].
  const parseSse = (text) => text.split('\n\n').filter((b) => /^event:/m.test(b)).map((b) => ({
    event: b.match(/^event: (.*)$/m)[1],
    data: JSON.parse(b.match(/^data: (.*)$/m)[1]),
  }));
  const writeSse = async (cookie, body) => {
    const r = await worker.fetch(req('/api/write-with-ai', { method: 'POST', cookie, headers: { Origin: ORIGIN, Accept: 'text/event-stream' }, body }), env, {});
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, type: r.headers.get('content-type') || '', nosniff: r.headers.get('x-content-type-options'), text, body: json, events: json ? [] : parseSse(text) };
  };
  const clearRate = async () => { for (const k of (await env.META.list({ prefix: 'rl:write-ai:' })).keys) await env.META.delete(k.name); };
  const remainingOf = async (cookie) => (await call('/api/write-with-ai', { cookie })).body.remaining;
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
    assert(left.status === 200 && left.body.remaining === 9 && left.body.units === 3, JSON.stringify(left.body));
  });

  let slug = null;
  await t('one sentence publishes v1, private, owned by the person who asked', async () => {
    const r = await write(dev, { prompt: 'A packing list for a week in Iceland, mail me at me@x.com' });
    assert(r.status === 200 && r.body.ok, `${r.status} ${r.text}`);
    slug = r.body.slug;
    assert(r.body.version === 1 && r.body.url === `/d/${slug}/v/1`);
    assert(r.body.title === 'Packing list for Iceland', r.body.title);
    // A draft is three of the Ask allowance (WRITE_AI_ASK_UNITS).
    assert(r.body.remaining === 6 && r.body.units === 3, `remaining ${r.body.remaining}`);
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
    // Six used above; the third draft is the last one (limit 9). A fresh
    // rate window, so the allowance is what stops the fourth.
    await clearRate();
    assert((await write(dev, { prompt: 'third' })).status === 200);
    const before = await docCount();
    const n = calls.length;
    const r = await write(dev, { prompt: 'fourth' });
    assert(r.status === 429 && r.body.error === 'ask_limit' && r.body.connect_href === '/start', `${r.status} ${r.text}`);
    assert(calls.length === n, 'the model ran past the allowance');
    assert(await docCount() === before, 'a doc was created past the allowance');
    // Streaming asked for: refused the same way, as JSON, before any stream.
    const s = await writeSse(dev, { prompt: 'fifth' });
    assert(s.status === 429 && s.body && s.body.error === 'ask_limit', `${s.status} ${s.text}`);
    assert(calls.length === n, 'the model ran past the allowance');
  });

  await t('a draft needs all three units: two left is not enough, and nothing is charged', async () => {
    env.ASK_FREE_LIMIT = '11';
    await clearRate();
    const r = await write(dev, { prompt: 'one more' });
    assert(r.status === 429 && r.body.error === 'ask_limit' && r.body.remaining === 2 && /uses 3/.test(r.body.message), `${r.status} ${r.text}`);
    assert(await remainingOf(dev) === 2, 'charged anyway');
  });

  await t('a model failure gives the request back and creates nothing', async () => {
    const other = await session('dev.writer@example.com', 'df'.repeat(16)); // same person, other sign-in
    env.ASK_FREE_LIMIT = '20';
    // A fresh rate window (the limit has its own test below).
    await clearRate();
    reply = () => ({ status: 500, body: { error: { message: 'down' } } });
    await clearRate();
    const before = await docCount();
    const left = (await call('/api/write-with-ai', { cookie: other })).body.remaining;
    const r = await write(other, { prompt: 'something' });
    assert(r.status === 502 && r.body.error === 'write_failed', `${r.status} ${r.text}`);
    assert(await docCount() === before, 'a doc was created');
    assert((await call('/api/write-with-ai', { cookie: other })).body.remaining === left, 'the request was not given back');
  });

  await t('streamed: the Markdown arrives as delta events, then done with the stored doc', async () => {
    env.ASK_FREE_LIMIT = '30';
    await clearRate();
    const pieces = ['# Strea', 'med plan\n\n## Steps', '\n\n- One\n- Two\n'];
    streamReply = () => ({ pieces });
    const left = await remainingOf(dev);
    const r = await writeSse(dev, { prompt: 'a streamed plan' });
    assert(r.status === 200 && /^text\/event-stream/.test(r.type) && r.nosniff === 'nosniff', `${r.status} ${r.type} ${r.text}`);
    const kinds = r.events.map((e) => e.event);
    assert(JSON.stringify(kinds) === JSON.stringify(['delta', 'delta', 'delta', 'done']), kinds.join(','));
    assert(r.events.slice(0, 3).map((e) => e.data.text).join('') === pieces.join(''), 'deltas are not the answer, in order');
    assert(!r.text.includes('scratch'), 'reasoning reached the reader');
    const done = r.events[3].data;
    assert(done.ok && done.version === 1 && done.url === `/d/${done.slug}/v/1` && done.title === 'Streamed plan', JSON.stringify(done));
    assert(done.remaining === left - 3, `charged ${left - done.remaining}`);
    const last = calls[calls.length - 1].body;
    assert(last.stream === true && last.max_tokens >= 6000, JSON.stringify(last));
    const meta = JSON.parse(await env.META.get(`meta:${done.slug}`));
    assert(meta.access.visibility === 'private' && meta.created_from === 'tdoc-ai');
    const html = await (await env.DOCS.get(`docs/${done.slug}/v1/index.html`)).text();
    assert(/<h2[^>]*>Steps<\/h2>/.test(html) && /<li>One<\/li>/.test(html), 'not stored as today');
  });

  await t('streamed: a <script> split across pieces is text in the stored doc', async () => {
    await clearRate();
    streamReply = () => ({ pieces: ['# Hi\n\n<scr', 'ipt>alert(document.cookie)</scr', 'ipt>\n\n<img src=x on', 'error="alert(1)">'] });
    const r = await writeSse(dev, { prompt: 'anything' });
    const done = r.events.find((e) => e.event === 'done');
    assert(done, r.text);
    const html = await (await env.DOCS.get(`docs/${done.data.slug}/v1/index.html`)).text();
    assert(!/<script>alert/i.test(html) && !/<img[^>]*onerror/i.test(html), 'markup from the model reached the page');
    assert(/&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/.test(html), 'not shown as text');
    // On the wire it is JSON in an event-stream (nosniff), never HTML.
    assert(r.events.filter((e) => e.event === 'delta').every((e) => typeof e.data.text === 'string'));
  });

  await t('streamed: the model fails (before or mid-stream): error event, given back, nothing created', async () => {
    await clearRate();
    const before = await docCount();
    const left = await remainingOf(dev);
    streamReply = () => ({ status: 500 });
    const a = await writeSse(dev, { prompt: 'fails' });
    assert(a.status === 200 && a.events.length === 1 && a.events[0].event === 'error' && a.events[0].data.error === 'write_failed' && a.events[0].data.status === 502, a.text);
    streamReply = () => ({ raw: [`data: ${JSON.stringify({ choices: [{ delta: { content: '# Half' } }] })}`, `data: ${JSON.stringify({ error: { message: 'overloaded', code: 502 } })}`] });
    const b = await writeSse(dev, { prompt: 'fails later' });
    assert(JSON.stringify(b.events.map((e) => e.event)) === '["delta","error"]', b.text);
    assert(await docCount() === before, 'a doc was created');
    assert(await remainingOf(dev) === left, 'not given back');
  });

  await t('streamed: the reader leaves mid-stream: the model stops, given back, nothing created', async () => {
    await clearRate();
    const before = await docCount();
    const left = await remainingOf(dev);
    const n = calls.length;
    streamReply = () => ({ pieces: Array.from({ length: 40 }, (_, i) => `line ${i}\n`), delay: 20 });
    const r = await worker.fetch(req('/api/write-with-ai', { method: 'POST', cookie: dev, headers: { Origin: ORIGIN, Accept: 'text/event-stream' }, body: { prompt: 'leave early' } }), env, {});
    const reader = r.body.getReader();
    let seen = '';
    while (!seen.includes('event: delta')) seen += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    for (let i = 0; i < 100 && (await remainingOf(dev)) !== left; i++) await new Promise((res) => setTimeout(res, 20));
    assert(await remainingOf(dev) === left, 'not given back');
    await new Promise((res) => setTimeout(res, 300));
    assert(await docCount() === before, 'a doc was created');
    assert(calls.length === n + 1, 'retried');
  });

  await t('no Accept: text/event-stream: one JSON body, as before', async () => {
    await clearRate();
    reply = () => ({ status: 200, body: { choices: [{ message: { content: '# Plain' } }] } });
    const r = await write(dev, { prompt: 'plain' });
    assert(r.status === 200 && r.body.ok && r.body.title === 'Plain', r.text);
    assert(!calls[calls.length - 1].body.stream, 'asked the model to stream');
  });

  await t('streamed, flag off: 404 before anything streams', async () => {
    const r = await writeSse(plain, { prompt: 'A packing list' });
    assert(r.status === 404 && !/event-stream/.test(r.type), `${r.status} ${r.type}`);
  });

  await t('PR preview without a key: the fixed draft streams in several pieces', async () => {
    const pv = makeEnv(mod.CommentsStore);
    pv.TDOC_PREVIEW = '1';
    pv.TDOC_EMAIL_ALIAS_SECRET = 'test-alias-secret';
    delete pv.COMMENTS;
    await pv.META.put(`session:${'aa'.repeat(16)}`, JSON.stringify({ email: 'p@example.com', name: 'p', created: '2026-01-01T00:00:00.000Z' }));
    const n = calls.length;
    const r = await worker.fetch(req('/api/write-with-ai', { method: 'POST', cookie: `tdoc_sid=${'aa'.repeat(16)}`, headers: { Origin: ORIGIN, Accept: 'text/event-stream' }, body: { prompt: 'demo' } }), pv, {});
    const events = parseSse(await r.text());
    const deltas = events.filter((e) => e.event === 'delta');
    assert(deltas.length >= 3, `${deltas.length} pieces`);
    assert(deltas.map((e) => e.data.text).join('').startsWith('# Preview draft'), 'not the fixed draft');
    const done = events[events.length - 1];
    assert(done.event === 'done' && done.data.url, JSON.stringify(done));
    assert(calls.length === n, 'the preview called a model');
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
