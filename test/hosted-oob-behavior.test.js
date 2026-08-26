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
  const root = path.join(__dirname, '..');
  let src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  // Inline the shell modules exactly like bin/tdoc-bundle, so the in-process
  // worker renders the real shell (doc pages carry the cfg with versions/
  // identity) instead of the bare no-SHELL fallback.
  const readerCss = fs.readFileSync(path.join(root, 'server', 'reader.css'), 'utf8');
  src = src.replace(
    /const READER_CSS = `__TDOC_READER_CSS__`;/,
    'const READER_CSS = ' + JSON.stringify(readerCss) + ';'
  );
  const chromeMod = fs.readFileSync(path.join(root, 'server', 'chrome.js'), 'utf8');
  const shellMod = fs.readFileSync(path.join(root, 'server', 'shell.js'), 'utf8');
  const probeJs = fs.readFileSync(path.join(root, 'server', 'frame-probe.js'), 'utf8');
  const chromeCss = fs.readFileSync(path.join(root, 'server', 'chrome.css'), 'utf8');
  src = src.replace('/* __TDOC_CHROME_MODULE__ */', chromeMod);
  src = src.replace('/* __TDOC_SHELL_MODULE__ */', shellMod);
  src = src.replace(/const CHROME_JS = `__TDOC_CHROME_JS__`;/, 'const CHROME_JS = ' + JSON.stringify(chromeMod) + ';');
  src = src.replace(/const PROBE_JS = `__TDOC_PROBE_JS__`;/, 'const PROBE_JS = ' + JSON.stringify(probeJs) + ';');
  src = src.replace(/const CHROME_CSS = `__TDOC_CHROME_CSS__`;/, 'const CHROME_CSS = ' + JSON.stringify(chromeCss) + ';');
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

