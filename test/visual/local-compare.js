// Local Studio visual comparison: two checkouts of tdoc (e.g. a worktree of
// origin/main and this branch), same fixture doc, same viewport, same actions,
// screenshotted side by side so a chrome change can be checked 1:1 against the
// version it replaces. Not part of `npm test` (needs Playwright + two roots).
//
//   node test/visual/local-compare.js <out-dir> <old-root> <new-root>
//
// Writes <scene>-old.png, <scene>-new.png, a composite <scene>.png per scene,
// and results.json (per-side page errors). Scenes cover the reader chrome:
// bar, menus, Publish dialog, comment card/reply/composer, dark mode, phone
// drawer, the owner Share panel (boot payload rewritten in-flight), and /me.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os'); const net = require('net');
const OUT = process.argv[2];
const SIDES = { old: process.argv[3], new: process.argv[4] };
const SLUG = 'sample-doc';
if (!OUT || !SIDES.old || !SIDES.new) { console.error('usage: node test/visual/local-compare.js <out-dir> <old-root> <new-root>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const OWNER = { access: { visibility: 'invited', comments: 'signed_in', history: 'everyone', allowed_users: [] }, versionCount: 2, commentCount: 4 };

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startServer(root) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cmp-'));
  fs.cpSync(path.join(root, 'test/fixtures/tdocs/sample-doc'), path.join(dir, SLUG), { recursive: true });
  const proc = spawn('node', [path.join(root, 'server/server.js')], { env: { ...process.env, TDOC_PORT: String(port), TDOC_HOST: '127.0.0.1', TDOC_DIR: dir, TDOC_E2E_USER: 'alice' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('server start timeout ' + root)), 8000); proc.stdout.on('data', (d) => { if (String(d).includes('tdoc server')) { clearTimeout(t); res(); } }); proc.stderr.on('data', (d) => process.stderr.write(`[${path.basename(root)}] ${d}`)); });
  return { proc, base: `http://127.0.0.1:${port}` };
}
const settle = (page, ms = 350) => page.waitForTimeout(ms);
async function ready(page) {
  await page.waitForSelector('.tdoc-bar', { timeout: 10000 });
  await page.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 10000 }).catch(() => {});
  await settle(page, 600);
}
async function selectInFrame(page) {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) return false;
  await frame.evaluate(() => {
    const p = document.querySelector('p');
    const range = document.createRange(); range.selectNodeContents(p);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await settle(page, 500);
  return true;
}
async function tryClick(page, selector) { const el = await page.$(selector); if (!el) return false; await el.click(); await settle(page); return true; }

const SCENES = [
  { name: '01-doc', run: async (p) => {} },
  { name: '02-more-menu', run: async (p) => { await tryClick(p, '#tdoc-more-btn'); } },
  { name: '03-version-menu', run: async (p) => { await tryClick(p, '#tdoc-version-toggle'); } },
  { name: '04-publish-dialog', run: async (p) => { await tryClick(p, '#tdoc-publish-btn'); } },
  { name: '05-comment-card', run: async (p) => { await tryClick(p, '.tdoc-pin'); } },
  { name: '06-reply-form', run: async (p) => { await tryClick(p, '.tdoc-pin'); await tryClick(p, '.tdoc-reply-toggle, .tdoc-reply'); } },
  { name: '06b-reaction-picker', run: async (p) => { await tryClick(p, '.tdoc-pin'); await tryClick(p, '.tdoc-reactions .tdoc-react-add, .tdoc-react-add'); await settle(p, 400); } },
  { name: '07-composer', run: async (p) => { await selectInFrame(p); } },
  { name: '08-dark', run: async (p) => { await tryClick(p, '#tdoc-theme-btn'); await settle(p, 600); } },
  { name: '09-dark-card', run: async (p) => { await tryClick(p, '#tdoc-theme-btn'); await tryClick(p, '.tdoc-pin'); await settle(p, 400); } },
  { name: '10-mobile-drawer', viewport: { width: 375, height: 812 }, run: async (p) => { await tryClick(p, '.tdoc-fab'); await settle(p, 500); } },
  { name: '10b-mobile-reaction-picker', viewport: { width: 375, height: 812 }, run: async (p) => { await tryClick(p, '.tdoc-fab'); await settle(p, 500); await tryClick(p, '.tdoc-reactions .tdoc-react-add, .tdoc-react-add'); await settle(p, 400); } },
  { name: '11-mobile-more', viewport: { width: 375, height: 812 }, run: async (p) => { await tryClick(p, '#tdoc-more-btn'); } },
  { name: '12-owner-share', owner: true, run: async (p) => { await tryClick(p, '#tdoc-share-btn'); await settle(p, 800); } },
  { name: '13-owner-share-adv', owner: true, run: async (p) => { await tryClick(p, '#tdoc-share-btn'); await settle(p, 500); await tryClick(p, '.tdoc-adv summary, details summary'); } },
  { name: '14-me-hub', url: '/me', run: async (p) => {} },
  { name: '15-signin', run: async (p) => { await tryClick(p, '#tdoc-signin-btn, .tdoc-signin-btn, button:has-text("Sign in")'); await settle(p, 500); } },
];

(async () => {
  const servers = { old: await startServer(SIDES.old), new: await startServer(SIDES.new) };
  const browser = await chromium.launch();
  const results = [];
  for (const scene of SCENES) {
    const row = { name: scene.name };
    for (const side of ['old', 'new']) {
      const ctx = await browser.newContext({ viewport: scene.viewport || { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
      if (scene.owner) {
        await page.route(`${servers[side].base}/d/${SLUG}/v/2`, async (route) => {
          const res = await route.fetch(); let html = await res.text();
          html = html.replace('"mode":"local"', `"mode":"remote","isOwner":true,"ownerManage":${JSON.stringify(OWNER)}`);
          await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-length': String(Buffer.byteLength(html)) } });
        });
      }
      try {
        await page.goto(servers[side].base + (scene.url || `/d/${SLUG}/v/2`), { waitUntil: 'networkidle' });
        if (!scene.url) await ready(page); else await settle(page, 800);
        await scene.run(page);
        await page.screenshot({ path: path.join(OUT, `${scene.name}-${side}.png`) });
        row[side] = errors.length ? `errors: ${errors.join(' | ')}` : 'ok';
      } catch (e) { row[side] = 'FAILED: ' + String(e).split('\n')[0]; }
      await ctx.close();
    }
    results.push(row); console.log(JSON.stringify(row));
  }
  // composite side-by-side images for quick review
  const page = await browser.newPage();
  for (const scene of SCENES) {
    const w = (scene.viewport || { width: 1280 }).width, h = (scene.viewport || { height: 800 }).height;
    const img = (side) => { const f = path.join(OUT, `${scene.name}-${side}.png`); return fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString('base64')}` : ''; };
    await page.setViewportSize({ width: w * 2 + 30, height: h + 40 });
    await page.setContent(`<body style="margin:0;background:#888;font:600 14px system-ui"><div style="display:flex;gap:10px;padding:10px"><div><div style="color:#fff">OLD (main) — ${scene.name}</div><img src="${img('old')}" width="${w}"></div><div><div style="color:#fff">NEW (react-vite-shell)</div><img src="${img('new')}" width="${w}"></div></div></body>`);
    await page.screenshot({ path: path.join(OUT, `${scene.name}.png`) });
  }
  await browser.close(); servers.old.proc.kill(); servers.new.proc.kill();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
