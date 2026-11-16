// Write with tdoc AI (New menu, flag writeWithTdocAi): one sentence, tdoc AI
// drafts the doc server-side and it is published as v1, private, owned by
// the person who asked.
//   - browser sessions only, same-site writes, signed in;
//   - every signed-in person (writeWithTdocAi graduated 2026-11-16), no dev
//     mode needed; a feedback session or a team agent: 404;
//   - off without the tdoc AI key (503), like Ask this doc;
//   - the sentence is capped; a few drafts per window per account;
//   - what the create would refuse that is knowable up front (the doc quota,
//     a team's plan) is refused before anything is charged or the model runs;
//   - the Ask this doc free allowance is charged first, WRITE_AI_ASK_UNITS (3)
//     per draft, and given back only when no piece of the draft was delivered
//     (the model failed, or the person left, before the first piece); out of
//     it, nothing is created;
//   - one draft at a time per account (a lock in the allowance's Durable
//     Object), so parallel requests cannot slip past the rate limit;
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
      const { pieces = [], raw = null, delay = 5, status = 200, thoughts = [], field = 'reasoning', firstDelay = 0, finish = null, usage = null, rejectOptions = false } = streamReply();
      // A provider that does not know stream_options refuses the request.
      if (rejectOptions && sent.stream_options) return new Response(JSON.stringify({ error: { message: 'unknown field stream_options' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (status !== 200) return new Response(JSON.stringify({ error: { message: 'down' } }), { status, headers: { 'Content-Type': 'application/json' } });
      const enc = new TextEncoder();
      // `thoughts`: reasoning-only deltas first (in `field`), as a reasoning
      // model sends before its answer. Every answer piece also carries a
      // reasoning 'scratch', which never reaches the reader.
      const lines = raw || [
        ': OPENROUTER PROCESSING',
        ...thoughts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: '', [field]: t } }] })}`),
        ...pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p, reasoning: 'scratch' } }] })}`),
        ...(finish ? [`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}`] : []),
        ...(usage ? [`data: ${JSON.stringify({ choices: [], usage })}`] : []),
        'data: [DONE]',
      ];
      const signal = init.signal;
      const body = new ReadableStream({
        async start(c) {
          for (const [i, line] of lines.entries()) {
            if (signal && signal.aborted) return;
            await new Promise((r) => setTimeout(r, i === 1 && firstDelay ? firstDelay : delay));
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

  await t('not in dev mode: the route is there too (graduated)', async () => {
    const r = await call('/api/write-with-ai', { cookie: plain });
    assert(r.status === 200 && r.body.available === true, `${r.status} ${r.text}`);
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
    assert(JSON.stringify(kinds) === JSON.stringify(['delta', 'delta', 'delta', 'publishing', 'done']), kinds.join(','));
    assert(r.events.slice(0, 3).map((e) => e.data.text).join('') === pieces.join(''), 'deltas are not the answer, in order');
    assert(!r.text.includes('scratch'), 'reasoning reached the reader');
    const done = r.events[4].data;
    assert(done.cutoff === null, JSON.stringify(done.cutoff));
    const tm = done.timing;
    // The shared ai_timing record (server/ai-timing.js), with this route's extras.
    assert(tm && tm.event === 'ai_timing' && tm.route === 'write_ai' && tm.stream === true && tm.model, JSON.stringify(tm));
    assert(tm.upstream_headers_ms >= 0 && tm.first_token_ms >= tm.upstream_headers_ms && tm.total_ms >= tm.first_token_ms, JSON.stringify(tm));
    // The mock's 'scratch' rides on every answer piece: counted, never shown.
    assert(tm.reasoning_chars === 'scratch'.length * pieces.length && tm.out_chars === pieces.join('').trim().length && tm.ok === true, JSON.stringify(tm));
    assert(done.ok && done.version === 1 && done.url === `/d/${done.slug}/v/1` && done.title === 'Streamed plan', JSON.stringify(done));
    assert(done.remaining === left - 3, `charged ${left - done.remaining}`);
    const last = calls[calls.length - 1].body;
    assert(last.stream === true && last.max_tokens >= 6000, JSON.stringify(last));
    const meta = JSON.parse(await env.META.get(`meta:${done.slug}`));
    assert(meta.access.visibility === 'private' && meta.created_from === 'tdoc-ai');
    const html = await (await env.DOCS.get(`docs/${done.slug}/v1/index.html`)).text();
    assert(/<h2[^>]*>Steps<\/h2>/.test(html) && /<li>One<\/li>/.test(html), 'not stored as today');
  });

  // A reasoning model: its thoughts stream as `thinking` before the draft,
  // each { text, elapsed_ms }, and are never part of the stored doc.
  for (const field of ['reasoning', 'reasoning_content']) {
    await t(`streamed, reasoning text in delta.${field}: thinking events with the text, then the draft; never stored`, async () => {
      await clearRate();
      const logs = [];
      const log = console.log;
      console.log = (...a) => { logs.push(a.join(' ')); };
      const thoughts = ['Plan the ', 'SECRET-THOUGHT sections.'];
      streamReply = () => ({ thoughts, field, pieces: ['# Thought plan\n\n', '- One\n'] });
      let r;
      try { r = await writeSse(dev, { prompt: 'a plan with private-words-xyz' }); } finally { console.log = log; }
      const kinds = r.events.map((e) => e.event);
      assert(JSON.stringify(kinds) === JSON.stringify(['thinking', 'thinking', 'delta', 'delta', 'publishing', 'done']), kinds.join(','));
      const th = r.events.filter((e) => e.event === 'thinking').map((e) => e.data);
      assert(th.map((d) => d.text).join('') === thoughts.join(''), JSON.stringify(th));
      assert(th.every((d) => Number.isInteger(d.elapsed_ms) && d.elapsed_ms >= 0), JSON.stringify(th));
      assert(!r.text.includes('scratch'), 'reasoning after the draft began reached the reader');
      const done = r.events[5].data;
      const tm = done.timing;
      assert(tm.reasoning_text === true && tm.reasoning_chars === thoughts.join('').length + 'scratch'.length * 2, JSON.stringify(tm));
      assert(tm.first_reasoning_ms != null && tm.first_reasoning_ms <= tm.first_token_ms, JSON.stringify(tm));
      const html = await (await env.DOCS.get(`docs/${done.slug}/v1/index.html`)).text();
      assert(!html.includes('SECRET-THOUGHT') && !html.includes('scratch'), 'reasoning stored in the doc');
      // One line per call: the ai_timing line, carrying the extras too.
      const timingLines = logs.filter((l) => /"event":"ai_timing"/.test(l));
      assert(timingLines.length === 1 && !logs.some((l) => l.startsWith('[write-with-ai timing]')), logs.join('\n'));
      const line = timingLines[0];
      const logged = JSON.parse(line);
      assert(logged.route === 'write_ai' && logged.reasoning_text === true && logged.first_token_ms === tm.first_token_ms, line);
      assert(!line.includes('private-words-xyz') && !line.includes('SECRET-THOUGHT') && !/acct|@/.test(line), `the log carries more than numbers: ${line}`);
    });
  }

  await t('streamed, a slow first token and no reasoning text: elapsed-only thinking events about once a second', async () => {
    await clearRate();
    streamReply = () => ({ firstDelay: 2300, raw: [': OPENROUTER PROCESSING', `data: ${JSON.stringify({ choices: [{ delta: { content: '# Slow\n' } }] })}`, 'data: [DONE]'] });
    const r = await writeSse(dev, { prompt: 'slow' });
    const th = r.events.filter((e) => e.event === 'thinking').map((e) => e.data);
    assert(th.length >= 1 && th.length <= 3, `${th.length} beats`);
    assert(th.every((d) => !('text' in d) && d.elapsed_ms >= 900), JSON.stringify(th));
    const first = r.events.findIndex((e) => e.event === 'delta');
    assert(first > r.events.findIndex((e) => e.event === 'thinking'), 'thinking after the draft');
    assert(r.events.slice(first).every((e) => e.event !== 'thinking'), 'a beat after the draft began');
    const done = r.events[r.events.length - 1];
    assert(done.data.timing.reasoning_text === false && done.data.timing.reasoning_chars === 0, JSON.stringify(done.data.timing));
    assert(done.event === 'done' && done.data.timing.first_token_ms >= 2000, JSON.stringify(done.data.timing));
  });

  await t('streamed: usage is asked for; finish_reason and token counts land in timing (done and the log)', async () => {
    env.ASK_FREE_LIMIT = '300';
    await clearRate();
    const logs = [];
    const log = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    streamReply = () => ({ pieces: ['# Counted\n'], finish: 'stop', usage: { prompt_tokens: 120, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } } });
    let r;
    try { r = await writeSse(dev, { prompt: 'counted' }); } finally { console.log = log; }
    const sentBody = calls[calls.length - 1].body;
    assert(sentBody.stream_options && sentBody.stream_options.include_usage === true, JSON.stringify(sentBody));
    const tm = r.events[r.events.length - 1].data.timing;
    assert(tm.finish_reason === 'stop' && tm.cutoff === null, JSON.stringify(tm));
    assert(JSON.stringify(tm.usage) === JSON.stringify({ prompt_tokens: 120, completion_tokens: 900, reasoning_tokens: 700 }), JSON.stringify(tm.usage));
    const logged = JSON.parse(logs.find((l) => /"event":"ai_timing"/.test(l)));
    assert(logged.finish_reason === 'stop' && logged.usage.reasoning_tokens === 700, JSON.stringify(logged));
  });

  await t('streamed: a provider that refuses stream_options is asked again without it', async () => {
    await clearRate();
    const n = calls.length;
    streamReply = () => ({ rejectOptions: true, pieces: ['# Fallback\n'] });
    const r = await writeSse(dev, { prompt: 'fallback' });
    const done = r.events.find((e) => e.event === 'done');
    assert(done && done.data.ok, r.text);
    assert(calls.length === n + 2 && calls[n].body.stream_options && !calls[n + 1].body.stream_options, JSON.stringify(calls.slice(n).map((c) => c.body.stream_options || null)));
    assert(done.data.timing.usage === null, 'usage without asking');
  });

  // Ended early, but with a draft: published all the same, and the dialog
  // is told why in one line (done.cutoff, timing.cutoff).
  for (const [name, reply, reason, message] of [
    ['the provider hit its length limit', () => ({ pieces: ['# Long\n\nhalf a sen'], finish: 'length' }), 'length', /^Stopped early: hit the length limit\. The end may be cut off\.$/],
    ['a content filter stopped it', () => ({ pieces: ['# Filtered\n\nsome'], finish: 'content_filter' }), 'filter', /^tdoc AI stopped this draft\.$/],
    ['a refusal', () => ({ raw: [`data: ${JSON.stringify({ choices: [{ delta: { content: '# Refused\n' } }] })}`, `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'I cannot help with that.' } }] })}`, 'data: [DONE]'] }), 'filter', /^tdoc AI stopped this draft\.$/],
    ['our length cap (WRITE_AI_MARKDOWN_CHARS)', () => ({ pieces: ['# Huge\n\n', ...Array.from({ length: 7 }, () => 'x'.repeat(10000))] }), 'length', /length limit/],
  ]) {
    await t(`streamed, cut off: ${name}: published, done.cutoff says so`, async () => {
      await clearRate();
      const before = await docCount();
      streamReply = reply;
      const r = await writeSse(dev, { prompt: `cut ${reason}` });
      const done = r.events[r.events.length - 1];
      assert(done.event === 'done' && done.data.ok, r.text.slice(0, 300));
      assert(done.data.cutoff && done.data.cutoff.reason === reason && message.test(done.data.cutoff.message), JSON.stringify(done.data.cutoff));
      assert(done.data.timing.cutoff === reason, JSON.stringify(done.data.timing));
      assert(r.events.some((e) => e.event === 'publishing'), 'no publishing event');
      assert(await docCount() === before + 1, 'not published');
    });
  }

  await t('streamed, cut off: the whole-draft time limit: what was written is published, done.cutoff time', async () => {
    await clearRate();
    env.ASK_STREAM_TOTAL_MS = '400';
    try {
      streamReply = () => ({ pieces: ['# Slow draft\n\n', 'line one\n', 'line two\n', 'line three\n', 'line four\n'], delay: 150 });
      const r = await writeSse(dev, { prompt: 'too slow' });
      const done = r.events[r.events.length - 1];
      assert(done.event === 'done' && done.data.ok && done.data.cutoff && done.data.cutoff.reason === 'time', r.text.slice(-400));
      assert(/time limit/.test(done.data.cutoff.message), done.data.cutoff.message);
    } finally { delete env.ASK_STREAM_TOTAL_MS; }
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

  await t('streamed: the model fails before its first piece: error event, given back, nothing created', async () => {
    await clearRate();
    const before = await docCount();
    const left = await remainingOf(dev);
    streamReply = () => ({ status: 500 });
    const a = await writeSse(dev, { prompt: 'fails' });
    assert(a.status === 200 && a.events.length === 1 && a.events[0].event === 'error' && a.events[0].data.error === 'write_failed' && a.events[0].data.status === 502 && a.events[0].data.charged === false, a.text);
    assert(await docCount() === before, 'a doc was created');
    assert(await remainingOf(dev) === left, 'not given back');
  });

  await t('streamed: the model fails after a piece was delivered: error event, still charged, nothing created', async () => {
    await clearRate();
    const before = await docCount();
    const left = await remainingOf(dev);
    streamReply = () => ({ raw: [`data: ${JSON.stringify({ choices: [{ delta: { content: '# Half' } }] })}`, `data: ${JSON.stringify({ error: { message: 'overloaded', code: 502 } })}`] });
    const b = await writeSse(dev, { prompt: 'fails later' });
    assert(JSON.stringify(b.events.map((e) => e.event)) === '["delta","error"]', b.text);
    assert(b.events[1].data.charged === true && !/Nothing was charged/.test(b.events[1].data.message), JSON.stringify(b.events[1].data));
    assert(await docCount() === before, 'a doc was created');
    assert(await remainingOf(dev) === left - 3, `given back after a delivered piece: ${await remainingOf(dev)} vs ${left}`);
  });

  await t('streamed: the reader leaves after a piece: the model stops, nothing created, still charged', async () => {
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
    await new Promise((res) => setTimeout(res, 400));
    assert(await remainingOf(dev) === left - 3, `given back after a delivered piece: ${await remainingOf(dev)} vs ${left}`);
    assert(await docCount() === before, 'a doc was created');
    assert(calls.length === n + 1, 'retried');
    // The lock was released: the next draft may start.
    await clearRate();
    streamReply = () => ({ pieces: ['# Next\n'] });
    const next = await writeSse(dev, { prompt: 'next one' });
    assert(next.events[next.events.length - 1].event === 'done', next.text);
  });

  await t('streamed: reasoning text was sent, then the reader leaves before the first piece: still charged', async () => {
    await clearRate();
    const before = await docCount();
    const left = await remainingOf(dev);
    streamReply = () => ({ thoughts: ['Planning the list. ', 'Clothes first, then gear. '], pieces: ['# Late\n'], delay: 200 });
    const r = await worker.fetch(req('/api/write-with-ai', { method: 'POST', cookie: dev, headers: { Origin: ORIGIN, Accept: 'text/event-stream' }, body: { prompt: 'leave after reasoning' } }), env, {});
    const reader = r.body.getReader();
    let seen = '';
    while (!/event: thinking\ndata: \{"text"/.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
    assert(!seen.includes('event: delta'), 'a draft piece came before the test left');
    await reader.cancel();
    await new Promise((res) => setTimeout(res, 800));
    assert(await remainingOf(dev) === left - 3, `given back after reasoning text was sent: ${await remainingOf(dev)} vs ${left}`);
    assert(await docCount() === before, 'a doc was created');
  });

  await t('streamed: the model fails after reasoning text, before any piece: still charged', async () => {
    await clearRate();
    const left = await remainingOf(dev);
    streamReply = () => ({ raw: [`data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning: 'Thinking about it. ' } }] })}`, `data: ${JSON.stringify({ error: { message: 'overloaded', code: 502 } })}`] });
    const r = await writeSse(dev, { prompt: 'fails after thinking' });
    const last = r.events[r.events.length - 1];
    assert(r.events.some((e) => e.event === 'thinking' && e.data.text) && last.event === 'error' && last.data.charged === true, r.text);
    assert(await remainingOf(dev) === left - 3, 'given back after reasoning text was sent');
  });

  await t('streamed: the reader leaves before anything the model wrote was sent: given back', async () => {
    await clearRate();
    const before = await docCount();
    const left = await remainingOf(dev);
    streamReply = () => ({ pieces: ['# Late\n'], firstDelay: 400 });
    const r = await worker.fetch(req('/api/write-with-ai', { method: 'POST', cookie: dev, headers: { Origin: ORIGIN, Accept: 'text/event-stream' }, body: { prompt: 'leave while thinking' } }), env, {});
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
    for (let i = 0; i < 100 && (await remainingOf(dev)) !== left; i++) await new Promise((res) => setTimeout(res, 20));
    assert(await remainingOf(dev) === left, 'not given back before any piece');
    await new Promise((res) => setTimeout(res, 600));
    assert(await docCount() === before, 'a doc was created');
  });

  await t('the doc quota is checked before anything is charged or the model runs', async () => {
    const full = await session('full.quota@example.com', 'f1'.repeat(16));
    await clearRate();
    // Mint the account and give it one doc, then a limit of one.
    reply = () => ({ status: 200, body: { choices: [{ message: { content: '# First' } }] } });
    assert((await write(full, { prompt: 'first' })).status === 200);
    env.TDOC_HOSTED_MAX_DOCS = '1';
    try {
      await clearRate();
      const left = await remainingOf(full);
      const n = calls.length;
      const before = await docCount();
      const r = await write(full, { prompt: 'second' });
      assert(r.status === 403 && /quota/.test(r.body.error || ''), `${r.status} ${r.text}`);
      const s = await writeSse(full, { prompt: 'second, streamed' });
      assert(s.status === 403 && s.body && /quota/.test(s.body.error || '') && !/event-stream/.test(s.type), `${s.status} ${s.text}`);
      assert(calls.length === n, 'the model ran for a doc the quota refuses');
      assert(await remainingOf(full) === left, 'charged for a doc the quota refuses');
      assert(await docCount() === before, 'a doc was created');
    } finally { delete env.TDOC_HOSTED_MAX_DOCS; }
  });

  await t('the create refuses a draft already streamed (the size cap): nothing stored, not given back', async () => {
    await clearRate();
    const left = await remainingOf(dev);
    const before = await docCount();
    env.TDOC_HOSTED_MAX_UPLOAD_BYTES = '200';
    try {
      streamReply = () => ({ pieces: ['# A long one\n\n', 'x'.repeat(400), '\n'] });
      const r = await writeSse(dev, { prompt: 'too big' });
      const last = r.events[r.events.length - 1];
      assert(last.event === 'error' && last.data.status === 413, r.text);
    } finally { delete env.TDOC_HOSTED_MAX_UPLOAD_BYTES; }
    assert(await docCount() === before, 'a doc was created');
    assert(await remainingOf(dev) === left - 3, 'a streamed draft was given back');
  });

  await t('one draft at a time per account: a parallel request is refused while one runs, before any charge', async () => {
    await clearRate();
    const left = await remainingOf(dev);
    streamReply = () => ({ pieces: Array.from({ length: 10 }, (_, i) => `line ${i}\n`), delay: 30 });
    const first = writeSse(dev, { prompt: 'first of two' });
    await new Promise((res) => setTimeout(res, 60));
    const n = calls.length;
    const [second, third] = await Promise.all([writeSse(dev, { prompt: 'second of two' }), write(dev, { prompt: 'third, JSON' })]);
    assert(second.status === 429 && second.body && second.body.error === 'write_in_progress', `${second.status} ${second.text}`);
    assert(third.status === 429 && third.body.error === 'write_in_progress', `${third.status} ${third.text}`);
    assert(calls.length === n, 'a parallel draft reached the model');
    const one = await first;
    assert(one.events[one.events.length - 1].event === 'done', one.text);
    assert(await remainingOf(dev) === left - 3, 'the refused requests were charged');
    // Released at the end: the next one runs.
    await clearRate();
    streamReply = () => ({ pieces: ['# After\n'] });
    const after = await writeSse(dev, { prompt: 'after' });
    assert(after.events[after.events.length - 1].event === 'done', after.text);
  });

  await t('no Accept: text/event-stream: one JSON body, as before', async () => {
    await clearRate();
    reply = () => ({ status: 200, body: { choices: [{ message: { content: '# Plain' } }] } });
    const r = await write(dev, { prompt: 'plain' });
    assert(r.status === 200 && r.body.ok && r.body.title === 'Plain', r.text);
    assert(!calls[calls.length - 1].body.stream, 'asked the model to stream');
  });

  await t('streamed, signed out: refused before anything streams', async () => {
    const r = await writeSse(null, { prompt: 'A packing list' });
    assert(r.status === 401 && !/event-stream/.test(r.type), `${r.status} ${r.type}`);
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
    // Its fixed reasoning first, so the thinking view can be tried there.
    const thinking = events.filter((e) => e.event === 'thinking');
    assert(thinking.length >= 1 && thinking.every((e) => typeof e.data.text === 'string') && events.indexOf(thinking[0]) < events.indexOf(deltas[0]), 'no preview thinking');
    const pt = events[events.length - 1].data.timing;
    assert(pt.model === 'preview' && pt.first_reasoning_ms != null && pt.first_token_ms >= pt.first_reasoning_ms, JSON.stringify(pt));
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
