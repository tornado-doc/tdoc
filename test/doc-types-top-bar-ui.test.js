// Every doc type has the same top bar (Julie, 2026-11-11): a doc, a sheet and
// a deck show the same items in the bar (title, Comment, Share / Publish, ⋯,
// space, account), the same ⋯ menu (Read / Comment / Edit, history, Download
// & copy, …) and, in Edit mode, the same editor bar with Save. Type-specific
// controls (the sheet's grid toolbar, the slide controls) live in the
// content below it. Desktop and phone; a sheet in full screen and a sheet on
// its own page (?sheet=1) keep the bar too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('doc-types-top-bar-ui.test.js');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function waitForServer(port, timeout = 8000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => { if (Date.now() > deadline) reject(new Error('server did not start')); else setTimeout(poll, 80); });
    })();
  });
}

(async () => {
  const M = await import('../shared/sheet-markup.mjs');
  const S = await import('../shared/slides-markup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-types-bar-'));
  const writeDoc = (slug, html) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    // One title for all three, so the bars can be compared item for item.
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: 'Plan', versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  writeDoc('a-doc', '<!doctype html><html><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>Plan</h1><p>What we will do, and why.</p></main></body></html>');
  writeDoc('a-sheet', M.blankSheetHtml('Plan'));
  writeDoc('a-deck', S.blankDeckHtml('Plan'));
  writeDoc('a-mixed', `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>Plan</h1><p>Before the table.</p>${M.tableHtml({ name: 'Runs', columns: [{ name: 'Run', type: 'text' }], rows: [{ id: 'r1', cells: ['one'] }] })}<p>After.</p></main></body></html>`);

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('every doc type: the same top bar and ⋯ menu');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    // What the bar shows: its visible controls, by name (the title is "Plan"
    // for all three; "Edited …" is the same words).
    const barItems = (page) => page.locator('.tdoc-bar').first().evaluate((bar) => Array.from(bar.querySelectorAll('button, a, [role="button"], .tdoc-edited'))
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0)
      .map((el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim()));
    const menuItems = async (page) => {
      await page.locator('.tdoc-bar #tdoc-more-btn:visible').first().click();
      await page.getByRole('menuitemradio', { name: 'Read', exact: true }).waitFor();
      const items = await page.locator('[role="menu"]').last().evaluate((menu) => Array.from(menu.querySelectorAll('[role^="menuitem"], .tdoc-menu-label'))
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
      await page.keyboard.press('Escape');
      // Dark mode follows the document's design, not its type: it is offered
      // where the doc uses the reader design (a sheet keeps its own, full
      // width), as for any prose doc with a design of its own.
      return items.filter((x) => !/^(Dark|Light) mode$/.test(x));
    };
    const load = async (page, url) => {
      await page.goto(`${base}${url}`);
      await page.locator('.tdoc-document-app').waitFor();
      await page.frameLocator('iframe[aria-label="Document content"]').locator('body').waitFor();
      await page.waitForTimeout(700);
    };

    for (const [label, viewport, mobile] of [['desktop', { width: 1280, height: 820 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      await test(`${label}: doc, sheet and deck have the same top bar and ⋯ menu`, async () => {
        const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        const seen = {};
        for (const slug of ['a-doc', 'a-sheet', 'a-deck']) {
          await load(page, `/d/${slug}/v/1`);
          seen[slug] = { bar: await barItems(page), menu: await menuItems(page) };
          if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `top-bar-${slug}-${label}.png`) }); }
        }
        const doc = JSON.stringify(seen['a-doc']);
        assert(seen['a-doc'].menu.some((x) => /Mode/.test(x)) && seen['a-doc'].menu.some((x) => /Edit/.test(x)), `the doc's ⋯ has the mode switch: ${doc}`);
        for (const slug of ['a-sheet', 'a-deck']) {
          assert(JSON.stringify(seen[slug].bar) === JSON.stringify(seen['a-doc'].bar), `${slug} bar ${JSON.stringify(seen[slug].bar)} ≠ doc bar ${JSON.stringify(seen['a-doc'].bar)}`);
          assert(JSON.stringify(seen[slug].menu) === JSON.stringify(seen['a-doc'].menu), `${slug} ⋯ ${JSON.stringify(seen[slug].menu)} ≠ doc ⋯ ${JSON.stringify(seen['a-doc'].menu)}`);
        }
        await context.close();
      });

      await test(`${label}: Edit mode shows the same editor bar with Save on every type`, async () => {
        const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        for (const slug of ['a-doc', 'a-sheet', 'a-deck']) {
          await load(page, `/d/${slug}/v/1`);
          await chooseMode(page, 'Edit');
          await page.locator('.tdoc-editor-toolbar').waitFor();
          assert(await page.getByRole('button', { name: 'Save', exact: true }).count(), `${slug}: Save in the editor bar`);
          await chooseMode(page, 'Read');
          await page.locator(modeSelector('read')).waitFor();
          assert(!(await page.locator('.tdoc-editor-toolbar').count()), `${slug}: no editor bar in Read`);
        }
        await context.close();
      });

      await test(`${label}: a sheet in full screen and on its own page keeps the top bar and the mode switch`, async () => {
        const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        await load(page, '/d/a-mixed/v/1');
        const normal = await barItems(page);
        for (const url of ['/d/a-mixed/v/1#expand=1', '/d/a-mixed/v/1?sheet=1']) {
          await page.goto('about:blank');
          await load(page, url);
          const frame = page.frames().find((f) => f.url().includes('/frame'));
          await frame.waitForFunction(() => window.__tdocSheets && window.__tdocSheets.expanded().on);
          const bar = await barItems(page);
          assert(JSON.stringify(bar) === JSON.stringify(normal), `${url}: bar ${JSON.stringify(bar)} ≠ ${JSON.stringify(normal)}`);
          const box = await page.locator('iframe[aria-label="Document content"]').boundingBox();
          const barBox = await page.locator('.tdoc-bar').first().boundingBox();
          assert(box.y >= barBox.y + barBox.height - 1, `${url}: the sheet sits under the bar`);
          await chooseMode(page, 'Edit');
          await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'edit');
          await page.locator('.tdoc-editor-toolbar').waitFor();
          await page.frameLocator('iframe[aria-label="Document content"]').getByRole('button', { name: 'Add row' }).waitFor();
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `top-bar-sheet-${url.includes('?') ? 'alone' : 'expanded'}-${label}.png`) });
          await chooseMode(page, 'Comment');
        }
        await context.close();
      });
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
