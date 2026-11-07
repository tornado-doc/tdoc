// Accepting a suggestion while Workers KV is behind, on the real runtime: the
// deploy bundle in workerd with a real Durable Object. KV and R2 are in-memory
// fakes inside the isolate, because staleness is what is under test: `/__stale`
// makes meta:<slug> read as an older record, for the Worker alone or for the
// Worker and the Durable Object, while writes still land, as a cached KV read
// behaves for up to 60 seconds after a publish from elsewhere.
//
// Pinned here: an accept whose read of the doc is behind publishes on the real
// latest (the edit still matching lands, the changed one is reported stale), the
// version it missed stays in the record while every other field comes from the
// read, an in-flight save is waited for and otherwise refused with nothing written,
// a doc KV never catches up on recovers after a bounded time, a purged slug starts
// from nothing, and a Raft agent signs suggestions with its own handle.
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
const fake = globalThis.__tdocFake || (globalThis.__tdocFake = { META: new KV(), DOCS: new R2(), stale: new Map(), staleFor: 'all' });
// Which reader sees the old record: the Worker's colo, or the Durable Object's too.
const metaFor = (who) => new Proxy(fake.META, { get(target, prop) {
  const behind = (k) => fake.stale.has(k) && (fake.staleFor === 'all' || who === 'worker');
  if (prop === 'get') return async (k) => (behind(k) ? fake.stale.get(k) : target.get(k));
  if (prop === 'getWithMetadata') return async (k) => (behind(k) ? { value: fake.stale.get(k), metadata: null } : target.getWithMetadata(k));
  const v = target[prop];
  return typeof v === 'function' ? v.bind(target) : v;
} });
const envFor = (env, who) => ({ META: metaFor(who), DOCS: fake.DOCS, COMMENTS: env.COMMENTS, TDOC_HOSTED_REGISTRATION: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef', PUBLIC_HOST: 'tdoc.dev', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test, bob@tdoc.test' });
export class TestStore extends CommentsStore {
  constructor(state, env) { super(state, envFor(env, 'do')); }
  async fetch(req) {
    const hook = new URL(req.url).pathname;
    if (hook === '/__storage') return Response.json({ cursor: (await this.state.storage.get('versionCursor')) ?? null, entries: (await this.state.storage.get('versionEntries')) ?? null, keys: [...(await this.state.storage.list()).keys()] });
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
    if (url.pathname === '/__put-html') { const { key, html } = await req.json(); await fake.DOCS.put(key, html); return new Response('ok'); }
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
    // The limit has passed: the refusal was stamped longer ago than it allows.
    const pastTheLimit = async (slug) => {
      const { cursor } = await storage(slug);
      assert.ok(cursor.behind_since, `stamped by the refusal: ${JSON.stringify(cursor)}`);
      await setStorage(slug, { versionCursor: { ...cursor, behind_since: Date.now() - 3 * 60 * 1000 } });
    };
    const trashAndPurge = async (slug, who = cookie) => {
      const trashed = await call(`/api/doc?slug=${slug}`, { method: 'DELETE', cookie: who });
      assert.equal(trashed.status, 200, trashed.text);
      const purged = await call('/api/trash/purge', { method: 'POST', cookie: who, body: { slug } });
      assert.equal(purged.status, 200, purged.text);
    };

    const expectV3 = async (slug, set, r, title = 'Plan as of v2') => {
      assert.equal(r.status, 200, `accept: ${r.status} ${r.text}`);
      assert.equal(r.body.version, 3);
      assert.deepEqual(r.body.accepted, [set.edits[0].id], 'the edit still matching lands');
      assert.deepEqual(r.body.stale, [set.edits[1].id], 'the changed one is reported stale');
      await behind(slug, null);
      const html = await htmlOf(slug, 3);
      assert.ok(html.includes('Alpha accepted.'), html);
      assert.ok(html.includes('Beta rewritten by v2.'), `v3 is built on v2, not on v1: ${html}`);
      assert.ok(!html.includes('Beta accepted.'), html);
      const meta = JSON.parse(await kv(`meta:${slug}`));
      assert.deepEqual(meta.versions.map((v) => Number(v.n)), [1, 2, 3], 'the version the read missed stays in the record');
      assert.equal(meta.versions[1].prompt, 'publish 2', 'with what v2 recorded');
      assert.equal(meta.versions[1].publisher_agent.agent_sub, 'agent-linked');
      assert.equal(meta.title, title);
    };

    await t('KV behind for the Worker and the Durable Object: publishes v3, v2 kept, the changed edit stale', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      // Everything but the versions comes from the read, v2's title included.
      await expectV3(slug, set, await accept(slug, set), 'Plan');
    });

