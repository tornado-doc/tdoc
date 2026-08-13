// Hosted OOB behavioral tests against worker.js with fake KV/R2/DO bindings.
//
// These cover the cross-tenant write bugs a static grep test cannot prove:
// missing-meta upload must still persist hosted ownership; a second hosted
// token must not overwrite that slug; and legacy/orphan docs with no ownership
// must fail closed for destructive/admin routes.

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

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e.stack || e.message || e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
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
  constructor() { this.map = new Map(); }
  async transaction(fn) {
    const txn = {
      get: async (k) => this.map.get(k),
      put: async (k, v) => { this.map.set(k, v); },
    };
    return fn(txn);
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
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
  const tmp = path.join(os.tmpdir(), `tdoc-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(tmp, src);
  const mod = await import(`file://${tmp}`);
  try { fs.unlinkSync(tmp); } catch {}
  return mod;
}

function makeEnv(StoreClass) {
  const env = {
    META: new FakeKV(),
    DOCS: new FakeR2(),
    TDOC_HOSTED_REGISTRATION: '1',
  };
  env.COMMENTS = new FakeDurableNamespace(env, StoreClass);
  return env;
}

function req(pathname, { method = 'GET', token = '', body = null } = {}) {
  return new Request(`https://tdoc.dev${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function issue(worker, env, label = 'test') {
  const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', body: { label } }), env, {});
  const data = await r.json();
  assert(r.status === 200 && data.token && data.account_id, `token issue failed ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('hosted OOB behavior');

  await t('missing-meta hosted upload still persists owner; second token cannot overwrite', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env, 'a');
    const b = await issue(worker, env, 'b');
    const first = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'owned-doc', version: 1, html: '<h1>A</h1>' },
    }), env, {});
    assert(first.status === 200, `first upload ${first.status}: ${await first.text()}`);
    const meta = JSON.parse(await env.META.get('meta:owned-doc'));
    assert(meta.hosted.account_id === a.account_id, 'first upload did not persist hosted owner meta');

    const second = await worker.fetch(req('/api/upload', {
      method: 'POST', token: b.token,
      body: { slug: 'owned-doc', version: 1, html: '<h1>B</h1>' },
    }), env, {});
    assert(second.status === 403, `second token should be denied, got ${second.status}`);
    const doc = await env.DOCS.get('docs/owned-doc/v1/index.html');
    assert((await doc.text()).includes('A'), 'denied second upload overwrote document bytes');
  });

  await t('R2 list failure during first claim fails closed before DO claim or R2 put', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'list-fails');
    env.DOCS.throwList = true;
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: 'list-fails', version: 1, html: '<h1>nope</h1>' },
    }), env, {});
    assert(r.status >= 400, `list failure should not succeed, got ${r.status}`);
    assert(env.DOCS.putCalls === 0, 'R2 put ran despite failed existence check');
    assert(!env.COMMENTS.stateFor('list-fails').storage.map.has('hostedOwner'), 'DO owner claim was persisted despite failed existence check');
  });

  await t('same hosted owner can retry after META write failure and repair ownership meta', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'repair');
    env.META.failPutOnce.add('meta:repair-doc');
    const first = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: 'repair-doc', version: 1, html: '<h1>first</h1>' },
    }), env, {});
    assert(first.status >= 400, `first upload should report failed meta write, got ${first.status}`);
    assert(await env.DOCS.head('docs/repair-doc/v1/index.html'), 'first upload did not leave the reproduced partial R2 write');
    assert(!await env.META.get('meta:repair-doc'), 'test setup expected meta write to fail');
    assert(env.COMMENTS.stateFor('repair-doc').storage.map.get('hostedOwner') === tok.account_id, 'test setup expected DO claim to persist');

    const retry = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: 'repair-doc', version: 1, html: '<h1>retry</h1>' },
    }), env, {});
    assert(retry.status === 200, `same owner retry should repair meta, got ${retry.status}: ${await retry.text()}`);
    const repaired = JSON.parse(await env.META.get('meta:repair-doc'));
    assert(repaired.hosted.account_id === tok.account_id, 'retry did not repair hosted ownership meta');
  });

  await t('hosted token cannot delete legacy/orphan R2 doc with no meta/owner', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'deleter');
    await env.DOCS.put('docs/legacy-no-meta/v1/index.html', '<h1>legacy</h1>');
    const r = await worker.fetch(req('/api/doc?slug=legacy-no-meta', { method: 'DELETE', token: tok.token }), env, {});
    assert(r.status !== 200, `delete should fail closed, got ${r.status}`);
    assert(await env.DOCS.head('docs/legacy-no-meta/v1/index.html'), 'legacy doc bytes were deleted');
  });

  await t('hosted token cannot wipe comments for legacy/no-meta slug', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'wiper');
    const state = env.COMMENTS.stateFor('legacy-comments').storage.map;
    state.set('list', [{ id: 'c1', events: [{ kind: 'created', at_version: 1, text: 'keep' }] }]);
    const r = await worker.fetch(req('/api/comments?slug=legacy-comments&all=1', { method: 'DELETE', token: tok.token }), env, {});
    assert(r.status !== 200, `wipe should fail closed, got ${r.status}`);
    assert(state.get('list').length === 1, 'comment list was wiped');
  });

  await t('hosted token cannot agent-reply on legacy/no-meta slug', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'agent');
    const state = env.COMMENTS.stateFor('legacy-reply').storage.map;
    state.set('list', [{ id: 'c1', events: [{ kind: 'created', at_version: 1, text: 'parent' }] }]);
    const r = await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token: tok.token,
      body: { slug: 'legacy-reply', parent_id: 'c1', text: 'should not write', status: 'applied' },
    }), env, {});
    assert(r.status !== 200, `agent reply should fail closed, got ${r.status}`);
    assert(state.get('list')[0].events.length === 1, 'agent reply mutated comments');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
