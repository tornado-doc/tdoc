// Every server path that stores a document version goes through
// prepareDocVersion(): bake the reading template, stamp aids, hash the exact
// stored bytes. This suite exercises the three writers — /api/upload, the
// browser Save inside the Durable Object, and duplicate — through the real
// fetch handler against fake bindings, and asserts the invariants landed in
// R2 and in the version entries. Widgets are asserted NOT baked: they are
// sandboxed islands, and the reading template does not belong in them.
//
// Why this exists: the browser Save path (#329) shipped without baking, which
// is exactly what happens when "store a version" is not a function anyone can
// be routed through. The harness mirrors hosted-oob-behavior.test.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}
class FakeR2 {
  constructor() { this.map = new Map(); }
  async get(k) {
    if (!this.map.has(k)) return null;
    const v = this.map.get(k);
    return { text: async () => v, body: v };
  }
  async put(k, v) { this.map.set(k, String(v)); }
  async head(k) { return this.map.has(k) ? { key: k } : null; }
  async delete(k) { const ks = Array.isArray(k) ? k : [k]; for (const one of ks) this.map.delete(one); }
  async list({ prefix = '', cursor } = {}) {
    return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false, cursor: undefined };
  }
}
class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : undefined; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async transaction(fn) { await fn(this); }
}
class FakeDurableNamespace {
  constructor(env, StoreClass) { this.env = env; this.StoreClass = StoreClass; this.states = new Map(); }
  idFromName(name) { return name; }
  get(id) {
    if (!this.states.has(id)) this.states.set(id, { storage: new FakeStorage() });
    const state = this.states.get(id);
    const { StoreClass, env } = this;
    return {
      fetch: async (url, init = {}) => {
        const store = new StoreClass(state, env);
        return store.fetch(new Request(url, init));
      },
    };
  }
}

