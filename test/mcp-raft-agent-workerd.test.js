// raft_agent on the real runtime: the deploy bundle in workerd, an OAuth
// connection made through the real routes, /mcp driving /api/upload and
// /api/agent/reply in process (MCP_INTERNAL_REQUESTS is what lets that token
// through at all). KV and R2 are small in-memory fakes inside the isolate, and
// Raft's directory and the client's metadata document are read from their KV
// caches: no network.
//
// Run with: node test/mcp-raft-agent-workerd.test.js   (part of npm run test:workerd)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  const root = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-mcp-raft-workerd-'));
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
const fake = globalThis.__tdocFake || (globalThis.__tdocFake = { META: new KV(), DOCS: new R2() });
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
const w :Workerd.Worker = (modules = [(name = "worker", esModule = embed "worker.mjs"), (name = "_worker.bundled.js", esModule = embed "_worker.bundled.js"), (name = "resvg.wasm", wasm = embed "resvg.wasm"), (name = "NotoSansSC-Regular.ttf", data = embed "NotoSansSC-Regular.ttf"), (name = "NotoSansSC-Bold.ttf", data = embed "NotoSansSC-Bold.ttf")], compatibilityDate = "2025-01-01", durableObjectNamespaces = [(className = "TestStore", uniqueKey = "tdoc-mcp-raft-test", enableSql = true)], durableObjectStorage = (localDisk = "do-disk"), bindings = [(name = "COMMENTS", durableObjectNamespace = "TestStore")]);
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
  let rpc = 0;
  const tool = async (token, name, args, headers = {}) => {
    const r = await call('/mcp', {
      method: 'POST', token,
      headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...headers },
      body: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } },
    });
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    return r.body.result;
  };
  const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bootData = (html) => JSON.parse(html.match(/__TDOC_APP_BOOT__\s*=\s*(\{.*?\});?\s*<\/script>/s)[1]);
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/__ping'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const id = crypto.randomBytes(16).toString('hex');
    await fetch(`${base}/__seed-session`, { method: 'POST', body: JSON.stringify({ id, login: 'julie' }) });
    const cookie = `tdoc_sid=${id}`;
    const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'julie' } });
    assert.equal(minted.status, 200, `token: ${minted.text} ${stderr}`);
    const accountId = minted.body.account_id;

    // The claude.ai connector's way in: an OAuth token shared by every agent.
    // Its metadata document is read from the cache a fetch would fill.
    const client = { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata' };
    await kv(`oauth-cimd:${crypto.createHash('sha256').update(client.client_id).digest('hex')}`, JSON.stringify({ ...client, client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], cimd: true }));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'mcp', resource: `${ORIGIN}/mcp` });
    const page = await call(`/oauth/authorize?${q}`, { cookie });
    assert.equal(page.status, 200, page.text.slice(0, 200));
    const boot = bootData(page.text);
    const approved = await call('/api/oauth/approve', { method: 'POST', cookie, body: { request_id: boot.request_id, csrf: boot.csrf, decision: 'allow' } });
    assert.equal(approved.status, 200, approved.text);
    const code = new URL(approved.body.redirect).searchParams.get('code');
    const issued = await call('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id, resource: `${ORIGIN}/mcp` } });
    assert.equal(issued.status, 200, issued.text);
    const token = issued.body.access_token;

    const S1 = 'server-one';
    const row = (agent_sub, agent_name) => ({ provider: 'raft', server_id: S1, server_slug: 'one', agent_sub, agent_name });
    await kv(`account-notify:${accountId}`, JSON.stringify([row('agent-linked', 'linked')]));
    await kv(`account-raft-servers:${accountId}`, JSON.stringify([{ server_id: S1, server_slug: 'one', installation_id: 'inst-1' }]));
    await kv(`raft-directory:${S1}`, JSON.stringify([row('agent-linked', 'linked'), row('agent-listed', '小c')]));
    const metaOf = async (slug) => JSON.parse(await kv(`meta:${slug}`));
    const doc = async (args) => {
      const r = await tool(token, 'create_doc', { title: 'Raft doc', html: '<h1>Raft doc</h1><p>a sentence to comment on</p>', ...args });
      assert.ok(!r.isError && r.structuredContent.slug, JSON.stringify(r));
      return r.structuredContent.slug;
    };

    // Published with the claim: recorded, and the @ list knows it.
    const slug = await doc({ raft_agent: `${S1}/agent-linked` });
    const meta = await metaOf(slug);
    assert.deepEqual(meta.versions[0].publisher_agent, { provider: 'raft', server_id: S1, agent_sub: 'agent-linked' });
    assert.equal(meta.notify_agents[0].agent_sub, 'agent-linked');
    const targets = await call(`/api/notify/targets?slug=${slug}`, { cookie });
    assert.equal(targets.status, 200, targets.text);
    const rows = [targets.body.default, ...(targets.body.candidates || [])].filter(Boolean);
    assert.ok(rows.find((x) => x.agent_sub === 'agent-linked').used_here_at, JSON.stringify(rows));

    // commit_upload, through the PUT that a shell's curl sends.
    const html = Buffer.from('<h1>By upload</h1><p>v2</p>');
    const up = await tool(token, 'create_upload', { slug, files: [{ name: 'index.html', type: 'text/html', size: html.length }] });
    assert.ok(!up.isError, JSON.stringify(up));
    const put = await fetch(up.structuredContent.files[0].url.replace(ORIGIN, base), { method: 'PUT', body: html });
    assert.equal(put.status, 200, await put.text());
    const committed = await tool(token, 'commit_upload', { upload_id: up.structuredContent.upload_id, raft_agent: `${S1}/agent-linked` });
    assert.ok(!committed.isError, JSON.stringify(committed));
    assert.equal((await metaOf(slug)).versions[1].publisher_agent.agent_sub, 'agent-linked');

    // Reply: the agent's name on it, through the event store on the real DO.
    const c = await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: 'please look', anchor: { kind: 'text', text: 'a sentence' } } });
    assert.equal(c.status, 200, c.text);
    const replied = await tool(token, 'reply_to_comment', { slug, comment_id: c.body.id, text: 'Looked.', status: 'answered', raft_agent: `${S1}/agent-linked` });
    assert.ok(!replied.isError && !replied.structuredContent.skipped, JSON.stringify(replied));
    const thread = (await call(`/api/comments?slug=${slug}&version=all`, { cookie })).body.find((x) => x.id === c.body.id);
    const author = thread.replies[thread.replies.length - 1].author;
    assert.equal(author.provider, 'raft');
    assert.equal(author.handle, '@linked');

    // Connected server, not linked: a non-Latin handle survives the header.
    const listed = await metaOf(await doc({ raft_agent: `${S1}/agent-listed` }));
    assert.equal(listed.versions[0].publisher_agent.agent_sub, 'agent-listed');
    assert.equal(listed.notify_agents[0].agent_name, '小c');

    // A server this account never connected: the write lands, nothing recorded.
    const foreign = await metaOf(await doc({ raft_agent: 'not-connected/agent-x' }));
    assert.ok(!foreign.versions[0].publisher_agent && !(foreign.notify_agents || []).length, JSON.stringify(foreign.versions));
    // Line breaks would throw in workerd's Headers if they ever got there.
    const crlf = await metaOf(await doc({ raft_agent: `${S1}/a\r\nX-Evil: 1` }));
    assert.ok(!crlf.versions[0].publisher_agent, JSON.stringify(crlf.versions));
    // No argument, and the header on the outer request: nothing recorded.
    const outer = await tool(token, 'create_doc', { title: 'Outer', html: '<p>x</p>' }, { 'X-Tdoc-Raft-Agent': `${S1}/agent-linked`, 'X-Tdoc-Raft-Agent-Name': 'linked' });
    assert.ok(!(await metaOf(outer.structuredContent.slug)).versions[0].publisher_agent, 'the outer header was forwarded');
    // The same token straight at the API is refused, header or not.
    const direct = await call('/api/upload', { method: 'POST', token, headers: { 'X-Tdoc-Raft-Agent': `${S1}/agent-linked` }, body: { slug: 'straight', version: 1, html: '<p>x</p>' } });
    assert.ok(direct.status === 401 || direct.status === 403, `${direct.status} ${direct.text}`);
    console.log('raft_agent in workerd: OAuth connection, publish, upload commit, reply, unlinked handle, foreign and malformed claims ok');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
