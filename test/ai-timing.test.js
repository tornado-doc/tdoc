// tdoc AI response times (server/ai-timing.js): one `ai_timing` log line per
// model call on Ask answer, Ask edit and Write with tdoc AI (JSON and
// streamed), with route, model, upstream_headers / first_token / total
// milliseconds, output size and ok or a short error code -- and never the
// question, the doc, the answer, a slug, an account or an upstream error
// message. The helper is checked with an injected clock; the routes with the
// chat-completions endpoint mocked (nothing leaves the process).
// Run with: node test/ai-timing.test.js

const AiTiming = require('../server/ai-timing.js');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ORIGIN = { Origin: 'https://tdoc.dev' };

(async () => {
  console.log('ai timing');

  // ── the helper ──
  const clock = (steps) => { let i = 0; return () => steps[Math.min(i++, steps.length - 1)]; };

  await t('marks are ms since start; one line, the record returned', async () => {
    const lines = [];
    const tm = AiTiming.start('write_ai', { model: 'vendor/model-1', stream: true, now: clock([1000, 1400, 1650, 4000]), log: (l) => lines.push(l) });
    tm.attempt().mark('upstream_headers').mark('first_token').mark('first_token');
    const rec = tm.done({ ok: true, chars: 321 });
    assert(lines.length === 1, `${lines.length} lines`);
    assert(JSON.stringify(rec) === lines[0], 'logged what it returned');
    assert(rec.event === 'ai_timing' && rec.route === 'write_ai' && rec.model === 'vendor/model-1' && rec.stream === true, lines[0]);
    assert(rec.upstream_headers_ms === 400 && rec.first_token_ms === 650 && rec.total_ms === 3000, lines[0]);
    assert(rec.ok === true && rec.status === 200 && rec.error === null && rec.out_chars === 321 && rec.attempts === 1, lines[0]);
  });

  await t('extra (Write with tdoc AI): only the known fields, coerced; first_reasoning is the first one', async () => {
    const lines = [];
    const tm = AiTiming.start('write_ai', { model: 'm', stream: true, now: clock([0, 100, 300, 500, 900, 1200]), log: (l) => lines.push(l) });
    tm.attempt().mark('upstream_headers').mark('first_reasoning').mark('first_reasoning').mark('first_token');
    const rec = tm.done({ ok: true, chars: 10, extra: {
      reasoning_text: 1, reasoning_chars: '42', finish_reason: 'length <script>', cutoff: 'length',
      usage: { prompt_tokens: 12, completion_tokens: '30', reasoning_tokens: -1, secret: 'x' },
      prompt: 'never logged', account: 'acct-1',
    } });
    assert(rec.first_reasoning_ms === 300 && rec.first_token_ms === 500 && rec.total_ms === 900, lines[0]);
    assert(rec.reasoning_text === true && rec.reasoning_chars === 42 && rec.finish_reason === 'lengthscript' && rec.cutoff === 'length', lines[0]);
    assert(JSON.stringify(rec.usage) === JSON.stringify({ prompt_tokens: 12, completion_tokens: 30, reasoning_tokens: null }), lines[0]);
    assert(!/never logged|acct-1|secret/.test(lines[0]) && lines.length === 1, lines[0]);
    // Without extra, the line is as before: no extra keys.
    const plain = AiTiming.start('ask_answer', { now: clock([0, 1]), log: () => {} }).done({ ok: true, chars: 1 });
    assert(!('first_reasoning_ms' in plain) && !('usage' in plain), JSON.stringify(plain));
  });

  await t('done is once: a second done or a late mark changes nothing', async () => {
    const lines = [];
    const tm = AiTiming.start('ask_answer', { now: clock([0, 10, 20, 30]), log: (l) => lines.push(l) });
    const a = tm.done({ ok: true, chars: 1 });
    tm.mark('upstream_headers');
    const b = tm.done({ ok: false, status: 500 });
    assert(lines.length === 1 && a === b && a.ok === true && a.upstream_headers_ms === null, lines.join('\n'));
  });

  await t('a retry starts its marks over and is counted', async () => {
    const tm = AiTiming.start('ask_edit', { now: clock([0, 100, 900, 1500]), log: () => {} });
    tm.attempt().mark('upstream_headers');
    tm.attempt().mark('upstream_headers');
    const rec = tm.done({ ok: true, chars: 5 });
    assert(rec.attempts === 2 && rec.upstream_headers_ms === 900 && rec.total_ms === 1500, JSON.stringify(rec));
  });

  await t('errors are a code from a fixed list; an upstream message never appears', async () => {
    const run = (r) => AiTiming.start('ask_answer', { now: clock([0, 5]), log: () => {} }).done(r);
    assert(run({ ok: false, status: 0, detail: 'timeout' }).error === 'timeout', 'timeout');
    assert(run({ ok: false, status: 502, detail: 'http_502' }).error === 'http_502', 'http');
    const leaky = run({ ok: false, status: 400, detail: 'Your prompt "SECRET-DOC-TEXT" is too long' });
    assert(leaky.error === 'http_400' && !JSON.stringify(leaky).includes('SECRET'), JSON.stringify(leaky));
    assert(run({ ok: false, detail: 'weird' }).error === 'error', 'fallback');
  });

  await t('unknown marks are ignored; route and model are short tokens', async () => {
    const rec = AiTiming.start('ask_answer"\n{x}', { model: 'm "quoted"\n' + 'x'.repeat(500), now: clock([0, 1, 2]), log: () => {} })
      .mark('prompt_text').done({ ok: true, chars: 3 });
    assert(!('prompt_text_ms' in rec) && rec.route === 'ask_answerx' && !/["\n ]/.test(rec.model) && rec.model.length <= 120, JSON.stringify(rec));
  });

  await t('none records nothing', async () => {
    assert(AiTiming.none.attempt().mark('first_token').done({ ok: true }) === null);
  });

  // ── the routes ──
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  env.TDOC_EMAIL_ALIAS_SECRET = 'test-alias-secret';
  env.ASK_API_KEY = 'sk-test-key';
  env.ASK_MODEL = 'vendor/test-model';
  env.ASK_FREE_LIMIT = '50';
  env.TDOC_DEBUG_ACCOUNTS = 'alice@tdoc.test';

  let content = () => 'Billing ships first.';
  let status = 200;
  let stream = null;
  globalThis.fetch = async (input, init = {}) => {
    const sent = init.body ? JSON.parse(init.body) : null;
    if (sent && sent.stream && stream) {
      const enc = new TextEncoder();
      const lines = [...stream.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}`), 'data: [DONE]'];
      const body = new ReadableStream({
        async start(c) {
          for (const line of lines) { await new Promise((r) => setTimeout(r, 3)); c.enqueue(enc.encode(`${line}\n\n`)); }
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (status !== 200) return new Response(JSON.stringify({ error: { message: `upstream echoes ${JSON.stringify(sent).slice(0, 80)}` } }), { status, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: content() } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  // The ai_timing lines a request logged.
  const timed = async (fn) => {
    const real = console.log;
    const lines = [];
    console.log = (...a) => { lines.push(a.join(' ')); };
    let out;
    try { out = await fn(); } finally { console.log = real; }
    const recs = lines.filter((l) => l.includes('"ai_timing"')).map((l) => JSON.parse(l));
    return { out, recs, lines };
  };

  let sidN = 0;
  const person = async (login) => {
    const sid = (++sidN).toString(16).padStart(32, '0');
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name: login, email: `${login}@tdoc.test`, avatar_url: '', created: new Date().toISOString() }));
    const cookie = `tdoc_sid=${sid}`;
    const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', cookie, body: { label: login } }), env, {});
    const data = await r.json();
    return { ...data, cookie, login };
  };
  const alice = await person('alice');
  const created = '2026-01-01T00:00:00.000Z';
  const SLUG = 'timing-plan-slug';
  await env.META.put(`meta:${SLUG}`, JSON.stringify({ title: 'Plan', slug: SLUG, created, versions: [{ n: 1, created }], access: { visibility: 'public' }, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
  await env.DOCS.put(`docs/${SLUG}/v1/index.html`, '<h1>Launch plan</h1><p>DOC-BODY-MARKER Billing ships first.</p>');
  await env.COMMENTS.get(env.COMMENTS.idFromName(SLUG)).fetch('https://do/owner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: SLUG, op: { kind: 'claim_owner', account_id: alice.account_id } }) });

  // Nothing personal or from the doc in any line.
  const clean = (rec) => {
    const s = JSON.stringify(rec);
    for (const bad of [SLUG, 'DOC-BODY-MARKER', 'QUESTION-MARKER', 'Billing', 'alice', alice.account_id, 'upstream echoes', 'tdoc_sid']) {
      assert(!bad || !s.includes(bad), `leaked ${bad}: ${s}`);
    }
  };

  await t('Ask answer: one line with headers and total, the answer size', async () => {
    const { out, recs } = await timed(() => call(`/api/docs/${SLUG}/ask`, { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { question: 'QUESTION-MARKER what ships?' } }));
    assert(out.status === 200 && out.body.answer === 'Billing ships first.', out.text);
    assert(recs.length === 1, `${recs.length} lines`);
    const r = recs[0];
    assert(r.route === 'ask_answer' && r.model === 'vendor/test-model' && r.stream === false && r.ok === true, JSON.stringify(r));
    assert(Number.isFinite(r.upstream_headers_ms) && r.first_token_ms === null && r.total_ms >= r.upstream_headers_ms && r.out_chars === 20 && r.attempts === 1, JSON.stringify(r));
    clean(r);
  });

  await t('Ask answer failing upstream: ok false, the status, two attempts, no upstream text', async () => {
    status = 503;
    try {
      const { out, recs } = await timed(() => call(`/api/docs/${SLUG}/ask`, { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { question: 'QUESTION-MARKER again?' } }));
      assert(out.status === 502, out.text);
      assert(recs.length === 1 && recs[0].ok === false && recs[0].status === 503 && recs[0].error === 'http_503' && recs[0].attempts === 2 && recs[0].out_chars === 0, JSON.stringify(recs));
      clean(recs[0]);
    } finally { status = 200; }
  });

  await t('Ask edit: one line, route ask_edit', async () => {
    content = () => '{"kind":"answer","answer":"It ships billing first."}';
    const { out, recs } = await timed(() => call(`/api/docs/${SLUG}/suggest`, { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { instruction: 'QUESTION-MARKER what ships?' } }));
    assert(out.status === 200 && out.body.kind === 'answer', out.text);
    assert(recs.length === 1 && recs[0].route === 'ask_edit' && recs[0].ok === true && recs[0].stream === false, JSON.stringify(recs));
    clean(recs[0]);
  });

  await t('Write with tdoc AI (JSON): one line, route write_ai', async () => {
    content = () => '# Packing list\n\n- Wool layers';
    const { out, recs } = await timed(() => call('/api/write-with-ai', { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { prompt: 'QUESTION-MARKER a packing list' } }));
    assert(out.status === 200 && out.body.ok, out.text);
    assert(recs.length === 1 && recs[0].route === 'write_ai' && recs[0].stream === false && recs[0].ok === true && recs[0].out_chars > 0, JSON.stringify(recs));
    assert(!JSON.stringify(recs[0]).includes(out.body.slug), 'new slug leaked');
    clean(recs[0]);
  });

  await t('Write with tdoc AI (streamed): first token between headers and total', async () => {
    stream = ['# Packing', ' list\n\n', '- Wool layers'];
    try {
      const { out, recs } = await timed(async () => {
        const r = await worker.fetch(req('/api/write-with-ai', { method: 'POST', cookie: alice.cookie, headers: { ...ORIGIN, Accept: 'text/event-stream' }, body: { prompt: 'QUESTION-MARKER a list' } }), env, {});
        return { status: r.status, text: await r.text() };
      });
      assert(out.status === 200 && /event: done/.test(out.text), out.text);
      assert(recs.length === 1, `${recs.length} lines`);
      const r = recs[0];
      assert(r.route === 'write_ai' && r.stream === true && r.ok === true, JSON.stringify(r));
      assert(Number.isFinite(r.first_token_ms) && r.first_token_ms >= r.upstream_headers_ms && r.total_ms >= r.first_token_ms, JSON.stringify(r));
      clean(r);
    } finally { stream = null; }
  });

  await t('the preview stand-in (no key) logs nothing', async () => {
    const key = env.ASK_API_KEY;
    delete env.ASK_API_KEY;
    env.TDOC_PREVIEW = '1';
    try {
      const { out, recs } = await timed(() => call(`/api/docs/${SLUG}/ask`, { method: 'POST', cookie: alice.cookie, headers: ORIGIN, body: { question: 'x?' } }));
      assert(out.status === 200 && recs.length === 0, `${out.status} ${recs.length}`);
    } finally { env.ASK_API_KEY = key; delete env.TDOC_PREVIEW; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