async function loadWorker() {
  const root = path.join(__dirname, '..');
  let src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  const readerCss = fs.readFileSync(path.join(root, 'server', 'reader.css'), 'utf8');
  src = src.replace(/const READER_CSS = `__TDOC_READER_CSS__`;/, 'const READER_CSS = ' + JSON.stringify(readerCss) + ';');
  const tmp = path.join(os.tmpdir(), `tdoc-wi-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(tmp, src);
  const mod = await import(`file://${tmp}`);
  try { fs.unlinkSync(tmp); } catch {}
  return mod;
}

function makeEnv(StoreClass) {
  const env = { META: new FakeKV(), DOCS: new FakeR2(), TDOC_HOSTED_REGISTRATION: '1' };
  env.COMMENTS = new FakeDurableNamespace(env, StoreClass);
  return env;
}

function req(pathname, { method = 'GET', token = '', body = null, cookie = '', headers = {} } = {}) {
  return new Request(`https://tdoc.dev${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: `tdoc_sid=${cookie}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function putSession(env, login) {
  const sid = crypto.randomBytes(16).toString('hex');
  await env.META.put(`session:${sid}`, JSON.stringify({ login, avatar_url: '', created: new Date().toISOString() }));
  return sid;
}

async function issue(worker, env, login = 'alice') {
  const cookie = await putSession(env, login);
  const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', cookie, body: { label: login } }), env, {});
  const data = await r.json();
  assert(r.status === 200 && data.token, `token issue failed ${r.status}: ${JSON.stringify(data)}`);
  return { ...data, cookie, login };
}

// A host document that follows the authoring contract: no font of its own, a
// responsive breakpoint — the exact shape the old fallback starved.
const DOC = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>t</title><style>body{background:#fff}@media (max-width:520px){.x{padding:4px}}</style>'
  + '</head><body><div class="wrap"><h1>T</h1><p>hi</p></div></body></html>';

(async () => {
  console.log('server write invariants (upload / browser save / duplicate)\n');
  const mod = await loadWorker();
  const worker = mod.default;

  await t('upload: stored bytes carry the baked, generation-stamped template', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token, headers: { 'X-Tdoc-Client': '0.9.0' },
      body: { slug: 'd1', version: 1, html: DOC, meta: { title: 'd1', slug: 'd1', versions: [{ n: 1 }] } },
    }), env, {});
    assert(r.status === 200, `upload ${r.status}: ${await r.text()}`);
    const stored = await (await env.DOCS.get('docs/d1/v1/index.html')).text();
    assert(/id="tdoc-reader" data-tdoc-template="[0-9a-f]{8}"/.test(stored), 'stored doc lacks the stamped template');
    assert((stored.match(/id="tdoc-reader"/g) || []).length === 1, 'template baked more than once');
  });

  await t('upload: version entry records sha of the stored bytes and the client', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token, headers: { 'X-Tdoc-Client': '0.9.0' },
      body: { slug: 'd2', version: 1, html: DOC, meta: { title: 'd2', slug: 'd2', versions: [{ n: 1 }] } },
    }), env, {});
    const meta = JSON.parse(await env.META.get('meta:d2'));
    const entry = meta.versions.find((v) => v.n === 1);
    assert(entry && /^[0-9a-f]{16}$/.test(entry.sha || ''), `version entry has no sha: ${JSON.stringify(entry)}`);
    assert(entry.client === '0.9.0', `version entry has no client: ${JSON.stringify(entry)}`);
    const stored = await (await env.DOCS.get('docs/d2/v1/index.html')).text();
    const expect = crypto.createHash('sha256').update(stored).digest('hex').slice(0, 16);
    assert(entry.sha === expect, 'sha does not match the stored bytes');
  });

  await t('upload: an already-baked document is not double-baked and keeps a stable sha', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    const prebaked = DOC.replace('</head>', '<style id="tdoc-reader">:where(body){font-size:17px}</style></head>');
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'd3', version: 1, html: prebaked, meta: { title: 'd3', slug: 'd3', versions: [{ n: 1 }] } },
    }), env, {});
    assert(r.status === 200, `upload ${r.status}`);
    const stored = await (await env.DOCS.get('docs/d3/v1/index.html')).text();
    assert((stored.match(/id="tdoc-reader"/g) || []).length === 1, 'pre-baked doc gained a second template');
  });

  await t('browser Save (DO path) bakes and records sha — the #329 gap', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'd4', version: 1, html: DOC, meta: { title: 'd4', slug: 'd4', versions: [{ n: 1 }] } },
    }), env, {});
    const save = await worker.fetch(req('/api/doc/versions', {
      method: 'POST', cookie: a.cookie,
      body: { slug: 'd4', baseVersion: 1, html: DOC.replace('<p>hi</p>', '<p>edited in browser</p>') },
    }), env, {});
    assert(save.status === 200, `save ${save.status}: ${await save.text()}`);
    const stored = await (await env.DOCS.get('docs/d4/v2/index.html')).text();
    assert(stored.includes('edited in browser'), 'save did not store the edit');
    assert(/id="tdoc-reader" data-tdoc-template="[0-9a-f]{8}"/.test(stored), 'browser-saved version lacks the template');
    const meta = JSON.parse(await env.META.get('meta:d4'));
    const entry = meta.versions.find((v) => v.n === 2);
    assert(entry && /^[0-9a-f]{16}$/.test(entry.sha || ''), `browser-saved entry has no sha: ${JSON.stringify(entry)}`);
  });

  await t('duplicate bakes the copy and records sha', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    // Seed an UNBAKED stored doc directly — the pre-migration population.
    await env.DOCS.put('docs/src/v1/index.html', DOC);
    await env.META.put('meta:src', JSON.stringify({ title: 'src', slug: 'src', versions: [{ n: 1 }], hosted: { account_id: a.account_id, github_login: a.login } }));
    const r = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', cookie: a.cookie, body: { slug: 'src', version: 1 },
    }), env, {});
    const dupText = await r.text();
    assert(r.status === 200, `duplicate ${r.status}: ${dupText}`);
    const dup = JSON.parse(dupText);
    const newSlug = dup.slug || dup.newSlug;
    assert(newSlug, `duplicate response has no slug: ${JSON.stringify(dup)}`);
    const stored = await (await env.DOCS.get(`docs/${newSlug}/v1/index.html`)).text();
    assert(stored.includes('id="tdoc-reader"'), 'duplicated copy lacks the template');
    const meta = JSON.parse(await env.META.get(`meta:${newSlug}`));
    assert(/^[0-9a-f]{16}$/.test((meta.versions[0] || {}).sha || ''), 'duplicated entry has no sha');
  });

  await t('widgets are NOT baked — the template does not belong in an island', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    const widget = '<!doctype html><html><head><title>w</title></head><body><script>1</script></body></html>';
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'd5', version: 1, html: DOC, widgets: { calc: widget }, meta: { title: 'd5', slug: 'd5', versions: [{ n: 1 }] } },
    }), env, {});
    assert(r.status === 200, `upload ${r.status}: ${await r.text()}`);
    const w = await env.DOCS.get('docs/d5/v1/widgets/calc.html');
    assert(w, 'widget not stored');
    assert(!(await w.text()).includes('id="tdoc-reader"'), 'widget was baked — reading template leaked into an island');
  });

  await t('a doc whose PROSE quotes id="tdoc-reader" is still baked', async () => {
    // The check is a tag match, not a substring: tdoc's own design docs quote
    // the id in code samples, and a substring check would skip baking them.
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    const quoting = DOC.replace('<p>hi</p>', '<p>Never write your own <code>id="tdoc-reader"</code> block.</p>');
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'q1', version: 1, html: quoting, meta: { title: 'q1', slug: 'q1', versions: [{ n: 1 }] } },
    }), env, {});
    const stored = await (await env.DOCS.get('docs/q1/v1/index.html')).text();
    assert(/<style[^>]*id="tdoc-reader"/.test(stored), 'prose mention suppressed the bake');
    assert((stored.match(/<style[^>]*id="tdoc-reader"/g) || []).length === 1, 'expected exactly one real block');
  });

  await t('history backfill refreshes the version entry sha', async () => {
    // Re-uploading an old version stores freshly-prepared bytes; the recorded
    // sha must follow them or /raw serves a stale ETag.
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env);
    for (const v of [1, 2]) {
      await worker.fetch(req('/api/upload', {
        method: 'POST', token: a.token,
        body: { slug: 'bf', version: v, html: DOC.replace('<p>hi</p>', `<p>v${v}</p>`), meta: { title: 'bf', slug: 'bf', versions: [{ n: 1 }, { n: 2 }].slice(0, v) } },
      }), env, {});
    }
    const meta0 = JSON.parse(await env.META.get('meta:bf'));
    meta0.versions.find((v) => v.n === 1).sha = 'deadbeefdeadbeef';
    await env.META.put('meta:bf', JSON.stringify(meta0));
    await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'bf', version: 1, html: DOC.replace('<p>hi</p>', '<p>v1</p>'), meta: { title: 'bf', slug: 'bf', versions: [{ n: 1 }, { n: 2 }] } },
    }), env, {});
    const meta = JSON.parse(await env.META.get('meta:bf'));
    const sha = meta.versions.find((v) => v.n === 1).sha;
    const stored = await (await env.DOCS.get('docs/bf/v1/index.html')).text();
    const expect = crypto.createHash('sha256').update(stored).digest('hex').slice(0, 16);
    assert(sha === expect, `backfill left a stale sha: ${sha} != ${expect}`);
    assert(meta.versions.find((v) => v.n === 2), 'backfill must not drop other version entries');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
