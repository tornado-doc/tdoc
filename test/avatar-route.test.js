// GET /avatar/<login> and /avatar/agent/<name>: comment faces served from
// the tdoc origin, so a site embedding the feedback widget needs only tdoc
// in its CSP img-src (app.hustlefree.ai blocked GitHub, Clerk and the logo
// CDN, 2026-11-02). The route must not be an open proxy: the client names a
// login or a table key, never a URL; upstreams and redirects stay on an
// allowlist; only a bounded raster image (or a table logo SVG, sandboxed)
// comes back; anything else is a 404 so the widget shows the initial.
// Also: the widget's avatarFor builds only tdoc URLs once setTdocOrigin is
// called, and the tdoc pages keep theirs.
// Run with: node test/avatar-route.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

// Upstream world: what each URL answers. Every fetch the worker makes is logged.
let routes = {};
const fetched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const href = typeof input === 'string' ? input : input.url;
  fetched.push({ href, init });
  const route = routes[href];
  if (!route) return new Response('nope', { status: 404 });
  if (typeof route === 'function') return route(init);
  return route;
};
const png = (extra = {}) => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', ...extra } });

// A Cache API stand-in (caches.default), keyed by URL like the real one.
class FakeCache {
  constructor() { this.map = new Map(); this.puts = []; }
  async match(request) { const hit = this.map.get(typeof request === 'string' ? request : request.url); return hit ? hit.clone() : undefined; }
  async put(request, response) {
    const key = typeof request === 'string' ? request : request.url;
    this.puts.push(key);
    this.map.set(key, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
  }
}
const cache = new FakeCache();
globalThis.caches = { default: cache };

(async () => {
  console.log('avatar route');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const get = async (p, opts = {}) => {
    const r = await worker.fetch(req(p, opts), env, ctx);
    await Promise.all(waits.splice(0));
    return r;
  };
  const reset = () => { routes = {}; fetched.length = 0; cache.map.clear(); cache.puts.length = 0; };

  await t('a GitHub login: the picture via github.com, redirect to the avatar host followed', async () => {
    reset();
    routes['https://github.com/dana.png?size=96'] = new Response(null, { status: 302, headers: { location: 'https://avatars.githubusercontent.com/u/42?v=4&s=96' } });
    routes['https://avatars.githubusercontent.com/u/42?v=4&s=96'] = png({ 'set-cookie': 'tracker=1', 'access-control-allow-origin': 'https://evil.example' });
    const r = await get('/avatar/dana');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.headers.get('content-type') === 'image/png', r.headers.get('content-type'));
    assert(r.headers.get('cross-origin-resource-policy') === 'cross-origin', 'CORP');
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff');
    assert(/max-age=86400/.test(r.headers.get('cache-control') || '') && /public/.test(r.headers.get('cache-control')), r.headers.get('cache-control'));
    assert(/sandbox/.test(r.headers.get('content-security-policy') || ''), 'CSP sandbox');
    assert(!r.headers.get('set-cookie'), 'upstream Set-Cookie must not pass through');
    assert(r.headers.get('access-control-allow-origin') !== 'https://evil.example', 'upstream headers must not pass through');
    const body = new Uint8Array(await r.arrayBuffer());
    assert(body.length === PNG.length && body[1] === 0x50, 'the image bytes');
    assert(fetched.every((f) => f.init.redirect === 'manual'), 'redirects are followed by hand');
    assert(fetched.every((f) => !f.init.headers || !Object.keys(f.init.headers).some((h) => /cookie|authorization/i.test(h))), 'no credentials upstream');
  });

  await t('cached by path only: a second request, or one with a query, is not fetched again', async () => {
    const before = fetched.length;
    const r = await get('/avatar/dana?u=https://evil.example/x.png');
    assert(r.status === 200, `status ${r.status}`);
    assert(fetched.length === before, 'served from the cache');
    assert(cache.puts.length === 1 && cache.puts[0] === 'https://tdoc.dev/avatar/dana', `cache keys ${JSON.stringify(cache.puts)}`);
    assert(!fetched.some((f) => f.href.includes('evil')), 'a query string never reaches upstream');
  });

  await t('HEAD answers the headers without a body', async () => {
    const r = await get('/avatar/dana', { method: 'HEAD' });
    assert(r.status === 200 && r.headers.get('cross-origin-resource-policy') === 'cross-origin');
    assert((await r.text()) === '');
  });

  await t('never an open proxy: a URL, a host, an encoded path or a login with odd case is a 404, nothing fetched', async () => {
    reset();
    for (const p of [
      '/avatar/https%3A%2F%2Fevil.example%2Fa.png',
      '/avatar/https://evil.example/a.png',
      '/avatar/evil.example',
      '/avatar/..%2F..%2Fapi%2Fme',
      '/avatar/dana%2F..%2Fopenai',
      '/avatar/Dana',
      '/avatar/@dana',
      '/avatar/github:dana',
      '/avatar/-dana',
      '/avatar/' + 'a'.repeat(40),
      '/avatar/',
      '/avatar/agent/evil',
      '/avatar/agent/constructor',
      '/avatar/agent/__proto__',
      '/avatar/agent/claude%2F..%2F..%2Fx',
      '/avatar/agent%2Fclaude%2F..%2Fx',
      '/avatar/email:dana@example.com',
      '/avatar/email-alias:abcdef',
    ]) {
      const r = await get(p);
      assert(r.status === 404, `${p} → ${r.status}`);
      assert(r.headers.get('x-content-type-options') === 'nosniff', `${p} nosniff`);
    }
    assert(fetched.length === 0, `fetched ${fetched.map((f) => f.href).join(', ')}`);
  });

  await t('logins that are not GitHub accounts are never a stranger\'s picture', async () => {
    reset();
    for (const login of ['tdoc', 'tdoc-ai', 'email-hidden', 'anon']) {
      const r = await get(`/avatar/${login}`);
      assert(r.status === 404, `${login} → ${r.status}`);
    }
    assert(fetched.length === 0);
  });

  await t('a redirect off the allowlist (or to http) is not followed: 404', async () => {
    for (const location of ['https://evil.example/a.png', 'http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil.example/u/1', 'https://user:pw@avatars.githubusercontent.com/u/1', 'https://169.254.169.254/latest/meta-data', 'https://avatars.githubusercontent.com:8443/u/1']) {
      reset();
      routes['https://github.com/eve.png?size=96'] = new Response(null, { status: 302, headers: { location } });
      routes[location] = png();
      const r = await get('/avatar/eve');
      assert(r.status === 404, `${location} → ${r.status}`);
      assert(!fetched.some((f) => f.href === location), `followed ${location}`);
    }
  });

  await t('too many redirects: 404', async () => {
    reset();
    routes['https://github.com/loop.png?size=96'] = new Response(null, { status: 302, headers: { location: 'https://avatars.githubusercontent.com/a' } });
    routes['https://avatars.githubusercontent.com/a'] = () => new Response(null, { status: 302, headers: { location: 'https://avatars.githubusercontent.com/a' } });
    const r = await get('/avatar/loop');
    assert(r.status === 404, `status ${r.status}`);
    assert(fetched.length <= 5, `${fetched.length} fetches`);
  });

  await t('not an image, an SVG for a person, a lying content-type, too big, empty, upstream error: 404', async () => {
    const cases = {
      html: () => new Response('<html><script>alert(1)</script></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      svg: () => new Response(SVG, { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
      liar: () => new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'image/png' } }),
      jpegAsPng: () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), { status: 200, headers: { 'content-type': 'image/png' } }),
      bigDeclared: () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024) } }),
      bigStreamed: () => {
        const big = new Uint8Array(600 * 1024); big.set(PNG);
        return new Response(new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 65536) c.enqueue(big.slice(i, i + 65536)); c.close(); } }), { status: 200, headers: { 'content-type': 'image/png' } });
      },
      empty: () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/png' } }),
      gone: () => new Response('gone', { status: 404 }),
      broken: () => new Response('err', { status: 500 }),
      partial: () => new Response(PNG, { status: 206, headers: { 'content-type': 'image/png' } }),
      threw: () => { throw new Error('network down'); },
    };
    for (const [name, make] of Object.entries(cases)) {
      reset();
      routes['https://github.com/x-' + name.toLowerCase() + '.png?size=96'] = make;
      const r = await get(`/avatar/x-${name.toLowerCase()}`);
      assert(r.status === 404, `${name} → ${r.status}`);
      assert(r.headers.get('content-type').startsWith('text/plain'), `${name} type ${r.headers.get('content-type')}`);
    }
  });

  await t('a slow upstream is cut off (timeout) and answered 404', async () => {
    reset();
    const realSetTimeout = globalThis.setTimeout;
    // Make the 5 s timer fire at once; the upstream waits for the abort.
    globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 1000 ? 5 : ms, ...a);
    try {
      routes['https://github.com/slow.png?size=96'] = (init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      const r = await get('/avatar/slow');
      assert(r.status === 404, `status ${r.status}`);
    } finally { globalThis.setTimeout = realSetTimeout; }
  });

  await t('a GitHub account id: the picture by id, from the avatar host', async () => {
    reset();
    routes['https://avatars.githubusercontent.com/u/12345?s=96&v=4'] = png();
    const r = await get('/avatar/u/12345');
    assert(r.status === 200 && r.headers.get('content-type') === 'image/png', `status ${r.status}`);
    assert(fetched.length === 1 && fetched[0].href === 'https://avatars.githubusercontent.com/u/12345?s=96&v=4', fetched.map((f) => f.href).join());
    assert(cache.puts[0] === 'https://tdoc.dev/avatar/u/12345');
    reset();
    for (const p of ['/avatar/u/0', '/avatar/u/012', '/avatar/u/abc', '/avatar/u/1234567890123', '/avatar/u/1%2F..%2F2', '/avatar/u/']) {
      assert((await get(p)).status === 404, p);
    }
    assert(fetched.length === 0);
  });

  await t('an upstream error, 403/429 or timeout: no-store for the browser, a minute at the edge; a real miss 5 min', async () => {
    for (const [name, make] of [['e500', () => new Response('x', { status: 500 })], ['e429', () => new Response('x', { status: 429 })], ['e403', () => new Response('x', { status: 403 })], ['threw', () => { throw new Error('down'); }]]) {
      reset();
      routes[`https://github.com/${name}.png?size=96`] = make;
      const r = await get(`/avatar/${name}`);
      assert(r.status === 404, `${name} ${r.status}`);
      assert(r.headers.get('cache-control') === 'no-store', `${name} ${r.headers.get('cache-control')}`);
      assert(cache.puts.length === 1, `${name} not kept at the edge`);
      const kept = await cache.match(`https://tdoc.dev/avatar/${name}`);
      assert(kept.status === 404 && kept.headers.get('cache-control') === 'public, max-age=60', `${name} edge ${kept.headers.get('cache-control')}`);
    }
    reset();
    routes['https://github.com/gone.png?size=96'] = new Response('x', { status: 404 });
    const r = await get('/avatar/gone');
    assert(r.status === 404 && /max-age=300/.test(r.headers.get('cache-control')) && cache.puts.length === 1);
  });

  await t('a miss is cached briefly, a hit for long', async () => {
    reset();
    const r = await get('/avatar/nobody-here');
    assert(r.status === 404);
    assert(/max-age=300/.test(r.headers.get('cache-control')), r.headers.get('cache-control'));
  });

  await t('agent marks come from the fixed table; a logo SVG is sandboxed', async () => {
    reset();
    routes['https://cdn.simpleicons.org/claude/d97757'] = new Response(SVG, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    const r = await get('/avatar/agent/claude');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.headers.get('content-type') === 'image/svg+xml', r.headers.get('content-type'));
    const csp = r.headers.get('content-security-policy') || '';
    assert(/default-src 'none'/.test(csp) && /sandbox/.test(csp), csp);
    assert(r.headers.get('cross-origin-resource-policy') === 'cross-origin');
    assert(fetched.length === 1 && fetched[0].href === 'https://cdn.simpleicons.org/claude/d97757');
    reset();
    routes['https://cdn.simpleicons.org/googlegemini/8e75b2'] = new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    assert((await get('/avatar/agent/gemini')).status === 404, 'not an SVG at all');
    reset();
    routes['https://github.com/openai.png?size=96'] = png();
    assert((await get('/avatar/agent/openai')).status === 200);
  });

  await t('the tdoc and Grok marks are embeddable cross-origin', async () => {
    for (const p of ['/tdoc_logo.png', '/grok_logo.svg']) {
      const r = await get(p);
      assert(r.status === 200 && r.headers.get('cross-origin-resource-policy') === 'cross-origin', p);
    }
  });

  await t('the route reads no session and writes nothing to KV', async () => {
    reset();
    routes['https://github.com/dana.png?size=96'] = png();
    const gets = env.META.gets.length;
    const keys = env.META.map.size;
    await get('/avatar/dana', { headers: { cookie: 'tdoc_sid=whatever' } });
    assert(env.META.gets.length === gets, `KV reads: ${env.META.gets.slice(gets).join(', ')}`);
    assert(env.META.map.size === keys);
  });

  // ---- the widget's URLs (shell/src/document/model.js) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-avatar-model-'));
  const file = path.join(dir, 'model.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'shell', 'src', 'document', 'model.js'), file);
  const model = await import(file);

  await t('on tdoc pages faces keep their own URLs', async () => {
    model.setTdocOrigin(null);
    assert(model.avatarFor({ login: 'dana', avatar_url: 'https://avatars.githubusercontent.com/u/1' }) === 'https://avatars.githubusercontent.com/u/1');
    assert(model.avatarFor({ kind: 'system', login: 'tdoc' }) === '/tdoc_logo.png');
    assert(model.tdocUrl('/@dana') === '/@dana');
  });

  await t('in the widget every face, the tdoc mark and the profile link are on the tdoc origin', async () => {
    const base = 'https://tdoc-preview.example.workers.dev';
    model.setTdocOrigin(base);
    try {
      const faces = [
        [{ login: 'yayashuxue', avatar_url: 'https://storage.googleapis.com/images.clerk.dev/oauth_github/img_x' }, `${base}/avatar/yayashuxue`],
        [{ login: 'Dana', avatar_url: 'https://img.clerk.com/abc' }, `${base}/avatar/dana`],
        [{ login: 'dana', avatar_url: 'https://github.com/dana.png?size=52' }, `${base}/avatar/dana`],
        [{ login: 'renamed', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4' }, `${base}/avatar/u/583231`],
        [{ login: 'email:x@example.com', avatar_url: 'https://avatars.githubusercontent.com/u/9?v=4' }, `${base}/avatar/u/9`],
        [{ login: 'dana', avatar_url: 'https://avatars.githubusercontent.com/u/9evil' }, `${base}/avatar/dana`],
        [{ login: 'dana', avatar_url: '' }, ''],
        [{ login: 'email:dana@example.com', avatar_url: 'https://img.clerk.com/abc' }, ''],
        [{ login: 'email-alias:0a1b2c', avatar_url: 'https://img.clerk.com/abc' }, ''],
        [{ login: 'email-hidden', avatar_url: 'https://img.clerk.com/abc' }, ''],
        [{ kind: 'system', login: 'tdoc', avatar_url: '' }, `${base}/tdoc_logo.png`],
        [{ kind: 'agent', login: 'tdoc-ai', avatar_url: '/tdoc_logo.png' }, `${base}/tdoc_logo.png`],
        [{ kind: 'agent', login: 'claude-code' }, `${base}/avatar/agent/claude`],
        [{ kind: 'agent', login: 'gemini' }, `${base}/avatar/agent/gemini`],
        [{ kind: 'agent', login: 'cursor' }, `${base}/avatar/agent/cursor`],
        [{ kind: 'agent', login: 'codex' }, `${base}/avatar/agent/openai`],
        [{ kind: 'agent', login: 'grok' }, `${base}/grok_logo.svg`],
      ];
      for (const [author, want] of faces) {
        const got = model.avatarFor(author);
        assert(got === want, `${JSON.stringify(author)} → ${got}, want ${want}`);
        assert(!got || got.startsWith(`${base}/`), `off-origin ${got}`);
      }
      assert(model.tdocUrl('/@dana') === `${base}/@dana`);
      assert(model.tdocUrl('//evil.example/x') === '//evil.example/x', 'protocol-relative is not a tdoc path');
      for (const bad of ['javascript:alert(1)', 'https://a@b.example', 'https://x.example?y', 'https://x.example/', 'data:,x']) {
        model.setTdocOrigin(bad);
        assert(model.tdocUrl('/@dana') === '/@dana', `${bad} is refused as an origin`);
      }
    } finally { model.setTdocOrigin(null); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t('the widget sets the origin it was served from; shared components ask avatarFor/tdocUrl', async () => {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'feedback/src/main.jsx'), 'utf8');
    assert(/setTdocOrigin\(base\)/.test(main), 'feedback/src/main.jsx calls setTdocOrigin(base)');
    const card = fs.readFileSync(path.join(root, 'shell/src/document/comment-card.jsx'), 'utf8');
    assert(/tdocUrl\(author\.profile_url\)/.test(card), 'the profile link goes through tdocUrl');
    const mention = fs.readFileSync(path.join(root, 'shell/src/document/mention-field.jsx'), 'utf8');
    assert(!/src=\{person\.avatar_url\}/.test(mention), 'mention faces go through avatarFor');
    const built = fs.readFileSync(path.join(root, 'server/runtime/feedback.js'), 'utf8');
    assert(built.includes('/avatar/agent/'), 'server/runtime/feedback.js is rebuilt with the avatar route');
  });

  await t('setup text names the CSP: endpoint result, MCP instructions, README', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
    assert(/csp: feedbackSiteCsp\(base\)/.test(src), 'POST /api/feedback/spaces returns csp');
    assert(/allow https:\/\/tdoc\.dev in script-src, connect-src and img-src/.test(src), 'MCP instructions');
    const readme = fs.readFileSync(path.join(__dirname, '..', 'packages', 'feedback', 'README.md'), 'utf8');
    assert(/img-src\s+https:\/\/tdoc\.dev/.test(readme));
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
