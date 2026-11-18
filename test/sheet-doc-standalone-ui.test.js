// A sheet doc is a type of its own (Julie, 2026-11-17): a doc that is only a
// sheet (shared/doc-type.mjs's sheet-only rule, "Sheet" in My docs) opens as
// a full page sheet, however it is linked. ?sheet=<tab> (the "Open on its
// own" link, a sheet embed's Open) and #expand=1 open that tab on the doc's
// own page: no way back to itself, no "Open on its own", no close full
// screen. A sheet inside a prose doc keeps all three; its way back is a
// breadcrumb, "Doc title / Tab" (Notion's full-page database), whose title
// closes full screen, or on the sheet's own page opens the doc. Desktop and phone.
// TDOC_TEST_SCREENSHOTS=<dir> saves a screenshot of each state.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('sheet-doc-standalone-ui.test.js');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheet-doc-'));
  const writeDoc = (slug, title, html) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  const tab = (name, cell) => ({ name, columns: [{ name: 'Item', type: 'text' }, { name: 'Amount', type: 'number' }], rows: [{ id: `${name}-1`, cells: [cell, '12'] }] });
  writeDoc('budget', 'Budget', M.sheetDocumentHtml({ title: 'Budget', sheets: [tab('Spend', 'Rent'), tab('Income', 'Salary')] }));
  writeDoc('plan', 'Plan', `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>Plan</h1><p>Before the table.</p>${M.tableHtml(tab('Runs', 'one'))}<p>After.</p></main></body></html>`);

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('a sheet doc stands alone; an embedded sheet still opens on its own');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    const open = async (page, url) => {
      await page.goto(`${base}${url}`);
      await page.locator('.tdoc-document-app').waitFor();
      const frame = page.frameLocator('iframe[aria-label="Document content"]');
      await frame.locator('.tdoc-sheet').first().waitFor();
      const doc = page.frames().find((f) => f.url().includes('/frame'));
      // The shell's config has reached the viewer (its first render after it).
      await doc.waitForFunction(() => window.__tdocSheets && document.querySelector('.tdoc-sheet .ts-row, .tdoc-sheet .ts-flat'));
      await page.waitForTimeout(300);
      return { frame, doc };
    };
    // What the sheet's chrome offers, as a person sees it.
    const chrome = (doc) => doc.evaluate(() => {
      const shown = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
      const named = (re) => Array.from(document.querySelectorAll('.tdoc-sheet a, .tdoc-sheet button')).filter((el) => shown(el) && re.test(el.getAttribute('aria-label') || el.textContent || ''));
      const h1 = document.querySelector('h1');
      return {
        expanded: window.__tdocSheets.expanded(),
        // The way back to the doc: the doc's title in the breadcrumb ("Doc / Tab").
        back: Array.from(document.querySelectorAll('.tdoc-sheet .ts-crumb-doc')).filter(shown).length,
        crumbs: shown(document.querySelector('.ts-xtitle')) ? Array.from(document.querySelectorAll('.ts-xtitle > *')).filter(shown).map((el) => el.textContent) : null,
        // "Plan / Runs": as much space before the slash as after it (the words, not the hover box).
        spacing: (() => {
          const doc = Array.from(document.querySelectorAll('.ts-xtitle .ts-crumb-doc')).find(shown), sep = document.querySelector('.ts-crumb-sep'), tab = document.querySelector('.ts-crumb-tab');
          if (!doc || !shown(sep) || !shown(tab)) return null;
          const r = document.createRange(); r.selectNodeContents(doc);
          const words = r.getBoundingClientRect(), s = sep.getBoundingClientRect(), t = tab.getBoundingClientRect();
          return { before: Math.round(s.left - words.right), after: Math.round(t.left - s.right) };
        })(),
        alone: named(/Open (this sheet )?on its own/).length,
        close: named(/^Close full screen/).length,
        expand: named(/^Expand sheet/).length,
        xhead: shown(document.querySelector('.ts-xhead')),
        title: h1 && h1.getBoundingClientRect().height > 0 && getComputedStyle(h1).visibility !== 'hidden' ? h1.textContent.trim() : '',
        tabs: Array.from(document.querySelectorAll('.ts-tab')).filter(shown).map((b) => `${b.textContent}${b.getAttribute('aria-selected') === 'true' ? '*' : ''}`),
      };
    });
    const shot = async (page, name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };

    for (const [label, viewport, mobile] of [['desktop', { width: 1280, height: 820 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));

      for (const url of ['/d/budget', '/d/budget?sheet=1', '/d/budget#expand=1']) {
        await test(`${label}: sheet doc at ${url} is a full page sheet, with nothing to go back to`, async () => {
          await page.goto('about:blank');
          const { doc } = await open(page, url);
          const c = await chrome(doc);
          assert(!c.expanded.on && !c.expanded.alone, `${url}: not the full-screen overlay: ${JSON.stringify(c.expanded)}`);
          assert(c.expanded.sheetOnly, `${url}: read as a sheet doc`);
          assert(!c.back && !c.alone && !c.close && !c.expand && !c.xhead, `${url}: no back / own-page / close / expand chrome: ${JSON.stringify(c)}`);
          assert(c.title === 'Budget', `${url}: the doc's title heads the page: ${JSON.stringify(c.title)}`);
          assert(JSON.stringify(c.tabs) === JSON.stringify(['Spend*', 'Income']), `${url}: both tabs, the first open: ${JSON.stringify(c.tabs)}`);
          await shot(page, `sheet-doc-${url.includes('?') ? 'sheet1' : url.includes('#') ? 'expand' : 'plain'}-${label}`);
        });
      }

      await test(`${label}: ?sheet=2 on a sheet doc opens that tab in place`, async () => {
        await page.goto('about:blank');
        const { doc } = await open(page, '/d/budget?sheet=2');
        const c = await chrome(doc);
        assert(!c.expanded.on && !c.back, `not full screen, no back: ${JSON.stringify(c)}`);
        assert(JSON.stringify(c.tabs) === JSON.stringify(['Spend', 'Income*']), `the second tab is open, the strip kept: ${JSON.stringify(c.tabs)}`);
        const grid = () => doc.evaluate(() => document.querySelector('.tdoc-sheet .ts-grid').textContent);
        assert(/Salary/.test(await grid()) && !/Rent/.test(await grid()), 'its rows show');
        // Back to the first tab (the same shape: one row, two columns) draws its rows.
        await doc.locator('.ts-tab', { hasText: 'Spend' }).click();
        await doc.waitForFunction(() => /Rent/.test(document.querySelector('.tdoc-sheet .ts-grid').textContent));
        assert(!/Salary/.test(await grid()), 'the other tab\'s rows are gone');
      });

      await test(`${label}: ?sheet=2 leaves the address once used: after a click on tab 1, a reload stays on tab 1`, async () => {
        await page.goto('about:blank');
        let { doc } = await open(page, '/d/budget?sheet=2');
        // The address is what is on screen: no ?sheet=, the view names the tab.
        await page.waitForFunction(() => !new URLSearchParams(location.search).has('sheet'));
        // The view in the hash names the open tab ({"a":"<tab>"}, encoded).
        const activeIn = (tab) => page.waitForFunction((t) => { let h = location.hash; for (let i = 0; i < 3; i++) { try { h = decodeURIComponent(h); } catch {} } return h.includes(`"a":"${t}"`); }, tab);
        await activeIn('Income');
        await doc.locator('.ts-tab', { hasText: 'Spend' }).click();
        await activeIn('Spend');
        await page.reload();
        await page.locator('.tdoc-document-app').waitFor();
        await page.frameLocator('iframe[aria-label="Document content"]').locator('.tdoc-sheet .ts-row').first().waitFor();
        doc = page.frames().find((f) => f.url().includes('/frame'));
        await page.waitForTimeout(300);
        const c = await chrome(doc);
        assert(JSON.stringify(c.tabs) === JSON.stringify(['Spend*', 'Income']), `reload stays on tab 1: ${JSON.stringify(c.tabs)} at ${page.url()}`);
        assert(/Rent/.test(await doc.evaluate(() => document.querySelector('.tdoc-sheet .ts-grid').textContent)), 'tab 1 rows');
        assert(!c.back && !c.expanded.on, 'still no back / full screen');
      });

      await test(`${label}: a sheet in a prose doc still expands, opens on its own, and goes back to the doc`, async () => {
        await page.goto('about:blank');
        let { doc } = await open(page, '/d/plan');
        let c = await chrome(doc);
        assert(!c.expanded.sheetOnly && c.expand === 1 && !c.back, `embedded: the expand button only: ${JSON.stringify(c)}`);
        await doc.locator('.tdoc-sheet button[aria-label^="Expand sheet"]').click();
        await doc.waitForFunction(() => window.__tdocSheets.expanded().on);
        c = await chrome(doc);
        assert(c.alone === 1 && c.close === 1 && c.back === 1, `full screen: Open on its own + close, and the breadcrumb: ${JSON.stringify(c)}`);
        assert(JSON.stringify(c.crumbs) === JSON.stringify(['Plan', '/', 'Runs']), `breadcrumb Plan / Runs: ${JSON.stringify(c.crumbs)}`);
        assert(c.spacing && Math.abs(c.spacing.before - c.spacing.after) <= 1 && c.spacing.before >= 4, `even space around the slash: ${JSON.stringify(c.spacing)}`);
        await shot(page, `embedded-expanded-${label}`);
        // Hovered, the title reads as a link.
        if (!mobile) {
          await doc.locator('.ts-xtitle button.ts-crumb-doc').hover();
          const look = await doc.evaluate(() => { const st = getComputedStyle(document.querySelector('.ts-xtitle button.ts-crumb-doc')); return { line: st.textDecorationLine, color: st.color }; });
          assert(look.line === 'underline' && look.color === 'rgb(22, 82, 240)', `underlined, in the accent colour, on hover: ${JSON.stringify(look)}`);
          await shot(page, `embedded-expanded-hover-${label}`);
        }
        // Keyboard: the title is a button in the tab order.
        assert(await doc.evaluate(() => { const b = document.querySelector('.ts-xtitle button.ts-crumb-doc'); return b.tabIndex >= 0 && !b.disabled; }), 'focusable');
        // In full screen the doc's title closes it: the doc is right there.
        await doc.locator('.ts-xtitle button.ts-crumb-doc').click();
        await doc.waitForFunction(() => !window.__tdocSheets.expanded().on);
        assert(/\/d\/plan(?:\/v\/1)?$/.test(new URL(page.url()).pathname), `still on the doc: ${page.url()}`);
        await page.goto('about:blank');
        ({ doc } = await open(page, '/d/plan?sheet=1'));
        await doc.waitForFunction(() => window.__tdocSheets.expanded().alone === 1);
        c = await chrome(doc);
        assert(c.back === 1 && !c.alone && !c.close, `own page: the breadcrumb's doc link only: ${JSON.stringify(c)}`);
        assert(JSON.stringify(c.crumbs) === JSON.stringify(['Plan', '/', 'Runs']), `breadcrumb Plan / Runs: ${JSON.stringify(c.crumbs)}`);
        assert(c.spacing && Math.abs(c.spacing.before - c.spacing.after) <= 1, `even space around the slash: ${JSON.stringify(c.spacing)}`);
        const href = await doc.evaluate(() => document.querySelector('.ts-xtitle a.ts-crumb-doc').getAttribute('href'));
        assert(/^\/d\/plan(?:\/v\/1)?(?:#|$)/.test(href), `the doc's title goes to the doc: ${href}`);
        await shot(page, `embedded-alone-${label}`);
      });

      await test(`${label}: no page errors`, async () => {
        assert(!errors.length, errors.join('; '));
      });
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
