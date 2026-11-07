// Accepting a suggestion while Workers KV is behind, on the real runtime: the
// deploy bundle in workerd with a real Durable Object. KV and R2 are in-memory
// fakes inside the isolate, because staleness is what is under test: `/__stale`
// makes meta:<slug> read as an older record, for the Worker alone or for the
// Worker and the Durable Object, while writes still land, as a cached KV read
// behaves for up to 60 seconds after a publish from elsewhere.
//
// Pinned here: an accept whose read of the doc is behind publishes on the real
// latest (the edit still matching lands, the changed one is reported stale), the
// version it missed stays in the record, an in-flight save is waited for and
// otherwise refused with nothing written, and a Raft agent signs suggestions
// with its own handle.
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
const envFor = (env, who) => ({ META: metaFor(who), DOCS: fake.DOCS, COMMENTS: env.COMMENTS, TDOC_HOSTED_REGISTRATION: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef', PUBLIC_HOST: 'tdoc.dev', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test' });
export class TestStore extends CommentsStore {
  constructor(state, env) { super(state, envFor(env, 'do')); }
  async fetch(req) {
    if (new URL(req.url).pathname === '/__forget-record') { await this.state.storage.delete('versionRecord'); return new Response('ok'); }
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

    const expectV3 = async (slug, set, r) => {
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
      assert.equal(meta.title, 'Plan as of v2', 'and what else v2 wrote is not rolled back');
    };

    await t('KV behind for the Worker and the Durable Object: publishes v3, v2 kept, the changed edit stale', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('KV behind for the Worker only: the same', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'worker');
      await expectV3(slug, set, await accept(slug, set));
    });

    await t('pressing Accept again after it landed publishes nothing more', async () => {
      const { slug, set, beforeV2 } = await twoEditsThenV2();
      await behind(slug, beforeV2, 'all');
      await expectV3(slug, set, await accept(slug, set));
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
      await post('/__do', { slug, path: '/__forget-record', op: {} });
      await behind(slug, beforeV2, 'all');
      const refused = await accept(slug, set);
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.error, 'save_in_progress');
      assert.equal(await latestOf(slug), 2);
      assert.equal(await htmlOf(slug, 3), '', 'no v3 bytes');
      await behind(slug, null);
      await expectV3(slug, set, await accept(slug, set));
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
      for (const name of ['tdoc AI', 'td0c  A1', 'Team Agent X', 'tdoc-ai-helper']) {
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
