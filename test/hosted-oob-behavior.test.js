// Hosted OOB behavioral tests against worker.js with fake KV/R2/DO bindings.
//
// These cover the cross-tenant write bugs a static grep test cannot prove:
// missing-meta upload must still persist hosted ownership; a second hosted
// token must not overwrite that slug; delete must release ownership so the
// original owner can republish; and legacy/orphan docs with no ownership
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
// Message only — avoid e.stack so CodeQL does not flag this test helper as
// "information exposure through a stack trace".
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
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
      delete: async (k) => { this.map.delete(k); },
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

  await t('hosted token mint is closed unless registration is explicitly enabled', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_REGISTRATION: '' });
    const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', body: { label: 'closed' } }), env, {});
    const data = await r.json();
    assert(r.status === 403, `expected 403, got ${r.status}`);
    assert(data.error === 'hosted_registration_disabled', `unexpected error ${JSON.stringify(data)}`);
    assert([...env.META.map.keys()].every(k => !k.startsWith('hosted-token:')),
      'disabled registration must not persist a token record');
  });

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

  await t('invalid access on first hosted upload does not park the slug', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env, 'bad-access');
    const b = await issue(worker, env, 'takes-slug');
    const bad = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: {
        slug: 'unparked', version: 1, html: '<h1>nope</h1>',
        meta: { access: { visibility: 'not-a-visibility' } },
      },
    }), env, {});
    assert(bad.status === 400, `invalid access should 400, got ${bad.status}`);
    assert(!env.COMMENTS.stateFor('unparked').storage.map.has('hostedOwner'),
      'a 400 must not persist hostedOwner');
    const okUpload = await worker.fetch(req('/api/upload', {
      method: 'POST', token: b.token,
      body: { slug: 'unparked', version: 1, html: '<h1>ok</h1>' },
    }), env, {});
    assert(okUpload.status === 200, `second token should take the unparked slug, got ${okUpload.status}: ${await okUpload.text()}`);
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

  await t('after delete, original owner can republish; second token cannot squat while owned', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env, 'owner');
    const b = await issue(worker, env, 'other');
    const first = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'reclaim-doc', version: 1, html: '<h1>v1</h1>' },
    }), env, {});
    assert(first.status === 200, `first upload ${first.status}`);

    const squatWhileOwned = await worker.fetch(req('/api/upload', {
      method: 'POST', token: b.token,
      body: { slug: 'reclaim-doc', version: 1, html: '<h1>stolen</h1>' },
    }), env, {});
    assert(squatWhileOwned.status === 403, `second token must not overwrite a live slug, got ${squatWhileOwned.status}`);

    const del = await worker.fetch(req('/api/doc?slug=reclaim-doc', { method: 'DELETE', token: a.token }), env, {});
    assert(del.status === 200, `delete ${del.status}: ${await del.text()}`);
    assert(!env.COMMENTS.stateFor('reclaim-doc').storage.map.has('hostedOwner'),
      'delete must release hostedOwner');
    assert(!await env.META.get('meta:reclaim-doc'), 'delete must drop meta');
    assert(!await env.DOCS.head('docs/reclaim-doc/v1/index.html'), 'delete must drop R2 bytes');

    const republish = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'reclaim-doc', version: 1, html: '<h1>v1-again</h1>' },
    }), env, {});
    assert(republish.status === 200, `original owner republish ${republish.status}: ${await republish.text()}`);
    const meta = JSON.parse(await env.META.get('meta:reclaim-doc'));
    assert(meta.hosted.account_id === a.account_id, 'republish did not restore hosted owner');
  });

  await t('DELETE fails closed when release_owner fails and COMMENTS exists', async () => {
    const env = makeEnv(mod.CommentsStore);
    const a = await issue(worker, env, 'release-fail');
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: a.token,
      body: { slug: 'parked-on-bad-release', version: 1, html: '<h1>v1</h1>' },
    }), env, {});
    assert(up.status === 200, `upload ${up.status}`);
    assert(env.COMMENTS.stateFor('parked-on-bad-release').storage.map.get('hostedOwner') === a.account_id,
      'expected hostedOwner before delete');

    const origGet = env.COMMENTS.get.bind(env.COMMENTS);
    env.COMMENTS.get = (id) => {
      const stub = origGet(id);
      const origFetch = stub.fetch.bind(stub);
      return {
        fetch: async (url, init = {}) => {
          const href = typeof url === 'string' ? url : String(url);
          if (href.includes('/owner') && init.body) {
            const payload = JSON.parse(init.body);
            if (payload.op && payload.op.kind === 'release_owner') {
              return Response.json({ ok: false, status: 503, error: 'forced_release_fail' });
            }
          }
          return origFetch(url, init);
        },
      };
    };

    const del = await worker.fetch(req('/api/doc?slug=parked-on-bad-release', {
      method: 'DELETE', token: a.token,
    }), env, {});
    assert(del.status !== 200, `DELETE must not succeed when release fails, got ${del.status}`);
    const body = await del.json();
    assert(body.error === 'forced_release_fail' || body.error === 'owner_release_failed',
      `unexpected error body ${JSON.stringify(body)}`);
    assert(env.COMMENTS.stateFor('parked-on-bad-release').storage.map.has('hostedOwner'),
      'failed release must leave hostedOwner set');
  });

  await t('DELETE without COMMENTS still succeeds (no hosted reservation)', async () => {
    const env = makeEnv(mod.CommentsStore);
    env.TDOC_UPLOAD_TOKEN = 'admin-token';
    await env.META.put('meta:vercel-style', JSON.stringify({
      title: 'x', slug: 'vercel-style', versions: [{ n: 1 }],
    }));
    await env.DOCS.put('docs/vercel-style/v1/index.html', '<h1>v1</h1>');
    delete env.COMMENTS;
    const del = await worker.fetch(req('/api/doc?slug=vercel-style', {
      method: 'DELETE', token: 'admin-token',
    }), env, {});
    assert(del.status === 200, `Vercel-style delete should 200, got ${del.status}: ${await del.text()}`);
    assert(!await env.META.get('meta:vercel-style'), 'meta should be wiped');
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
