// A sheet inside a prose doc, in Edit mode, desktop + phone (owner feedback
// on a supplier follow-up doc: "can't hide/remove a column", "why an extra
// Comment button", "the blue boxes"):
//   - Edit mode draws the full grid (not the flat read table), and the
//     column menu leads with Insert left / right, Hide and Delete, in view
//     without scrolling the menu; Hide and Delete work and are saved
//   - no "Comment on sheet" button in any mode: Comment mode is the way in,
//     and a click on a cell in it opens the composer
//   - no blue frame around the editable doc area or around the sheet's grid
//     when it has focus; the active cell's ring is the one blue mark
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheet-edit-ux-ui.test.js');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

let pass = 0, fail = 0;
async function test(name, fn) {
  if (process.env.TDOC_TEST_FILTER && !name.includes(process.env.TDOC_TEST_FILTER)) return;
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function waitForServer(port, timeout = 8000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const r = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      r.on('error', () => { if (Date.now() > deadline) reject(new Error('server did not start')); else setTimeout(poll, 80); });
    })();
  });
}

(async () => {
  const M = await import('../shared/sheet-markup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheet-edit-ux-'));
  // A prose doc (paragraphs around it) with a small, wide sheet: the shape
  // that reads as a flat table in Read and Comment.
  const table = M.tableHtml({ name: 'Supplier CRM', columns: [
    { name: 'Supplier', type: 'text' }, { name: 'Status', type: 'tags' }, { name: 'Next action', type: 'text' },
    { name: 'Contact', type: 'text' }, { name: 'Channel', type: 'tags' }, { name: 'Notes', type: 'text' }, { name: 'Updated', type: 'date' },
  ], rows: ['EGI', 'Potato', 'Mighty Wireless', 'Via Trading', 'Great Buy'].map((s, k) => ({ id: `r${k + 1}`, cells: [s, [k ? 'Awaiting reply' : 'Active'], `Confirm SKU prices and MOQ with ${s}`, `contact ${k + 1}`, ['WhatsApp'], 'Pricing, MOQ and fulfillment terms unknown.', '2026-11-10'] })) });
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Follow up</title></head><body><main><h1>Supplier follow up</h1><p>First paragraph of the plan.</p><p>Second paragraph with the current focus.</p><p>Third paragraph before the sheet.</p>${table}<p>After the sheet.</p></main></body></html>`;
  const writeDoc = (slug) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), doc);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  for (const slug of ['desk', 'phone']) writeDoc(slug);
  const saved = (slug, v) => fs.readFileSync(path.join(root, slug, `v${v}`, 'index.html'), 'utf8');

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheet in a prose doc, Edit mode: column menu, no Comment button, no blue frames');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const devices = {
      desk: { viewport: { width: 1280, height: 860 } },
      phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    };
    for (const slug of Object.keys(devices)) {
      await test(`${slug}: no Comment-on-sheet button; Edit is the grid; Hide and Delete lead the column menu and save; no blue frame on the editor or the grid`, async () => {
        const context = await browser.newContext(devices[slug]);
        await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/d/${slug}/v/1`);
        const f = page.frameLocator('iframe[aria-label="Document content"]');
        await f.locator('.tdoc-sheet').waitFor({ timeout: 15000 });
        const frame = page.frames().find((x) => x.url().includes('/frame'));
        const frameMode = (m) => frame.waitForFunction((x) => document.documentElement.getAttribute('data-tdoc-interaction-mode') === x, m);
        const noCommentButton = () => frame.evaluate(() => !document.querySelector('.tdoc-sheet [aria-label="Comment on sheet"]') && ![...document.querySelectorAll('.tdoc-sheet button')].some((b) => /Comment on sheet/.test(b.textContent)));
        const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `edit-ux-${name}-${slug}.png`) }); } };

        for (const m of ['Read', 'Comment']) {
          await chooseMode(page, m);
          await frameMode(m.toLowerCase());
          assert(await noCommentButton(), `no "Comment on sheet" in ${m}`);
        }
        // Comment mode: a click on a cell comments on it.
        await frame.waitForFunction(() => document.querySelector('.tdoc-sheet').classList.contains('is-flat'));
        await f.locator('.ts-flat [data-i="1"][data-c="2"], .ts-flat .ts-card-l[data-i="1"]').first().click();
        await page.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
        await shot('comment');
        await page.keyboard.press('Escape');

        await chooseMode(page, 'Edit');
        await frameMode('edit');
        assert(await noCommentButton(), 'no "Comment on sheet" in Edit');
        // The full grid, not the flat read table.
        await frame.waitForFunction(() => { const s = document.querySelector('.tdoc-sheet'); return !s.classList.contains('is-flat') && s.querySelector('.ts-rows .ts-row'); });
        // Focus the editable area, then the grid: neither draws a frame.
        await f.locator('main p').first().click();
        const editorFrame = await frame.evaluate(() => { const el = document.querySelector('[data-tdoc-editor-root]'); const cs = getComputedStyle(el); return { focused: document.activeElement === el || el.contains(document.activeElement), shadow: cs.boxShadow, outline: cs.outlineStyle }; });
        assert(editorFrame.shadow === 'none' && editorFrame.outline === 'none', `no frame on the editor: ${JSON.stringify(editorFrame)}`);
        await f.locator('.ts-rows .ts-row[data-i="0"] .ts-c[data-c="0"]').click();
        await page.keyboard.press('ArrowRight');
        const grid = await frame.evaluate(() => { const g = document.querySelector('.tdoc-sheet .ts-grid'); const cs = getComputedStyle(g); const h = document.querySelector('.ts-h.is-sel'); return { focused: document.activeElement === g, shadow: cs.boxShadow, outline: cs.outlineStyle, head: h && getComputedStyle(h).backgroundColor }; });
        assert(grid.focused && grid.shadow === 'none' && grid.outline === 'none', `no ring around the grid: ${JSON.stringify(grid)}`);
        assert(grid.head === 'rgb(236, 236, 240)', `the selected column's header is grey, not blue: ${grid.head}`);
        await shot('edit');

        // Column C's menu: Insert left / right, Hide, Delete first, in view.
        const openMenu = async (name) => {
          const b = f.getByRole('button', { name: `${name} column menu` });
          await b.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }));
          if (slug === 'phone') await b.tap(); else await b.click();
          await f.locator('.ts-pop').waitFor();
        };
        await openMenu('Next action');
        const menu = await frame.evaluate(() => {
          const pop = document.querySelector('.ts-pop'), box = pop.getBoundingClientRect();
          return [...pop.querySelectorAll('.ts-mi')].slice(0, 4).map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), seen: r.top >= box.top && r.bottom <= box.bottom }; });
        });
        assert(JSON.stringify(menu.map((x) => x.t)) === JSON.stringify(['Insert column left', 'Insert column right', 'Hide column C', 'Delete column']), `menu leads with structure: ${JSON.stringify(menu)}`);
        assert(menu.every((x) => x.seen), `all four in view without scrolling: ${JSON.stringify(menu)}`);
        await shot('colmenu');
        await f.getByRole('menuitem', { name: 'Hide column C' }).click();
        await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th')[2].hasAttribute('data-hidden'));
        assert(!(await frame.evaluate(() => [...document.querySelectorAll('.ts-h b')].some((b) => b.textContent === 'Next action'))), 'Next action is out of the grid');
        // Delete column F (Notes).
        // Two taps close together are a double-tap (Rename on a header).
        await page.waitForTimeout(600);
        await openMenu('Notes');
        await f.getByRole('menuitem', { name: 'Delete column' }).click();
        await frame.waitForFunction(() => ![...document.querySelectorAll('table[data-tdoc-sheet] thead th')].some((th) => th.textContent === 'Notes'));
        await shot('edited');
        // Save.
        await page.waitForFunction(() => { const b = document.querySelector('.tdoc-editor-toolbar button.primary'); return b && !b.disabled; });
        await page.locator('.tdoc-editor-toolbar button.primary').click();
        await page.waitForURL(new RegExp(`/d/${slug}/v/2`), { timeout: 10000 });
        const v2 = saved(slug, 2);
        assert(/<th[^>]*data-hidden[^>]*>Next action<\/th>|<th[^>]*data-hidden[^>]*>[^<]*Next action/.test(v2) || /<th(?=[^>]*data-hidden)[^>]*>Next action/.test(v2), 'v2 holds Next action hidden');
        assert(!/>Notes<\/th>/.test(v2) && !/Pricing, MOQ and fulfillment terms unknown/.test(v2), 'v2 has no Notes column');
        assert(/>Contact<\/th>/.test(v2) && /After the sheet\./.test(v2), 'the rest of the doc is kept');
        assert(!errors.length, `page errors: ${errors.join(' | ')}`);
        await context.close();
      });
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