function req(pathname, { method = 'GET', token = '', body = null, cookie = '', host = 'tdoc.dev' } = {}) {
  return new Request(`https://${host}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie.includes('=') ? cookie : `tdoc_sid=${cookie}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('hosted OOB behavior');

  await t('hosted token mint is closed unless registration is explicitly enabled', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_REGISTRATION: '0' });
    const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', body: { label: 'closed' } }), env, {});
    const data = await r.json();
    assert(r.status === 403, `expected 403, got ${r.status}`);
    assert(data.error === 'hosted_registration_disabled', `unexpected error ${JSON.stringify(data)}`);
    assert([...env.META.map.keys()].every(k => !k.startsWith('hosted-token:')),
      'disabled registration must not persist a token record');
  });

  await t('unset registration enables on tdoc.dev and stays closed on BYOK hosts', async () => {
    const env = makeEnv(mod.CommentsStore);
    delete env.TDOC_HOSTED_REGISTRATION;
    const cookie = await putSession(env, 'alice');
    const onDev = await worker.fetch(req('/api/hosted/token', {
      method: 'POST', cookie, body: { label: 'dev' },
    }), env, {});
    assert(onDev.status === 200, `tdoc.dev should mint, got ${onDev.status}: ${await onDev.clone().text()}`);
    const byok = await worker.fetch(new Request('https://example.workers.dev/api/hosted/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ label: 'byok' }),
    }), env, {});
    assert(byok.status === 403, `BYOK host should stay closed, got ${byok.status}`);
    const byokBody = await byok.json();
    assert(byokBody.error === 'hosted_registration_disabled', `unexpected ${JSON.stringify(byokBody)}`);
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

  await t('create against orphan R2 bytes (no hostedOwner) returns slug_taken 409', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'orphan-claimer');
    await env.DOCS.put('docs/orphan-bytes/v1/index.html', '<h1>legacy</h1>');
    assert(!env.COMMENTS.stateFor('orphan-bytes').storage.map.has('hostedOwner'),
      'test setup expected no hostedOwner');
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: 'orphan-bytes', version: 1, html: '<h1>takeover</h1>' },
    }), env, {});
    assert(r.status === 409, `orphan bytes should be slug_taken 409, got ${r.status}`);
    const body = await r.json();
    assert(body.error === 'slug_taken', `expected slug_taken, got ${JSON.stringify(body)}`);
    assert((await (await env.DOCS.get('docs/orphan-bytes/v1/index.html')).text()).includes('legacy'),
      'denied orphan claim must not overwrite bytes');
  });

  await t('hostedOwnerOp DO fetch failure returns controlled 503 shape (no throw)', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'do-down');
    env.COMMENTS.get = () => ({
      fetch: async () => { throw new Error('forced DO down'); },
    });
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: 'do-down-doc', version: 1, html: '<h1>x</h1>' },
    }), env, {});
    assert(r.status === 503, `DO failure should be 503, got ${r.status}: ${await r.clone().text()}`);
    const body = await r.json();
    assert(body.error === 'hosted_owner_store_unavailable', `unexpected body ${JSON.stringify(body)}`);
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

  await t('hosted token mint requires a GitHub session even when registration is open', async () => {
    const env = makeEnv(mod.CommentsStore);
    const r = await worker.fetch(req('/api/hosted/token', { method: 'POST', body: { label: 'anon' } }), env, {});
    const data = await r.json();
    assert(r.status === 401, `expected 401, got ${r.status}`);
    assert(data.error === 'sign_in_required', `unexpected error ${JSON.stringify(data)}`);
    // The 401 body carries an actionable hint so a stale CLI that just prints
    // the response still tells the user to update.
    assert(typeof data.hint === 'string' && /tdoc update/.test(data.hint),
      `sign_in_required should include an update hint, got ${JSON.stringify(data)}`);
    assert([...env.META.map.keys()].every(k => !k.startsWith('hosted-token:')),
      'anonymous mint must not persist a token record');
  });

  await t('same GitHub login remints the same account_id; a second login cannot overwrite that slug', async () => {
    const env = makeEnv(mod.CommentsStore);
    const first = await issue(worker, env, 'alice', 'laptop');
    const remint = await issue(worker, env, 'alice', 'phone');
    assert(first.account_id === remint.account_id, 'remint must reuse account_id');
    assert(first.token !== remint.token, 'remint must issue a new token');

    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: first.token,
      body: { slug: 'alice-doc', version: 1, html: '<h1>A</h1>' },
    }), env, {});
    assert(up.status === 200, `alice upload ${up.status}: ${await up.text()}`);
    const meta = JSON.parse(await env.META.get('meta:alice-doc'));
    assert(meta.hosted.github_login === 'alice', 'upload must stamp github_login');

    const bob = await issue(worker, env, 'bob');
    const steal = await worker.fetch(req('/api/upload', {
      method: 'POST', token: bob.token,
      body: { slug: 'alice-doc', version: 1, html: '<h1>stolen</h1>' },
    }), env, {});
    assert(steal.status === 403, `bob should be denied, got ${steal.status}`);
  });

  await t('/me lists only the signed-in GitHub user docs; operator keeps legacy unhosted', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    const alice = await issue(worker, env, 'alice');
    const bob = await issue(worker, env, 'bob');
    const aUp = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'alice-doc', version: 1, html: '<h1>A</h1>', meta: { title: 'Alice Doc' } },
    }), env, {});
    assert(aUp.status === 200, `alice upload ${aUp.status}`);
    const bUp = await worker.fetch(req('/api/upload', {
      method: 'POST', token: bob.token,
      body: { slug: 'bob-doc', version: 1, html: '<h1>B</h1>', meta: { title: 'Bob Doc' } },
    }), env, {});
    assert(bUp.status === 200, `bob upload ${bUp.status}`);
    await env.META.put('meta:legacy', JSON.stringify({
      title: 'Legacy', slug: 'legacy', versions: [{ n: 1 }],
    }));

    const aliceMe = await worker.fetch(req('/me', { cookie: alice.cookie }), env, {});
    assert(aliceMe.status === 200, `/me alice ${aliceMe.status}`);
    const aliceHtml = await aliceMe.text();
    assert(aliceHtml.includes('alice-doc'), 'alice must see her slug');
    assert(!aliceHtml.includes('data-slug="bob-doc"'), 'alice must not see bob');
    assert(!aliceHtml.includes('data-slug="legacy"'), 'alice must not see operator legacy docs');

    const bobMe = await worker.fetch(req('/me', { cookie: bob.cookie }), env, {});
    const bobHtml = await bobMe.text();
    assert(bobHtml.includes('bob-doc'), 'bob must see his slug');
    assert(!bobHtml.includes('alice-doc'), 'bob must not see alice');

    const julieSid = await putSession(env, 'julie');
    const julieMe = await worker.fetch(req('/me', { cookie: julieSid }), env, {});
    assert(julieMe.status === 200, `/me julie ${julieMe.status}`);
    const julieHtml = await julieMe.text();
    assert(julieHtml.includes('data-slug="legacy"'), 'operator must still see unhosted legacy docs');
    assert(!julieHtml.includes('data-slug="alice-doc"'), 'operator /me must not list other tenants');
    assert(!julieHtml.includes('data-slug="bob-doc"'), 'operator /me must not list other tenants');
  });

  await t('hosted create enforces per-account doc quota; retry of same slug does not consume another slot', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_MAX_DOCS: '1' });
    const alice = await issue(worker, env, 'alice');
    const first = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'one', version: 1, html: '<h1>1</h1>' },
    }), env, {});
    assert(first.status === 200, `first upload ${first.status}`);
    const second = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'two', version: 1, html: '<h1>2</h1>' },
    }), env, {});
    assert(second.status === 403, `quota should 403, got ${second.status}`);
    const body = await second.json();
    assert(body.error === 'quota_docs', `expected quota_docs, got ${JSON.stringify(body)}`);
    const retry = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'one', version: 2, html: '<h1>1b</h1>' },
    }), env, {});
    assert(retry.status === 200, `same-slug retry should not count as a new doc, got ${retry.status}: ${await retry.text()}`);
  });

  await t('hosted upload rejects oversize html', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_MAX_UPLOAD_BYTES: '20' });
    const alice = await issue(worker, env, 'alice');
    const r = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'big', version: 1, html: '<h1>this is more than twenty bytes of html</h1>' },
    }), env, {});
    assert(r.status === 413, `expected 413, got ${r.status}`);
    const body = await r.json();
    assert(body.error === 'quota_upload_bytes', `expected quota_upload_bytes, got ${JSON.stringify(body)}`);
  });

  await t('hosted upload quota counts UTF-8 bytes, not JS string length', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_MAX_UPLOAD_BYTES: '20' });
    const alice = await issue(worker, env, 'alice');
    const cjk = '<p>' + '文'.repeat(7) + '</p>'; // 14 UTF-16 units, 28 UTF-8 bytes
    assert(cjk.length <= 20, 'fixture must sit under the JS length cap');
    const over = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'cjk', version: 1, html: cjk },
    }), env, {});
    assert(over.status === 413, `expected 413 for CJK over the byte cap, got ${over.status}`);
    const overBody = await over.json();
    assert(overBody.error === 'quota_upload_bytes', `unexpected ${JSON.stringify(overBody)}`);
    assert(overBody.size === new TextEncoder().encode(cjk).byteLength,
      `size should be UTF-8 bytes, got ${overBody.size}`);
    const okUp = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'ok', version: 1, html: '<p>hi</p>' },
    }), env, {});
    assert(okUp.status === 200, `ASCII under the cap should upload, got ${okUp.status}: ${await okUp.text()}`);
  });

  await t('duplicate requires a signed-in session', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    await env.DOCS.put('docs/src-doc/v1/index.html', '<h1>Src</h1>');
    await env.META.put('meta:src-doc', JSON.stringify({ title: 'Src', slug: 'src-doc', versions: [{ n: 1 }] }));
    const r = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', body: { slug: 'src-doc', version: 1 },
    }), env, {});
    assert(r.status === 401, `expected 401, got ${r.status}`);
    const body = await r.json();
    assert(body.error === 'sign_in_required', `unexpected ${JSON.stringify(body)}`);
  });

  await t('self-host non-owner cannot duplicate; owner can', async () => {
    const env = makeEnv(mod.CommentsStore, {
      TDOC_OWNER: 'julie',
      TDOC_ACCOUNT_COPY: '',
      TDOC_HOSTED_REGISTRATION: '',
    });
    await env.DOCS.put('docs/src-doc/v1/index.html', '<h1>Src</h1>');
    await env.META.put('meta:src-doc', JSON.stringify({ title: 'Src', slug: 'src-doc', versions: [{ n: 1 }] }));
    const alice = await putSession(env, 'alice');
    const denied = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', cookie: alice, host: 'tdoc.example.workers.dev',
      body: { slug: 'src-doc', version: 1 },
    }), env, {});
    assert(denied.status === 403, `alice should 403 on self-host, got ${denied.status}`);
    assert((await denied.json()).error === 'account_copy_unavailable', 'expected account_copy_unavailable');

    const julie = await putSession(env, 'julie');
    const okDup = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', cookie: julie, host: 'tdoc.example.workers.dev',
      body: { slug: 'src-doc', version: 1 },
    }), env, {});
    const okBody = await okDup.json();
    assert(okDup.status === 200 && okBody.ok && okBody.slug === 'src-doc-copy',
      `owner duplicate failed ${okDup.status}: ${JSON.stringify(okBody)}`);
    assert(await env.DOCS.head('docs/src-doc-copy/v1/index.html'), 'owner copy missing R2 bytes');
    const comments = await env.META.get('comments:src-doc-copy');
    assert(!comments, 'duplicate must not copy comments');
  });

  await t('tdoc.dev signed-in reader gets an unlisted snapshot they own; /me hides it from the operator', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    await env.DOCS.put('docs/public-essay/v2/index.html', '<h1>Essay</h1><p>body</p>');
    await env.META.put('meta:public-essay', JSON.stringify({
      title: 'Essay', slug: 'public-essay', versions: [{ n: 1 }, { n: 2 }],
    }));
    await env.META.put('comments:public-essay', JSON.stringify([{ id: 'c1', text: 'nope' }]));
    const alice = await putSession(env, 'alice');
    const first = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', cookie: alice,
      body: { slug: 'public-essay', version: 2 },
    }), env, {});
    const firstBody = await first.json();
    assert(first.status === 200 && firstBody.slug === 'public-essay-copy',
      `alice duplicate failed ${first.status}: ${JSON.stringify(firstBody)}`);
    const meta = JSON.parse(await env.META.get('meta:public-essay-copy'));
    assert(meta.duplicated_by === 'alice', 'duplicated_by missing');
    assert(meta.source && meta.source.slug === 'public-essay' && meta.source.version === 2, 'source pointer missing');
    assert(meta.versions.length === 1 && meta.versions[0].n === 1, 'must be a v1 snapshot');
    assert(meta.access && meta.access.visibility === 'unlisted', 'copy should default unlisted');
    assert(meta.hosted && meta.hosted.github_login === 'alice', 'copy must bind alice');
    const tok = await issue(worker, env, 'alice');
    assert(tok.account_id === meta.hosted.account_id,
      'CLI mint and Duplicate must share account_id');
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: tok.token,
      body: { slug: firstBody.slug, version: 2, html: '<h1>Essay v2</h1>' },
    }), env, {});
    assert(up.status === 200, `CLI token should update the copy, got ${up.status}: ${await up.text()}`);
    assert(!(await env.META.get('comments:public-essay-copy')), 'comments must not come along');

    const second = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', cookie: alice,
      body: { slug: 'public-essay', version: 2 },
    }), env, {});
    const secondBody = await second.json();
    assert(second.status === 200 && secondBody.slug === 'public-essay-copy-2',
      `second copy should be -copy-2, got ${JSON.stringify(secondBody)}`);

    const julie = await putSession(env, 'julie');
    const me = await worker.fetch(req('/me', { cookie: julie }), env, {});
    const meHtml = await me.text();
    assert(me.status === 200, `/me ${me.status}`);
    assert(meHtml.includes('public-essay') && !meHtml.includes('public-essay-copy'),
      'operator /me must not list alice\'s account copies');
  });

  await t('duplicate consumes the same hosted doc quota as publish', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_MAX_DOCS: '1' });
    await env.DOCS.put('docs/src-doc/v1/index.html', '<h1>Src</h1>');
    await env.META.put('meta:src-doc', JSON.stringify({ title: 'Src', slug: 'src-doc', versions: [{ n: 1 }] }));
    const alice = await issue(worker, env, 'alice');
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: alice.token,
      body: { slug: 'one', version: 1, html: '<h1>1</h1>' },
    }), env, {});
    assert(up.status === 200, `seed upload ${up.status}`);
    const dup = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', cookie: alice.cookie,
      body: { slug: 'src-doc', version: 1 },
    }), env, {});
    assert(dup.status === 403, `duplicate should hit quota, got ${dup.status}`);
    assert((await dup.json()).error === 'quota_docs', 'duplicate must return quota_docs');
  });

  await t('legacy hosted-github account_id is reused by mint', async () => {
    const env = makeEnv(mod.CommentsStore);
    await env.META.put('hosted-github:alice', JSON.stringify({
      account_id: 'acct_legacyalice', github_login: 'alice', created: '2026-01-01T00:00:00.000Z',
    }));
    const tok = await issue(worker, env, 'alice');
    assert(tok.account_id === 'acct_legacyalice', `expected migrated account_id, got ${tok.account_id}`);
    const rec = JSON.parse(await env.META.get('hosted-account:alice'));
    assert(rec.account_id === 'acct_legacyalice', 'must copy the leftover record onto hosted-account');
  });

  await t('duplicate refuses island-bearing docs', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    await env.DOCS.put('docs/with-island/v1/index.html', '<h1>Host</h1><iframe src="/d/with-island/v/1/widget/sim"></iframe>');
    await env.DOCS.put('docs/with-island/v1/widgets/sim.html', '<html><script>1</script></html>');
    await env.META.put('meta:with-island', JSON.stringify({ title: 'Island', slug: 'with-island', versions: [{ n: 1 }] }));
    const alice = await putSession(env, 'alice');
    const r = await worker.fetch(req('/api/doc/duplicate', {
      method: 'POST', cookie: alice,
      body: { slug: 'with-island', version: 1 },
    }), env, {});
    assert(r.status === 409, `expected 409, got ${r.status}`);
    assert((await r.json()).error === 'islands_not_supported');
    assert(!await env.DOCS.head('docs/with-island-copy/v1/index.html'), 'island doc must not be copied');
  });

  await t('export attachment uses slug-vN.html', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    await env.DOCS.put('docs/src-doc/v1/index.html', '<h1>Src</h1>');
    await env.META.put('meta:src-doc', JSON.stringify({ title: 'Src', slug: 'src-doc', versions: [{ n: 1 }] }));
    const r = await worker.fetch(req('/d/src-doc/v/1/export?download=1'), env, {});
    assert(r.status === 200, `export ${r.status}`);
    const cd = r.headers.get('content-disposition') || '';
    assert(cd.includes('src-doc-v1.html'), `disposition was ${cd}`);
    assert(!cd.includes('fork'), `disposition still says fork: ${cd}`);
  });

  await t('export HTML includes reader CSS and no overlay bar', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_OWNER: 'julie' });
    await env.DOCS.put('docs/src-doc/v1/index.html', '<!doctype html><html><head><title>Src</title></head><body><h1>Src</h1></body></html>');
    await env.META.put('meta:src-doc', JSON.stringify({ title: 'Src', slug: 'src-doc', versions: [{ n: 1 }] }));
    const r = await worker.fetch(req('/d/src-doc/v/1/export?download=1'), env, {});
    assert(r.status === 200, `export ${r.status}`);
    const body = await r.text();
    assert(body.includes('id="tdoc-reader"'), 'export must stamp #tdoc-reader');
    assert(body.includes(':where(body h1)'), 'export must include the Classic heading template');
    assert(body.includes('--td-accent'), 'export must include theme tokens');
    assert(!body.includes('window.__TDOC__'), 'export must not boot overlay JS');
    assert(!body.includes('id="tdoc-duplicate-btn"'), 'export must not include published chrome');
  });


  // ---- the owner's CLI token can read their own private doc (#278) ----
  // The read gate resolved identity only through a browser cookie, so
  // `tdoc-pull` — which authenticates with the account token — was treated as
  // an anonymous visitor and denied. FIRST-DOC.md publishes every new user's
  // first doc as private, so the first doc they made was the one they could
  // not iterate on.

  // Publish a doc under `owner` with an access policy, and leave a comment on
  // it as some signed-in reader so there is something to pull.
  async function publishWith(env, owner, slug, access) {
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: owner.token,
      body: { slug, version: 1, html: '<h1>P</h1>', meta: { title: 'P', slug, versions: [{ n: 1 }], access } },
    }), env, {});
    assert(up.status === 200, `upload ${up.status}: ${await up.text()}`);
    return up;
  }

  await t('the owner token reads comments on their own private doc', async () => {
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    await publishWith(env, owner, 'priv-doc', {
      visibility: 'private', history_visibility: 'owner',
      commenting: 'signed_in', allowed_users: ['reader'],
    });
    // A comment from an allowlisted reader — the thing /tdoc pull exists to fetch.
    const readerCookie = await putSession(env, 'reader');
    const post = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie: readerCookie,
      body: { slug: 'priv-doc', version: 1, text: 'please fix the chart' },
    }), env, {});
    assert(post.status === 200, `reader comment ${post.status}: ${await post.text()}`);

    // Anonymous — the behaviour that must not change.
    const anon = await worker.fetch(req('/api/comments?slug=priv-doc&version=all'), env, {});
    assert(anon.status !== 200, `anonymous read of a private doc returned ${anon.status}`);

    // The owner's CLI token — this is the fix.
    const r = await worker.fetch(req('/api/comments?slug=priv-doc&version=all', {
      token: owner.token,
    }), env, {});
    assert(r.status === 200, `owner token denied: ${r.status} ${await r.clone().text()}`);
    const list = await r.json();
    assert(Array.isArray(list), `expected an array, got ${JSON.stringify(list).slice(0, 120)}`);
    assert(list.length === 1 && list[0].text === 'please fix the chart',
      `owner did not get the comment: ${JSON.stringify(list)}`);
  });

  await t('another account token is still denied the same private doc', async () => {
    // The whole fix rests on this: reading over a token must grant exactly the
    // docs that token can already overwrite, and nothing else.
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    const stranger = await issue(worker, env, 'stranger');
    await publishWith(env, owner, 'priv-doc', {
      visibility: 'private', history_visibility: 'owner', allowed_users: [],
    });

    const r = await worker.fetch(req('/api/comments?slug=priv-doc&version=all', {
      token: stranger.token,
    }), env, {});
    assert(r.status !== 200, `a stranger's token read a private doc: ${await r.clone().text()}`);
    const body = await r.json();
    assert(body.error === 'access_denied', `unexpected body ${JSON.stringify(body)}`);

    // And the stranger cannot write it either — the same account-id comparison.
    const w = await worker.fetch(req('/api/upload', {
      method: 'POST', token: stranger.token,
      body: { slug: 'priv-doc', version: 2, html: '<h1>X</h1>' },
    }), env, {});
    assert(w.status === 403, `stranger write should be 403, got ${w.status}`);
  });

  await t('a bearer token nobody issued is denied, and does not 500', async () => {
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    await publishWith(env, owner, 'priv-doc', { visibility: 'private', allowed_users: [] });
    for (const junk of ['not-a-token', '', 'Bearer', '../../etc/passwd']) {
      const r = await worker.fetch(req('/api/comments?slug=priv-doc&version=all', { token: junk }), env, {});
      assert(r.status !== 200, `junk token "${junk}" was accepted`);
      assert(r.status < 500, `junk token "${junk}" caused ${r.status}`);
    }
  });

  await t('the owner token opens the private doc HTML and sees every version', async () => {
    // history_visibility: 'owner' hides the version picker from everyone else.
    // Reading over the token has to count as the owner there too, or the CLI
    // sees a doc that claims to have one version.
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    for (const v of [1, 2, 3]) {
      const up = await worker.fetch(req('/api/upload', {
        method: 'POST', token: owner.token,
        body: {
          slug: 'multi-doc', version: v, html: `<h1>v${v}</h1>`,
          meta: {
            title: 'M', slug: 'multi-doc',
            versions: [1, 2, 3].slice(0, v).map((n) => ({ n })),
            access: { visibility: 'private', history_visibility: 'owner', allowed_users: [] },
          },
        },
      }), env, {});
      assert(up.status === 200, `upload v${v} ${up.status}: ${await up.text()}`);
    }

    const anon = await worker.fetch(req('/d/multi-doc/v/3'), env, {});
    assert(anon.status !== 200, `anonymous opened a private doc: ${anon.status}`);

    const r = await worker.fetch(req('/d/multi-doc/v/3', { token: owner.token }), env, {});
    assert(r.status === 200, `owner token denied the HTML: ${r.status}`);
    const body = await r.text();
    assert(/v3/.test(body), 'the document body did not come back');
    // All three versions reachable, not just the one being viewed.
    const nav = body.match(/"versions":\s*(\[[^\]]*\])/);
    assert(nav, 'the page did not carry a version list');
    assert(JSON.parse(nav[1]).length === 3,
      `owner should see 3 versions, saw ${JSON.parse(nav[1]).length}`);
  });

  await t('reading over a token does not sign the CLI in', async () => {
    // The token proves ownership for the read and nothing more. If it were
    // turned into a session, the page would render a signed-in identity that
    // no browser ever authenticated, and a comment could be attributed to it.
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    await publishWith(env, owner, 'ident-doc', { visibility: 'private', allowed_users: [] });

    const r = await worker.fetch(req('/d/ident-doc/v/1', { token: owner.token }), env, {});
    assert(r.status === 200, `owner token denied: ${r.status}`);
    const body = await r.text();
    const ident = body.match(/"identity":\s*(null|\{[^}]*\})/);
    assert(ident, 'the page did not carry an identity field at all');
    assert(ident[1] === 'null',
      `a synthetic session was rendered into the page: ${ident[1]}`);

    // And the token must not let it write a comment as anyone.
    const w = await worker.fetch(req('/api/comments', {
      method: 'POST', token: owner.token,
      body: { slug: 'ident-doc', version: 1, text: 'from a token' },
    }), env, {});
    assert(w.status === 401, `a token should not post comments, got ${w.status}`);
  });

  await t('an unlisted doc still needs no token at all', async () => {
    // The fix must not make anonymous reads harder anywhere.
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    await publishWith(env, owner, 'open-doc', { visibility: 'unlisted' });
    const r = await worker.fetch(req('/api/comments?slug=open-doc&version=all'), env, {});
    assert(r.status === 200, `anonymous read of an unlisted doc broke: ${r.status}`);
    assert(Array.isArray(await r.json()), 'unlisted read did not return an array');
  });


  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
