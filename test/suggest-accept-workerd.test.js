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
  async put(k, v, o) { this.map.set(k, String(v)); if (o && o.metadata !== undefined) this.meta.set(k, o.metadata); else this.meta.delete(k); }
  async delete(k) { this.map.delete(k); this.meta.delete(k); }
  async list({ prefix = '' } = {}) { return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => (this.meta.has(name) ? { name, metadata: this.meta.get(name) } : { name })), list_complete: true }; }
}
class R2 {
  constructor() { this.map = new Map(); }
  async put(k, v) { this.map.set(k, typeof v === 'string' ? v : new Uint8Array(v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer())); return { key: k }; }
  async get(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); const b = typeof v === 'string' ? new TextEncoder().encode(v) : v; return { text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), size: b.length, httpMetadata: {} }; }
  async head(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); return { size: typeof v === 'string' ? new TextEncoder().encode(v).length : v.length, httpMetadata: {} }; }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) this.map.delete(key); }
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
  const v = target[prop];
  return typeof v === 'function' ? v.bind(target) : v;
} });
// Which reader sees the old record: the Worker's colo, or the Durable Object's too.
const metaFor = (who) => new Proxy(fake.META, { get(target, prop) {
  const behind = (k) => fake.stale.has(k) && (fake.staleFor === 'all' || who === 'worker');
  if (prop === 'get') return async (k) => (behind(k) ? fake.stale.get(k) : target.get(k));
  if (prop === 'getWithMetadata') return async (k) => (behind(k) ? { value: fake.stale.get(k), metadata: null } : target.getWithMetadata(k));
  const v = target[prop];
  return typeof v === 'function' ? v.bind(target) : v;
} });
const envFor = (env, who) => ({ META: metaFor(who), DOCS: docs, COMMENTS: env.COMMENTS, TDOC_HOSTED_REGISTRATION: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef', PUBLIC_HOST: 'tdoc.dev', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test, bob@tdoc.test' });
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

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
