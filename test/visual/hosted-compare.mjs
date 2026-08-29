// Hosted (Worker) visual comparison. Runs two bundled workers in-process behind
// a tiny HTTP bridge with fake KV/R2/DO (same fakes as the hosted test suites),
// seeded with the fixture doc, an owner session (alice), a reader session
// (bob), and the fixture comments — so owner-only chrome (Share panel, delete,
// notifications) and anonymous chrome (sign-in) can be screenshotted side by
// side without Cloudflare or GitHub. Not part of `npm test`.
//
//   node bin/tdoc-bundle with SKILL_DIR=<root> OUT_DIR=<dir> for each side, then
//   node test/visual/hosted-compare.mjs <out-dir> <old-bundle.js> <new-bundle.js> [fixture-dir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.argv[2]; const BUNDLES = { old: process.argv[3], new: process.argv[4] };
const FIXTURE = process.argv[5] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures/tdocs/sample-doc');
if (!OUT || !BUNDLES.old || !BUNDLES.new) { console.error('usage: node test/visual/hosted-compare.mjs <out-dir> <old-bundle> <new-bundle> [fixture-dir]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

class FakeKV { constructor() { this.map = new Map(); } async get(k) { return this.map.has(k) ? this.map.get(k) : null; } async put(k, v) { this.map.set(k, String(v)); } async delete(k) { this.map.delete(k); } async list({ prefix = '' } = {}) { return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } }
class FakeR2 { constructor() { this.map = new Map(); } async put(k, v) { this.map.set(k, String(v)); } async get(k) { return this.map.has(k) ? { text: async () => this.map.get(k) } : null; } async head(k) { return this.map.has(k) ? { size: Buffer.byteLength(this.map.get(k)) } : null; } async delete(k) { this.map.delete(k); } async list({ prefix = '' } = {}) { return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; } }
class FakeStorage { constructor() { this.map = new Map(); } async transaction(fn) { return fn({ get: async (k) => this.map.get(k), put: async (k, v) => { this.map.set(k, v); }, delete: async (k) => { this.map.delete(k); } }); } }
class FakeDO { constructor(env, Store) { this.env = env; this.Store = Store; this.states = new Map(); } idFromName(n) { return n; } get(id) { if (!this.states.has(id)) this.states.set(id, { storage: new FakeStorage() }); const st = this.states.get(id); return { fetch: async (url, init = {}) => new this.Store(st, this.env).fetch(new Request(url, init)) }; } }

const sid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function boot(side) {
  const mod = await import(`file://${BUNDLES[side]}`);
  const env = { META: new FakeKV(), DOCS: new FakeR2(), TDOC_HOSTED_REGISTRATION: '1', GITHUB_CLIENT_ID: 'Iv1.fake', TDOC_UPLOAD_TOKEN: 'tok' };
  env.COMMENTS = new FakeDO(env, mod.CommentsStore);
  const sessions = {};
  for (const login of ['alice', 'bob']) { const id = sid(); await env.META.put(`session:${id}`, JSON.stringify({ login, name: login, avatar_url: '', created: new Date().toISOString() })); sessions[login] = id; }
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'meta.json'), 'utf8'));
  meta.hosted = { account_id: 'acct-alice', github_login: 'alice' };
  await env.META.put('meta:sample-doc', JSON.stringify(meta));
  // The homepage is a tdoc of its own (LANDING_SLUG = tornado-doc, served at
  // `/`). Seed the newest version out of the checkout so site chrome — the
  // mark, the bar, the theme — can be compared where it actually ships,
  // instead of against the neutral fallback page.
  // `node bin/tdoc-landing-release` first if you want the production shape —
  // one v1 instead of the working copy's version picker. Falls back to the
  // newest working version so the harness runs without that step.
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const release = path.join(repo, '.release/tornado-doc');
  const working = path.join(repo, 'landing/tornado-doc');
  let landing = null;
  if (fs.existsSync(path.join(release, 'v1/index.html'))) {
    landing = { n: 1, html: path.join(release, 'v1/index.html') };
  } else if (fs.existsSync(working)) {
    const n = Math.max(0, ...fs.readdirSync(working).map((d) => Number((d.match(/^v(\d+)$/) || [])[1]) || 0));
    if (n) landing = { n, html: path.join(working, `v${n}`, 'index.html') };
  }
  if (landing) {
    await env.META.put('meta:tornado-doc', JSON.stringify({ title: 'tornado-doc', slug: 'tornado-doc', versions: [{ n: landing.n }] }));
    await env.DOCS.put(`docs/tornado-doc/v${landing.n}/index.html`, fs.readFileSync(landing.html, 'utf8'));
  }
  for (const v of [1, 2]) await env.DOCS.put(`docs/sample-doc/v${v}/index.html`, fs.readFileSync(path.join(FIXTURE, `v${v}/index.html`), 'utf8'));
  const call = (pathname, init = {}, cookie) => mod.default.fetch(new Request(`https://tdoc.dev${pathname}`, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { Cookie: `tdoc_sid=${cookie}` } : {}) } }), env, { waitUntil() {}, passThroughOnException() {} });
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'comments.json'), 'utf8'));
  for (const c of fixture) {
    const r = await call('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'sample-doc', version: c.version, text: c.text, anchor: c.anchor }) }, sessions.bob);
    const created = await r.json().catch(() => ({}));
    if (created.id) {
      for (const rep of c.replies || []) await call('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'sample-doc', version: c.version, text: rep.text, parent_id: created.id }) }, sessions.alice);
      await call('/api/reactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'sample-doc', version: c.version, comment_id: created.id, emoji: '👍' }) }, sessions.alice);
    } else console.error(side, 'seed comment failed', r.status, created);
  }
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'connection') headers.set(k, v);
    headers.set('host', 'tdoc.dev');
    let out;
    try { out = await mod.default.fetch(new Request(`https://tdoc.dev${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' }), env, { waitUntil() {}, passThroughOnException() {} }); }
    catch (e) { res.writeHead(500); res.end(String(e)); return; }
    const h = {}; out.headers.forEach((v, k) => { if (k !== 'content-encoding') h[k] = v; });
    if (h.location) h.location = h.location.replace('https://tdoc.dev', '');
    res.writeHead(out.status, h); res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, sessions };
}

const settle = (p, ms = 400) => p.waitForTimeout(ms);
async function ready(page) { await page.waitForSelector('.tdoc-bar', { timeout: 10000 }); await page.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 10000 }).catch(() => {}); await settle(page, 600); }
async function click(p, sel) { const el = await p.$(sel); if (!el) return false; await el.click(); await settle(p); return true; }
const SCENES = [
  { name: 'h01-anon-doc', as: null },
  { name: 'h02-anon-signin', as: null, run: async (p) => { await click(p, '.tdoc-chip.signin, #tdoc-signin-btn, button:has-text("Sign in")'); await settle(p, 800); } },
  { name: 'h03-owner-doc', as: 'alice' },
  { name: 'h04-owner-share', as: 'alice', run: async (p) => { await click(p, '#tdoc-share-btn'); await settle(p, 800); } },
  { name: 'h05-owner-share-adv', as: 'alice', run: async (p) => { await click(p, '#tdoc-share-btn'); await settle(p, 600); await click(p, '.tdoc-adv summary, details summary'); } },
  { name: 'h06-owner-more', as: 'alice', run: async (p) => { await click(p, '#tdoc-more-btn'); } },
  { name: 'h07-account-menu', as: 'alice', run: async (p) => { await click(p, '.tdoc-chip'); } },
  { name: 'h08-notifications', as: 'alice', run: async (p) => { await click(p, '.tdoc-chip'); await click(p, 'text=Notifications'); await settle(p, 600); } },
  { name: 'h09-reader-card', as: 'bob', run: async (p) => { await click(p, '.tdoc-pin'); } },
  { name: 'h10-owner-dark-share', as: 'alice', run: async (p) => { await click(p, '#tdoc-theme-btn'); await click(p, '#tdoc-share-btn'); await settle(p, 800); } },
  { name: 'h11-me', as: 'alice', url: '/me' },
  // The homepage, full page, signed out and signed in — the surface most
  // chrome changes are actually judged on.
  { name: 'h11b-landing', as: null, url: '/', full: true },
  { name: 'h11c-landing-owner', as: 'alice', url: '/', full: true },
  { name: 'h12-anon-mobile', as: null, viewport: { width: 375, height: 812 }, run: async (p) => { await click(p, '.tdoc-fab'); await settle(p, 500); } },
];
const servers = { old: await boot('old'), new: await boot('new') };
const browser = await chromium.launch();
for (const scene of SCENES) {
  const row = { name: scene.name };
  for (const side of ['old', 'new']) {
    const ctx = await browser.newContext({ viewport: scene.viewport || { width: 1280, height: 800 } });
    if (scene.as) await ctx.addCookies([{ name: 'tdoc_sid', value: servers[side].sessions[scene.as], url: servers[side].base }]);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
    try {
      const r = await page.goto(servers[side].base + (scene.url || '/d/sample-doc/v/2'), { waitUntil: 'networkidle' });
      if (!scene.url) await ready(page); else await settle(page, 800);
      if (scene.run) await scene.run(page);
      await page.screenshot({ path: path.join(OUT, `${scene.name}-${side}.png`), fullPage: Boolean(scene.full) });
      row[side] = (r.status() !== 200 ? `HTTP ${r.status()} ` : '') + (errors.length ? 'errors: ' + errors.join(' | ') : 'ok');
    } catch (e) { row[side] = 'FAILED: ' + String(e).split('\n')[0]; try { await page.screenshot({ path: path.join(OUT, `${scene.name}-${side}.png`) }); } catch {} }
    await ctx.close();
  }
  console.log(JSON.stringify(row));
}
const page = await browser.newPage();
for (const scene of SCENES) {
  const w = (scene.viewport || { width: 1280 }).width, h = (scene.viewport || { height: 800 }).height;
  const img = (side) => { const f = path.join(OUT, `${scene.name}-${side}.png`); return fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString('base64')}` : ''; };
  await page.setViewportSize({ width: w * 2 + 30, height: h + 40 });
  await page.setContent(`<body style="margin:0;background:#888;font:600 14px system-ui"><div style="display:flex;gap:10px;padding:10px"><div><div style="color:#fff">OLD (main) — ${scene.name}</div><img src="${img('old')}" width="${w}"></div><div><div style="color:#fff">NEW (react-vite-shell)</div><img src="${img('new')}" width="${w}"></div></div></body>`);
  await page.screenshot({ path: path.join(OUT, `${scene.name}.png`) });
}
await browser.close(); servers.old.server.close(); servers.new.server.close();
