// Write it with tdoc AI, streamed, on the real runtime: the deploy bundle in
// workerd with a real Durable Object (the Ask allowance), and the model as a
// second workerd service (the Worker's only outbound) that streams its answer
// as chat-completions server-sent events, a piece every STEP ms.
//
// Pinned here, as Cloudflare runs it (TransformStream, a fetch body read as
// it arrives, a response body written while the model is still answering):
//   - the first delta reaches the client long before the last one: the
//     response is streamed, not buffered;
//   - the deltas, in order, are the model's answer; then `done` with the
//     stored v1, private, its Markdown escaped (a <script> is text);
//   - a draft costs WRITE_AI_ASK_UNITS (3) of the allowance;
//   - the client hanging up mid-stream stops the model and gives the three
//     back, and nothing is created;
//   - without Accept: text/event-stream the answer is one JSON body;
//   - a PR preview with no key streams its fixed draft over time.
//
// Run with: node test/write-with-ai-workerd.test.js   (part of npm run test:workerd)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const STEP = 150;

(async () => {
  const root = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-write-ai-workerd-'));
  const binary = path.join(root, 'node_modules', '.bin', 'workerd');
  assert.ok(fs.existsSync(binary), 'workerd devDependency is required');
  execFileSync(process.execPath, [path.join(root, 'bin', 'tdoc-bundle')], { env: { ...process.env, OUT_DIR: dir }, stdio: 'pipe' });
  for (const name of ['resvg.wasm', 'NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf']) {
    fs.copyFileSync(path.join(root, 'server', 'preview', name), path.join(dir, name));
  }
  fs.mkdirSync(path.join(dir, 'do'));
  fs.writeFileSync(path.join(dir, 'model.mjs'), `
const PIECES = ['# Live plan\\n\\n', 'A first paragraph.\\n\\n', '## Steps\\n\\n', '- One\\n', '- Two\\n\\n', '<scr', 'ipt>alert(1)</scr', 'ipt>\\n\\n', '## End\\n\\n', 'Done.\\n'];
const state = globalThis.__model || (globalThis.__model = { calls: 0, last: null, cancelled: 0, sentPieces: 0 });
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/__state') return Response.json(state);
    if (url.pathname !== '/v1/chat/completions') return new Response('no network here', { status: 502 });
    state.calls++;
    state.last = await req.json();
    if (!state.last.stream) {
      return Response.json({ choices: [{ message: { content: PIECES.join('') } }] });
    }
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    (async () => {
      try {
        await w.write(enc.encode(': OPENROUTER PROCESSING\\n\\n'));
        for (const p of PIECES) {
          await new Promise((r) => setTimeout(r, ${STEP}));
          await w.write(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: p, reasoning: 'scratch' } }] }) + '\\n\\n'));
          state.sentPieces++;
        }
        await w.write(enc.encode('data: [DONE]\\n\\n'));
        await w.close();
      } catch { state.cancelled++; }
    })();
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } });
  },
};
`);
  fs.writeFileSync(path.join(dir, 'worker.mjs'), `import worker, { CommentsStore } from './_worker.bundled.js';
class KV {
  constructor() { this.map = new Map(); this.meta = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async getWithMetadata(k) { return { value: this.map.has(k) ? this.map.get(k) : null, metadata: this.meta.get(k) ?? null }; }
  async put(k, v, o) { this.map.set(k, String(v)); if (o && o.metadata !== undefined) this.meta.set(k, o.metadata); else this.meta.delete(k); }
  async delete(k) { this.map.delete(k); this.meta.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => (this.meta.has(name) ? { name, metadata: this.meta.get(name) } : { name })), list_complete: true }; }
}
class R2 {
  constructor() { this.map = new Map(); }
  async put(k, v, o) { if (o && o.onlyIf && this.map.has(k)) return null; const bytes = typeof v === 'string' ? v : new Uint8Array(v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer()); this.map.set(k, bytes); return { key: k }; }
  async get(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); const b = typeof v === 'string' ? new TextEncoder().encode(v) : v; return { text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), size: b.length, httpMetadata: {} }; }
  async head(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); return { size: typeof v === 'string' ? new TextEncoder().encode(v).length : v.length, httpMetadata: {} }; }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) this.map.delete(key); }
  async list({ prefix = '' } = {}) { return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}
const fake = globalThis.__tdocFake || (globalThis.__tdocFake = { META: new KV(), DOCS: new R2(), PV: new KV(), PVDOCS: new R2() });
const base = { TDOC_HOSTED_REGISTRATION: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef', PUBLIC_HOST: 'tdoc.dev', TDOC_EMAIL_ALIAS_SECRET: 'test-alias-secret' };
const envFor = (env) => ({ ...base, META: fake.META, DOCS: fake.DOCS, COMMENTS: env.COMMENTS, TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test', ASK_API_KEY: 'test-key', ASK_API_BASE: 'https://model.test/v1', ASK_FREE_LIMIT: '9' });
// A PR preview: no Durable Object, no key.
const previewEnv = () => ({ ...base, META: fake.PV, DOCS: fake.PVDOCS, TDOC_PREVIEW: '1' });
export class TestStore extends CommentsStore { constructor(state, env) { super(state, envFor(env)); } }
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const preview = url.pathname.startsWith('/__preview/');
    const store = preview ? fake.PV : fake.META;
    if (url.pathname.endsWith('/__seed-session')) {
      const { id, login, email } = await req.json();
      await store.put('session:' + id, JSON.stringify({ login, name: login, email, avatar_url: '', created: new Date().toISOString() }));
      return new Response('ok');
    }
    if (url.pathname === '/__docs') return Response.json((await fake.META.list({ prefix: 'meta:' })).keys.map((k) => k.name.slice(5)));
    if (url.pathname === '/__html') return new Response(await (await fake.DOCS.get(url.searchParams.get('key')))?.text() ?? '');
    if (url.pathname === '/__model') return fetch('https://model.test/__state');
    const p = preview ? url.pathname.slice('/__preview'.length) : url.pathname;
    return worker.fetch(new Request('https://tdoc.dev' + p + url.search, req), preview ? previewEnv() : envFor(env), ctx);
  },
};
`);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  // The model is the main Worker's globalOutbound: every fetch it makes goes
  // there, through the runtime's own HTTP stack, streamed.
  fs.writeFileSync(path.join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = .w), (name = "model", worker = .m), (name = "do-disk", disk = (path = ${JSON.stringify(path.join(dir, 'do'))}, writable = true))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);
const m :Workerd.Worker = (modules = [(name = "model", esModule = embed "model.mjs")], compatibilityDate = "2025-01-01");
const w :Workerd.Worker = (modules = [(name = "worker", esModule = embed "worker.mjs"), (name = "_worker.bundled.js", esModule = embed "_worker.bundled.js"), (name = "resvg.wasm", wasm = embed "resvg.wasm"), (name = "NotoSansSC-Regular.ttf", data = embed "NotoSansSC-Regular.ttf"), (name = "NotoSansSC-Bold.ttf", data = embed "NotoSansSC-Bold.ttf")], compatibilityDate = "2025-01-01", globalOutbound = "model", durableObjectNamespaces = [(className = "TestStore", uniqueKey = "tdoc-write-ai-test", enableSql = true)], durableObjectStorage = (localDisk = "do-disk"), bindings = [(name = "COMMENTS", durableObjectNamespace = "TestStore")]);
`);
  const child = spawn(binary, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.on('data', (chunk) => { stderr += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}, signal) => fetch(origin + p, {
    method: 'POST',
    headers: { Origin: 'https://tdoc.dev', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  // Reads an event stream, timing each event from the request.
  const readEvents = async (res, t0, stopAfter = Infinity) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buf = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
      let at;
      while ((at = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const ev = (block.match(/^event: (.*)$/m) || [])[1];
        if (!ev) continue;
        events.push({ event: ev, data: JSON.parse(block.match(/^data: (.*)$/m)[1]), at: Date.now() - t0 });
        if (events.length >= stopAfter) { await reader.cancel(); return events; }
      }
    }
    return events;
  };

  let passed = 0;
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error && error.stack ? error.stack : error}\n${stderr.slice(-1500)}`); }
  };

  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(origin + '/__docs'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    console.log('write with tdoc AI, streamed (workerd)');
    const sid = crypto.randomBytes(16).toString('hex');
    await post('/__seed-session', { id: sid, login: 'julie', email: 'julie@tdoc.test' });
    const cookie = `tdoc_sid=${sid}`;
    const remaining = async () => (await (await fetch(origin + '/api/write-with-ai', { headers: { Cookie: cookie } })).json()).remaining;
    const docs = async () => (await (await fetch(origin + '/__docs')).json()).length;

    await t('streamed through the runtime: deltas as the model writes, then done with the stored v1', async () => {
      assert.equal(await remaining(), 9);
      const t0 = Date.now();
      const res = await post('/api/write-with-ai', { prompt: 'a live plan' }, { Cookie: cookie, Accept: 'text/event-stream' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/event-stream/);
      const events = await readEvents(res, t0);
      const deltas = events.filter((e) => e.event === 'delta');
      const done = events[events.length - 1];
      assert.equal(done.event, 'done', JSON.stringify(events.map((e) => e.event)));
      assert.ok(deltas.length >= 5, `${deltas.length} deltas`);
      // Streamed, not buffered: the first piece came long before the last.
      const spread = deltas[deltas.length - 1].at - deltas[0].at;
      assert.ok(spread >= STEP * 5, `deltas arrived within ${spread} ms of each other: buffered`);
      assert.ok(done.at - deltas[0].at >= STEP * 5, 'done arrived with the first delta');
      const text = deltas.map((e) => e.data.text).join('');
      assert.ok(text.startsWith('# Live plan') && text.includes('<script>alert(1)</script>') && !text.includes('scratch'), text);
      assert.equal(done.data.title, 'Live plan');
      assert.equal(done.data.url, `/d/${done.data.slug}/v/1`);
      assert.equal(done.data.remaining, 6, 'a draft is three of the allowance');
      const model = await (await fetch(origin + '/__model')).json();
      assert.equal(model.last.stream, true);
      assert.ok(model.last.max_tokens >= 6000);
      const html = await (await fetch(`${origin}/__html?key=${encodeURIComponent(`docs/${done.data.slug}/v1/index.html`)}`)).text();
      assert.match(html, /<h2[^>]*>Steps<\/h2>/);
      assert.ok(!/<script>alert/.test(html), 'a script tag from the model reached the page');
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });

    await t('the client hangs up mid-stream: the model stops, the three are given back, nothing is created', async () => {
      const before = await docs();
      const left = await remaining();
      const sentBefore = (await (await fetch(origin + '/__model')).json()).sentPieces;
      const ctl = new AbortController();
      const res = await post('/api/write-with-ai', { prompt: 'leave early' }, { Cookie: cookie, Accept: 'text/event-stream' }, ctl.signal);
      await readEvents(res, Date.now(), 2);
      ctl.abort();
      let now = null;
      for (let i = 0; i < 60 && now !== left; i++) { now = await remaining(); if (now !== left) await new Promise((r) => setTimeout(r, 100)); }
      assert.equal(now, left, 'not given back');
      await new Promise((r) => setTimeout(r, STEP * 12));
      assert.equal(await docs(), before, 'a doc was created');
      const model = await (await fetch(origin + '/__model')).json();
      assert.ok(model.sentPieces - sentBefore < 10, `the model kept writing (${model.sentPieces - sentBefore} pieces)`);
    });

    await t('without Accept: text/event-stream: one JSON body, as before', async () => {
      const res = await post('/api/write-with-ai', { prompt: 'plain' }, { Cookie: cookie });
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.ok(body.ok && body.url && body.title === 'Live plan');
      assert.equal(body.remaining, 3);
      const model = await (await fetch(origin + '/__model')).json();
      assert.ok(!model.last.stream);
    });

    await t('refused before the model runs: JSON with its status, even when streaming is asked for', async () => {
      // Three left: one more draft, then the allowance stops the next.
      const ok = await post('/api/write-with-ai', { prompt: 'last' }, { Cookie: cookie, Accept: 'text/event-stream' });
      await readEvents(ok, Date.now());
      const res = await post('/api/write-with-ai', { prompt: 'one too many' }, { Cookie: cookie, Accept: 'text/event-stream' });
      assert.ok(res.status === 429, `${res.status}`);
      assert.match(res.headers.get('content-type'), /application\/json/);
    });

    await t('a PR preview without a key: the fixed draft streams over time', async () => {
      const psid = crypto.randomBytes(16).toString('hex');
      await post('/__preview/__seed-session', { id: psid, login: 'pat', email: 'pat@tdoc.test' });
      const t0 = Date.now();
      const res = await post('/__preview/api/write-with-ai', { prompt: 'demo' }, { Cookie: `tdoc_sid=${psid}`, Accept: 'text/event-stream' });
      assert.equal(res.status, 200);
      const events = await readEvents(res, t0);
      const deltas = events.filter((e) => e.event === 'delta');
      assert.ok(deltas.length >= 3, `${deltas.length} pieces`);
      assert.ok(deltas[deltas.length - 1].at - deltas[0].at >= 600, 'the preview draft arrived at once');
      assert.equal(events[events.length - 1].event, 'done', JSON.stringify(events[events.length - 1]));
    });
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
