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
    this.failPutOnce = new Set();
  }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) {
    if (this.failPutOnce.has(k)) {
      this.failPutOnce.delete(k);
      throw new Error(`forced KV put failure: ${k}`);
    }
    this.map.set(k, String(v));
  }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    return {
      keys: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
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
    this.map.set(k, String(v));
  }
  async get(k) {
    if (!this.map.has(k)) return null;
    const v = this.map.get(k);
    return { text: async () => v };
  }
  async head(k) {
    if (!this.map.has(k)) return null;
    return { size: Buffer.byteLength(this.map.get(k)) };
  }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    if (this.throwList) throw new Error('forced R2 list failure');
    return {
      objects: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    };
  }
}

class FakeStorage {
  constructor() { this.map = new Map(); this.queue = Promise.resolve(); }
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
  get(id) {
    return {
      fetch: async (url, init = {}) => {
        const store = new this.StoreClass(this.stateFor(id), this.env);
        return store.fetch(new Request(url, init));
      },
    };
  }
}

async function loadWorker() {
  const root = path.join(__dirname, '..', '..');
  let src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  // Inline the shell modules exactly like bin/tdoc-bundle, so the in-process
  // worker renders the real shell (doc pages carry the cfg with versions/
  // identity) instead of the bare no-SHELL fallback.
  const readerCss = fs.readFileSync(path.join(root, 'server', 'reader.css'), 'utf8');
  src = src.replace(
    /const READER_CSS = `__TDOC_READER_CSS__`;/,
    'const READER_CSS = ' + JSON.stringify(readerCss) + ';'
  );
  const shellMod = fs.readFileSync(path.join(root, 'server', 'shell.js'), 'utf8');
  const probeJs = fs.readFileSync(path.join(root, 'server', 'frame-probe.js'), 'utf8');
  src = src.replace('/* __TDOC_SHELL_MODULE__ */', shellMod);
  src = src.replace(/const PROBE_JS = `__TDOC_PROBE_JS__`;/, 'const PROBE_JS = ' + JSON.stringify(probeJs) + ';');
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

function req(pathname, { method = 'GET', token = '', body = null, cookie = '', host = 'tdoc.dev', dest = '' } = {}) {
  return new Request(`https://${host}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie.includes('=') ? cookie : `tdoc_sid=${cookie}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(dest ? { 'Sec-Fetch-Dest': dest } : {}),
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
