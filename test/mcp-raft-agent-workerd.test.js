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
// Raft's three legs, answered here: workerd has no network, and a handoff that
// is not delivered holds nobody.
globalThis.fetch = async (input) => {
  const u = String(input && input.url ? input.url : input);
  if (globalThis.__down) return new Response('{}', { status: 500 });
  if (u.endsWith('/api/oauth/requests/agent')) return Response.json({ requestId: 'r1', agent: { serverId: 'server-one' } });
  if (u.endsWith('/api/oauth/token')) return Response.json({ access_token: 't' });
  if (u.endsWith('/api/oauth/agent-events')) return Response.json(globalThis.__duplicate ? { id: 'e1', status: 'duplicate', deduped: true } : { id: 'e1', status: 'queued' });
  return new Response('no network here', { status: 502 });
};
const fake = globalThis.__tdocFake || (globalThis.__tdocFake = { META: new KV(), DOCS: new R2() });
const envFor = (env) => ({ META: fake.META, DOCS: fake.DOCS, COMMENTS: env.COMMENTS, TDOC_HOSTED_REGISTRATION: '1', TDOC_REMOTE_MCP: '1', TDOC_DATA_MIRROR_KEY: 'test-mirror-key-0123456789abcdef', PUBLIC_HOST: 'tdoc.dev', RAFT_CLIENT_ID: 'tdoc-x', RAFT_CLIENT_SECRET: 's', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test' });
export class TestStore extends CommentsStore { constructor(state, env) { super(state, envFor(env)); } }
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/__down') { const mode = await req.text(); globalThis.__down = mode === 'on'; globalThis.__duplicate = mode === 'duplicate'; return new Response('ok'); }
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
    await fetch(`${base}/__seed-session`, { method: 'POST', body: JSON.stringify({ id, login: 'julie', email: 'julie@tdoc.test' }) });
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

    // A suggestions handoff (dev mode: julie is on the list) on the real Durable
    // Object, through every MCP publish tool. The acting agent is what raft_agent
    // says; the OAuth token alone cannot tell the agents apart.
    const A = `${S1}/agent-linked`;
    const B = `${S1}/agent-listed`;
    const held = await doc({ raft_agent: A, html: '<h1>Raft doc</h1><p>First sentence here.</p><p>Second sentence here.</p>' });
    const say = async (text, quote) => {
      const r = await call('/api/comments', { method: 'POST', cookie, body: { slug: held, version: 1, text, anchor: { kind: 'text', text: quote } } });
      assert.equal(r.status, 200, r.text);
      return r.body.id;
    };
    const c1 = await say('fix the first', 'First sentence');
    const c2 = await say('fix the second', 'Second sentence');
    const sent = await call('/api/notify/handoff', { method: 'POST', cookie, body: { slug: held, comment_ids: [c1, c2], recipient: row('agent-linked', 'linked'), instruction: 'address these', reply_as: 'suggestions' } });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.body.reply_as, 'suggestions', sent.text);
    assert.equal(sent.body.delivery.status, 'delivered', sent.text);
    const refusedSuggest = (r, what) => {
      assert.ok(r.isError, `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.structuredContent.error, 'suggestions_only_run', `${what}: ${JSON.stringify(r)}`);
      assert.match(r.content[0].text, /propose_edits/, what);
      assert.match(r.content[0].text, /do not publish or retry/, what);
    };
    const versions = async () => (await metaOf(held)).versions.length;
    refusedSuggest(await tool(token, 'update_doc', { slug: held, html: '<h1>Raft doc</h1><p>rewritten</p>', raft_agent: A }), 'update_doc');
    refusedSuggest(await tool(token, 'edit_doc', { slug: held, edits: [{ find: 'First sentence', replace: 'Changed' }], raft_agent: A }), 'edit_doc');
    const staged = Buffer.from('<h1>By upload</h1><p>held</p>');
    const up2 = await tool(token, 'create_upload', { slug: held, files: [{ name: 'index.html', type: 'text/html', size: staged.length }] });
    assert.ok(!up2.isError, JSON.stringify(up2));
    assert.equal((await fetch(up2.structuredContent.files[0].url.replace(ORIGIN, base), { method: 'PUT', body: staged })).status, 200);
    refusedSuggest(await tool(token, 'commit_upload', { upload_id: up2.structuredContent.upload_id, raft_agent: A }), 'commit_upload');
    // No raft_agent at all: it may well be the recipient.
    refusedSuggest(await tool(token, 'update_doc', { slug: held, html: '<h1>Raft doc</h1><p>nameless</p>' }), 'update_doc with no identity');
    assert.equal(await versions(), 1, 'nothing was published');
    // A new doc is not this doc; suggestions and replies go on.
    assert.ok(!(await tool(token, 'create_doc', { title: 'Another', html: '<p>x</p>', raft_agent: A })).isError, 'create_doc');
    const first = await tool(token, 'propose_edits', { slug: held, edits: [{ find: 'First sentence here.', replace: 'First, better.', comment_id: c1 }] });
    assert.ok(!first.isError, JSON.stringify(first));
    // The second comment is open: still held. Accepting the first publishes as the person.
    refusedSuggest(await tool(token, 'update_doc', { slug: held, html: '<h1>Raft doc</h1><p>rewritten</p>', raft_agent: A }), 'one comment still open');
    const accepted = await call(`/api/docs/${held}/suggestions/${first.structuredContent.suggestion_id}/accept`, { method: 'POST', cookie, body: {} });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(await versions(), 2, 'accepting published');
    refusedSuggest(await tool(token, 'update_doc', { slug: held, html: '<h1>Raft doc</h1><p>rewritten</p>', raft_agent: A }), 'still open after an accept');
    // Another of the account's agents, named, is not held.
    const other = await tool(token, 'update_doc', { slug: held, html: '<h1>Raft doc</h1><p>First, better.</p><p>Second sentence here.</p>', raft_agent: B });
    assert.ok(!other.isError, JSON.stringify(other));
    const second = await tool(token, 'propose_edits', { slug: held, edits: [{ find: 'Second sentence here.', replace: 'Second, better.', comment_id: c2 }] });
    assert.ok(!second.isError, JSON.stringify(second));
    const free = await tool(token, 'update_doc', { slug: held, html: '<h1>Raft doc</h1><p>rewritten</p>', raft_agent: A });
    assert.ok(!free.isError, JSON.stringify(free));
    console.log('suggestions handoff in workerd: every MCP publish tool refused, propose_edits lifts it, accept and another agent unaffected ok');

    {
    // How a lock ends on the real Durable Object, where a comment wipe leaves the
    // rest of the object's storage alone.
    const cli = minted.body.token;
    const asA = { 'X-Tdoc-Raft-Agent': A };
    const lockedDoc = async () => {
      const slug = await doc({ raft_agent: A, html: '<h1>T</h1><p>First sentence here.</p>' });
      const c = await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: 'fix', anchor: { kind: 'text', text: 'First sentence' } } });
      assert.equal(c.status, 200, c.text);
      const h = await call('/api/notify/handoff', { method: 'POST', cookie, body: { slug, comment_ids: [c.body.id], recipient: row('agent-linked', 'linked'), instruction: 'x', reply_as: 'suggestions' } });
      assert.equal(h.status, 200, h.text);
      return { slug, comment: c.body.id, handoff: h.body.handoff_id };
    };
    const upload = async (slug, t = cli, headers = asA) => {
      const m = await metaOf(slug);
      const n = m ? Math.max(...m.versions.map((v) => v.n)) + 1 : 1;
      return call('/api/upload', { method: 'POST', token: t, headers, body: { slug, version: n, html: `<h1>T</h1><p>v${n}</p>`, meta: { title: 'T', versions: [{ n, created: new Date().toISOString() }] } } });
    };
    const held = async (slug, what) => { const r = await upload(slug); assert.equal(r.status, 403, `${what}: ${r.text}`); assert.equal(r.body.error, 'suggestions_only_run', what); };
    const free = async (slug, what) => { const r = await upload(slug); assert.equal(r.status, 200, `${what}: ${r.text}`); };

    const wiped = await lockedDoc();
    await held(wiped.slug, 'before the wipe');
    assert.equal((await call(`/api/comments?slug=${wiped.slug}&all=1`, { method: 'DELETE', token: cli })).status, 200);
    await free(wiped.slug, 'comments wiped');

    const purged = await lockedDoc();
    assert.equal((await call(`/api/doc?slug=${purged.slug}`, { method: 'DELETE', cookie })).status, 200);
    assert.equal((await call('/api/trash/purge', { method: 'POST', cookie, body: { slug: purged.slug } })).status, 200);
    const carolSid = crypto.randomBytes(16).toString('hex');
    await fetch(`${base}/__seed-session`, { method: 'POST', body: JSON.stringify({ id: carolSid, login: 'carol', email: 'carol@other.test' }) });
    const carol = await call('/api/hosted/token', { method: 'POST', cookie: `tdoc_sid=${carolSid}`, body: { label: 'carol' } });
    assert.equal(carol.status, 200, carol.text);
    for (const n of [1, 2]) {
      const r = await call('/api/upload', { method: 'POST', token: carol.body.token, body: { slug: purged.slug, version: n, html: `<p>carol ${n}</p>`, meta: { title: 'Carol', versions: [{ n, created: new Date().toISOString() }] } } });
      assert.equal(r.status, 200, `the next owner of a purged slug, v${n}: ${r.text}`);
    }

    const resent = await lockedDoc();
    await fetch(`${base}/__down`, { method: 'POST', body: 'on' });
    const failedResend = await call('/api/notify/handoff/resend', { method: 'POST', cookie, body: { slug: resent.slug, handoff_id: resent.handoff } });
    await fetch(`${base}/__down`, { method: 'POST', body: 'off' });
    assert.equal(failedResend.body.delivery.status, 'failed', failedResend.text);
    await held(resent.slug, 'a failed Resend does not free an agent that already heard');

    const dup = await lockedDoc();
    const untilOf = async (slug) => { const r = await upload(slug); assert.equal(r.body.error, 'suggestions_only_run', r.text); return r.body.until; };
    const untilBefore = await untilOf(dup.slug);
    await fetch(`${base}/__down`, { method: 'POST', body: 'duplicate' });
    const dupResend = await call('/api/notify/handoff/resend', { method: 'POST', cookie, body: { slug: dup.slug, handoff_id: dup.handoff } });
    await fetch(`${base}/__down`, { method: 'POST', body: 'off' });
    assert.equal(dupResend.body.delivery.deduped, true, dupResend.text);
    assert.equal(await untilOf(dup.slug), untilBefore, 'a Resend that woke nobody starts no new hour');

    const applied = await lockedDoc();
    const saved = await call('/api/doc/versions', { method: 'POST', cookie, body: { slug: applied.slug, baseVersion: 1, html: '<!doctype html><html><head><title>T</title></head><body><h1>T</h1><p>Saved.</p></body></html>' } });
    assert.equal(saved.status, 200, saved.text);
    const said = await call('/api/agent/reply', { method: 'POST', token: cli, headers: asA, body: { slug: applied.slug, parent_id: applied.comment, text: 'Done', status: 'applied', applied_in: 2 } });
    assert.equal(said.status, 200, said.text);
    assert.equal(said.body.downgraded_from, undefined, said.text);
    await free(applied.slug, 'a real applied');
    console.log('suggestions lock in workerd: a wipe, a purge and a real applied end it; a failed Resend does not ok');
    }
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
