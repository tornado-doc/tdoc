// In-process worker harness: worker.js booted with fake KV / R2 / Durable
// Object bindings, so a suite can drive real routes end to end without a
// live Cloudflare. Extracted from hosted-oob-behavior.test.js when a second
// suite needed the same boot; that file still owns the hosted-token cases.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');

if (typeof globalThis.crypto === 'undefined') globalThis.crypto = webcrypto;

if (typeof Response !== 'undefined' && !Response.json) {
  Response.json = (body, init = {}) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

class FakeKV {
  constructor() {
    this.map = new Map();
    // Per-key metadata, as Workers KV keeps it: replaced on every put, and
    // returned by list() without reading the value.
    this.metadata = new Map();
    this.failPutOnce = new Set();
    this.gets = [];
  }
  async get(k) { this.gets.push(k); return this.map.has(k) ? this.map.get(k) : null; }
  // Workers KV returns the value and its metadata in one read; the doc and
  // team indexes diff the prior metadata against the next record on write.
  async getWithMetadata(k) {
    this.gets.push(k);
    return { value: this.map.has(k) ? this.map.get(k) : null, metadata: this.metadata.has(k) ? this.metadata.get(k) : null };
  }
  async put(k, v, opts) {
    if (this.failPutOnce.has(k)) {
      this.failPutOnce.delete(k);
      throw new Error(`forced KV put failure: ${k}`);
    }
    this.map.set(k, String(v));
    if (opts && opts.metadata !== undefined) this.metadata.set(k, JSON.parse(JSON.stringify(opts.metadata)));
    else this.metadata.delete(k);
  }
  async delete(k) { this.map.delete(k); this.metadata.delete(k); }
  async list({ prefix = '' } = {}) {
    return {
      keys: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(name => (
        this.metadata.has(name) ? { name, metadata: this.metadata.get(name) } : { name }
      )),
      list_complete: true,
    };
  }
}

class FakeR2 {
  constructor() {
    this.map = new Map();
    this.throwList = false;
    this.putCalls = 0;
  }
  async put(k, v) {
    this.putCalls++;
    this.map.set(k, v instanceof Uint8Array ? new Uint8Array(v) : String(v));
  }
  // `range` as R2 takes it: the shell page reads only the head of a doc.
  async get(k, opts) {
    if (!this.map.has(k)) return null;
    let v = this.map.get(k);
    const range = opts && opts.range;
    if (range && typeof range.length === 'number') v = v.slice(range.offset || 0, (range.offset || 0) + range.length);
    return {
      text: async () => typeof v === 'string' ? v : new TextDecoder().decode(v),
      arrayBuffer: async () => typeof v === 'string' ? new TextEncoder().encode(v).buffer : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
      size: this.map.get(k).length,
    };
  }
  async head(k) {
    if (!this.map.has(k)) return null;
    const v = this.map.get(k);
    return { size: typeof v === 'string' ? Buffer.byteLength(v) : v.byteLength };
  }
  // R2 deletes one key or an array of up to 1,000.
  async delete(k) {
    const keys = Array.isArray(k) ? k : [k];
    if (keys.length > 1000) throw new Error('R2 delete takes at most 1000 keys');
    for (const key of keys) this.map.delete(key);
  }
  async list({ prefix = '' } = {}) {
    if (this.throwList) throw new Error('forced R2 list failure');
    return {
      objects: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    };
  }
}

// SQLite-backed Durable Object storage's sql.exec, on node:sqlite (Node 22+),
// for the full-text search store. Absent on older Node: storage.sql is then
// undefined, exactly like a KV-backed Durable Object, and search degrades.
let nodeSqlite = null;
try { nodeSqlite = require('node:sqlite'); } catch {}
function fakeSql() {
  if (!nodeSqlite) return undefined;
  const db = new nodeSqlite.DatabaseSync(':memory:');
  return {
    exec(query, ...params) {
      const rows = db.prepare(query).all(...params.map((p) => (p === undefined ? null : p)));
      const plain = rows.map((row) => ({ ...row }));
      return { toArray: () => plain, one: () => plain[0], [Symbol.iterator]: () => plain[Symbol.iterator]() };
    },
  };
}

class FakeStorage {
  constructor() { this.map = new Map(); this.queue = Promise.resolve(); this.alarmAt = null; this._sql = undefined; }
  get sql() { if (this._sql === undefined) this._sql = fakeSql() || null; return this._sql || undefined; }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(at) { this.alarmAt = Number(at); }
  async deleteAlarm() { this.alarmAt = null; }
  async transaction(fn) {
    const run = this.queue.then(() => {
      const txn = {
        get: async (k) => this.map.get(k),
        put: async (k, v) => { this.map.set(k, v); },
        delete: async (k) => { this.map.delete(k); },
      };
      return fn(txn);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

class FakeDurableNamespace {
  constructor(env, StoreClass) {
    this.env = env;
    this.StoreClass = StoreClass;
    this.states = new Map();
  }
  idFromName(name) { return name; }
  stateFor(id) {
    if (!this.states.has(id)) this.states.set(id, { storage: new FakeStorage() });
    return this.states.get(id);
  }
  // Run every armed alarm until none is left (or `max` runs), as the
  // runtime would after their delays.
  async runAlarms(max = 100) {
    let runs = 0;
    for (let again = true; again && runs < max;) {
      again = false;
      for (const [id, state] of this.states) {
        if (state.storage.alarmAt == null) continue;
        state.storage.alarmAt = null;
        const store = new this.StoreClass(state, this.env);
        if (typeof store.alarm === 'function') await store.alarm();
        runs += 1;
        again = true;
      }
    }
    return runs;
  }
  get(id) {
    return {
      fetch: async (url, init = {}) => {
        const store = new this.StoreClass(this.stateFor(id), this.env);
        return store.fetch(new Request(url, init));
      },
    };
  }
}

async function loadWorker({ previewRenderer = false } = {}) {
  const root = path.join(__dirname, '..', '..');
  // TDOC_WORKER_JS: another worker.js to boot (test/bench compares a
  // checkout of main against the working tree with it). Tests never set it.
  let src = fs.readFileSync(process.env.TDOC_WORKER_JS || path.join(root, 'worker', 'worker.js'), 'utf8');
  // Inline the shell modules exactly like bin/tdoc-bundle, so the in-process
  // worker renders the real shell (doc pages carry the cfg with versions/
  // identity) instead of the bare no-SHELL fallback.
  const readerCss = fs.readFileSync(path.join(root, 'server', 'reader.css'), 'utf8');
  src = src.replace(
    /const READER_CSS = `__TDOC_READER_CSS__`;/,
    'const READER_CSS = ' + JSON.stringify(readerCss) + ';'
  );
  const shellMod = fs.readFileSync(path.join(root, 'server', 'shell.js'), 'utf8');
  const probeJs = require(path.join(root, 'server', 'frame-probe-source.js'))();
  src = src.replace('/* __TDOC_SHELL_MODULE__ */', shellMod);
  src = src.replace('/* __TDOC_NOTIFICATION_TEXT__ */', fs.readFileSync(path.join(root, 'shell', 'src', 'notification-text.js'), 'utf8').replace(/^export /gm, ''));
  src = src.replace('/* __TDOC_PREVIEW_VALIDATOR__ */', fs.readFileSync(path.join(root, 'server', 'preview', 'validate-svg.js'), 'utf8'));
  src = src.replace(/const PROBE_JS = `__TDOC_PROBE_JS__`;/, 'const PROBE_JS = ' + JSON.stringify(probeJs) + ';');
  const guides = require(path.join(root, 'server', 'authoring-guides.js')).loadAuthoringGuides(root);
  src = src.replace(/const AUTHORING_GUIDES = "__TDOC_AUTHORING_GUIDES__";/, 'const AUTHORING_GUIDES = ' + JSON.stringify(guides) + ';');
  if (previewRenderer) {
    const dir = path.join(root, 'server', 'preview');
    const resvg = fs.readFileSync(path.join(dir, 'resvg.mjs'), 'utf8')
      .replace(/export\s*\{\s*Resvg2 as Resvg,\s*initWasm\s*\};?\s*$/, 'return { Resvg: Resvg2, initWasm };');
    src = src.replace(/const PREVIEW_RENDERER = "__TDOC_PREVIEW_RENDERER__";/, 'const PREVIEW_RENDERER = (() => {\n' + resvg + '\n})();');
    src = src.replace(/const PREVIEW_WASM = "__TDOC_PREVIEW_WASM__";/,
      'const PREVIEW_WASM = ' + JSON.stringify(fs.readFileSync(path.join(dir, 'resvg.wasm'), 'base64')) + ';');
    src = src.replace(/const PREVIEW_FONTS = "__TDOC_PREVIEW_FONTS__";/,
      'const PREVIEW_FONTS = ' + JSON.stringify(['Regular', 'Bold'].map((weight) => fs.readFileSync(path.join(dir, `NotoSansSC-${weight}.ttf`), 'base64'))) + ';');
    src = src.replace(/const PREVIEW_FONT_COVERAGE = "__TDOC_PREVIEW_FONT_COVERAGE__";/,
      'const PREVIEW_FONT_COVERAGE = ' + fs.readFileSync(path.join(dir, 'coverage.json'), 'utf8') + ';');
  }
  const tmp = path.join(os.tmpdir(), `tdoc-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(tmp, src);
  const mod = await import(`file://${tmp}`);
  try { fs.unlinkSync(tmp); } catch {}
  return mod;
}

function makeEnv(StoreClass, extra = {}) {
  const env = {
    META: new FakeKV(),
    DOCS: new FakeR2(),
    TDOC_HOSTED_REGISTRATION: '1',
    ...extra,
  };
  env.COMMENTS = new FakeDurableNamespace(env, StoreClass);
  return env;
}

function req(pathname, { method = 'GET', token = '', body = null, cookie = '', host = 'tdoc.dev', dest = '', headers = {} } = {}) {
  return new Request(`https://${host}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie.includes('=') ? cookie : `tdoc_sid=${cookie}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(dest ? { 'Sec-Fetch-Dest': dest } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function bootData(html, name) {
  const marker = `window.${name} = `;
  const start = html.indexOf(marker);
  assert(start >= 0, `${name} missing`);
  const end = html.indexOf(';</script>', start);
  assert(end >= 0, `${name} script is not terminated`);
  return JSON.parse(html.slice(start + marker.length, end));
}

async function putSession(env, login, sid) {
  // Worker parseCookie only accepts hex tdoc_sid values.
  const id = sid || [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    login, name: login, avatar_url: '', created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

async function issue(worker, env, login = 'alice', label = login) {
  const cookie = await putSession(env, login);
  const r = await worker.fetch(req('/api/hosted/token', {
    method: 'POST', cookie, body: { label },
  }), env, {});
  const data = await r.json();
  assert(r.status === 200 && data.token && data.account_id,
    `token issue failed ${r.status}: ${JSON.stringify(data)}`);
  assert(data.github_login === login, `expected github_login ${login}, got ${data.github_login}`);
  return { ...data, cookie, login };
}


module.exports = {
  FakeKV, FakeR2, FakeStorage, FakeDurableNamespace,
  loadWorker, makeEnv, req, bootData, putSession, issue,
};
