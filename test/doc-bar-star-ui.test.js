#!/usr/bin/env node
// The star after the title in the doc bar (Julie, 2026-11-16: "need a star
// here for saved?"). Google Docs style: outline = not starred, filled =
// starred, click toggles; tooltip "Star" / "Starred", aria-pressed. It is the
// My docs star: POST /api/star, so a doc starred in its bar is in My docs ›
// Starred, and one starred from My docs boots filled. Optimistic, put back
// when the server refuses. Signed-in viewers only; a logged-out reader sees
// no star. Every doc surface that shares the bar (doc, sheet, slides),
// desktop and phone (in the title row, right after the title).
// Real worker routes in process, real shell runtime, Chromium.
// TDOC_UI_SHOTS=<dir> writes screenshots.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, devices } = requirePlaywrightOrSkip('doc-bar-star-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const ONLY_SHOTS = process.env.TDOC_STAR_SHOTS_ONLY === '1';

const DOC = (t) => `<!doctype html><html><body><h1>${t}</h1><p>Phase one ships the runner; phase two the scorer.</p></body></html>`;
const SHEET = (t) => `<!doctype html><html><head><title>${t}</title></head><body><div class="tdoc-table-scroll"><table data-tdoc-sheet data-name="Tasks"><thead><tr><th>Task</th><th>Owner</th></tr></thead><tbody><tr><td>Runner</td><td>Julie</td></tr><tr><td>Scorer</td><td>Bob</td></tr></tbody></table></div></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    let body = ''; req.on('data', (d) => { body += d; }); await new Promise((r) => req.on('end', r));
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let out = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) out = Buffer.from(out.toString('utf8').replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path).replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    response.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'content-security-policy'].includes(k)) res.setHeader(k, v); });
    res.statusCode = response.status; res.end(out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('Doc bar star (real shell)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const julie = await issue(worker, env, 'julie');
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const { blankDeckHtml } = await import(path.join(__dirname, '..', 'shared', 'slides-markup.mjs'));
  const up = (slug, title, html) => api('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html, meta: { title, access: { visibility: 'public' } } } });
  await up('raftbench-task-list', 'RaftBench task list', DOC('RaftBench task list'));
  await up('raftbench-sheet', 'RaftBench sheet', SHEET('RaftBench sheet'));
  await up('raftbench-deck', 'RaftBench deck', blankDeckHtml('RaftBench deck'));
  const starredSlugs = async () => {
    const html = await (await worker.fetch(new Request('https://tdoc.dev/me', { headers: { cookie: julie.cookie } }), env, {})).text();
    const marker = 'window.__TDOC_APP_BOOT__ = ';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('/me has no boot payload');
    const boot = JSON.parse(html.slice(start + marker.length, html.indexOf(';</script>', start)));
    return (boot?.starred || []).map((d) => d.slug);
  };

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const open = async (who, slug, phone = false) => {
    const context = await browser.newContext(phone ? { ...devices['iPhone 13'], defaultBrowserType: undefined } : { viewport: { width: 1512, height: 823 } });
    if (who) await context.addCookies([{ name: 'tdoc_sid', value: who.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(`${base}/d/${slug}`);
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 15000 });
    await page.waitForTimeout(300);
    return { context, page };
  };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name) });
  };

  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  };

  try {
    if (ONLY_SHOTS) {
      // Screenshot mode, for a before/after pair from any build.
      for (const [phone, tag] of [[false, 'desktop'], [true, 'phone']]) {
        const { context, page } = await open(julie, 'raftbench-task-list', phone);
        await shot(page, `${tag}.png`);
        const star = page.locator('#tdoc-star-btn');
        if (await star.count()) { await star.click(); await page.waitForTimeout(400); await shot(page, `${tag}-starred.png`); await star.click(); }
        await context.close();
      }
      return;
    }

    const star = (page) => page.locator('.tdoc-bar-left #tdoc-star-btn');
    const clickAndSave = async (page, s) => {
      const saved = page.waitForResponse((r) => r.url().endsWith('/api/star') && r.request().method() === 'POST');
      await s.click();
      await saved;
    };

    await t('desktop: an outline star right after the title; click fills it and My docs › Starred has the doc', async () => {
      const { context, page } = await open(julie, 'raftbench-task-list');
      const s = star(page);
      await s.waitFor();
      if (await s.getAttribute('aria-pressed') !== 'false') throw new Error('star does not start unpressed');
      if (await s.getAttribute('title') !== 'Star' || await s.getAttribute('aria-label') !== 'Star') throw new Error('unstarred tooltip/name is not "Star"');
      if (await s.locator('svg').getAttribute('fill') !== 'none') throw new Error('unstarred star is not an outline');
      const geo = await page.evaluate(() => {
        const title = document.querySelector('.tdoc-bar-left .doc-title').getBoundingClientRect();
        const btn = document.getElementById('tdoc-star-btn').getBoundingClientRect();
        return { gap: btn.left - title.right, titleMid: title.top + title.height / 2, btnMid: btn.top + btn.height / 2, w: btn.width, h: btn.height };
      });
      if (geo.gap < 0 || geo.gap > 16) throw new Error(`star is not right after the title: ${JSON.stringify(geo)}`);
      if (Math.abs(geo.titleMid - geo.btnMid) > 2) throw new Error(`star is off the title's line: ${JSON.stringify(geo)}`);
      if (geo.w !== 32 || geo.h !== 32) throw new Error(`desktop star is not the 32px icon button: ${JSON.stringify(geo)}`);
      await shot(page, 'desktop-unstarred.png');
      const posted = page.waitForResponse((r) => r.url().endsWith('/api/star') && r.request().method() === 'POST');
      await s.click();
      if (await s.getAttribute('aria-pressed') !== 'true') throw new Error('star did not fill on click');
      const res = await posted;
      if (JSON.parse(res.request().postData()).starred !== true) throw new Error('star posted the wrong state');
      if (await s.getAttribute('title') !== 'Starred') throw new Error('starred tooltip is not "Starred"');
      if (await s.locator('svg').getAttribute('fill') !== 'currentColor') throw new Error('starred star is not filled');
      await page.waitForTimeout(250); // the bar's colour transition
      { const c = await s.evaluate((el) => getComputedStyle(el).color); if (c !== 'rgb(245, 166, 35)') throw new Error(`starred star is not My docs' star colour: ${c}`); }
      if (!(await starredSlugs()).includes('raftbench-task-list')) throw new Error('My docs › Starred does not have the doc');
      await shot(page, 'desktop-starred.png');
      // Unstar from the bar takes it back out of My docs.
      await clickAndSave(page, s);
      if (await s.getAttribute('aria-pressed') !== 'false') throw new Error('star did not clear on click');
      if ((await starredSlugs()).includes('raftbench-task-list')) throw new Error('unstar did not leave My docs › Starred');
      if (await page.locator('[data-action="star"]').count()) throw new Error('a second star is in ⋯');
      await context.close();
    });

    await t('a star set in My docs boots filled in the bar', async () => {
      await api('/api/star', { method: 'POST', cookie: julie.cookie, body: { slug: 'raftbench-task-list', starred: true } });
      const { context, page } = await open(julie, 'raftbench-task-list');
      if (await star(page).getAttribute('aria-pressed') !== 'true') throw new Error('a My docs star did not show in the bar');
      await context.close();
      await api('/api/star', { method: 'POST', cookie: julie.cookie, body: { slug: 'raftbench-task-list', starred: false } });
    });

    await t('a refused star is put back and the failure shown', async () => {
      const { context, page } = await open(julie, 'raftbench-task-list');
      let release;
      const held = new Promise((r) => { release = r; });
      await page.route('**/api/star', async (route) => { await held; await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }); });
      await star(page).click();
      if (await star(page).getAttribute('aria-pressed') !== 'true') throw new Error('star is not optimistic');
      release();
      await page.waitForFunction(() => document.getElementById('tdoc-star-btn').getAttribute('aria-pressed') === 'false');
      await page.locator('.tdoc-toast, [role="status"]').filter({ hasText: /./ }).first().waitFor();
      if ((await starredSlugs()).includes('raftbench-task-list')) throw new Error('a refused star was stored');
      await context.close();
    });

    await t('logged-out reader: no star', async () => {
      const { context, page } = await open(null, 'raftbench-task-list');
      await page.locator('.tdoc-bar-left .doc-title').waitFor();
      if (await page.locator('#tdoc-star-btn').count()) throw new Error('a logged-out reader got a star');
      await context.close();
    });

    await t('sheet and slides share the bar: the star is there and stars the doc', async () => {
      for (const slug of ['raftbench-sheet', 'raftbench-deck']) {
        const { context, page } = await open(julie, slug);
        const s = star(page);
        await s.waitFor();
        await clickAndSave(page, s);
        if (!(await starredSlugs()).includes(slug)) throw new Error(`${slug}: not in My docs › Starred`);
        await shot(page, `desktop-${slug}.png`);
        await clickAndSave(page, s);
        await context.close();
      }
    });

    await t('phone: the star sits in the title row, right after the title, a 44px target; the actions still fit', async () => {
      for (const slug of ['raftbench-task-list', 'raftbench-sheet', 'raftbench-deck']) {
        const { context, page } = await open(julie, slug, true);
        const s = star(page);
        await s.waitFor();
        if (!(await s.isVisible())) throw new Error(`${slug}: star hidden on a phone`);
        const geo = await page.evaluate(() => {
          const title = document.querySelector('.tdoc-bar-left .doc-title').getBoundingClientRect();
          const btn = document.getElementById('tdoc-star-btn').getBoundingClientRect();
          const more = document.getElementById('tdoc-more-btn').getBoundingClientRect();
          return { gap: btn.left - title.right, titleMid: title.top + title.height / 2, btnMid: btn.top + btn.height / 2, w: btn.width, h: btn.height, moreRight: more.right, inner: window.innerWidth, scroll: document.documentElement.scrollWidth };
        });
        if (geo.gap < -1 || geo.gap > 8) throw new Error(`${slug}: star is not right after the title on a phone: ${JSON.stringify(geo)}`);
        if (Math.abs(geo.titleMid - geo.btnMid) > 2) throw new Error(`${slug}: star is off the title row: ${JSON.stringify(geo)}`);
        if (geo.w !== 44 || geo.h !== 44) throw new Error(`${slug}: phone star is not 44px: ${JSON.stringify(geo)}`);
        if (geo.moreRight > geo.inner || geo.scroll > geo.inner + 1) throw new Error(`${slug}: phone bar overflows: ${JSON.stringify(geo)}`);
        if (slug === 'raftbench-task-list') {
          await shot(page, 'phone-unstarred.png');
          await clickAndSave(page, s);
          if (await s.getAttribute('aria-pressed') !== 'true') throw new Error('phone star did not fill');
          await shot(page, 'phone-starred.png');
          await clickAndSave(page, s);
        }
        await context.close();
      }
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
