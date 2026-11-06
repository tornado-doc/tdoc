// A feedback token can sit in the source of somebody else's page, and a webhook
// URL often works as a credential: no response that token can reach names one,
// while the picker and Resend keep working by id. A webhook's URL, signature and
// key go only to the address stored for it, and only for the account that
// connected it. The deploy bundle in workerd,
// through the real routes; only the receiver's end of the webhook is stubbed,
// inside the isolate. KV and R2 are small in-memory fakes.
//
// Run with: node test/feedback-webhook-url-workerd.test.js   (part of npm run test:workerd)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  const root = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-fb-webhook-workerd-'));
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
  async put(k, v, o) { if (o && o.onlyIf && this.map.has(k)) return null; const bytes = typeof v === 'string' ? v : new Uint8Array(v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer()); this.map.set(k, bytes); return { key: k }; }
  async get(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); const b = typeof v === 'string' ? new TextEncoder().encode(v) : v; return { text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), size: b.length, httpMetadata: {} }; }
  async head(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); return { size: typeof v === 'string' ? new TextEncoder().encode(v).length : v.length, httpMetadata: {} }; }
  async delete(k) { for (const key of Array.isArray(k) ? k : [k]) this.map.delete(key); }
  async list({ prefix = '' } = {}) { return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}
const fake = globalThis.__tdocFake || (globalThis.__tdocFake = { META: new KV(), DOCS: new R2(), posts: [] });
// The receiver's side of a webhook: records what arrived, or fails the way a
// runtime may, naming the address in its error.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const to = String((input && input.url) || input);
  if (!to.startsWith('https://hooks.example/')) return realFetch(input, init);
  fake.posts.push({ url: to, redirect: init && init.redirect, headers: Object.fromEntries(new Headers(init && init.headers).entries()) });
  if (to.includes('boom')) throw new Error('connection to ' + to + ' failed');
  return new Response('ok');
};
const envFor = (env) => ({ META: fake.META, DOCS: fake.DOCS, COMMENTS: env.COMMENTS, TDOC_HOSTED_REGISTRATION: '1', TDOC_REMOTE_MCP: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef', PUBLIC_HOST: 'tdoc.dev', RAFT_CLIENT_ID: 'tdoc-x', RAFT_CLIENT_SECRET: 's' });
export class TestStore extends CommentsStore { constructor(state, env) { super(state, envFor(env)); } }
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/__seed-session') {
      const { id, login } = await req.json();
      await fake.META.put('session:' + id, JSON.stringify({ login, name: login, avatar_url: '', created: new Date().toISOString() }));
      return new Response('ok');
    }
    if (url.pathname === '/__kv') {
      const { key, value } = await req.json();
      if (value !== undefined) await fake.META.put(key, value);
      return Response.json({ value: await fake.META.get(key) });
    }
    if (url.pathname === '/__posts') return Response.json(fake.posts.splice(0));
    return worker.fetch(new Request('https://tdoc.dev' + url.pathname + url.search, req), envFor(env), ctx);
  },
};
`);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(path.join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = .w), (name = "do-disk", disk = (path = ${JSON.stringify(path.join(dir, 'do'))}, writable = true))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);
const w :Workerd.Worker = (modules = [(name = "worker", esModule = embed "worker.mjs"), (name = "_worker.bundled.js", esModule = embed "_worker.bundled.js"), (name = "resvg.wasm", wasm = embed "resvg.wasm"), (name = "NotoSansSC-Regular.ttf", data = embed "NotoSansSC-Regular.ttf"), (name = "NotoSansSC-Bold.ttf", data = embed "NotoSansSC-Bold.ttf")], compatibilityDate = "2025-01-01", durableObjectNamespaces = [(className = "TestStore", uniqueKey = "tdoc-fb-webhook-test", enableSql = true)], durableObjectStorage = (localDisk = "do-disk"), bindings = [(name = "COMMENTS", durableObjectNamespace = "TestStore")]);
`);
  const child = spawn(binary, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const ORIGIN = 'https://tdoc.dev';
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
  const call = async (pathname, { method = 'GET', cookie = '', token = '', body, headers = {}, form } = {}) => {
    const r = await fetch(base + pathname, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, body: json };
  };
  const kv = async (key, value) => (await (await fetch(`${base}/__kv`, { method: 'POST', body: JSON.stringify({ key, value }) })).json()).value;
  const APP = 'https://app.example';
  const HOOK_A = 'https://hooks.example/secret-path-abc';
  const HOOK_B = 'https://hooks.example/secret-path-def';
  const HOOK_BOOM = 'https://hooks.example/secret-path-boom';
  const AUTH_KEY = 'gb_sentinel_auth_key';
  const secrets = [];
  // Every connector secret this test made, anywhere in a response.
  const assertClean = (what, r, status = 200) => {
    assert.equal(r.status, status, `${what}: ${r.status} ${r.text}`);
    for (const secret of ['hooks.example/', 'secret-path', AUTH_KEY, 'whsec_', ...secrets]) {
      assert.ok(!r.text.includes(secret), `${what} carries ${secret}: ${r.text}`);
    }
  };
  const rowsOf = (body) => [body.default, ...(body.candidates || []), body.fallback].filter(Boolean);
  const posts = async () => (await fetch(`${base}/__posts`)).json();
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); } catch (error) { failed += 1; console.error(`  FAIL ${name}\n       ${String(error.message).slice(0, 400)}`); }
  };
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/__ping'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const id = crypto.randomBytes(16).toString('hex');
    await fetch(`${base}/__seed-session`, { method: 'POST', body: JSON.stringify({ id, login: 'julie' }) });
    const cookie = `tdoc_sid=${id}`;
    const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'julie' } });
    assert.equal(minted.status, 200, `token: ${minted.text} ${stderr}`);
    const hook = async (url, label, extra = {}) => {
      const r = await call('/api/me/connectors/webhook', { method: 'POST', cookie, body: { url, label, ...extra } });
      assert.equal(r.status, 200, r.text);
      secrets.push(r.body.secret);
      return r.body.target;
    };
    const botA = await hook(HOOK_A, 'Bot A', { auth_key: AUTH_KEY });
    const botB = await hook(HOOK_B, 'Bot B');
    const botBoom = await hook(HOOK_BOOM, 'Bot Boom');

    // The owner's token on a third party's page.
    const connected = await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin: APP } });
    assert.equal(connected.status, 200, connected.text);
    const { token, slug } = connected.body;
    assert.match(token, /^fb_/);
    const page = { token, headers: { Origin: APP } };
    const comment = async (text) => {
      const r = await call('/api/comments', { method: 'POST', ...page, body: { slug, version: 1, text, anchor: { kind: 'product', url: `${APP}/pricing` } } });
      assert.equal(r.status, 200, r.text);
      return r.body.id;
    };
    const send = (commentId, recipient) => call('/api/notify/handoff', { method: 'POST', ...page, body: { slug, comment_ids: [commentId], recipient } });
    const sameAgent = (a, b) => a.provider === b.provider && a.server_id === b.server_id && a.agent_sub === b.agent_sub;
    // What the widget holds of an agent: a row of the token's own answer, or,
    // before the fix, that row as it would read without its address.
    const pickerRows = async () => (await call(`/api/notify/targets?slug=${slug}`, page)).body;
    const row = async (agent) => {
      const { url: _url, ...rest } = rowsOf(await pickerRows()).find((t) => sameAgent(t, agent));
      return rest;
    };

    await check('targets: a feedback token sees no URL or secret, and every agent by id', async () => {
      const r = await call(`/api/notify/targets?slug=${slug}`, page);
      assertClean('targets', r);
      assert.deepEqual(rowsOf(r.body).map((t) => t.agent_name).sort(), ['Bot A', 'Bot B', 'Bot Boom']);
      for (const t of rowsOf(r.body)) assert.match(t.agent_sub, /^wh_/);
    });

    const first = await comment('first');
    await check('handoff: the picker sends by id, to the stored address', async () => {
      await posts();
      const r = await send(first, await row(botA));
      assertClean('handoff', r);
      assert.equal(r.body.delivery.status, 'delivered', r.text);
      const got = await posts();
      assert.deepEqual(got.map((p) => p.url), [HOOK_A]);
      assert.ok(got[0].headers['x-tdoc-signature'], 'signed');
      assert.equal(got[0].headers.authorization, `Bearer ${AUTH_KEY}`);
      assert.equal(got[0].redirect, 'manual', 'a redirect must not carry the key elsewhere');
    });

    await check('handoff: an agent picked by id is not swapped for the default', async () => {
      const r = await send(await comment('second'), await row(botB));
      assertClean('handoff', r);
      assert.deepEqual((await posts()).map((p) => p.url), [HOOK_B]);
    });

    await check('handoff: a URL from the page is ignored; the stored one is used', async () => {
      const r = await send(await comment('third'), { ...(await row(botB)), url: 'https://hooks.example/page-made-this-up' });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual((await posts()).map((p) => p.url), [HOOK_B]);
    });

    await check('handoff: a pick the token was not offered is refused, not sent to the default', async () => {
      const r = await send(await comment('fourth'), { provider: 'webhook', server_id: 'webhook', agent_sub: 'wh_00000000000000000000', url: 'https://hooks.example/page-made-this-up' });
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.error, 'agent_unavailable');
      assert.ok(r.body.message, 'says why');
      assert.deepEqual(await posts(), []);
      const malformed = await send(await comment('fourth array'), { provider: 'webhook', server_id: 'webhook', agent_sub: [botA.agent_sub] });
      assert.equal(malformed.status, 409, malformed.text);
      assert.deepEqual(await posts(), []);
      const raft = await send(await comment('fourth raft'), { provider: 'raft', server_id: 'gone', server_slug: 'gone', agent_sub: 'gone' });
      assert.equal(raft.status, 409, raft.text);
      assert.deepEqual(await posts(), []);
    });

    await check('handoffs: a feedback token sees the recipient by id, no URL', async () => {
      const r = await call(`/api/notify/handoffs?slug=${slug}`, page);
      assertClean('handoffs', r);
      assert.ok(r.body.handoffs.length >= 2);
      assert.ok(r.body.handoffs.some((h) => h.recipient && sameAgent(h.recipient, botA)), r.text);
    });

    await check('resend: by handoff id, from the token, to the stored address', async () => {
      const list = (await call(`/api/notify/handoffs?slug=${slug}`, page)).body.handoffs;
      const handoff = list.find((h) => h.recipient && sameAgent(h.recipient, botA));
      await posts();
      const r = await call('/api/notify/handoff/resend', { method: 'POST', ...page, body: { slug, handoff_id: handoff.handoff_id } });
      assertClean('resend', r);
      assert.equal(r.body.delivery.status, 'delivered', r.text);
      assert.deepEqual((await posts()).map((p) => p.url), [HOOK_A]);
      const kept = JSON.parse(await kv(`handoffs:${slug}`)).find((h) => h.handoff_id === handoff.handoff_id);
      assert.equal(kept.recipient.url, HOOK_A, 'the record keeps the address');
    });

    await check('delivery error: a failure naming the address does not carry it', async () => {
      const r = await send(await comment('boom'), await row(botBoom));
      assertClean('failed handoff', r);
      assert.equal(r.body.delivery.status, 'failed', r.text);
      assertClean('handoffs after failure', await call(`/api/notify/handoffs?slug=${slug}`, page));
    });

    await check('every other route the token can read', async () => {
      assertClean('comments', await call(`/api/comments?slug=${slug}`, page));
      assertClean('comments, all versions', await call(`/api/comments?slug=${slug}&version=all`, page));
      assertClean('mentions', await call(`/api/mentions?slug=${slug}`, page));
      assertClean('auth/me', await call('/api/auth/me', page));
      assertClean('feedback/session', await call('/api/feedback/session', page));
      // Sharing stays on tdoc for a third party's page: refused, and still clean.
      assertClean('feedback/invites', await call(`/api/feedback/invites?slug=${slug}`, page), 403);
      for (const route of ['/api/me/connectors', `/api/docs/${slug}/my-agent`]) {
        assert.equal((await call(route, page)).status, 403, `${route} is closed to this token`);
      }
    });

    await check('my-agent: the own-agent token sees no URL and asks by id', async () => {
      const home = await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin: ORIGIN } });
      assert.equal(home.status, 200, home.text);
      const own = { token: home.body.token };
      const listed = await call(`/api/docs/${home.body.slug}/my-agent`, own);
      assertClean('my-agent', listed);
      const made = await call('/api/comments', { method: 'POST', ...own, body: { slug: home.body.slug, version: 1, text: 'ask it', anchor: { kind: 'product', url: `${ORIGIN}/x` } } });
      assert.equal(made.status, 200, made.text);
      await posts();
      const pick = listed.body.agents.find((t) => sameAgent(t, botB));
      const asked = await call(`/api/docs/${home.body.slug}/my-agent`, { method: 'POST', ...own, body: { comment_id: made.body.id, recipient: pick } });
      assertClean('my-agent ask', asked);
      assert.deepEqual((await posts()).map((p) => p.url), [HOOK_B]);
    });

    // Other accounts, on their own docs, with their own credentials.
    const user = async (login) => {
      const sid = crypto.randomBytes(16).toString('hex');
      await fetch(`${base}/__seed-session`, { method: 'POST', body: JSON.stringify({ id: sid, login }) });
      const userCookie = `tdoc_sid=${sid}`;
      const made = await call('/api/hosted/token', { method: 'POST', cookie: userCookie, body: { label: login } });
      assert.equal(made.status, 200, made.text);
      return { login, cookie: userCookie, token: made.body.token, account: made.body.account_id };
    };
    const upload = async (who, name, version = 1) => {
      const r = await call('/api/upload', { method: 'POST', token: who.token, body: { slug: name, version, html: `<h1>${name}</h1><p>a sentence v${version}</p>`, meta: { title: name, access: { visibility: 'private', allowed_users: [] } } } });
      assert.equal(r.status, 200, r.text);
    };
    const note = async (who, name, text = 'a note') => {
      const r = await call('/api/comments', { method: 'POST', cookie: who.cookie, body: { slug: name, version: 1, text, anchor: { kind: 'text', text: 'a sentence' } } });
      assert.equal(r.status, 200, r.text);
      return r.body.id;
    };
    const julie = { login: 'julie', cookie, token: minted.body.token, account: minted.body.account_id };
    const dana = await user('dana');
    const bob = await user('bob');
    const carol = await user('carol');
    await upload(dana, 'dana-doc');
    await upload(julie, 'jul-doc');
    const ELSEWHERE = 'https://hooks.example/somewhere-else';
    const named = (agent, extra = {}) => ({ provider: 'webhook', server_id: 'webhook', agent_sub: agent.agent_sub, ...extra });
    const hand = (who, name, commentId, recipient, how = 'cookie') => call('/api/notify/handoff', { method: 'POST', ...(how === 'cookie' ? { cookie: who.cookie } : { token: who.token }), body: { slug: name, comment_ids: [commentId], recipient } });

    await check('another account cannot use a webhook, by any credential, with or without an address', async () => {
      await posts();
      for (const how of ['cookie', 'token']) {
        for (const extra of [{ url: ELSEWHERE }, {}]) {
          const r = await hand(dana, 'dana-doc', await note(dana, 'dana-doc'), named(botA, extra), how);
          assert.equal(r.status, 409, `${how} ${JSON.stringify(extra)}: ${r.text}`);
          assert.equal(r.body.error, 'agent_unavailable');
        }
      }
      assert.deepEqual(await posts(), []);
      assert.ok(!JSON.parse((await kv('handoffs:dana-doc')) || '[]').length, 'nothing recorded');
    });

    await check('the owner naming their own webhook: the stored address, whatever else was sent', async () => {
      for (const how of ['cookie', 'token']) {
        const r = await hand(julie, 'jul-doc', await note(julie, 'jul-doc'), named(botA, { url: ELSEWHERE }), how);
        assert.equal(r.body.delivery && r.body.delivery.status, 'delivered', r.text);
        assert.deepEqual((await posts()).map((p) => p.url), [HOOK_A]);
      }
      const seen = JSON.parse(await kv('handoffs:jul-doc'))[0];
      assert.equal(seen.recipient.url, HOOK_A, 'the record never keeps a sent address');
    });

    await check('a webhook pushed off the account list can still be named by its owner, and only by them', async () => {
      const off = await hook('https://hooks.example/secret-path-off', 'Bot Off');
      const list = JSON.parse(await kv(`account-notify:${julie.account}`));
      await kv(`account-notify:${julie.account}`, JSON.stringify(list.filter((t) => t.agent_sub !== off.agent_sub)));
      await posts();
      const r = await hand(julie, 'jul-doc', await note(julie, 'jul-doc'), named(off));
      assert.equal(r.body.delivery && r.body.delivery.status, 'delivered', r.text);
      assert.deepEqual((await posts()).map((p) => p.url), ['https://hooks.example/secret-path-off']);
      const theirs = await hand(dana, 'dana-doc', await note(dana, 'dana-doc'), named(off, { url: ELSEWHERE }));
      assert.equal(theirs.status, 409, theirs.text);
      assert.deepEqual(await posts(), []);
    });

    await check('a webhook connected before ownership was recorded: its account list says whose it is', async () => {
      const old = 'wh_aaaaaaaaaaaaaaaaaaaa';
      await kv(`notify-webhook-secret:${old}`, 'whsec_old');
      const list = JSON.parse(await kv(`account-notify:${julie.account}`));
      await kv(`account-notify:${julie.account}`, JSON.stringify([...list, { provider: 'webhook', server_id: 'webhook', agent_sub: old, url: 'https://hooks.example/secret-path-old', agent_name: 'Old' }]));
      const r = await hand(julie, 'jul-doc', await note(julie, 'jul-doc'), { provider: 'webhook', server_id: 'webhook', agent_sub: old, url: ELSEWHERE });
      assert.equal(r.body.delivery && r.body.delivery.status, 'delivered', r.text);
      assert.deepEqual((await posts()).map((p) => p.url), ['https://hooks.example/secret-path-old']);
      const theirs = await hand(dana, 'dana-doc', await note(dana, 'dana-doc'), { provider: 'webhook', server_id: 'webhook', agent_sub: old, url: ELSEWHERE });
      assert.equal(theirs.status, 409, theirs.text);
      assert.deepEqual(await posts(), []);
    });

    await check('Resend: a stored record naming somebody else\'s webhook sends nothing', async () => {
      for (const recipient of [named(botA, { url: ELSEWHERE, agent_name: 'x' }), named(botA, { url: HOOK_A, agent_name: 'x' })]) {
        const id = `h_seed_${crypto.randomBytes(3).toString('hex')}`;
        await kv('handoffs:dana-doc', JSON.stringify([{ handoff_id: id, at: new Date().toISOString(), recipient, comment_ids: [await note(dana, 'dana-doc')], instruction: '', delivery: { status: 'delivered' } }]));
        const r = await call('/api/notify/handoff/resend', { method: 'POST', cookie: dana.cookie, body: { slug: 'dana-doc', handoff_id: id } });
        assert.ok(r.status === 409 || r.body.delivery.status === 'failed', r.text);
        assert.deepEqual(await posts(), []);
      }
      await kv('handoffs:dana-doc', '[]');
    });

    await check('Resend: the owner\'s old record with another address goes to the stored one', async () => {
      const id = 'h_seed_owner';
      await kv('handoffs:jul-doc', JSON.stringify([{ handoff_id: id, at: new Date().toISOString(), recipient: named(botB, { url: ELSEWHERE, agent_name: 'Bot B' }), comment_ids: [await note(julie, 'jul-doc')], instruction: '', delivery: { status: 'delivered' } }]));
      const r = await call('/api/notify/handoff/resend', { method: 'POST', cookie, body: { slug: 'jul-doc', handoff_id: id } });
      assert.equal(r.body.delivery && r.body.delivery.status, 'delivered', r.text);
      assert.deepEqual((await posts()).map((p) => p.url), [HOOK_B]);
    });

    await check('a test send and my-agent reach only the caller\'s own webhook', async () => {
      const tested = await call('/api/me/connectors/test', { method: 'POST', cookie: dana.cookie, body: named(botA) });
      assert.equal(tested.status, 404, tested.text);
      const home = await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin: ORIGIN } });
      const made = await call('/api/comments', { method: 'POST', token: home.body.token, body: { slug: home.body.slug, version: 1, text: 'and again', anchor: { kind: 'product', url: `${ORIGIN}/y` } } });
      await posts();
      const own = await call(`/api/docs/${home.body.slug}/my-agent`, { method: 'POST', token: home.body.token, body: { comment_id: made.body.id, recipient: named(botB, { url: ELSEWHERE }) } });
      assert.equal(own.status, 200, own.text);
      assert.deepEqual((await posts()).map((p) => p.url), [HOOK_B]);
      const made2 = await call('/api/comments', { method: 'POST', token: home.body.token, body: { slug: home.body.slug, version: 1, text: 'once more', anchor: { kind: 'product', url: `${ORIGIN}/z` } } });
      const refused = await call(`/api/docs/${home.body.slug}/my-agent`, { method: 'POST', token: home.body.token, body: { comment_id: made2.body.id, recipient: { provider: 'webhook', server_id: 'webhook', agent_sub: 'wh_00000000000000000000', url: ELSEWHERE } } });
      assert.equal(refused.status, 403, refused.text);
      assert.deepEqual(await posts(), []);
    });

    await check('a disconnected webhook is gone: no ownership record, nothing sent, refused to the token', async () => {
      const gone = await hook('https://hooks.example/secret-path-gone', 'Gone');
      const removed = await call('/api/me/connectors/remove', { method: 'POST', cookie, body: named(gone) });
      assert.equal(removed.status, 200, removed.text);
      assert.equal(await kv(`notify-webhook:${julie.account}:${gone.agent_sub}`), null);
      const viaOwner = await hand(julie, 'jul-doc', await note(julie, 'jul-doc'), named(gone));
      assert.equal(viaOwner.status, 409, viaOwner.text);
      const viaToken = await send(await comment('gone'), named(gone));
      assert.equal(viaToken.status, 409, viaToken.text);
      assert.deepEqual(await posts(), []);
    });

    await check('nobody reads the URL on /api/notify/handoffs: member, second admin, owner, after a doc leaves a team', async () => {
      const team = (await call('/api/teams', { method: 'POST', cookie, body: { name: 'Crew' } })).body.team;
      const invite = team.invite_url.split('/').pop();
      for (const who of [bob, carol]) assert.equal((await call('/api/team/join', { method: 'POST', cookie: who.cookie, body: { token: invite } })).status, 200);
      assert.equal((await call('/api/team/role', { method: 'POST', cookie, body: { id: team.id, account_id: carol.account, role: 'admin' } })).status, 200);
      await upload(julie, 'team-doc');
      assert.equal((await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: ['team-doc'] } })).status, 200);
      const bobsNote = await note(bob, 'team-doc', 'from bob');
      const row = rowsOf((await call('/api/notify/targets?slug=team-doc', { cookie })).body).find((t) => sameAgent(t, botA));
      const sent = await call('/api/notify/handoff', { method: 'POST', cookie, body: { slug: 'team-doc', comment_ids: [bobsNote], recipient: row } });
      assert.equal(sent.body.delivery && sent.body.delivery.status, 'delivered', sent.text);
      assert.deepEqual((await posts()).map((p) => p.url), [HOOK_A]);
      const reads = { 'member cookie': { cookie: bob.cookie }, 'second admin cookie': { cookie: carol.cookie }, 'second admin token': { token: carol.token }, 'sender cookie': { cookie }, 'sender token': { token: julie.token } };
      for (const [who, how] of Object.entries(reads)) {
        const r = await call('/api/notify/handoffs?slug=team-doc', how);
        assertClean(who, r);
        assert.ok(r.body.handoffs.some((h) => h.recipient && sameAgent(h.recipient, botA)), `${who}: ${r.text}`);
      }
      // Bob's own doc, in the team, then out of it, with Julie's webhook on record.
      await upload(bob, 'bob-team');
      assert.equal((await call('/api/team/move', { method: 'POST', token: bob.token, body: { team: team.id, slugs: ['bob-team'] } })).status, 200);
      const m = JSON.parse(await kv('meta:bob-team'));
      for (const v of m.versions) { v.source = 'browser'; delete v.by; }
      await kv('meta:bob-team', JSON.stringify(m));
      await upload(julie, 'bob-team', 2);
      const row2 = rowsOf((await call('/api/notify/targets?slug=bob-team', { cookie })).body).find((t) => sameAgent(t, botA));
      const out = await call('/api/notify/handoff', { method: 'POST', cookie, body: { slug: 'bob-team', comment_ids: [await note(bob, 'bob-team')], recipient: row2 } });
      assert.equal(out.body.delivery && out.body.delivery.status, 'delivered', out.text);
      await posts();
      assert.equal((await call('/api/team/move', { method: 'POST', cookie, body: { team: null, slugs: ['bob-team'] } })).status, 200);
      assertClean('owner, doc out of the team', await call('/api/notify/handoffs?slug=bob-team', { cookie: bob.cookie }));
      const again = await call('/api/notify/handoff/resend', { method: 'POST', cookie: bob.cookie, body: { slug: 'bob-team', handoff_id: out.body.handoff_id } });
      assert.ok(again.status === 409 || again.body.delivery.status === 'failed', again.text);
      assert.deepEqual(await posts(), []);
    });

    await check('the owner in their browser still has the URLs to manage their connector', async () => {
      const targets = await call(`/api/notify/targets?slug=${slug}`, { cookie });
      assert.equal(targets.status, 200, targets.text);
      for (const url of [HOOK_A, HOOK_B, HOOK_BOOM]) assert.ok(rowsOf(targets.body).some((t) => t.url === url), targets.text);
      const connectors = await call('/api/me/connectors', { cookie });
      assert.ok(connectors.body.targets.some((t) => t.url === HOOK_A), connectors.text);
    });

    assert.equal(failed, 0, `${failed} failed`);
    console.log('feedback token in workerd: no webhook URL or secret in any response; picker and Resend work by id; owner unchanged');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
