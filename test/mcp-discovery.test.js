// The remote MCP server is findable: /llms.txt has a Connect section with
// the server URL and each app's install line; a document's Markdown ends
// with one line pointing at it; /raw keeps the exact stored bytes and says
// the same in a Link header; the MCP Server Card (SEP-2127) is served at
// /mcp/server-card, listed in /.well-known/ai-catalog.json, and mirrored at
// /.well-known/mcp.json and /.well-known/mcp/server-card.json. With the
// server off (self-host without TDOC_REMOTE_MCP) none of the dynamic hints
// appear. And the remoteMcp flag is on by default.
//
// Run with: node test/mcp-discovery.test.js

const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const STORED = '<!doctype html>\n<h1>Plan</h1>\n<p>Ship the importer.</p>\n';
const LINE = 'To reply to comments or publish an update, connect tdoc: https://tdoc.dev/mcp (see https://tdoc.dev/llms.txt).';

async function seed(env, slug) {
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put(`meta:${slug}`, JSON.stringify({ title: 'Plan', slug, created, versions: [{ n: 1, created }], access: { visibility: 'public' } }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, STORED);
}

(async () => {
  console.log('MCP discovery (llms.txt Connect, markdown line, raw Link header, server card, flag default)');
  const mod = await loadWorker();
  const worker = mod.default;
  const on = makeEnv(mod.CommentsStore, { TDOC_REMOTE_MCP: '1' });
  const off = makeEnv(mod.CommentsStore, { TDOC_REMOTE_MCP: '0' });
  await seed(on, 'plan');
  await seed(off, 'plan');
  const call = async (env, p, o = {}) => worker.fetch(req(p, o), env, {});

  await t('/llms.txt and /llms-full.txt name the MCP server and every app\'s install line', async () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'README.md'), 'utf8');
    for (const p of ['/llms.txt', '/llms-full.txt']) {
      const body = await (await call(on, p)).text();
      assert(body.includes('## Connect') && body.includes('https://tdoc.dev/mcp'), `${p}: no Connect section`);
      assert(!/writing goes through the tdoc skill\./.test(body), `${p}: still says writing only goes through the skill`);
      for (const want of [
        'claude plugin install tdoc-cloud --marketplace tornado-doc/tdoc',
        '/plugin marketplace add tornado-doc/tdoc', '/plugin install tdoc-cloud@tornado-tdoc',
        'claude mcp add --transport http tdoc https://tdoc.dev/mcp',
        'codex plugin marketplace add tornado-doc/tdoc && codex plugin add tdoc@tornado-tdoc',
        'codex mcp add tdoc --url https://tdoc.dev/mcp',
        `code --add-mcp '{"name":"tdoc","type":"http","url":"https://tdoc.dev/mcp"}'`,
        'https://cursor.com/install-mcp?name=tdoc&config=eyJ1cmwiOiJodHRwczovL3Rkb2MuZGV2L21jcCJ9',
        'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=tdoc&connectorUrl=https%3A%2F%2Ftdoc.dev%2Fmcp',
        'Add custom MCP server', 'Bearer tdoc_', 'OAuth',
        'https://tdoc.dev/mcp/server-card', 'fallback',
      ]) assert(body.includes(want), `${p} lacks ${want}`);
    }
    // The commands are the README's, not a copy that drifted.
    for (const cmd of ['claude plugin install tdoc-cloud --marketplace tornado-doc/tdoc', 'codex plugin marketplace add tornado-doc/tdoc && codex plugin add tdoc@tornado-tdoc']) {
      assert(readme.includes(cmd), `plugins/README.md no longer says ${cmd}`);
    }
  });

  await t('a document\'s Markdown ends with the connect line; /raw bytes are unchanged and carry Link rel="mcp"', async () => {
    for (const p of ['/d/plan', '/d/plan/v/1']) {
      const md = await (await call(on, p, { headers: { Accept: 'text/markdown' } })).text();
      assert(md.trimEnd().endsWith(LINE), `${p}: markdown does not end with the line:\n${md.slice(-300)}`);
      assert(md.split(LINE).length === 2, `${p}: line appears more than once`);
    }
    for (const p of ['/d/plan/raw', '/d/plan/v/1/raw']) {
      for (const accept of [undefined, 'text/markdown']) {
        const r = await call(on, p, accept ? { headers: { Accept: accept } } : {});
        const body = await r.text();
        assert(r.status === 200 && body === STORED, `${p} (${accept || 'no accept'}): raw bytes changed: ${JSON.stringify(body)}`);
        assert(r.headers.get('link') === '<https://tdoc.dev/mcp>; rel="mcp"', `${p}: Link ${r.headers.get('link')}`);
      }
    }
    // Same bytes with the server off: the hint is a header, never the body.
    const rawOff = await call(off, '/d/plan/raw');
    assert((await rawOff.text()) === STORED && !rawOff.headers.get('link'), 'raw with MCP off');
    const mdOff = await (await call(off, '/d/plan', { headers: { Accept: 'text/markdown' } })).text();
    assert(!mdOff.includes('/mcp'), 'markdown names /mcp with the server off');
    // The browser page is unchanged by the line.
    const page = await (await call(on, '/d/plan', { headers: { Accept: 'text/html' } })).text();
    assert(!page.includes(LINE), 'connect line leaked into the HTML page');
  });

  await t('Server Card at /mcp/server-card follows the SEP-2127 schema; the AI Catalog points at it', async () => {
    const r = await call(on, '/mcp/server-card', { headers: { Accept: 'application/mcp-server-card+json' } });
    assert(r.status === 200, `card ${r.status}`);
    assert((r.headers.get('content-type') || '').startsWith('application/mcp-server-card+json'), r.headers.get('content-type'));
    assert(r.headers.get('access-control-allow-origin') === '*', 'CORS');
    const card = JSON.parse(await r.text());
    assert(card.$schema === 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json', card.$schema);
    assert(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(card.name) && card.name.length <= 200, card.name);
    assert(typeof card.version === 'string' && !/[\^~>*x]/.test(card.version), card.version);
    assert(card.description.length >= 1 && card.description.length <= 100, `description ${card.description.length} chars`);
    assert(card.title && card.title.length <= 100, 'title');
    assert(card.repository.url === 'https://github.com/tornado-doc/tdoc' && card.repository.source === 'github', 'repository');
    const [remote] = card.remotes;
    assert(card.remotes.length === 1 && remote.type === 'streamable-http' && remote.url === 'https://tdoc.dev/mcp', JSON.stringify(remote));
    assert(remote.supportedProtocolVersions.includes('2025-06-18'), 'protocol versions');
    const auth = remote.headers.find((h) => h.name === 'Authorization');
    assert(auth && auth.isRequired === false && auth.isSecret === true, 'optional Bearer header');
    const meta = card._meta['dev.tdoc/auth'];
    assert(meta.type === 'oauth2' && meta.protected_resource_metadata === 'https://tdoc.dev/.well-known/oauth-protected-resource/mcp', JSON.stringify(meta));
    assert(meta.authorization_server_metadata === 'https://tdoc.dev/.well-known/oauth-authorization-server', 'AS metadata');
    for (const key of Object.keys(card._meta)) assert(!/(^|\.)(modelcontextprotocol|mcp)\//.test(key), `reserved _meta prefix ${key}`);
    // The metadata URLs it names answer.
    for (const u of [meta.protected_resource_metadata, meta.authorization_server_metadata]) {
      const m = await call(on, new URL(u).pathname);
      assert(m.status === 200 && JSON.parse(await m.text()), `${u} ${m.status}`);
    }
    // The URL it names is the live server: it asks for OAuth.
    const init = await call(on, '/mcp', { method: 'POST', headers: { Accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } } });
    assert(init.status === 401, `unauthenticated initialize ${init.status}`);

    const cat = await call(on, '/.well-known/ai-catalog.json');
    assert(cat.status === 200 && (cat.headers.get('content-type') || '').startsWith('application/ai-catalog+json'), `catalog ${cat.status}`);
    const catalog = JSON.parse(await cat.text());
    assert(catalog.specVersion === '1.0' && catalog.entries.length === 1, JSON.stringify(catalog));
    const [entry] = catalog.entries;
    assert(entry.type === 'application/mcp-server-card+json' && entry.url === 'https://tdoc.dev/mcp/server-card' && entry.identifier === 'urn:air:tdoc.dev:mcp:tdoc', JSON.stringify(entry));
  });

  await t('/.well-known/mcp.json and /.well-known/mcp/server-card.json serve the same card as JSON, not a redirect', async () => {
    const card = await (await call(on, '/mcp/server-card')).text();
    for (const p of ['/.well-known/mcp.json', '/.well-known/mcp/server-card.json']) {
      const r = await call(on, p);
      assert(r.status === 200, `${p} ${r.status} ${r.headers.get('location') || ''}`);
      assert((r.headers.get('content-type') || '').startsWith('application/json'), `${p} ${r.headers.get('content-type')}`);
      const body = await r.text();
      assert(body === card && JSON.parse(body).name === 'dev.tdoc/tdoc', `${p} differs from the card`);
      const head = await call(on, p, { method: 'HEAD' });
      assert(head.status === 200 && (await head.text()) === '', `${p} HEAD`);
    }
    const post = await call(on, '/.well-known/mcp.json', { method: 'POST', body: {} });
    assert(post.status === 405, `POST ${post.status}`);
  });

  await t('with the server off, the discovery routes are 404', async () => {
    for (const p of ['/mcp/server-card', '/.well-known/mcp.json', '/.well-known/mcp/server-card.json', '/.well-known/ai-catalog.json']) {
      const r = await call(off, p);
      assert(r.status === 404, `${p} ${r.status}`);
    }
  });

  await t('remoteMcp is on by default, outside dev mode and previews', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'feature-flags.js'), 'utf8');
    const line = src.split('\n').find((l) => /^\s*remoteMcp:/.test(l));
    assert(line && /default:\s*true/.test(line), `remoteMcp flag: ${line}`);
    const { isFeatureOn, devOnlyFlags } = await import(path.join(__dirname, '..', 'shell', 'src', 'feature-flags.js')).catch(() => ({}));
    if (isFeatureOn) {
      assert(isFeatureOn('remoteMcp', { on: false }) === true, 'flag off outside dev mode');
      assert(!devOnlyFlags().some((f) => f.name === 'remoteMcp'), 'still listed as dev-only');
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
