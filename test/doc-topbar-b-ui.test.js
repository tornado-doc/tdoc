// Doc bar layout B (flag docTopbarB), in the real shell against the real
// worker (design: tdoc.dev/d/doc-topbar-redesign):
//   - desktop: the title opens the document's menu with every document
//     action (Rename, Mode, Version history "just now", Download & copy and
//     its formats, Duplicate, Convert to Sheet, Move, Delete); the star and
//     "Edited …" follow the title; the right side is exactly Ask AI ·
//     Comments · Share · avatar (no ⋯, no space chip, no filter chevron); the
//     space switcher is in the account menu; Rename from the menu renames.
//   - a reader: See what changed (and its "just now") in the menu, no
//     owner rows; the same four on the right.
//   - phone (390): the same title menu; the bar's right is Share · avatar
//     (comments and Ask AI are the one entry at the bottom), no ⋯.
//   - slides and sheets: the same title menu and the same four.
//   - modeless editing: the Markdown switch is a row of the title menu.
//   - flag off: the current bar, unchanged (⋯, space chip, filter chevron,
//     the title renames in place, no document menu).
// Screenshots with TDOC_UI_SHOTS=<dir>.
// Run with: node test/doc-topbar-b-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('doc-topbar-b-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const DOC = (t) => `<!doctype html><html><head><title>${t}</title></head><body><h1>${t}</h1><p>Billing ships first, on March 14, because invoices block two renewals. Search follows in April.</p><p>The mobile app waits for Q4.</p><p>Phase one ships the runner; phase two the scorer.</p></body></html>`;
const WITH_SHEET = `<!doctype html><html><head><title>Tasks</title></head><body><h1>Tasks</h1><p>Every open task, one row each.</p>
<table data-tdoc-sheet data-name="Tasks"><thead><tr><th data-key="c1" data-type="text">Task</th><th data-key="c2" data-type="text">Owner</th></tr></thead>
<tbody><tr data-row="r1"><td>Port the harness</td><td>julie</td></tr><tr data-row="r2"><td>Seed fixtures</td><td>bob</td></tr></tbody></table></body></html>`;

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
  return { server, base: `http://127.0.0.1:${port(server)}` };
}
const port = (server) => server.address().port;

