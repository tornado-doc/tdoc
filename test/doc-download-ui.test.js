// Download in the real shell (flag docDownload), against the local server:
//   - ⋯ → Download & copy lists PDF, Word, Markdown, HTML and Copy as
//     Markdown for a prose doc; CSV (this tab), Excel, PDF, HTML for a
//     sheet doc; desktop and phone; with the flag off the menu is as before
//   - each item downloads a file of its type: .docx (a Word package with the
//     doc's heading and an embedded picture of its chart), .md (text/markdown,
//     an attachment), .csv (the tab on screen), .xlsx (every tab)
//   - PDF prints the reading column with the print rules added
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('doc-download-ui.test.js');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';
const FIX = path.join(__dirname, 'fixtures', 'doc-download');

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
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

(async () => {
  console.log('Download menu (PDF / Word / Markdown / CSV / Excel)');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-download-ui-'));
  const writeDoc = (slug, file, title) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.copyFileSync(path.join(FIX, file), path.join(root, slug, 'v1', 'index.html'));
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  writeDoc('q3-plan', 'q3-plan.html', 'Q3 launch plan');
  writeDoc('expenses', 'expenses.html', 'Expenses');

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  try {
    await waitForServer(port);
    browser = await chromium.launch();
  } catch (error) {
    server.kill();
    if (process.env.TDOC_REQUIRE_BROWSER_TESTS) throw error;
    console.log(`  - skipped: ${error.message}`);
    process.exit(0);
  }

  const context = async (viewport, flag = true, extra = {}) => {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true, ...extra });
    await ctx.addInitScript((on) => { if (window === window.top) window.__TDOC_FLAGS__ = Object.assign({}, window.__TDOC_FLAGS__, { docDownload: on }); }, flag);
    return ctx;
  };
  const openDoc = async (ctx, slug, ready = 'h1') => {
    const page = await ctx.newPage();
    await page.goto(`${base}/d/${slug}/v/1`);
    await page.frameLocator('iframe').first().locator(ready).first().waitFor();
    // The frame's ready message carries the doc's shape.
    await page.waitForTimeout(400);
    return page;
  };
  const openMenu = async (page, tap = false) => {
    await page.getByRole('button', { name: 'More actions' }).click();
    const trigger = page.getByRole('menuitem', { name: /Download & copy/ });
    if (tap) await trigger.click(); else await trigger.hover();
    await page.getByRole('menuitem', { name: 'Download PDF' }).waitFor();
  };
  const items = async (page) => page.locator('.ui-menu-popup').last().getByRole('menuitem').allInnerTexts();
  const download = async (page, name) => {
    await openMenu(page);
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name }).click()]);
    const saved = path.join(root, `dl-${Date.now()}-${file.suggestedFilename()}`);
    await file.saveAs(saved);
    return { name: file.suggestedFilename(), bytes: fs.readFileSync(saved) };
  };

  try {
    const desk = await context({ width: 1280, height: 860 });

    await test('a prose doc offers PDF, Word, Markdown, HTML and Copy as Markdown', async () => {
      const page = await openDoc(desk, 'q3-plan');
      await openMenu(page);
      const list = (await items(page)).map((s) => s.trim());
      assert(JSON.stringify(list) === JSON.stringify(['Download PDF', 'Download Word', 'Download Markdown', 'Download HTML', 'Copy as Markdown']), JSON.stringify(list));
      const box = await page.locator('.ui-menu-popup').last().boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 1280, `menu off screen ${JSON.stringify(box)}`);
      await shot(page, 'download-menu-desktop');
      await page.keyboard.press('Escape');
      await page.close();
    });

    await test('Word downloads a .docx: a Word package with the heading, a list and the chart as a picture', async () => {
      const page = await openDoc(desk, 'q3-plan');
      const file = await download(page, 'Download Word');
      assert(file.name === 'q3-plan.docx', file.name);
      assert(file.bytes.slice(0, 2).toString() === 'PK', 'not a zip');
      const text = file.bytes.toString('utf8');
      for (const want of ['[Content_Types].xml', 'word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        '<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Q3 launch plan', 'Beta invite', 'descr="Signups chart"', 'word/media/image2.png', 'Forecast model']) {
        assert(text.includes(want), `docx lacks ${want}`);
      }
      // The rasterised chart is a real PNG, drawn with the author's colour.
      const at = text.indexOf('word/media/image2.png');
      assert(file.bytes.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]), at) > at, 'chart is not a PNG');
      await page.close();
    });

    await test('Markdown downloads <slug>.md as text/markdown: the text, no comments or preamble', async () => {
      const page = await openDoc(desk, 'q3-plan');
      const file = await download(page, 'Download Markdown');
      assert(file.name === 'q3-plan.md', file.name);
      // What the menu fetched, asked again with the page's cookies: the type
      // and the attachment header.
      const r = await page.request.get(`${base}/d/q3-plan/v/1/export.md`);
      assert((r.headers()['content-type'] || '').startsWith('text/markdown'), r.headers()['content-type']);
      assert(/^attachment; filename="q3-plan\.md"$/.test(r.headers()['content-disposition'] || ''), r.headers()['content-disposition']);
      assert((await r.text()) === file.bytes.toString('utf8'), 'the file is the endpoint\'s Markdown');
      const md = file.bytes.toString('utf8');
      assert(md.startsWith('# Q3 launch plan\n') && md.includes('| Owner | Item | Due |\n| --- | --- | --- |') && md.includes('```bash'), md.slice(0, 400));
      assert(!md.includes('Comments (') && !md.includes('tdoc document'), 'preamble or comments in the file');
      await page.close();
    });

    await test('PDF prints the reading column with the print rules', async () => {
      const page = await openDoc(desk, 'q3-plan');
      // The local server has no /export; serve what the worker would.
      await page.route('**/d/q3-plan/v/1/export?download=0', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(FIX, 'q3-plan.html'), 'utf8') }));
      await page.exposeFunction('__tdocPrinted', (info) => { page.__printed = info; });
      await page.addInitScript(() => {
        if (window === window.top) return;
        window.print = () => window.top.__tdocPrinted({ rules: !!document.getElementById('tdoc-print'), title: document.title, slide: (document.getElementById('tdoc-print') || {}).textContent || '' });
      });
      await openMenu(page);
      await page.getByRole('menuitem', { name: 'Download PDF' }).click();
      const deadline = Date.now() + 5000;
      while (!page.__printed && Date.now() < deadline) await page.waitForTimeout(50);
      assert(page.__printed, 'print never called');
      assert(page.__printed.rules && page.__printed.title === 'Q3 launch plan', JSON.stringify(page.__printed));
      assert(page.__printed.slide.includes('@page tdoc-slide') && page.__printed.slide.includes('break-after: avoid'), 'print rules');
      await page.close();
    });

    await test('a sheet doc offers CSV (this tab) and Excel; CSV is the tab on screen, Excel every tab', async () => {
      const page = await openDoc(desk, 'expenses', '.tdoc-sheet');
      await openMenu(page);
      const list = (await items(page)).map((s) => s.trim());
      assert(JSON.stringify(list) === JSON.stringify(['Download CSV (this tab)', 'Download Excel', 'Download PDF', 'Download HTML', 'Copy as Markdown']), JSON.stringify(list));
      await shot(page, 'download-menu-sheet-desktop');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const csv = await download(page, 'Download CSV (this tab)');
      assert(csv.name === 'expenses-q3.csv', csv.name);
      assert(csv.bytes.toString('utf8') === '﻿Item,Amount,Paid,Tags\r\n"Laptop, 14""","1,899.00",✓,"hardware, ana"\r\nCoffee,12.5,,office\r\n\'-SUM(A1),-3,✓,\r\n', JSON.stringify(csv.bytes.toString('utf8')));
      // The second tab, then CSV again: that tab.
      await page.frameLocator('iframe').first().getByRole('tab', { name: 'Q4 [plan]' }).click();
      await page.waitForFunction(() => /sheet=/.test(location.hash), null, { timeout: 3000 });
      const second = await download(page, 'Download CSV (this tab)');
      assert(second.name === 'expenses-q4-plan.csv' && second.bytes.toString('utf8').includes('Desk,450'), `${second.name} ${second.bytes}`);
      const xlsx = await download(page, 'Download Excel');
      assert(xlsx.name === 'expenses.xlsx' && xlsx.bytes.slice(0, 2).toString() === 'PK', xlsx.name);
      const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js'));
      const book = XLSX.read(xlsx.bytes, { type: 'buffer' });
      assert(JSON.stringify(book.SheetNames) === '["Q3","Q4 (plan)"]', JSON.stringify(book.SheetNames));
      await page.close();
    });

    await test('a phone: the same rows, inside the screen', async () => {
      const phone = await context({ width: 390, height: 844 }, true, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await openDoc(phone, 'q3-plan');
      await openMenu(page, true);
      const list = (await items(page)).map((s) => s.trim());
      assert(list.includes('Download Word') && list.includes('Download Markdown') && list.includes('Download PDF'), JSON.stringify(list));
      const boxes = await page.locator('.ui-menu-popup').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
      assert(boxes.every((b) => b.left >= 0 && b.right <= 391), `menu off screen ${JSON.stringify(boxes)}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page scrolls sideways');
      await shot(page, 'download-menu-phone');
      const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download Word' }).click()]);
      assert(file.suggestedFilename() === 'q3-plan.docx', file.suggestedFilename());
      await phone.close();
    });

    await test('with the flag off the menu is as it was', async () => {
      const off = await context({ width: 1280, height: 860 }, false);
      const page = await openDoc(off, 'q3-plan');
      await openMenu(page);
      const list = (await items(page)).map((s) => s.trim());
      assert(JSON.stringify(list) === JSON.stringify(['Copy as Markdown', 'Download HTML', 'Download PDF']), JSON.stringify(list));
      await off.close();
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
