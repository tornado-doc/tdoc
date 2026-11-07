// Accepting a suggestion while Workers KV is behind, on the real runtime: the
// deploy bundle in workerd with a real Durable Object. KV and R2 are in-memory
// fakes inside the isolate, because staleness is what is under test: `/__stale`
// makes meta:<slug> read as an older record, for the Worker alone or for the
// Worker and the Durable Object, while writes still land, as a cached KV read
// behaves for up to 60 seconds after a publish from elsewhere.
//
// Pinned here: a save never writes from a read the version cursor knows is stale
// (a version, a switch to private and Trash all stay), Accept gives KV a moment and
// otherwise leaves the suggestion pending, a doc KV never catches up on recovers
// after a bounded time without losing anything, a purged slug starts from nothing,
// and a Raft agent signs suggestions with its own handle.
//
// Run with: node test/suggest-accept-workerd.test.js   (part of npm run test:workerd)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  const root = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-suggest-accept-workerd-'));
  const binary = path.join(root, 'node_modules', '.bin', 'workerd');
  assert.ok(fs.existsSync(binary), 'workerd devDependency is required');
  execFileSync(process.execPath, [path.join(root, 'bin', 'tdoc-bundle')], { env: { ...process.env, OUT_DIR: dir }, stdio: 'pipe' });
  for (const name of ['resvg.wasm', 'NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf']) {
    fs.copyFileSync(path.join(root, 'server', 'preview', name), path.join(dir, name));
  }
  fs.mkdirSync(path.join(dir, 'do'));
  fs.writeFileSync(path.join(dir, 'worker.mjs'), `import worker, { CommentsStore } from './_worker.bundled.js';
class KV {
  constructor() { this.map = new Map(); this.meta = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async getWithMetadata(k) { return { value: this.map.has(k) ? this.map.get(k) : null, metadata: this.meta.get(k) ?? null }; }
  async put(k, v, o) { if (fake.failPut && fake.failPut.delete(k)) throw new Error('kv write failed'); this.map.set(k, String(v)); if (o && o.metadata !== undefined) this.meta.set(k, o.metadata); else this.meta.delete(k); }
  async delete(k) { this.map.delete(k); this.meta.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => (this.meta.has(name) ? { name, metadata: this.meta.get(name) } : { name })), list_complete: true }; }
}
class R2 {
  constructor() { this.map = new Map(); this.info = new Map(); this.tags = 0; }
  // As R2: null, and nothing written, when onlyIf fails.
  async put(k, v, o = {}) {
    const cond = o.onlyIf;
    if (cond && typeof cond.get === 'function' && cond.get('If-None-Match') === '*' && this.map.has(k)) return null;
    if (cond && cond.etagMatches && (!this.info.has(k) || this.info.get(k).etag !== cond.etagMatches)) return null;
    this.map.set(k, typeof v === 'string' ? v : new Uint8Array(v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer()));
    this.info.set(k, { etag: 'etag-' + (++this.tags), uploaded: new Date() });
    return { key: k };
  }
  async get(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); const b = typeof v === 'string' ? new TextEncoder().encode(v) : v; return { ...this.info.get(k), text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), size: b.length, httpMetadata: {} }; }
  async head(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); return { ...this.info.get(k), size: typeof v === 'string' ? new TextEncoder().encode(v).length : v.length, httpMetadata: {} }; }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) { this.map.delete(key); this.info.delete(key); } }
  async list({ prefix = '' } = {}) { return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}
const fake = globalThis.__tdocFake || (globalThis.__tdocFake = { META: new KV(), DOCS: new R2(), stale: new Map(), staleFor: 'all', r2: {} });
// head as a failing or slow R2 answers it.
const docs = new Proxy(fake.DOCS, { get(target, prop) {
  if (prop === 'head') return async (k) => {
    while (fake.r2.hold) await new Promise((resolve) => setTimeout(resolve, 20));
    if (fake.r2.fail) throw new Error('r2 down');
    return target.head(k);
  };
  if (prop === 'get') return async (k) => {
    if (fake.r2.failWidgetGet && k.includes('/widgets/')) throw new Error('r2 down');
    return target.get(k);
  };
  // A put that waits, fails on a widget, or loses a race to another writer.
  if (prop === 'put') return async (k, v, o) => {
    while (fake.r2.holdPut && k.endsWith('/index.html')) await new Promise((resolve) => setTimeout(resolve, 20));
    if (fake.r2.failWidgetPut && k.includes('/widgets/')) throw new Error('r2 down');
    if (fake.r2.racePut && k === fake.r2.racePut.key) { const { value } = fake.r2.racePut; fake.r2.racePut = null; await target.put(k, value); }
    return target.put(k, v, o);
  };
  const v = target[prop];
  return typeof v === 'function' ? v.bind(target) : v;
} });
// Which reader sees the old record: the Worker's colo, or the Durable Object's too.
const metaFor = (who) => new Proxy(fake.META, { get(target, prop) {
  const behind = (k) => fake.stale.has(k) && (fake.staleFor === 'all' || who === 'worker');
  if (prop === 'get') return async (k) => {
    // A read that fails, for the Worker alone, after some good ones.
    if (who === 'worker' && fake.readFail && fake.readFail.key === k && fake.readFail.skip-- <= 0) throw new Error('kv read failed');
    return behind(k) ? fake.stale.get(k) : target.get(k);
  };
  if (prop === 'getWithMetadata') return async (k) => (behind(k) ? { value: fake.stale.get(k), metadata: null } : target.getWithMetadata(k));
  const v = target[prop];
  return typeof v === 'function' ? v.bind(target) : v;
} });
const envFor = (env, who) => ({ META: metaFor(who), DOCS: docs, COMMENTS: env.COMMENTS, TDOC_HOSTED_REGISTRATION: '1', TDOC_HOSTED_MAX_DOCS: '500', TDOC_REMOTE_MCP: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef', PUBLIC_HOST: 'tdoc.dev', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test, bob@tdoc.test' });
export class TestStore extends CommentsStore {
  constructor(state, env) { super(state, envFor(env, 'do')); }
  async fetch(req) {
    const hook = new URL(req.url).pathname;
    if (hook === '/__storage') return Response.json({ cursor: (await this.state.storage.get('versionCursor')) ?? null, keys: [...(await this.state.storage.list()).keys()] });
    if (hook === '/__set-storage') {
      const { op } = await req.json();
      for (const [k, v] of Object.entries(op)) { if (v === null) await this.state.storage.delete(k); else await this.state.storage.put(k, v); }
      return new Response('ok');
    }
    return super.fetch(req);
  }
}
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/__seed-session') {
      const { id, login, email } = await req.json();
      await fake.META.put('session:' + id, JSON.stringify({ login, name: login, email, avatar_url: '', created: new Date().toISOString() }));
      return new Response('ok');
    }
    if (url.pathname === '/__kv') {
      const { key, value } = await req.json();
      if (value !== undefined) await fake.META.put(key, value);
      return Response.json({ value: await fake.META.get(key) });
    }
    if (url.pathname === '/__stale') {
      const { key, value, who } = await req.json();
      if (value === null) fake.stale.delete(key); else fake.stale.set(key, value);
      fake.staleFor = who || 'all';
      return new Response('ok');
    }
    if (url.pathname === '/__r2') { Object.assign(fake.r2, await req.json()); return new Response('ok'); }
    if (url.pathname === '/__kv-fail') {
      const { put, read } = await req.json();
      if (put) (fake.failPut = fake.failPut || new Set()).add(put);
      fake.readFail = read || null;
      return new Response('ok');
    }
    if (url.pathname === '/__write-r2') {
      const { key, value, ageMs = 0 } = await req.json();
      if (value === null) { await fake.DOCS.delete(key); return new Response('ok'); }
      if (value !== undefined) await fake.DOCS.put(key, value);
      fake.DOCS.info.set(key, { ...fake.DOCS.info.get(key), uploaded: new Date(Date.now() - ageMs) });
      return new Response('ok');
    }
    if (url.pathname === '/__left') {
      const s = url.searchParams.get('slug');
      return Response.json({ kv: [...fake.META.map.keys()].filter((k) => k === 'meta:' + s || k.endsWith(':' + s)), r2: [...fake.DOCS.map.keys()].filter((k) => k.startsWith('docs/' + s + '/')) });
    }
    if (url.pathname === '/__html') return new Response(await (await fake.DOCS.get(url.searchParams.get('key')))?.text() ?? '');
    if (url.pathname === '/__do') {
      const { slug, op, path: doPath } = await req.json();
      return env.COMMENTS.get(env.COMMENTS.idFromName(slug)).fetch('https://do' + doPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, op }) });
    }
    return worker.fetch(new Request('https://tdoc.dev' + url.pathname + url.search, req), envFor(env, 'worker'), ctx);
  },
};
`);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  fs.writeFileSync(path.join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = .w), (name = "do-disk", disk = (path = ${JSON.stringify(path.join(dir, 'do'))}, writable = true))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);
const w :Workerd.Worker = (modules = [(name = "worker", esModule = embed "worker.mjs"), (name = "_worker.bundled.js", esModule = embed "_worker.bundled.js"), (name = "resvg.wasm", wasm = embed "resvg.wasm"), (name = "NotoSansSC-Regular.ttf", data = embed "NotoSansSC-Regular.ttf"), (name = "NotoSansSC-Bold.ttf", data = embed "NotoSansSC-Bold.ttf")], compatibilityDate = "2025-01-01", durableObjectNamespaces = [(className = "TestStore", uniqueKey = "tdoc-suggest-accept-test", enableSql = true)], durableObjectStorage = (localDisk = "do-disk"), bindings = [(name = "COMMENTS", durableObjectNamespace = "TestStore")]);
`);
  const child = spawn(binary, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const call = async (pathname, { method = 'GET', cookie = '', token = '', body, headers = {} } = {}) => {
    const r = await fetch(base + pathname, {
      method,
      headers: {
        Origin: 'https://tdoc.dev',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, body: json };
  };
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
  const kv = async (key, value) => (await (await post('/__kv', { key, value })).json()).value;
  const htmlOf = async (slug, n) => (await fetch(`${base}/__html?key=${encodeURIComponent(`docs/${slug}/v${n}/index.html`)}`)).text();

  let passed = 0;
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error && error.stack ? error.stack : error}\n${stderr.slice(-800)}`); }
  };

  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/__ping'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    console.log('accepting a suggestion while KV is behind (workerd)');
    const sid = crypto.randomBytes(16).toString('hex');
    await post('/__seed-session', { id: sid, login: 'julie', email: 'julie@tdoc.test' });
    const cookie = `tdoc_sid=${sid}`;
    const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'julie' } });
    assert.equal(minted.status, 200, `token: ${minted.text} ${stderr}`);
    const token = minted.body.token;
    const bobSid = crypto.randomBytes(16).toString('hex');
    await post('/__seed-session', { id: bobSid, login: 'bob', email: 'bob@tdoc.test' });
    const bobCookie = `tdoc_sid=${bobSid}`;
    const bob = (await call('/api/hosted/token', { method: 'POST', cookie: bobCookie, body: { label: 'bob' } })).body;
    const accountId = minted.body.account_id;
    const S1 = 'server-one';
    const row = (agent_sub, agent_name) => ({ provider: 'raft', server_id: S1, server_slug: 'one', agent_sub, agent_name });
    await kv(`account-notify:${accountId}`, JSON.stringify([row('agent-linked', 'linked')]));
    await kv(`account-raft-servers:${accountId}`, JSON.stringify([{ server_id: S1, server_slug: 'one', installation_id: 'inst-1' }]));

    const page = (a, b) => `<h1>Plan</h1><p>${a}</p><p>${b}</p>`;
    let docN = 0;
    const publish = (slug, n, a, b, title = 'Plan') => call('/api/upload', {
      method: 'POST', token,
      headers: { 'X-Tdoc-Raft-Agent': `${S1}/agent-linked` },
      body: { slug, version: n, html: page(a, b), meta: { title, versions: [{ n, created: new Date().toISOString(), prompt: `publish ${n}` }] } },
    });
    // v1, a set of two edits on it, then a v2 that changes one of those passages,
    // with the record as it stood before v2 kept to read back as the stale one.
    const twoEditsThenV2 = async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      const proposed = await call(`/api/docs/${slug}/suggestions`, {
        method: 'POST', token,
        body: { edits: [{ find: 'Alpha sentence stays.', replace: 'Alpha accepted.' }, { find: 'Beta sentence here.', replace: 'Beta accepted.' }], agent_login: 'claude', agent_name: 'Claude' },
      });
      assert.equal(proposed.status, 200, proposed.text);
      assert.equal(proposed.body.suggestion.base_version, 1);
      const beforeV2 = await kv(`meta:${slug}`);
      assert.equal((await publish(slug, 2, 'Alpha sentence stays.', 'Beta rewritten by v2.', 'Plan as of v2')).status, 200);
      return { slug, set: proposed.body.suggestion, beforeV2 };
    };
    const accept = (slug, set) => call(`/api/docs/${slug}/suggestions/${set.id}/accept`, { method: 'POST', cookie, body: {} });
    const latestOf = async (slug) => Math.max(...JSON.parse(await kv(`meta:${slug}`)).versions.map((v) => Number(v.n)));
    const behind = (slug, value, who) => post('/__stale', { key: `meta:${slug}`, value, who });

    const storage = async (slug) => (await post('/__do', { slug, path: '/__storage', op: {} })).json();
    const setStorage = (slug, op) => post('/__do', { slug, path: '/__set-storage', op });
    const doSave = async (slug, baseVersion, html = page('Typed.', 'Typed too.')) => {
      const r = await post('/__do', { slug, path: '/version', op: { baseVersion, html: `<!doctype html><html><head><title>Plan</title></head><body>${html}</body></html>`, actorLogin: 'julie', prompt: 'browser save' } });
      return { status: r.status, body: await r.json() };
    };
    const metaOf = async (slug) => JSON.parse(await kv(`meta:${slug}`));
    const numbers = (meta) => meta.versions.map((v) => Number(v.n));
    const pendingIds = async (slug) => (await call(`/api/docs/${slug}/suggestions`, { cookie })).body.suggestions.flatMap((x) => x.edits.filter((e) => e.state === 'pending').map((e) => e.id));
    const reserve = async (slug, baseVersion) => (await (await post('/__do', { slug, path: '/version-lock', op: { kind: 'reserve', baseVersion } })).json());
    const finish = (slug, reservation, committed) => post('/__do', { slug, path: '/version-lock', op: { kind: 'finish', reservation, committed } });
    const r2 = (mode) => post('/__r2', mode);
    const refusedSave = (r) => { assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.error, 'save_in_progress'); };
    // The limit has passed: the refusal was stamped longer ago than it allows.
    const pastTheLimit = async (slug) => {
      const { cursor } = await storage(slug);
      assert.ok(cursor.behind_since, `stamped by the refusal: ${JSON.stringify(cursor)}`);
      await setStorage(slug, { versionCursor: { ...cursor, behind_since: Date.now() - 3 * 60 * 1000 } });
    };
    const trashAndPurge = async (slug) => {
      const trashed = await call(`/api/doc?slug=${slug}`, { method: 'DELETE', cookie });
      assert.equal(trashed.status, 200, trashed.text);
      const purged = await call('/api/trash/purge', { method: 'POST', cookie, body: { slug } });
      assert.equal(purged.status, 200, purged.text);
    };

    const expectV3 = async (slug, set, r) => {
      assert.equal(r.status, 200, `accept: ${r.status} ${r.text}`);
      assert.equal(r.body.version, 3);
      assert.deepEqual(r.body.accepted, [set.edits[0].id], 'the edit still matching lands');
      assert.deepEqual(r.body.stale, [set.edits[1].id], 'the changed one is reported stale');
      const html = await htmlOf(slug, 3);
      assert.ok(html.includes('Alpha accepted.'), html);
      assert.ok(html.includes('Beta rewritten by v2.'), `v3 is built on v2, not on v1: ${html}`);
      assert.ok(!html.includes('Beta accepted.'), html);
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3]);
      assert.equal(meta.versions[1].prompt, 'publish 2');
      assert.equal(meta.versions[1].publisher_agent.agent_sub, 'agent-linked');
      assert.equal(meta.title, 'Plan as of v2');
    };
    // KV behind: nothing is written and the suggestion stays pending.
    const refusedAccept = async (slug, set, code) => {
      const r = await accept(slug, set);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.error, code);
      assert.equal(await htmlOf(slug, 3), '', 'no v3 bytes');
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2]);
      assert.deepEqual((await pendingIds(slug)).sort(), set.edits.map((e) => e.id).sort(), 'still pending');
    };

    await t('KV behind for the Worker and the Durable Object: refused, still pending; once it catches up, v3 with v2 kept', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      await refusedAccept(slug, set, 'save_in_progress');
      await behind(slug, null);
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('KV behind for the Worker only: the Accept takes the store\'s version and lands on it', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'worker');
      const r = await accept(slug, set);
      await behind(slug, null);
      await expectV3(slug, set, r);
    });

    await t('KV catching up during the short wait: the Accept lands without a second press', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      const pressed = accept(slug, set);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await behind(slug, null);
      await expectV3(slug, set, await pressed);
    });

    await t('pressing Accept again after it landed publishes nothing more', async () => {
      const { slug, set } = await twoEditsThenV2();
      await expectV3(slug, set, await accept(slug, set));
      const again = await accept(slug, set);
      assert.equal(again.status, 409, again.text);
      assert.equal(again.body.error, 'nothing_pending');
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3]);
    });

    await t('a set made on v2, accepted through a read still at v1: good edits are not called stale', async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      const beforeV2 = await kv(`meta:${slug}`);
      assert.equal((await publish(slug, 2, 'Alpha sentence stays.', 'Beta rewritten by v2.')).status, 200);
      const proposed = await call(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'Beta rewritten by v2.', replace: 'Beta accepted.' }], agent_login: 'claude', agent_name: 'Claude' } });
      assert.equal(proposed.body.suggestion.base_version, 2, proposed.text);
      await behind(slug, beforeV2, 'all');
      const refused = await accept(slug, proposed.body.suggestion);
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.error, 'save_in_progress');
      assert.deepEqual(await pendingIds(slug), [proposed.body.suggestion.edits[0].id]);
      await behind(slug, null);
      const r = await accept(slug, proposed.body.suggestion);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.version, 3);
      assert.deepEqual(r.body.stale, []);
      assert.ok((await htmlOf(slug, 3)).includes('Beta accepted.'));
    });

    await t('the page an Accept moves to, /v/3, opens while this colo\'s KV still reads the old record', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      const r = await accept(slug, set);
      assert.equal(r.status, 200, r.text);
      await behind(slug, beforeV2, 'worker');
      const shown = await call(r.body.url, { cookie });
      assert.equal(shown.status, 200, `${r.body.url}: ${shown.status} ${shown.text.slice(0, 200)}`);
      await behind(slug, null);
    });

    await t('a save on a read the store knows is stale is refused at any base', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      const route = await call('/api/doc/versions', { method: 'POST', cookie, body: { slug, baseVersion: 2, html: `<!doctype html><html><head><title>Plan</title></head><body>${page('Typed.', 'Beta rewritten by v2.')}</body></html>` } });
      assert.equal(route.status, 409, route.text);
      assert.equal(route.body.error, 'save_in_progress');
      refusedSave(await doSave(slug, 1));
      refusedSave(await doSave(slug, 2));
      await behind(slug, null);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2]);
      assert.equal(await htmlOf(slug, 3), '');
      assert.equal((await doSave(slug, 2)).status, 200, 'and fine once KV has caught up');
    });

    await t('a blank doc\'s scaffold is not replaced through a read that misses a later version', async () => {
      const created = await call('/api/doc/create', { method: 'POST', cookie, body: {} });
      assert.equal(created.status, 200, created.text);
      const { slug } = created.body;
      const beforeV2 = await kv(`meta:${slug}`);
      assert.ok(JSON.parse(beforeV2).versions[0].blank, beforeV2);
      assert.equal((await doSave(slug, 1)).status, 200, 'first save replaces the scaffold');
      await kv(`meta:${slug}`, beforeV2);
      await setStorage(slug, { versionCursor: { latest: 2, pending: null } });
      refusedSave(await doSave(slug, 1));
    });

    await t('a switch to private stays private after a known-stale Accept', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      assert.equal((await call('/api/doc/access', { method: 'PATCH', token, body: { slug, access: { visibility: 'public' } } })).status, 200);
      const old = JSON.parse(beforeV2);
      const publicRead = { ...old, access: (await metaOf(slug)).access };
      assert.equal((await call('/api/doc/access', { method: 'PATCH', token, body: { slug, access: { visibility: 'private' } } })).status, 200);
      await behind(slug, JSON.stringify(publicRead), 'all');
      const r = await accept(slug, set);
      assert.equal(r.status, 409, r.text);
      await behind(slug, null);
      const meta = await metaOf(slug);
      assert.equal(meta.access.visibility, 'private');
      assert.deepEqual(numbers(meta), [1, 2]);
    });

    await t('Trash stays Trash after a known-stale Accept', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      assert.equal((await call(`/api/doc?slug=${slug}`, { method: 'DELETE', cookie })).status, 200);
      await behind(slug, beforeV2, 'all');
      const r = await accept(slug, set);
      assert.equal(r.status, 409, r.text);
      await behind(slug, null);
      const meta = await metaOf(slug);
      assert.ok(meta.trashed_at, 'still in Trash');
      assert.deepEqual(numbers(meta), [1, 2]);
    });

    await t('a reservation that died, KV behind: refused, no list missing a version, and recovery can still start', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      await setStorage(slug, { versionCursor: { latest: 2, pending: { id: 'dead', base: 2, next: 3, started: Date.now() - 5 * 60 * 1000 } } });
      await behind(slug, beforeV2, 'all');
      refusedSave(await doSave(slug, 2));
      await behind(slug, null);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2]);
      const { cursor } = await storage(slug);
      assert.equal(cursor.pending, null, 'the dead reservation is cleared');
      assert.ok(cursor.behind_since, 'stamped');
    });

    await t('KV never catching up, a cursor from before this change: refused inside the limit, then v3, losing nothing', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      const before = JSON.parse(beforeV2);
      await setStorage(slug, { versionCursor: { latest: 2, pending: null } });
      await kv(`meta:${slug}`, JSON.stringify({ ...before, title: 'Still here', access: { ...(before.access || {}), visibility: 'private' } }));
      refusedSave(await doSave(slug, 2));
      refusedSave(await doSave(slug, 2));
      await pastTheLimit(slug);
      const saved = await doSave(slug, 2);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.version, 3);
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3], 'the bytes R2 holds count as v2');
      assert.equal(meta.versions[1].prompt, 'Recovered version');
      assert.equal(meta.title, 'Still here');
      assert.equal(meta.access.visibility, 'private');
      assert.ok((await htmlOf(slug, 2)).includes('Beta rewritten by v2.'), 'v2 bytes untouched');
    });

    const stuck = async () => {
      const made = await twoEditsThenV2();
      await setStorage(made.slug, { versionCursor: { latest: 2, pending: null } });
      await kv(`meta:${made.slug}`, made.beforeV2);
      return made;
    };

    await t('KV never catching up, through Accept: refused inside the limit, then v3 on v2, the changed edit stale', async () => {
      const { slug, set } = await stuck();
      const refused = await accept(slug, set);
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.error, 'save_in_progress');
      assert.deepEqual((await pendingIds(slug)).sort(), set.edits.map((e) => e.id).sort(), 'still pending');
      await pastTheLimit(slug);
      const r = await accept(slug, set);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.version, 3);
      assert.deepEqual(r.body.accepted, [set.edits[0].id]);
      assert.deepEqual(r.body.stale, [set.edits[1].id]);
      const html = await htmlOf(slug, 3);
      assert.ok(html.includes('Alpha accepted.') && html.includes('Beta rewritten by v2.'), html);
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3]);
      assert.equal(meta.versions[1].prompt, 'Recovered version');
    });

    await t('a save at a low base past the limit does not restart the clock', async () => {
      const { slug } = await stuck();
      refusedSave(await doSave(slug, 2));
      await pastTheLimit(slug);
      const stamp = (await storage(slug)).cursor.behind_since;
      const low = await doSave(slug, 1);
      assert.equal(low.status, 409, JSON.stringify(low.body));
      assert.equal(low.body.error, 'version_conflict');
      assert.equal(low.body.latestVersion, 2);
      assert.equal((await storage(slug)).cursor.behind_since, stamp, 'same stamp');
      assert.equal((await doSave(slug, 2)).status, 200, 'and the right base lands at once');
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3]);
    });

    const aheadOfBytes = async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      await setStorage(slug, { versionCursor: { latest: 5, pending: null } });
      refusedSave(await doSave(slug, 1));
      await pastTheLimit(slug);
      return slug;
    };

    await t('a cursor ahead of any bytes (a slug reused before this change): back in step past the limit', async () => {
      const slug = await aheadOfBytes();
      const saved = await doSave(slug, 1);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.version, 2);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2]);
      assert.equal((await storage(slug)).cursor.latest, 2);
    });

    await t('a cursor ahead of any bytes, through Accept: readable refusal inside the limit, then it lands', async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      const { body } = await call(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'Alpha sentence stays.', replace: 'Alpha accepted.' }], agent_login: 'claude', agent_name: 'Claude' } });
      await setStorage(slug, { versionCursor: { latest: 5, pending: null } });
      const refused = await accept(slug, body.suggestion);
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.error, 'save_in_progress');
      await pastTheLimit(slug);
      const r = await accept(slug, body.suggestion);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.version, 2);
    });

    await t('an R2 error past the limit is a 503, never "no bytes": nothing lowered, nothing written', async () => {
      const slug = await aheadOfBytes();
      await r2({ fail: true });
      const r = await doSave(slug, 1);
      await r2({ fail: false });
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, 'version_store_unavailable');
      assert.equal((await storage(slug)).cursor.latest, 5);
      assert.deepEqual(numbers(await metaOf(slug)), [1]);
    });

    await t('a commit during a slow R2 read: the cursor is not lowered under it, and only one save gets the number', async () => {
      const slug = await aheadOfBytes();
      await r2({ hold: true });
      const first = doSave(slug, 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const held = await reserve(slug, 5);
      assert.ok(held.ok, JSON.stringify(held));
      await finish(slug, { id: held.id, next: held.next }, true);
      await r2({ hold: false });
      refusedSave(await first);
      assert.equal((await storage(slug)).cursor.latest, 6, 'the commit stands');
      assert.deepEqual(numbers(await metaOf(slug)), [1]);
    });

    await t('a save that begins during a slow R2 read: its reservation is not disturbed', async () => {
      const slug = await aheadOfBytes();
      await r2({ hold: true });
      const first = doSave(slug, 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const held = await reserve(slug, 5);
      assert.ok(held.ok, JSON.stringify(held));
      await r2({ hold: false });
      refusedSave(await first);
      const { cursor } = await storage(slug);
      assert.equal(cursor.latest, 5);
      assert.equal(cursor.pending.id, held.id);
      await finish(slug, { id: held.id, next: held.next }, false);
    });

    await t('a live reservation, past the limit: no recovery runs under it', async () => {
      const slug = await aheadOfBytes();
      const stamped = (await storage(slug)).cursor;
      const held = await reserve(slug, 5);
      assert.ok(held.ok, JSON.stringify(held));
      assert.ok(stamped.behind_since);
      refusedSave(await doSave(slug, 1));
      const { cursor } = await storage(slug);
      assert.equal(cursor.latest, 5);
      assert.equal(cursor.pending.id, held.id);
      await finish(slug, { id: held.id, next: held.next }, false);
    });

    await t('the stamp goes once KV has caught up, so a later lag starts its own wait', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      refusedSave(await doSave(slug, 2));
      assert.ok((await storage(slug)).cursor.behind_since);
      await behind(slug, null);
      assert.equal((await doSave(slug, 1)).body.error, 'version_conflict', 'an old base, with KV current');
      assert.ok(!(await storage(slug)).cursor.behind_since, 'cleared');
    });

    await t('a publish after an old stamp: KV merely lagging on it is refused, not recovered', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      await setStorage(slug, { versionCursor: { latest: 2, pending: null, behind_since: Date.now() - 3 * 60 * 1000 } });
      assert.equal((await publish(slug, 3, 'Alpha sentence stays.', 'Beta rewritten by v3.')).status, 200);
      await behind(slug, beforeV2, 'all');
      refusedSave(await doSave(slug, 3));
      await behind(slug, null);
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3]);
      assert.equal(meta.versions[2].prompt, 'publish 3', 'not a recovered entry');
    });

    const purgedAndMadeAgain = async ({ team = null } = {}) => {
      const slug = `accept-doc-${++docN}`;
      const body = (n, a) => ({ slug, version: n, html: page(a, 'Secret plans of the first owner.'), ...(team ? { team } : {}), meta: { title: 'First owner title', versions: [{ n, created: new Date().toISOString(), prompt: `first owner ${n}` }] } });
      for (const n of [1, 2]) {
        const r = await call('/api/upload', { method: 'POST', token, body: body(n, `Words ${n}.`) });
        assert.equal(r.status, 200, r.text);
      }
      assert.equal(Boolean((await metaOf(slug)).workspace_id), Boolean(team), 'a team doc when it says so');
      assert.equal((await storage(slug)).cursor.latest, 2);
      await trashAndPurge(slug);
      const left = await storage(slug);
      assert.equal(left.cursor, null, 'no cursor');
      assert.ok(!left.keys.some((k) => /version/i.test(k)), `left behind: ${left.keys}`);
      const made = await call('/api/upload', { method: 'POST', token: bob.token, body: { slug, version: 1, html: page('Bob words.', 'Bob more.'), meta: { title: 'Bob title', versions: [{ n: 1, created: new Date().toISOString(), prompt: 'bob 1' }] } } });
      assert.equal(made.status, 200, made.text);
      return slug;
    };
    const stillBobs = (meta) => {
      assert.equal(meta.title, 'Bob title');
      assert.equal(meta.hosted.account_id, bob.account_id);
      assert.ok(!meta.workspace_id, 'not the old team');
      for (const v of meta.versions) assert.ok(!/first owner/.test(v.prompt || ''), JSON.stringify(v));
    };

    await t('Delete forever leaves no cursor; the slug\'s next owner saves freely and inherits nothing', async () => {
      const slug = await purgedAndMadeAgain();
      const stale = await doSave(slug, 2);
      assert.equal(stale.status, 409, 'a base from the old doc means nothing here');
      assert.equal(stale.body.error, 'version_conflict');
      stillBobs(await metaOf(slug));
      const r = await call('/api/upload', { method: 'POST', token: bob.token, body: { slug, version: 2, html: page('Bob v2.', 'Bob more.'), meta: { title: 'Bob title', versions: [{ n: 2, created: new Date().toISOString(), prompt: 'bob 2' }] } } });
      assert.equal(r.status, 200, r.text);
      assert.equal((await doSave(slug, 2)).status, 200, 'and a save works');
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3]);
      stillBobs(meta);
    });

    await t('a team doc: the same', async () => {
      const created = await call('/api/teams', { method: 'POST', cookie, body: { name: 'Acme' } });
      assert.equal(created.status, 200, created.text);
      const slug = await purgedAndMadeAgain({ team: created.body.team.slug || created.body.team.name });
      assert.equal((await doSave(slug, 2)).status, 409);
      stillBobs(await metaOf(slug));
    });

    await t('another save holding the version: refused after the short wait, nothing written, repeatable', async () => {
      const { slug, set } = await twoEditsThenV2();
      const held = await reserve(slug, 2);
      assert.ok(held.ok, JSON.stringify(held));
      for (let press = 0; press < 2; press++) await refusedAccept(slug, set, 'save_in_progress');
      await finish(slug, { id: held.id, next: held.next }, false);
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('a save that ends just before the last try: the accept still lands', async () => {
      const { slug, set } = await twoEditsThenV2();
      const held = await reserve(slug, 2);
      assert.ok(held.ok, JSON.stringify(held));
      const pressed = accept(slug, set);
      // Tries come a second apart: this is after the second, before the third.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await finish(slug, { id: held.id, next: held.next }, false);
      await expectV3(slug, set, await pressed);
    });

    const newDoc = async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      return slug;
    };
    const propose = (slug, headers = {}) => call(`/api/docs/${slug}/suggestions`, {
      method: 'POST', token, headers,
      body: { edits: [{ find: 'Alpha sentence stays.', replace: 'Alpha accepted.' }], agent_login: 'claude', agent_name: 'Claude' },
    });
    const asAgent = (sub, name) => ({ 'X-Tdoc-Raft-Agent': `${S1}/${sub}`, ...(name ? { 'X-Tdoc-Raft-Agent-Name': encodeURIComponent(name) } : {}) });

    await t('a Raft agent signs with its handle, linked or on a connected server, and the accept says so', async () => {
      const slug = await newDoc();
      const linked = await propose(slug, asAgent('agent-linked'));
      assert.equal(linked.status, 200, linked.text);
      const signed = linked.body.suggestion.agent;
      assert.equal(signed.name, 'linked');
      assert.equal(signed.handle, '@linked');
      assert.equal(signed.provider, 'raft');
      assert.equal(signed.location, 'one');
      assert.equal(signed.principal.terminal, 'Claude', 'the runtime stays as detail, as on a reply');
      const unlinked = await propose(await newDoc(), asAgent('agent-other', '@helper'));
      assert.equal(unlinked.body.suggestion.agent.name, 'helper');
      assert.equal(unlinked.body.suggestion.agent.handle, '@helper');
      const a = await accept(slug, linked.body.suggestion);
      assert.equal(a.status, 200, a.text);
      assert.match(JSON.parse(await kv(`meta:${slug}`)).versions.at(-1).prompt, /^Accepted linked suggestion/);
    });

    await t('a handle that could pass for someone else, or that is not plain Latin, does not sign', async () => {
      // Spaceless: actingAgent takes no handle with a space, so these reach the check.
      for (const name of ['tdoc.AI', 'td0c_A1', 'Team-Agent-X', 'tdoc-ai-helper']) {
        const r = await propose(await newDoc(), asAgent('agent-posing', name));
        assert.equal(r.status, 200, r.text);
        const who = r.body.suggestion.agent;
        assert.equal(who.name, 'Claude', `${name}: ${JSON.stringify(who)}`);
        assert.ok(!who.handle, `${name}: ${JSON.stringify(who)}`);
      }
      const cjk = await propose(await newDoc(), asAgent('agent-cjk', '小c'));
      assert.equal(cjk.body.suggestion.agent.name, 'Claude');
      assert.ok(!cjk.body.suggestion.agent.handle, JSON.stringify(cjk.body.suggestion.agent));
      assert.equal(cjk.body.suggestion.agent.provider, 'raft', 'the route it came by is still true');
    });

    await t('a claim on a server this account never connected signs nothing new', async () => {
      const r = await propose(await newDoc(), { 'X-Tdoc-Raft-Agent': 'not-connected/agent-x', 'X-Tdoc-Raft-Agent-Name': 'linked' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.suggestion.agent.name, 'Claude');
      assert.ok(!r.body.suggestion.agent.handle);
    });

    // An agent's connection, the way the claude.ai connector gets one.
    let mcpCached = null;
    const mcpSession = async () => {
      if (mcpCached) return mcpCached;
      const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
      const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const client_id = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
      await kv(`oauth-cimd:${crypto.createHash('sha256').update(client_id).digest('hex')}`, JSON.stringify({ client_id, client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], fetched_at: Date.now() }));
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'mcp', resource: 'https://tdoc.dev/mcp' });
      const authorize = await call(`/oauth/authorize?${q}`, { cookie });
      assert.equal(authorize.status, 200, authorize.text.slice(0, 200));
      const boot = JSON.parse(authorize.text.match(/__TDOC_APP_BOOT__\s*=\s*(\{.*?\});?\s*<\/script>/s)[1]);
      const approved = await call('/api/oauth/approve', { method: 'POST', cookie, body: { request_id: boot.request_id, csrf: boot.csrf, decision: 'allow' } });
      const code = new URL(approved.body.redirect).searchParams.get('code');
      const issued = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id, resource: 'https://tdoc.dev/mcp' }).toString() });
      const mcpToken = (await issued.json()).access_token;
      mcpCached = async (name, args) => {
        const r = await call('/mcp', { method: 'POST', token: mcpToken, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
        assert.equal(r.status, 200, r.text);
        return r.body.result;
      };
      return mcpCached;
    };

    // ── A version's bytes are written once, whatever the read behind the save ──
    const pageOf = (a) => page(a, 'Same.');
    const left = async (slug) => (await fetch(`${base}/__left?slug=${slug}`)).json();
    const docPage = (b) => `<!doctype html><html><head><title>Plan</title></head><body>${b}</body></html>`;
    const browserSave = (slug, baseVersion, b) => call('/api/doc/versions', { method: 'POST', cookie, body: { slug, baseVersion, html: docPage(b) } });
    const fresh = async (name) => { const slug = `${name}-doc-${++docN}`; const r = await publish(slug, 1, 'Alpha one.', 'Beta one.'); assert.equal(r.status, 200, r.text); return slug; };
    const browserSaveOf = (slug, baseVersion, a) => browserSave(slug, baseVersion, page(a, 'Same.'));
    const age = (slug, n, ageMs) => post('/__write-r2', { key: `docs/${slug}/v${n}/index.html`, ageMs });
    // v3's record landed and the store never heard, and its reservation has expired;
    // the record as it stood at v2 is what a stale reader still sees.
    const lostFinish = async () => {
      const slug = `immutable-doc-${++docN}`;
      for (const n of [1, 2]) assert.equal((await publish(slug, n, `Words ${n}.`, 'Same.')).status, 200);
      const atV2 = await kv(`meta:${slug}`);
      assert.equal((await publish(slug, 3, 'ORIGINAL THREE.', 'Same.')).status, 200);
      const v3 = await htmlOf(slug, 3);
      await setStorage(slug, { versionCursor: { latest: 2, pending: { id: 'gone', base: 2, next: 3, started: Date.now() - 120000 } } });
      await behind(slug, atV2, 'all');
      return { slug, v3 };
    };
    const thenCaughtUp = async (slug, v3) => {
      await behind(slug, null);
      assert.equal(await htmlOf(slug, 3), v3, 'v3 is what it was');
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3]);
      const next = await doSave(slug, 3, page('Fourth.', 'Same.'));
      assert.equal(next.status, 200, JSON.stringify(next.body));
      assert.equal(next.body.version, 4);
      assert.equal(await htmlOf(slug, 3), v3);
    };

    await t('a lost finish and a stale read: browser save refused, v3 unchanged, the next real save is v4', async () => {
      const { slug, v3 } = await lostFinish();
      const r = await browserSave(slug, 2, page('OVERWRITE.', 'Same.'));
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.error, 'save_in_progress');
      assert.equal(await htmlOf(slug, 3), v3);
      refusedSave(await doSave(slug, 2, page('OVERWRITE.', 'Same.')));
      await thenCaughtUp(slug, v3);
    });

    await t('a lost finish and a stale read: Accept refused and still pending, v3 unchanged', async () => {
      const { slug, v3 } = await lostFinish();
      await behind(slug, null);
      const { body } = await call(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'ORIGINAL THREE.', replace: 'OVERWRITE.' }], agent_login: 'claude', agent_name: 'Claude' } });
      await behind(slug, JSON.stringify({ ...(await metaOf(slug)), versions: (await metaOf(slug)).versions.slice(0, 2) }), 'worker');
      await post('/__stale', { key: `meta:${slug}`, value: JSON.stringify({ ...(await metaOf(slug)), versions: (await metaOf(slug)).versions.slice(0, 2) }), who: 'all' });
      const r = await accept(slug, body.suggestion);
      assert.equal(r.status, 409, r.text);
      assert.equal(await htmlOf(slug, 3), v3);
      assert.equal((await pendingIds(slug)).length, 1);
      await thenCaughtUp(slug, v3);
    });

    await t('a lost finish and a stale read: an upload is refused, v3 unchanged; the same bytes are not a conflict', async () => {
      const { slug, v3 } = await lostFinish();
      const r = await publish(slug, 3, 'OVERWRITE.', 'Same.');
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.error, 'version_conflict');
      assert.equal(r.body.latestVersion, 3);
      assert.equal(await htmlOf(slug, 3), v3);
      await thenCaughtUp(slug, v3);
    });

    await t('a stale read cannot touch the widgets of the version it would have overwritten', async () => {
      const slug = `immutable-doc-${++docN}`;
      const up = (n, a, w) => call('/api/upload', { method: 'POST', token, body: { slug, version: n, html: page(a, 'Same.'), widgets: { calc: `<p>${w}</p>` }, meta: { title: 'Plan', versions: [{ n, created: new Date().toISOString(), prompt: `publish ${n}` }] } } });
      for (const n of [1, 2]) assert.equal((await up(n, `Words ${n}.`, `widget ${n}`)).status, 200);
      const atV2 = await kv(`meta:${slug}`);
      assert.equal((await up(3, 'Three.', 'widget three')).status, 200);
      await setStorage(slug, { versionCursor: { latest: 2, pending: { id: 'gone', base: 2, next: 3, started: Date.now() - 120000 } } });
      await behind(slug, atV2, 'all');
      refusedSave(await doSave(slug, 2, page('OVERWRITE.', 'Same.')));
      await behind(slug, null);
      const widget = await fetch(`${base}/__html?key=${encodeURIComponent(`docs/${slug}/v3/widgets/calc.html`)}`);
      assert.equal(await widget.text(), '<p>widget three</p>');
    });

    const blankDoc = async () => {
      const made = await call('/api/doc/create', { method: 'POST', cookie, body: {} });
      assert.equal(made.status, 200, made.text);
      return { slug: made.body.slug, blank: await kv(`meta:${made.body.slug}`) };
    };

    await t('the first real save replaces the scaffold, once: a stale blank read is refused, v1 not reported twice', async () => {
      const { slug, blank } = await blankDoc();
      const first = await browserSave(slug, 1, '<h1>Real one</h1><p>REAL.</p>');
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.version, 1);
      const v1 = await htmlOf(slug, 1);
      assert.ok(v1.includes('REAL.'), v1);
      await behind(slug, blank, 'all');
      const stale = await browserSave(slug, 1, '<h1>Second</h1><p>OVERWRITE.</p>');
      assert.equal(stale.status, 409, stale.text);
      assert.equal(stale.body.error, 'save_in_progress');
      assert.equal(await htmlOf(slug, 1), v1);
      await behind(slug, null);
      const second = await browserSave(slug, 1, '<h1>Second</h1><p>SECOND.</p>');
      assert.equal(second.status, 200, second.text);
      assert.equal(second.body.version, 2);
      assert.equal(await htmlOf(slug, 1), v1);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2]);
    });

    await t('two first saves at once: neither overwrites the other', async () => {
      const { slug } = await blankDoc();
      const results = await Promise.all([browserSave(slug, 1, '<h1>A</h1><p>Save A.</p>'), browserSave(slug, 1, '<h1>B</h1><p>Save B.</p>')]);
      const won = results.filter((r) => r.status === 200);
      assert.ok(won.length >= 1, results.map((r) => r.text).join());
      assert.equal(new Set(won.map((r) => r.body.version)).size, won.length, 'each number reported once');
      for (const r of results) {
        if (r.status === 200) assert.ok((await htmlOf(slug, r.body.version)).includes(r === results[0] ? 'Save A.' : 'Save B.'));
        else assert.equal(r.body.error, 'save_in_progress');
      }
    });

    await t('a first save whose commit was lost: past the limit its bytes are v1 and the next save is v2', async () => {
      const { slug } = await blankDoc();
      const blank = await metaOf(slug);
      assert.equal((await browserSave(slug, 1, '<h1>Real</h1><p>REAL.</p>')).status, 200);
      const v1 = await htmlOf(slug, 1);
      await kv(`meta:${slug}`, JSON.stringify(blank));
      refusedSave(await doSave(slug, 1, '<h1>Next</h1><p>NEXT.</p>'));
      await age(slug, 1, 3 * 60 * 1000);
      const r = await doSave(slug, 1, '<h1>Next</h1><p>NEXT.</p>');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.version, 2);
      assert.equal(await htmlOf(slug, 1), v1);
      assert.ok(!(await metaOf(slug)).versions[0].blank, 'no longer scaffolding');
    });

    await t('bytes no record lists: refused, not overwritten, then listed so saving goes on above them', async () => {
      const slug = await fresh('orphan');
      const key = `docs/${slug}/v2/index.html`;
      await post('/__write-r2', { key, value: '<p>ORPHAN</p>' });
      refusedSave(await doSave(slug, 1, page('Mine.', 'Same.')));
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
      await age(slug, 2, 3 * 60 * 1000);
      await pastTheLimit(slug);
      const r = await doSave(slug, 2, page('Mine.', 'Same.'));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.version, 3);
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
      assert.equal((await metaOf(slug)).versions[1].prompt, 'Recovered version');
    });

    await t('an upload onto other bytes no record lists: refused; past the limit they are listed and it builds on them', async () => {
      const slug = await fresh('orphan');
      await post('/__write-r2', { key: `docs/${slug}/v2/index.html`, value: '<p>ORPHAN</p>' });
      const refused = await publish(slug, 2, 'Mine.', 'Same.');
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.latestVersion, 2);
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
      await pastTheLimit(slug);
      const told = await publish(slug, 2, 'Mine.', 'Same.');
      assert.equal(told.status, 409, told.text);
      assert.equal(told.body.latestVersion, 2);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2], 'listed');
      const up = await publish(slug, 3, 'Mine.', 'Same.');
      assert.equal(up.status, 200, up.text);
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
    });

    const v1Upload = (slug, a) => call('/api/upload', { method: 'POST', token, body: { slug, version: 1, html: page(a, 'Same.'), meta: { title: 'Plan', versions: [{ n: 1, created: new Date().toISOString() }] } } });

    await t('a first publish whose commit failed: the same bytes commit', async () => {
      const slug = `immutable-doc-${++docN}`;
      await post('/__kv-fail', { put: `meta:${slug}` });
      assert.equal((await v1Upload(slug, 'Mine.')).status, 500);
      const bytes = await htmlOf(slug, 1);
      assert.ok(bytes.includes('Mine.'), 'stored');
      const r = await v1Upload(slug, 'Mine.');
      assert.equal(r.status, 200, r.text);
      assert.equal(await htmlOf(slug, 1), bytes);
      assert.deepEqual(numbers(await metaOf(slug)), [1]);
    });

    await t('a first publish whose commit failed: other bytes wait out the limit, told so, then the slug is free', async () => {
      const slug = `immutable-doc-${++docN}`;
      await post('/__kv-fail', { put: `meta:${slug}` });
      assert.equal((await v1Upload(slug, 'Died.')).status, 500);
      const refused = await v1Upload(slug, 'Mine.');
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.latestVersion, 0);
      assert.ok(refused.body.retry_after > 0 && /did not finish/.test(refused.body.message), refused.text);
      assert.ok((await htmlOf(slug, 1)).includes('Died.'));
      await age(slug, 1, 3 * 60 * 1000);
      const r = await v1Upload(slug, 'Mine.');
      assert.equal(r.status, 200, r.text);
      assert.ok((await htmlOf(slug, 1)).includes('Mine.'));
    });

    // The shape live docs are in: bytes above the record, days old, nothing in the cursor.
    const oldUnlisted = async () => {
      const slug = await fresh('orphan');
      await post('/__write-r2', { key: `docs/${slug}/v2/index.html`, value: '<p>ORPHAN</p>', ageMs: 3 * 24 * 60 * 60 * 1000 });
      return slug;
    };

    await t('old bytes no record lists: an upload is refused once, they are listed as they were, and it publishes above them', async () => {
      const slug = await oldUnlisted();
      const r = await publish(slug, 2, 'Mine.', 'Same.');
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.latestVersion, 2);
      assert.equal(r.body.next_version, 3);
      assert.ok(!r.body.retry_after, r.text);
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
      assert.equal((await metaOf(slug)).versions[1].prompt, 'Recovered version');
      assert.equal((await publish(slug, 3, 'Mine.', 'Same.')).status, 200);
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
    });

    await t('old bytes no record lists: a browser save is refused twice, then lands above them from their page', async () => {
      const slug = await oldUnlisted();
      refusedSave(await browserSaveOf(slug, 1, 'Mine.'));
      const second = await browserSaveOf(slug, 1, 'Mine.');
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'version_conflict');
      assert.equal(second.body.latestVersion, 2);
      assert.equal((await call(`/d/${slug}/v/2`, { cookie })).status, 200);
      const third = await browserSaveOf(slug, 2, 'Mine.');
      assert.equal(third.status, 200, third.text);
      assert.equal(third.body.version, 3);
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
    });

    // ── A version's other files ──
    const widgetKey = (slug, n, w) => `${base}/__html?key=${encodeURIComponent(`docs/${slug}/v${n}/widgets/${w}.html`)}`;
    const widgetOf = async (slug, n, w) => (await fetch(widgetKey(slug, n, w))).text();
    const upWithWidgets = (slug, n, a, widgets) => call('/api/upload', { method: 'POST', token, body: { slug, version: n, html: page(a, 'Same.'), widgets, meta: { title: 'Plan', versions: [{ n, created: new Date().toISOString(), prompt: `publish ${n}` }] } } });

    await t('a listed version\'s widgets are fixed: edited or new ones are refused, the same ones pass', async () => {
      const slug = `immutable-doc-${++docN}`;
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: '<p>A</p>' })).status, 200);
      const edited = await upWithWidgets(slug, 1, 'One.', { a: '<p>EDITED</p>' });
      assert.equal(edited.status, 409, edited.text);
      assert.equal(edited.body.error, 'version_conflict');
      assert.equal(edited.body.next_version, undefined, 'this read may be behind: no number promised');
      assert.match(edited.body.message, /Publish this as a new version/);
      assert.equal(await widgetOf(slug, 1, 'a'), '<p>A</p>');
      const added = await upWithWidgets(slug, 1, 'One.', { a: '<p>A</p>', b: '<p>B</p>' });
      assert.equal(added.status, 409, added.text);
      assert.equal(await widgetOf(slug, 1, 'b'), '', 'nothing landed');
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: '<p>A</p>' })).status, 200, 'a retry');
      assert.equal((await upWithWidgets(slug, 2, 'Two.', { a: '<p>EDITED</p>', b: '<p>B</p>' })).status, 200, 'a new version has its own');
      assert.equal(await widgetOf(slug, 1, 'a'), '<p>A</p>');
    });

    await t('a listed version whose page was lost: the page is restored, its widgets are still fixed, a lost one returns', async () => {
      const slug = `immutable-doc-${++docN}`;
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: '<p>A</p>' })).status, 200);
      const pageKey = `docs/${slug}/v1/index.html`;
      await post('/__write-r2', { key: pageKey, value: null });
      const edited = await upWithWidgets(slug, 1, 'One.', { a: '<p>EDITED</p>' });
      assert.equal(edited.status, 409, edited.text);
      assert.equal(await widgetOf(slug, 1, 'a'), '<p>A</p>');
      await post('/__write-r2', { key: `docs/${slug}/v1/widgets/a.html`, value: null });
      await post('/__write-r2', { key: pageKey, value: null });
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: '<p>A</p>' })).status, 200);
      assert.equal(await widgetOf(slug, 1, 'a'), '<p>A</p>');
      assert.ok((await htmlOf(slug, 1)).includes('One.'));
    });

    await t('an upload whose commit failed: its widgets finish on retry; edited ones are refused', async () => {
      const slug = await fresh('widgets');
      await post('/__kv-fail', { put: `meta:${slug}` });
      assert.equal((await upWithWidgets(slug, 2, 'Two.', { a: '<p>A</p>' })).status, 500);
      const edited = await upWithWidgets(slug, 2, 'Two.', { a: '<p>EDITED</p>' });
      assert.equal(edited.status, 409, edited.text);
      assert.equal(await widgetOf(slug, 2, 'a'), '<p>A</p>');
    });

    await t('a refused upload leaves nothing: an oversized widget stores no page and the number stays free', async () => {
      const slug = await fresh('widgets');
      const r = await upWithWidgets(slug, 2, 'Rejected.', { big: 'x'.repeat(513 * 1024) });
      assert.equal(r.status, 400, r.text.slice(0, 200));
      assert.equal(await htmlOf(slug, 2), '');
      assert.deepEqual((await left(slug)).r2.filter((k) => k.includes('/v2/')), []);
      assert.equal((await upWithWidgets(slug, 2, 'Good.', { small: '<p>S</p>' })).status, 200);
    });

    await t('a widget copy that fails: the save\'s bytes go, the number stays free', async () => {
      const slug = `immutable-doc-${++docN}`;
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: '<p>A</p>' })).status, 200);
      await r2({ failWidgetPut: true });
      const failed = await doSave(slug, 1, page('Two.', 'Same.'));
      await r2({ failWidgetPut: false });
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
      assert.equal(await htmlOf(slug, 2), '', 'no bytes');
      const r = await doSave(slug, 1, page('Two again.', 'Same.'));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.version, 2);
    });

    await t('the scaffold replaced under a first save: the etag condition refuses it, the other bytes stay', async () => {
      const { slug } = await blankDoc();
      await r2({ racePut: { key: `docs/${slug}/v1/index.html`, value: '<p>WON THE RACE</p>' } });
      const r = await browserSave(slug, 1, '<h1>Mine</h1><p>Lost.</p>');
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.error, 'save_in_progress');
      assert.equal(await htmlOf(slug, 1), '<p>WON THE RACE</p>');
    });

    await t('the record unreadable: an upload is refused, the version and record untouched', async () => {
      const slug = await fresh('readfail');
      assert.equal((await publish(slug, 2, 'Two.', 'Same.')).status, 200);
      const [v1, record] = [await htmlOf(slug, 1), await kv(`meta:${slug}`)];
      await post('/__kv-fail', { read: { key: `meta:${slug}`, skip: 0 } });
      const r = await publish(slug, 1, 'OVERWRITE.', 'Same.');
      await post('/__kv-fail', {});
      assert.equal(r.status, 503, r.text);
      assert.equal(r.body.error, 'doc_record_unavailable');
      assert.equal(await htmlOf(slug, 1), v1);
      assert.equal(await kv(`meta:${slug}`), record);
    });

    await t('the record unreadable at the commit: the upload fails, the record is not rebuilt from nothing', async () => {
      const slug = await fresh('readfail');
      assert.equal((await publish(slug, 2, 'Two.', 'Same.')).status, 200);
      const record = await kv(`meta:${slug}`);
      await post('/__kv-fail', { read: { key: `meta:${slug}`, skip: 1 } });
      const r = await publish(slug, 3, 'Three.', 'Same.');
      await post('/__kv-fail', {});
      assert.equal(r.status, 500, r.text);
      assert.equal(r.body.error, 'meta_put_failed');
      assert.equal(await kv(`meta:${slug}`), record);
    });

    // ── The CLI and MCP, in words ──
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cli-home-'));
    fs.mkdirSync(path.join(cliHome, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(cliHome, '.tdoc/published.json'), JSON.stringify({ platform: 'hosted', upload_token: token, base, public_host: '127.0.0.1' }));
    const cliDocs = path.join(cliHome, 'tdocs');
    const localDoc = (slug, versions) => {
      const d = path.join(cliDocs, slug);
      fs.rmSync(d, { recursive: true, force: true });
      const ns = Object.keys(versions).map(Number).sort((a, b) => a - b);
      for (const n of ns) { fs.mkdirSync(path.join(d, `v${n}`), { recursive: true }); fs.writeFileSync(path.join(d, `v${n}/index.html`), docPage(`<h1>Plan</h1><p>${versions[n]}</p>`)); }
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ title: 'Plan', slug, created: '2026-11-01T10:00:00Z', versions: ns.map((n) => ({ n, created: '2026-11-01T10:00:00Z', prompt: `v${n}` })) }));
    };
    const cliPublish = async (slug) => {
      const child2 = spawn(path.join(root, 'bin', 'tdoc-publish'), [slug], { env: { ...process.env, HOME: cliHome, TDOC_DIR: cliDocs, TDOC_SKIP_UPDATE_CHECK: '1', TDOC_TEAM: '', SLOCK_CURRENT_SERVER_ID: '', SLOCK_CURRENT_AGENT_ID: '' } });
      let output = '';
      child2.stdout.on('data', (d) => { output += d; });
      child2.stderr.on('data', (d) => { output += d; });
      const status = await new Promise((resolve) => child2.on('close', resolve));
      assert.ok(!/\{"error"/.test(output), `raw JSON: ${output}`);
      return { status, output };
    };

    await t('CLI: an edited re-publish after a failed commit is told the wait and the number, then publishes above it', async () => {
      const slug = `cli-doc-${++docN}`;
      localDoc(slug, { 1: 'one', 2: 'two' });
      assert.equal((await cliPublish(slug)).status, 0);
      await post('/__kv-fail', { put: `meta:${slug}` });
      assert.equal((await publish(slug, 3, 'three', 'Same.')).status, 500, 'the commit fails');
      localDoc(slug, { 1: 'one', 2: 'two', 3: 'three EDITED' });
      const refused = await cliPublish(slug);
      assert.notEqual(refused.status, 0);
      assert.match(refused.output, /v3 not published: Version 3 already holds different content .* In about \d+ seconds .* publish this as version 4/);
      assert.doesNotMatch(refused.output, /--version next/, 'a wait, not a new version yet');
      await pastTheLimit(slug);
      const told = await cliPublish(slug);
      assert.notEqual(told.status, 0);
      assert.match(told.output, /v3 not published: .*Publish this as version 4/);
      assert.match(told.output, /--version next --title <title> --html-file/);
      assert.equal((await metaOf(slug)).versions[2].prompt, 'Recovered version');
      localDoc(slug, { 1: 'one', 2: 'two', 3: 'three EDITED', 4: 'four' });
      const up = await cliPublish(slug);
      assert.equal(up.status, 0, up.output);
      assert.match(up.output, /older version\(s\) 3 differ from the server's/);
      assert.doesNotMatch(up.output, /re-run \/tdoc publish to retry/);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3, 4]);
      assert.ok(!(await htmlOf(slug, 3)).includes('EDITED'));
    });

    await t('CLI: a first publish that stopped is told to wait, in words', async () => {
      const slug = `cli-doc-${++docN}`;
      await post('/__kv-fail', { put: `meta:${slug}` });
      assert.equal((await v1Upload(slug, 'one')).status, 500);
      localDoc(slug, { 1: 'one EDITED' });
      const r = await cliPublish(slug);
      assert.notEqual(r.status, 0);
      assert.match(r.output, /v1 not published: An earlier first publish of this doc did not finish\. Try again in about \d+ seconds/);
      await age(slug, 1, 3 * 60 * 1000);
      const again = await cliPublish(slug);
      assert.equal(again.status, 0, again.output);
    });

    // A cursor ahead of the record, with no stamp: as live cursors are at deploy.
    await t('CLI: a cursor ahead of any bytes starts a bounded wait and ends it, with no person involved', async () => {
      const slug = `cli-doc-${++docN}`;
      localDoc(slug, { 1: 'one' });
      assert.equal((await cliPublish(slug)).status, 0);
      await setStorage(slug, { versionCursor: { latest: 5, pending: null } });
      localDoc(slug, { 1: 'one', 2: 'two' });
      const refused = await cliPublish(slug);
      assert.notEqual(refused.status, 0);
      assert.match(refused.output, /v2 not published: .*Try again in about \d+ seconds/);
      await pastTheLimit(slug);
      const up = await cliPublish(slug);
      assert.equal(up.status, 0, up.output);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2]);
      assert.equal((await storage(slug)).cursor.latest, 2);
    });

    await t('MCP: a cursor ahead of bytes no record lists: wait, then told, then get_doc and publish land above them', async () => {
      const mcp = await mcpSession();
      const slug = await fresh('mcp');
      await post('/__write-r2', { key: `docs/${slug}/v2/index.html`, value: '<p>ORPHAN</p>' });
      await setStorage(slug, { versionCursor: { latest: 2, pending: null } });
      const first = await mcp('update_doc', { slug, html: pageOf('Words.') });
      assert.ok(first.isError);
      assert.ok(first.structuredContent.retry_after > 0, JSON.stringify(first.structuredContent));
      assert.doesNotMatch(first.structuredContent.message, /get_doc/, 'nothing to read yet');
      await pastTheLimit(slug);
      const told = await mcp('update_doc', { slug, html: pageOf('Words.') });
      assert.ok(told.isError);
      assert.equal(told.structuredContent.next_version, 3);
      assert.match(told.structuredContent.message, /Call get_doc, then publish again/);
      const doc = await mcp('get_doc', { slug, format: 'text' });
      assert.equal(doc.structuredContent.latest_version, 2);
      const landed = await mcp('update_doc', { slug, html: pageOf('Words.') });
      assert.ok(!landed.isError, JSON.stringify(landed));
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3]);
      assert.equal(await htmlOf(slug, 2), '<p>ORPHAN</p>');
    });

    await t('a healthy doc: saves and uploads alternate, retried bytes pass, the store says nothing new', async () => {
      const slug = await fresh('healthy');
      assert.equal((await browserSave(slug, 1, page('Two.', 'Same.'))).status, 200);
      assert.equal((await publish(slug, 3, 'Three.', 'Same.')).status, 200);
      const v3 = await htmlOf(slug, 3);
      assert.equal((await publish(slug, 3, 'Three.', 'Same.')).status, 200, 'the same upload again');
      assert.equal(await htmlOf(slug, 3), v3);
      assert.equal((await doSave(slug, 3, page('Four.', 'Same.'))).body.version, 4);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3, 4]);
      assert.ok(!(await storage(slug)).cursor.behind_since);
    });

    // ── Refusals during KV lag promise no number ──
    await t('KV lag for the Worker: an identical re-run is told to try again, not to publish a new version', async () => {
      const slug = `lag-doc-${++docN}`;
      localDoc(slug, { 1: 'one', 2: 'two' });
      assert.equal((await cliPublish(slug)).status, 0);
      const atV2 = await kv(`meta:${slug}`);
      localDoc(slug, { 1: 'one', 2: 'two', 3: 'three' });
      assert.equal((await cliPublish(slug)).status, 0);
      await behind(slug, atV2, 'worker');
      const r = await cliPublish(slug);
      assert.notEqual(r.status, 0);
      assert.match(r.output, /v3 not published: .*Try again in about \d+ seconds/);
      assert.doesNotMatch(r.output, /version 4|--version next/);
      await behind(slug, null);
      assert.equal((await cliPublish(slug)).status, 0, 'and once KV catches up it is a retry');
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3]);
    });

    await t('KV lag for both: a version just after the last names no number that is already taken', async () => {
      const slug = await fresh('lag');
      const atV1 = await kv(`meta:${slug}`);
      assert.equal((await publish(slug, 2, 'Two.', 'Same.')).status, 200);
      assert.equal((await publish(slug, 3, 'Three.', 'Same.')).status, 200);
      await behind(slug, atV1, 'all');
      const r = await publish(slug, 4, 'Four.', 'Same.');
      await behind(slug, null);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.next_version, undefined, r.text);
      assert.ok(r.body.retry_after > 0, r.text);
    });

    await t('an older version re-uploaded through a behind read: the record keeps what came after', async () => {
      const slug = await fresh('lag');
      assert.equal((await publish(slug, 2, 'Two.', 'Same.')).status, 200);
      const stale = JSON.parse(await kv(`meta:${slug}`));
      delete stale.versions[0].sha;
      const record = JSON.parse(await kv(`meta:${slug}`));
      await kv(`meta:${slug}`, JSON.stringify({ ...record, title: 'Renamed', access: { ...record.access, visibility: 'private' } }));
      assert.equal((await publish(slug, 3, 'Three.', 'Same.', 'Renamed')).status, 200);
      const current = await kv(`meta:${slug}`);
      await behind(slug, JSON.stringify(stale), 'all');
      const r = await call('/api/upload', { method: 'POST', token, headers: { 'X-Tdoc-Client': 'other-client' }, body: { slug, version: 1, html: page('Alpha one.', 'Beta one.'), meta: { title: 'Plan', versions: [{ n: 1, created: stale.versions[0].created }, { n: 3, created: new Date().toISOString() }] } } });
      await behind(slug, null);
      assert.equal(r.status, 200, r.text);
      assert.equal(await kv(`meta:${slug}`), current, 'untouched');
      const meta = JSON.parse(current);
      assert.equal(meta.title, 'Renamed');
      assert.equal(meta.access.visibility, 'private');
    });

    await t('CLI: an older version told to wait is one a re-run can still send', async () => {
      const slug = `lag-doc-${++docN}`;
      localDoc(slug, { 1: 'one' });
      assert.equal((await cliPublish(slug)).status, 0);
      const atV1 = await kv(`meta:${slug}`);
      assert.equal((await publish(slug, 2, 'two', 'Same.')).status, 200);
      assert.equal((await publish(slug, 3, 'three', 'Same.')).status, 200);
      await behind(slug, atV1, 'all');
      localDoc(slug, { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' });
      const r = await cliPublish(slug);
      await behind(slug, null);
      assert.doesNotMatch(r.output, /differ from the server's/);
      assert.doesNotMatch(r.output, /--version next/);
    });

    await t('a first publish that stopped, with an edited widget: told to wait, with no version promised', async () => {
      const slug = `immutable-doc-${++docN}`;
      await post('/__kv-fail', { put: `meta:${slug}` });
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: '<p>A</p>' })).status, 500);
      const r = await upWithWidgets(slug, 1, 'One.', { a: '<p>EDITED</p>' });
      assert.equal(r.status, 409, r.text);
      assert.ok(r.body.retry_after > 0, r.text);
      assert.equal(r.body.next_version, undefined);
      assert.match(r.body.message, /did not finish/);
      await age(slug, 1, 3 * 60 * 1000);
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: '<p>EDITED</p>' })).status, 200);
      assert.equal(await widgetOf(slug, 1, 'a'), '<p>EDITED</p>');
    });

    await t('a widget starting with a byte order mark: the same one again is a retry', async () => {
      const slug = `immutable-doc-${++docN}`;
      const bom = '﻿<p>A</p>';
      assert.equal((await upWithWidgets(slug, 1, 'One.', { a: bom })).status, 200);
      const r = await upWithWidgets(slug, 1, 'One.', { a: bom });
      assert.equal(r.status, 200, r.text);
    });

    await t('a widget read that fails during a retry: the reservation is released, not left for a minute', async () => {
      const slug = await fresh('widgets');
      await post('/__kv-fail', { put: `meta:${slug}` });
      assert.equal((await upWithWidgets(slug, 2, 'Two.', { a: '<p>A</p>' })).status, 500);
      await r2({ failWidgetGet: true });
      const r = await upWithWidgets(slug, 2, 'Two.', { a: '<p>A</p>' });
      await r2({ failWidgetGet: false });
      assert.equal(r.status, 500, r.text);
      assert.equal((await storage(slug)).cursor.pending, null);
      assert.equal((await upWithWidgets(slug, 2, 'Two.', { a: '<p>A</p>' })).status, 200);
    });

    // ── A doc deleted for good stays deleted for its own saves ──
    const nothingLeft = async (slug) => assert.deepEqual(await left(slug), { kv: [], r2: [] });
    const purgedAtStaleRead = async (publishAs = (slug, n) => publish(slug, n, `Words ${n}.`, 'Same.')) => {
      const slug = `purged-doc-${++docN}`;
      for (const n of [1, 2]) { const r = await publishAs(slug, n); assert.equal(r.status, 200, r.text); }
      const old = await kv(`meta:${slug}`);
      await trashAndPurge(slug);
      await nothingLeft(slug);
      await behind(slug, old, 'all');
      return { slug, old };
    };

    await t('a browser save from a stale read after Delete forever: refused, nothing comes back', async () => {
      const { slug } = await purgedAtStaleRead();
      const r = await browserSave(slug, 2, page('Back again?', 'Same.'));
      assert.equal(r.status, 404, r.text);
      assert.equal((await doSave(slug, 2)).status, 404);
      await behind(slug, null);
      await nothingLeft(slug);
    });

    await t('Accept from a stale read after Delete forever: refused, nothing comes back', async () => {
      const slug = `purged-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha one.', 'Same.')).status, 200);
      const { body } = await call(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'Alpha one.', replace: 'Alpha x.' }], agent_login: 'claude', agent_name: 'Claude' } });
      const old = await kv(`meta:${slug}`);
      await trashAndPurge(slug);
      await behind(slug, old, 'all');
      const r = await accept(slug, body.suggestion);
      assert.notEqual(r.status, 200, r.text);
      await behind(slug, null);
      await nothingLeft(slug);
    });

    await t('a teammate\'s upload from a stale read after Delete forever: refused, at any version, nothing comes back', async () => {
      const created = await call('/api/teams', { method: 'POST', cookie, body: { name: 'Purge Co' } });
      assert.equal(created.status, 200, created.text);
      const team = created.body.team.slug || created.body.team.name;
      const up = (slug, n, a = `Words ${n}.`) => call('/api/upload', { method: 'POST', token, body: { slug, version: n, team, html: page(a, 'Same.'), meta: { title: 'Team doc', versions: [{ n, created: new Date().toISOString(), prompt: `publish ${n}` }] } } });
      const { slug } = await purgedAtStaleRead(up);
      for (const [n, a] of [[3, 'Next.'], [2, 'Words 2.'], [1, 'History.']]) {
        const r = await up(slug, n, a);
        assert.equal(r.status, 404, `v${n}: ${r.text}`);
      }
      await behind(slug, null);
      await nothingLeft(slug);
    });

    await t('MCP update_doc on a team doc, from a stale read after Delete forever: refused, nothing comes back', async () => {
      const mcp = await mcpSession();
      const created = await call('/api/teams', { method: 'POST', cookie, body: { name: 'Mcp Co' } });
      const team = created.body.team.slug || created.body.team.name;
      const up = (slug, n) => call('/api/upload', { method: 'POST', token, body: { slug, version: n, team, html: pageOf(`Words ${n}.`), meta: { title: 'Team doc', versions: [{ n, created: new Date().toISOString(), prompt: `publish ${n}` }] } } });
      const { slug } = await purgedAtStaleRead(up);
      const r = await mcp('update_doc', { slug, html: pageOf('Back again?') });
      assert.ok(r.isError, JSON.stringify(r));
      await behind(slug, null);
      await nothingLeft(slug);
    });

    await t('a stale read reaching the store\'s reservation after Delete forever: refused there, before any bytes', async () => {
      const { slug } = await purgedAtStaleRead();
      const r = await reserve(slug, 2);
      assert.equal(r.error, 'not_found', JSON.stringify(r));
      await behind(slug, null);
      assert.equal((await storage(slug)).cursor, null, 'no reservation taken');
    });

    await t('an old tab, long after: its read finds no record', async () => {
      const { slug } = await purgedAtStaleRead();
      await behind(slug, null);
      const r = await browserSave(slug, 2, page('Back again?', 'Same.'));
      assert.notEqual(r.status, 200, r.text);
      await nothingLeft(slug);
    });

    await t('a slug reused at once: the old doc\'s stale save cannot touch the new doc, and the new doc saves freely', async () => {
      const { slug, old } = await purgedAtStaleRead();
      await behind(slug, null);
      const made = await call('/api/upload', { method: 'POST', token: bob.token, body: { slug, version: 1, html: page('Bob words.', 'Bob more.'), meta: { title: 'Bob title', versions: [{ n: 1, created: new Date().toISOString(), prompt: 'bob 1' }] } } });
      assert.equal(made.status, 200, made.text);
      const v1 = await htmlOf(slug, 1);
      await behind(slug, old, 'all');
      assert.equal((await doSave(slug, 2)).status, 404);
      await behind(slug, null);
      stillBobs(await metaOf(slug));
      assert.deepEqual(numbers(await metaOf(slug)), [1]);
      assert.equal(await htmlOf(slug, 1), v1);
      const r = await doSave(slug, 1);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      stillBobs(await metaOf(slug));
    });

    await t('the same files published again after Delete forever: a new doc, not refused', async () => {
      const slug = `purged-doc-${++docN}`;
      const created = '2026-11-01T00:00:00.000Z';
      const up = (n, a) => call('/api/upload', { method: 'POST', token, body: { slug, version: n, html: page(a, 'Same.'), meta: { title: 'Plan', versions: [{ n, created, prompt: `p${n}` }] } } });
      assert.equal((await up(1, 'Same words.')).status, 200);
      await trashAndPurge(slug);
      assert.equal((await up(1, 'Same words.')).status, 200);
      assert.equal((await up(2, 'Later.')).status, 200);
      assert.equal((await doSave(slug, 2)).status, 200);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2, 3]);
    });

    await t('a purge cut short, then restored: the doc saves as ever', async () => {
      const slug = await fresh('restored');
      assert.equal((await call(`/api/doc?slug=${slug}`, { method: 'DELETE', cookie })).status, 200);
      const identity = (await metaOf(slug)).versions[0].created;
      await post('/__do', { slug, path: '/version-lock', op: { kind: 'purging', identity } });
      assert.equal((await call('/api/trash/restore', { method: 'POST', cookie, body: { slug } })).status, 200);
      assert.equal((await doSave(slug, 1)).status, 200);
    });

    await t('the hold runs out: a record with the purged doc\'s date is not refused for ever', async () => {
      const slug = await fresh('held');
      await setStorage(slug, { purgeHold: { at: Date.now() - 11 * 60 * 1000, identity: (await metaOf(slug)).versions[0].created } });
      assert.equal((await doSave(slug, 1)).status, 200);
      assert.ok(!(await storage(slug)).keys.includes('purgeHold'), 'and is gone');
    });

    await t('a save already running when the purge begins: the bytes it writes after go, and the record does not come back', async () => {
      const slug = await fresh('inflight');
      await r2({ holdPut: true });
      const running = doSave(slug, 1, page('In flight.', 'Same.'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await trashAndPurge(slug);
      await r2({ holdPut: false });
      const r = await running;
      assert.equal(r.status, 404, JSON.stringify(r.body));
      await nothingLeft(slug);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