    await t('KV behind for the Worker only: the same', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'worker');
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('pressing Accept again after it landed publishes nothing more', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      await expectV3(slug, set, await accept(slug, set), 'Plan');
      const again = await accept(slug, set);
      assert.equal(again.status, 409, again.text);
      assert.equal(again.body.error, 'nothing_pending');
      assert.equal(await latestOf(slug), 3);
    });

    await t('a set made on v2 and accepted through a read still at v1 is not called stale', async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      const beforeV2 = await kv(`meta:${slug}`);
      assert.equal((await publish(slug, 2, 'Alpha sentence stays.', 'Beta rewritten by v2.')).status, 200);
      const proposed = await call(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'Beta rewritten by v2.', replace: 'Beta accepted.' }], agent_login: 'claude', agent_name: 'Claude' } });
      assert.equal(proposed.body.suggestion.base_version, 2, proposed.text);
      await behind(slug, beforeV2, 'all');
      const r = await accept(slug, proposed.body.suggestion);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.version, 3);
      assert.deepEqual(r.body.stale, []);
      await behind(slug, null);
      assert.ok((await htmlOf(slug, 3)).includes('Beta accepted.'));
    });

    await t('the page the accept moves to, /v/3, opens while this colo\'s KV still reads the old record', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'worker');
      const r = await accept(slug, set);
      assert.equal(r.status, 200, r.text);
      const shown = await call(r.body.url, { cookie });
      assert.equal(shown.status, 200, `${r.body.url}: ${shown.status} ${shown.text.slice(0, 200)}`);
      await behind(slug, null);
    });

    await t('KV current: unchanged, v3 on v2', async () => {
      const { slug, set } = await twoEditsThenV2();
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('a browser save based on the real latest, KV behind, keeps v2 in the record too', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      const saved = await call('/api/doc/versions', { method: 'POST', cookie, body: { slug, baseVersion: 2, html: `<!doctype html><html><head><title>Plan</title></head><body>${page('Typed.', 'Beta rewritten by v2.')}</body></html>` } });
      assert.equal(saved.status, 200, saved.text);
      await behind(slug, null);
      assert.deepEqual(JSON.parse(await kv(`meta:${slug}`)).versions.map((v) => Number(v.n)), [1, 2, 3]);
    });

    await t('no record of what KV is missing: refused and nothing written, then fine once KV catches up', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await setStorage(slug, { versionEntries: null });
      await behind(slug, beforeV2, 'all');
      const refused = await accept(slug, set);
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.error, 'save_in_progress');
      assert.equal(await latestOf(slug), 2);
      assert.equal(await htmlOf(slug, 3), '', 'no v3 bytes');
      await behind(slug, null);
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('a version an Accept published is kept for the next save whose read misses it, and one a browser save published', async () => {
      const { slug, set } = await twoEditsThenV2();
      const beforeAccept = await kv(`meta:${slug}`);
      assert.equal((await accept(slug, set)).status, 200);
      await behind(slug, beforeAccept, 'all');
      const saved = await call('/api/doc/versions', { method: 'POST', cookie, body: { slug, baseVersion: 3, html: `<!doctype html><html><head><title>Plan</title></head><body>${page('Typed.', 'Beta rewritten by v2.')}</body></html>` } });
      assert.equal(saved.status, 200, saved.text);
      await behind(slug, null);
      const beforeNext = await kv(`meta:${slug}`);
      assert.match((await metaOf(slug)).versions[2].prompt, /^Accepted Claude suggestion/, 'the Accept\'s entry');
      const proposed = await call(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'Typed.', replace: 'Typed again.' }], agent_login: 'claude', agent_name: 'Claude' } });
      assert.equal(proposed.status, 200, proposed.text);
      const fifth = await doSave(slug, 4);
      assert.equal(fifth.status, 200, JSON.stringify(fifth.body));
      await behind(slug, beforeNext, 'all');
      assert.equal((await doSave(slug, 5)).status, 200);
      await behind(slug, null);
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3, 4, 5, 6]);
      assert.equal(meta.versions[4].prompt, 'browser save', 'the browser save\'s entry');
    });

    await t('what the store keeps: the last few entries, short, without the token and client stamps', async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'One.', 'Two.')).status, 200);
      for (let n = 2; n <= 8; n++) {
        const r = await call('/api/upload', { method: 'POST', token, headers: { 'X-Tdoc-Raft-Agent': `${S1}/agent-linked`, 'X-Tdoc-Client': 'cli/1.2.3' }, body: { slug, version: n, html: page(`One ${n}.`, 'Two.'), meta: { title: 'Plan', versions: [{ n, created: new Date().toISOString(), prompt: 'p'.repeat(5000) }] } } });
        assert.equal(r.status, 200, r.text);
      }
      const { entries, keys } = await storage(slug);
      assert.deepEqual(entries.map((x) => x.entry.n), [4, 5, 6, 7, 8]);
      for (const { entry } of entries) {
        assert.ok(entry.prompt.length <= 200, `prompt ${entry.prompt.length}`);
        assert.ok(!('token' in entry) && !('client' in entry), JSON.stringify(entry));
        assert.equal(entry.publisher_agent.agent_sub, 'agent-linked');
      }
      assert.ok(!keys.some((k) => /record/i.test(k)), `no doc record: ${keys}`);
      for (const value of [JSON.stringify(entries)]) {
        assert.ok(!/allowed_users|"access"|"hosted"|"title"|"preview"/.test(value), value);
      }
    });

    await t('sharing, workspace and title changed after the missed publish all survive the save', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      assert.equal((await call('/api/doc/access', { method: 'PATCH', token, body: { slug, access: { visibility: 'public' } } })).status, 200);
      const publicNow = JSON.parse(await kv(`meta:${slug}`));
      const publicV1 = { ...publicNow, versions: JSON.parse(beforeV2).versions };
      // The owner's own write, through a read at v1: KV is { v1, private }.
      await kv(`meta:${slug}`, JSON.stringify(publicV1));
      const made = await call('/api/doc/access', { method: 'PATCH', token, body: { slug, access: { visibility: 'private' } } });
      assert.equal(made.status, 200, made.text);
      const read = JSON.parse(await kv(`meta:${slug}`));
      assert.deepEqual(numbers(read), [1]);
      assert.equal(read.access.visibility, 'private');
      await kv(`meta:${slug}`, JSON.stringify({ ...read, title: 'Renamed', workspace_id: 'team-moved-to' }));
      const saved = await doSave(slug, 2);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3]);
      assert.equal(meta.access.visibility, 'private');
      assert.equal(meta.title, 'Renamed');
      assert.equal(meta.workspace_id, 'team-moved-to');
    });

    await t('a cursor from before these entries, KV never catching up: refused, then v3 past the limit, losing nothing', async () => {
      const { slug, beforeV2 } = await twoEditsThenV2();
      const before = JSON.parse(beforeV2);
      // What every doc live at deploy looks like: a cursor and nothing beside it.
      await setStorage(slug, { versionEntries: null, versionCursor: { latest: 2, pending: null } });
      await kv(`meta:${slug}`, JSON.stringify({ ...before, title: 'Still here', access: { ...(before.access || {}), visibility: 'private' } }));
      const refused = await doSave(slug, 2);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, 'save_in_progress');
      assert.equal(refused.body.latestVersion, 2);
      assert.equal((await doSave(slug, 2)).status, 409, 'still inside the limit');
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

    await t('a cursor ahead of any bytes, as a slug reused before this change: back in step past the limit', async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      await setStorage(slug, { versionEntries: null, versionCursor: { latest: 5, pending: null } });
      assert.equal((await doSave(slug, 1)).status, 409);
      await pastTheLimit(slug);
      const saved = await doSave(slug, 1);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.version, 2);
      assert.deepEqual(numbers(await metaOf(slug)), [1, 2]);
      assert.equal((await storage(slug)).cursor.latest, 2);
    });

    const purgedAndMadeAgain = async ({ team = null } = {}) => {
      const slug = `accept-doc-${++docN}`;
      const body = (n, a) => ({ slug, version: n, html: page(a, 'Secret plans of the first owner.'), ...(team ? { team } : {}), meta: { title: 'First owner title', versions: [{ n, created: new Date().toISOString(), prompt: `first owner ${n}` }] } });
      for (const n of [1, 2]) {
        const r = await call('/api/upload', { method: 'POST', token, body: body(n, `Words ${n}.`) });
        assert.equal(r.status, 200, r.text);
      }
      assert.equal(Boolean((await metaOf(slug)).workspace_id), Boolean(team), 'a team doc when it says so');
      const held = await storage(slug);
      assert.equal(held.cursor.latest, 2);
      assert.ok(held.entries.length, 'something to leave behind');
      await trashAndPurge(slug);
      const left = await storage(slug);
      assert.equal(left.cursor, null, 'no cursor');
      assert.equal(left.entries, null, 'no entries');
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

    await t('Delete forever leaves no version store; the slug\'s next owner saves freely and inherits nothing', async () => {
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

    await t('entries of another doc on this slug (a purge that could not clear them) are never merged in', async () => {
      const slug = `accept-doc-${++docN}`;
      assert.equal((await publish(slug, 1, 'Alpha sentence stays.', 'Beta sentence here.')).status, 200);
      await setStorage(slug, {
        versionCursor: { latest: 2, pending: null },
        versionEntries: [{ doc: '1|2020-01-01T00:00:00.000Z|oldsha', entry: { n: 2, created: '2020-01-02T00:00:00.000Z', prompt: 'first owner 2', by: 'first-owner' } }],
      });
      assert.equal((await doSave(slug, 2)).status, 409, 'refused, not merged');
      await pastTheLimit(slug);
      const saved = await doSave(slug, 1);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2]);
      assert.ok(!JSON.stringify(meta.versions).includes('first owner'), JSON.stringify(meta.versions));
    });

    const reserve = async (slug, baseVersion) => (await (await post('/__do', { slug, path: '/version-lock', op: { kind: 'reserve', baseVersion } })).json());
    const finish = (slug, reservation, committed) => post('/__do', { slug, path: '/version-lock', op: { kind: 'finish', reservation, committed } });

    await t('another save holding the version: refused after a short wait, nothing written, repeatable', async () => {
      const { slug, set } = await twoEditsThenV2();
      const held = await reserve(slug, 2);
      assert.ok(held.ok, JSON.stringify(held));
      for (let press = 0; press < 2; press++) {
        const r = await accept(slug, set);
        assert.equal(r.status, 409, r.text);
        assert.equal(r.body.error, 'save_in_progress');
        assert.equal(await latestOf(slug), 2);
      }
      await finish(slug, { id: held.id, next: held.next }, false);
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('a save that ends during the wait: the accept lands', async () => {
      const { slug, set } = await twoEditsThenV2();
      const held = await reserve(slug, 2);
      assert.ok(held.ok, JSON.stringify(held));
      const pressed = accept(slug, set);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await finish(slug, { id: held.id, next: held.next }, false);
      await expectV3(slug, set, await pressed);
    });

    await t('KV behind, a save in progress, and that save landing: the accept lands on top of it', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      const held = await reserve(slug, 2);
      assert.ok(held.ok, JSON.stringify(held));
      await behind(slug, beforeV2, 'all');
      const pressed = accept(slug, set);
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The other save commits while the accept waits.
      await post('/__put-html', { key: `docs/${slug}/v3/index.html`, html: page('Alpha sentence stays.', 'Beta rewritten by v2.') });
      const entry = { n: 3, created: new Date().toISOString(), prompt: 'the other save' };
      const real = await metaOf(slug);
      await kv(`meta:${slug}`, JSON.stringify({ ...real, versions: [...real.versions, entry] }));
      await post('/__do', { slug, path: '/version-lock', op: { kind: 'finish', reservation: { id: held.id, next: held.next }, committed: true, version: { doc: `${real.versions[0].n}|${real.versions[0].created}|${real.versions[0].sha}`, entry } } });
      const r = await pressed;
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.version, 4);
      await behind(slug, null);
      const meta = await metaOf(slug);
      assert.deepEqual(numbers(meta), [1, 2, 3, 4]);
      assert.equal(meta.versions[2].prompt, 'the other save');
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