(async () => {
  console.log('doc bar layout B');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1' });
  const julie = await issue(worker, env, 'julie');
  const reader = await issue(worker, env, 'reader');
  await env.META.delete(`account-terminal:${reader.account_id}`);
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const publish = async (slug, version, html, title) => {
    const r = await api('/api/upload', { method: 'POST', token: julie.token, body: { slug, version, html, meta: { title, access: { visibility: 'public' } } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const team = (await api('/api/teams', { method: 'POST', cookie: julie.cookie, body: { name: 'Tdoc' } })).body.team;
  const slug = 'launch-plan';
  await publish(slug, 1, DOC('Launch plan'), 'Launch plan');
  await publish(slug, 2, DOC('Launch plan'), 'Launch plan');
  await api('/api/team/move', { method: 'POST', cookie: julie.cookie, body: { slugs: [slug], team: team.id } });
  const comment = (who, text, anchor) => api('/api/comments', { method: 'POST', cookie: who.cookie, body: { slug, version: 2, text, anchor: { kind: 'text', text: anchor } } });
  await comment(julie, 'Tighten this sentence.', 'Search follows in April');
  await comment(reader, 'Q4?', 'The mobile app waits');
  await publish('tasks', 1, WITH_SHEET, 'Tasks');
  const { blankDeckHtml } = await import('../shared/slides-markup.mjs');
  await publish('deck', 1, blankDeckHtml(), 'Deck');
  const { sheetDocumentHtml } = await import('../shared/sheet-markup.mjs');
  await publish('budget', 1, sheetDocumentHtml({ title: 'Budget', sheets: [{ name: 'Spend', columns: [{ name: 'Item', type: 'text' }], rows: [{ id: 'r1', cells: ['Rent'] }] }] }), 'Budget');

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/${name}` }); } };
  const open = async ({ who = julie, phone = false, flags = { docTopbarB: true }, path = `/d/${slug}` } = {}) => {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((pinned) => { window.__TDOC_FLAGS__ = pinned; }, flags);
    if (who) await ctx.addCookies([{ name: 'tdoc_sid', value: who.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (error) => errors.push(error.message));
    p.errors = errors;
    await p.goto(`${base}${path}`);
    await p.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 15000 });
    await p.waitForTimeout(500);
    return { ctx, p };
  };
  // What the bar's right side shows, one entry per visible control.
  const rightControls = (p) => p.evaluate(() => {
    const shown = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    return [...document.querySelectorAll('.tdoc-bar .tdoc-bar-right button, .tdoc-bar .tdoc-bar-right a, .tdoc-bar .tdoc-bar-right .tdoc-edited, .tdoc-bar .tdoc-bar-right .tdoc-switch')]
      .filter(shown).map((el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim());
  });
  const menuRows = async (p) => { await p.locator('[role=menu]').first().waitFor(); await p.waitForTimeout(200); return readRows(p); };
  const readRows = (p) => p.evaluate(() => [...document.querySelectorAll('[role=menu] [role^=menuitem], [role=menu] .tdoc-menu-label, [role=menu] .tdoc-menu-note')]
    .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0)
    .map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
  const openTitleMenu = async (p) => {
    await p.locator('#tdoc-title-menu-btn').click();
    return menuRows(p);
  };
  const closeMenu = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(200); };
  const assertFourOnTheRight = (controls) => {
    assert.equal(controls.length, 4, JSON.stringify(controls));
    assert.match(controls[0], /^Ask AI/);
    assert.match(controls[1], /^Comments/);
    assert.equal(controls[2], 'Share');
    assert.match(controls[3], /^Account: /);
  };

  try {
    await t('desktop owner: the title opens the document menu with every action; the right side is exactly Ask AI · Comments · Share · avatar', async () => {
      const { ctx, p } = await open();
      assert.equal(await p.locator('.tdoc-bar[data-bar-layout="b"]').count(), 1);
      assertFourOnTheRight(await rightControls(p));
      assert.equal(await p.locator('#tdoc-more-btn').count(), 0, 'no ⋯');
      assert.equal(await p.locator('.tdoc-bar .tdoc-comments-filter-menu').count(), 0, 'no filter chevron');
      assert.equal(await p.locator('.tdoc-bar .tdoc-workspace-switcher, .tdoc-bar .tdoc-space-chip').count(), 0, 'no space chip');
      // The left: title ▾, star, "Edited …" (opens the history).
      assert.equal(await p.locator('.tdoc-bar-left #tdoc-star-btn').count(), 1);
      assert.match(await p.locator('.tdoc-bar-left #tdoc-version-toggle').getAttribute('aria-label'), /Version history/);
      assert.match(await p.locator('.tdoc-bar .tdoc-comments-toggle').innerText(), /2/);
      await shot(p, 'desktop-owner.png');
      const rows = await openTitleMenu(p);
      for (const row of ['Rename', 'Mode', 'Read', 'Comment', 'Edit', 'Version history just now', 'Download & copy', 'Duplicate', 'Move document…', 'Delete doc…']) {
        assert.ok(rows.includes(row), `${row} in ${JSON.stringify(rows)}`);
      }
      await shot(p, 'desktop-owner-title-menu.png');
      // Download & copy keeps its formats.
      await p.locator('[role=menu] .tdoc-export-submenu-trigger').hover();
      await p.locator('[data-action="download-md"]').waitFor();
      for (const action of ['download-pdf', 'download-docx', 'download-md', 'download', 'copy']) {
        assert.equal(await p.locator(`[role=menu] [data-action="${action}"]`).count(), 1, action);
      }
      await closeMenu(p); await closeMenu(p);
      // The filter is inside the comment list: Open / Replied / Resolved / All.
      await p.locator('.tdoc-bar .tdoc-comments-toggle').click();
      await p.locator('.tdoc-cpanel .tdoc-cpanel-filterrow').waitFor();
      assert.match(await p.locator('.tdoc-cpanel .tdoc-cpanel-filterrow').innerText(), /Open[\s\S]*Resolved[\s\S]*All/);
      await shot(p, 'desktop-owner-comments.png');
      await p.locator('.tdoc-bar .tdoc-comments-toggle').click();
      // Version history from the menu opens the panel.
      await openTitleMenu(p);
      await p.locator('[role=menu] [data-action="history"]').click();
      await p.locator('.tdoc-history-panel').waitFor();
      await ctx.close();
    });

    await t('desktop owner: Rename from the title menu renames; the account menu has Switch space', async () => {
      const { ctx, p } = await open();
      await openTitleMenu(p);
      await p.locator('[role=menu] [data-action="rename"]').click();
      const input = p.locator('.tdoc-bar .doc-title-input');
      await input.waitFor();
      await input.fill('Launch plan v2');
      await input.press('Enter');
      await p.locator('#tdoc-title-menu-btn', { hasText: 'Launch plan v2' }).waitFor();
      await p.locator('.tdoc-bar .tdoc-account-trigger').click();
      const rows = await menuRows(p);
      assert.ok(rows.some((row) => /^Switch space\s*Tdoc/.test(row)), JSON.stringify(rows));
      for (const row of ['My docs', 'Settings', 'Agents', 'Sign out']) assert.ok(rows.includes(row), row);
      await shot(p, 'desktop-owner-account.png');
      await closeMenu(p);
      // Renamed back for the tests that follow.
      await openTitleMenu(p);
      await p.locator('[role=menu] [data-action="rename"]').click();
      await input.waitFor();
      await input.fill('Launch plan');
      await input.press('Enter');
      await p.locator('#tdoc-title-menu-btn', { hasText: /^Launch plan$/ }).waitFor();
      assert.deepEqual(p.errors, []);
      await ctx.close();
    });

    await t('desktop owner: a doc holding a sheet has Convert to Sheet in the title menu', async () => {
      const { ctx, p } = await open({ path: '/d/tasks' });
      const rows = await openTitleMenu(p);
      assert.ok(rows.includes('Convert to Sheet'), JSON.stringify(rows));
      await ctx.close();
    });

    await t('desktop reader: See what changed in the title menu, no owner rows; the same four on the right', async () => {
      const { ctx, p } = await open({ who: reader });
      assertFourOnTheRight(await rightControls(p));
      await shot(p, 'desktop-reader.png');
      const rows = await openTitleMenu(p);
      assert.ok(rows.includes('See what changed just now'), JSON.stringify(rows));
      for (const row of ['Rename', 'Move document…', 'Delete doc…']) assert.ok(!rows.includes(row), row);
      assert.ok(rows.includes('Download & copy'));
      await shot(p, 'desktop-reader-title-menu.png');
      await p.locator('[role=menu] [data-action="what-changed"]').click();
      await p.getByRole('main', { name: 'Version changes' }).waitFor();
      await ctx.close();
    });

    await t('phone owner and reader: the same title menu; Share · avatar on the right, no ⋯; comments + Ask AI at the bottom', async () => {
      for (const [who, name] of [[julie, 'owner'], [reader, 'reader']]) {
        const { ctx, p } = await open({ who, phone: true });
        const controls = await rightControls(p);
        assert.equal(controls.length, 2, JSON.stringify(controls));
        assert.equal(controls[0], 'Share');
        assert.match(controls[1], /^Account: /);
        assert.equal(await p.locator('#tdoc-more-btn').count(), 0, 'no ⋯');
        assert.ok(await p.locator('.tdoc-fab').isVisible(), 'the one comment + Ask AI entry');
        const bar = await p.locator('.tdoc-bar').boundingBox();
        const avatar = await p.locator('.tdoc-bar .tdoc-account-trigger').boundingBox();
        assert.ok(avatar.x + avatar.width <= bar.width + 1, 'the avatar fits');
        await shot(p, `phone-${name}.png`);
        const rows = await openTitleMenu(p);
        assert.ok(rows.includes(name === 'owner' ? 'Version history just now' : 'See what changed just now'), JSON.stringify(rows));
        assert.ok(rows.includes('Download & copy'));
        if (name === 'owner') for (const row of ['Rename', 'Move document…', 'Delete doc…']) assert.ok(rows.includes(row), row);
        assert.ok(!rows.includes('Share'), 'Share stays in the bar');
        await shot(p, `phone-${name}-title-menu.png`);
        await closeMenu(p);
        await p.locator('.tdoc-bar .tdoc-account-trigger').click();
        const account = await menuRows(p);
        assert.ok(account.some((row) => /^Switch space/.test(row)), JSON.stringify(account));
        assert.ok(account.includes('Sign out'));
        await ctx.close();
      }
    });

    await t('signed out: the title menu holds Dark mode; Sign in on the right at both widths', async () => {
      for (const phone of [false, true]) {
        const { ctx, p } = await open({ who: null, phone });
        assert.equal(await p.locator('#tdoc-more-btn').count(), 0);
        assert.ok(await p.locator('.tdoc-bar .tdoc-account-trigger.signin').isVisible(), 'Sign in');
        const rows = await openTitleMenu(p);
        if (await p.evaluate(() => document.querySelector('[data-action="theme"]') !== null)) assert.ok(rows.some((row) => /mode$/.test(row)));
        assert.ok(rows.includes('Download & copy'));
        await ctx.close();
      }
    });

    await t('slides and sheets: the same title menu and the same four on the right', async () => {
      for (const path of ['/d/deck', '/d/budget']) {
        const { ctx, p } = await open({ path });
        assert.equal(await p.locator('#tdoc-more-btn').count(), 0, path);
        assertFourOnTheRight(await rightControls(p));
        const rows = await openTitleMenu(p);
        for (const row of ['Rename', 'Download & copy', 'Delete doc…']) assert.ok(rows.includes(row), `${path}: ${row} in ${JSON.stringify(rows)}`);
        await shot(p, `desktop-owner-${path.split('/').pop()}-title-menu.png`);
        await ctx.close();
      }
    });

    await t('modeless editing: the Markdown switch is a row of the title menu, not a fifth control', async () => {
      const { ctx, p } = await open({ flags: { docTopbarB: true, modelessEdit: true, markdownEditMode: true } });
      assertFourOnTheRight(await rightControls(p));
      assert.equal(await p.locator('.tdoc-bar #tdoc-md-switch').count(), 0);
      await openTitleMenu(p);
      const row = p.locator('[role=menu] [data-action="markdown"]');
      await row.waitFor();
      assert.equal(await row.getAttribute('aria-checked'), 'false');
      await row.click();
      await p.locator('.tdoc-md-source, textarea').first().waitFor({ timeout: 10000 });
      await openTitleMenu(p);
      assert.equal(await p.locator('[role=menu] [data-action="markdown"]').getAttribute('aria-checked'), 'true');
      await p.locator('[role=menu] [data-action="markdown"]').click();
      await ctx.close();
    });

    await t('flag off: the current bar, unchanged', async () => {
      for (const phone of [false, true]) {
        const { ctx, p } = await open({ flags: { docTopbarB: false }, phone });
        assert.equal(await p.locator('.tdoc-bar[data-bar-layout]').count(), 0);
        assert.equal(await p.locator('#tdoc-title-menu-btn').count(), 0, 'no document menu on the title');
        assert.equal(await p.locator('.tdoc-bar button.doc-title-edit').count(), 1, 'the title renames in place');
        assert.ok(await p.locator('#tdoc-more-btn').isVisible(), '⋯');
        if (!phone) {
          assert.ok(await p.locator('.tdoc-bar-right #tdoc-version-toggle').isVisible(), 'Edited … on the right');
          assert.ok(await p.locator('.tdoc-bar .tdoc-comments-filter-menu').isVisible(), 'the filter chevron');
          assert.ok(await p.locator('.tdoc-bar .tdoc-account-trigger').isVisible());
          await p.locator('#tdoc-more-btn').click();
          const rows = await menuRows(p);
          assert.ok(rows.includes('Version history'), JSON.stringify(rows));
          assert.ok(!rows.includes('Rename'));
          await closeMenu(p);
        } else {
          assert.ok(!(await p.locator('.tdoc-bar .tdoc-account-trigger').isVisible()), 'the avatar is in ⋯ on a phone');
        }
        await ctx.close();
      }
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
