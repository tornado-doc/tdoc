// Full-text search on the real runtime: the deploy bundle in workerd, with a
// SQLite-backed Durable Object (the CommentsStore class the deploy binds as
// COMMENTS), so FTS5's trigram tokenizer, json_each, bm25 and the store's
// alarm are workerd's own -- not node:sqlite standing in for them. KV and R2
// are small in-memory fakes inside the isolate.
//
// Run with: node test/search-workerd.test.js   (part of npm run test:workerd)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  const root = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-search-workerd-'));
  const binary = path.join(root, 'node_modules', '.bin', 'workerd');
  assert.ok(fs.existsSync(binary), 'workerd devDependency is required');
  execFileSync(process.execPath, [path.join(root, 'bin', 'tdoc-bundle')], { env: { ...process.env, OUT_DIR: dir }, stdio: 'pipe' });
  const previewDir = path.join(root, 'server', 'preview');
  for (const name of ['resvg.wasm', 'NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf']) {
    fs.copyFileSync(path.join(previewDir, name), path.join(dir, name));
  }
  fs.mkdirSync(path.join(dir, 'do'));
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
  async put(k, v) { this.map.set(k, typeof v === 'string' ? v : new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer || v)); }
  async get(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); return { text: async () => (typeof v === 'string' ? v : new TextDecoder().decode(v)), arrayBuffer: async () => (typeof v === 'string' ? new TextEncoder().encode(v).buffer : v.buffer), size: v.length }; }
  async head(k) { return this.map.has(k) ? { size: this.map.get(k).length } : null; }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) this.map.delete(key); }
  async list({ prefix = '' } = {}) { return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}
const fake = globalThis.__tdocFake || (globalThis.__tdocFake = { META: new KV(), DOCS: new R2() });
const envFor = (env) => ({ META: fake.META, DOCS: fake.DOCS, COMMENTS: env.COMMENTS, TDOC_HOSTED_REGISTRATION: '1', TDOC_SEARCH_CACHE_MS: '0' });
export class TestStore extends CommentsStore { constructor(state, env) { super(state, envFor(env)); } }
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/__seed-session') {
      const { id, login } = await req.json();
      await fake.META.put('session:' + id, JSON.stringify({ login, name: login, avatar_url: '', created: new Date().toISOString() }));
      return new Response('ok');
    }
    return worker.fetch(req, envFor(env), ctx);
  },
};
`);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(path.join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = .w), (name = "do-disk", disk = (path = ${JSON.stringify(path.join(dir, 'do'))}, writable = true))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);
const w :Workerd.Worker = (modules = [(name = "worker", esModule = embed "worker.mjs"), (name = "_worker.bundled.js", esModule = embed "_worker.bundled.js"), (name = "resvg.wasm", wasm = embed "resvg.wasm"), (name = "NotoSansSC-Regular.ttf", data = embed "NotoSansSC-Regular.ttf"), (name = "NotoSansSC-Bold.ttf", data = embed "NotoSansSC-Bold.ttf")], compatibilityDate = "2025-01-01", durableObjectNamespaces = [(className = "TestStore", uniqueKey = "tdoc-search-test", enableSql = true)], durableObjectStorage = (localDisk = "do-disk"), bindings = [(name = "COMMENTS", durableObjectNamespace = "TestStore")]);
`);
  const child = spawn(binary, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  // workerd sees plain http; the worker's cookie and origin checks expect
  // tdoc.dev, so every request names it.
  const call = async (pathname, { method = 'GET', cookie = '', token = '', body } = {}) => {
    const r = await fetch(base + pathname, {
      method,
      headers: {
        Host: 'tdoc.dev', 'X-Forwarded-Proto': 'https',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, body: json };
  };
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/__ping'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const person = async (login) => {
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await fetch(base + '/__seed-session', { method: 'POST', body: JSON.stringify({ id, login }) });
      const cookie = `tdoc_sid=${id}`;
      const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: login } });
      assert.equal(minted.status, 200, `token for ${login}: ${minted.text} ${stderr}`);
      return { cookie, token: minted.body.token };
    };
    const alice = await person('alice');
    const bob = await person('bob');
    const publish = async (who, slug, title, html) => {
      const r = await call('/api/upload', { method: 'POST', token: who.token, body: { slug, version: 1, html, meta: { title, access: { visibility: 'private' } } } });
      assert.equal(r.status, 200, `publish ${slug}: ${r.text}`);
    };
    await publish(alice, 'plan-en', 'Launch plan', '<h1>Launch plan</h1><p>We ship full-text search tonight &amp; then <b>polish</b>.</p>');
    await publish(alice, 'plan-zh', '季度报告', '<h1>季度报告</h1><p>本季度收入增长稳定，新产品用户反馈良好。</p>');
    await publish(bob, 'bob-only', 'Bob only', '<p>Bob writes about full-text search and 收入增长 too.</p>');
    const comment = await call('/api/comments', { method: 'POST', cookie: alice.cookie, body: { slug: 'plan-en', version: 1, text: 'Remember the pangolin budget', anchor: null } });
    assert.equal(comment.status, 200, `comment: ${comment.text}`);

    const search = (who, q) => call(`/api/search?q=${encodeURIComponent(q)}`, { cookie: who.cookie });
    // The store indexes on its alarm, a moment after the writes.
    const until = async (who, q, want) => {
      let last;
      for (let i = 0; i < 60; i++) {
        last = await search(who, q);
        if (last.status === 200 && last.body.results.map((r) => r.slug).join() === want) return last;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert.fail(`${q}: wanted [${want}], got ${last && last.text} ${stderr}`);
    };
    const en = await until(alice, 'full-text search', 'plan-en');
    assert.ok(en.body.results[0].snippet.some((s) => s.hit && s.text.toLowerCase() === 'full-text'), JSON.stringify(en.body.results[0].snippet));
    assert.ok(en.body.results[0].snippet.map((s) => s.text).join('').includes('then polish.'), 'inline tags do not split words');
    const zh = await until(alice, '收入增长', 'plan-zh');
    assert.ok(zh.body.results[0].snippet.some((s) => s.hit && s.text === '收入增长'));
    await until(alice, '收入', 'plan-zh');
    const viaComment = await until(alice, 'pangolin', 'plan-en');
    assert.equal(viaComment.body.results[0].where, 'comments');
    await until(bob, 'full-text search', 'bob-only');
    const leak = await search(alice, 'Bob writes');
    assert.equal(leak.body.results.length, 0, 'another person\'s private doc was returned');
    console.log('search in workerd: FTS5 trigram (English + Chinese), comments, alarm indexing, access ok');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
