// Sheets in the browser, end to end against the local server:
//   - a CSV and an .xlsx chosen from Create a doc, and a CSV dropped on My
//     docs, become sheet docs (multi-sheet workbook → tabs)
//   - search with next/previous, a value filter, a tag filter, a range
//     filter, multi-column sort, tabs, keyboard navigation; the view rides
//     in the #hash and survives a reload; none of it is a document edit
//   - a cell comment anchors to the row id and survives a sort
//   - Edit mode: edit a cell, pick a tag, add a row, paste a TSV range, undo,
//     and Save writes a new version with the edits in the author's table
//   - an agent's sheet published through the CLI (tdoc-new --from-csv, and
//     hand-written markup) renders as a grid
//   - 10,000 rows × 20 columns: loads, scrolls within a frame budget, sorts
//   - a phone: no sideways page scroll, menus as bottom sheets, tap to select
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('sheets-ui.test.js');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
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
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => { if (Date.now() > deadline) reject(new Error('server did not start')); else setTimeout(poll, 80); });
    })();
  });
}
async function shot(page, name, opts = {}) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
}

(async () => {
  const M = await import('../shared/sheet-markup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheets-ui-'));
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheets-files-'));
  const writeDoc = (slug, html, title) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title, versions: [{ n: 1, created: new Date().toISOString() }] }, null, 2));
  };

  // The tracker: 30 tasks with every column type, and a second tab.
  const statuses = ['open', 'done', 'blocked'];
  const owners = ['Ann', 'Bo', 'Cy'];
  const tasks = Array.from({ length: 30 }, (_, k) => {
    const i = k + 1;
    const day = String(1 + (i % 28)).padStart(2, '0');
    return { id: `r${i}`, cells: [`Task ${i}`, owners[k % 3], String((i * 7) % 20), `2026-0${1 + (i % 3)}-${day}`, [statuses[k % 3]].concat(i % 5 === 0 ? ['urgent'] : []), i % 3 === 0 ? 'yes' : '', i % 4 === 0 ? `https://example.com/t/${i}` : ''] };
  });
  writeDoc('tracker', M.sheetDocumentHtml({ title: 'Tracker', note: 'Thirty tasks.', sheets: [
    { name: 'Tasks', columns: [{ name: 'Task', type: 'text' }, { name: 'Owner', type: 'text' }, { name: 'Points', type: 'number' }, { name: 'Due', type: 'date' }, { name: 'Status', type: 'tags', palette: 'done:green, blocked:red, urgent:orange' }, { name: 'Done', type: 'checkbox' }, { name: 'Link', type: 'url' }], rows: tasks },
    { name: 'People', columns: [{ name: 'Name', type: 'text' }, { name: 'Team', type: 'tags' }], rows: [{ cells: ['Ann', ['core']] }, { cells: ['Bo', ['web']] }, { cells: ['Cy', ['core', 'web']] }] },
  ] }), 'Tracker');
  // A second copy for Edit mode, so the read tests never see its edits.
  writeDoc('editable', fs.readFileSync(path.join(root, 'tracker', 'v1', 'index.html'), 'utf8'), 'Editable');
  // 10,000 rows × 20 columns as a CSV, imported through the browser (about
  // 6 MB as a sheet doc: the raised sheet cap).
  const bigCsv = path.join(files, 'customers_10k.csv');
  {
    const names = ['Name', 'Email', 'Amount', 'Date', 'Status', 'Owner', 'Region', 'Score', 'Notes', 'Link'];
    const lines = [Array.from({ length: 20 }, (_, c) => `${names[c % 10]} ${c + 1}`).join(',')];
    for (let r = 0; r < 10000; r++) {
      lines.push(Array.from({ length: 20 }, (_, c) => [`Customer ${r}`, `user${r}@example.com`, ((r * 13.37) % 9999).toFixed(2), `2026-0${1 + (r % 9)}-1${r % 9}`, ['open', 'won', 'lost'][r % 3], ['Ann', 'Bo', 'Cy'][r % 3], ['EMEA', 'APAC', 'NA'][r % 3], String(r % 100), `Follow up about order ${r}`, `https://example.com/o/${r}`][c % 10]).join(','));
    }
    fs.writeFileSync(bigCsv, lines.join('\n'));
  }
  // Agent-authored markup, no row ids, no thead (a <th> row in the body).
  writeDoc('handwritten', `<!doctype html><html><head><meta charset="utf-8"><title>Hand</title></head><body><main><h1>Inventory</h1>
<table data-tdoc-sheet data-name="Stock"><tr><th>Item</th><th data-type="number">Qty</th><th data-type="tags">Where</th></tr>
<tr><td>Bolts</td><td>120</td><td><span data-tag>A1</span></td></tr><tr><td>Nuts</td><td>8</td><td><span data-tag>B2</span> <span data-tag>A1</span></td></tr></table></main></body></html>`, 'Hand');
  // An agent publishing a CSV through the CLI.
  const csv = path.join(files, 'expenses.csv');
  fs.writeFileSync(csv, 'Date,Vendor,Amount,Category,Reimbursed\n2026-01-03,"Acme, Inc.",120.50,travel,yes\n2026-01-09,Bistro,42,meals,no\n2026-02-11,Acme,980,"travel, hotel",no\n');
  execFileSync(path.join(__dirname, '..', 'bin', 'tdoc-new'), ['--slug', 'expenses', '--from-csv', csv, '--no-server', '--quiet'], { env: { ...process.env, TDOC_DIR: root }, stdio: 'pipe' });
  // Files to import in the browser.
  const importCsv = path.join(files, 'q3_budget.csv');
  fs.writeFileSync(importCsv, 'Line,Amount,Owner,Tags\nRent,"1,200",Ann,fixed\nAds,300,Bo,"growth, test"\nTools,85.5,Ann,fixed\n');
  const dropCsv = path.join(files, 'dropped.csv');
  fs.writeFileSync(dropCsv, 'A,B\n1,x\n2,y\n');
  const xlsxFile = path.join(files, 'book.xlsx');
  let xlsxReady = false;
  try {
    const X = require('xlsx');
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Item', 'Cost', 'When'], ['Desk', 120, { t: 'n', v: 46053, z: 'yyyy-mm-dd' }], ['Lamp', 30, { t: 'n', v: 46060, z: 'm/d/yy' }]]), 'Budget');
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Who', 'Done'], ['Ann', 'yes'], ['Bo', 'no']]), 'People');
    X.writeFile(wb, xlsxFile);
    xlsxReady = true;
  } catch (error) {
    if (process.env.TDOC_REQUIRE_BROWSER_TESTS) throw error;
  }

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheets in the browser');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    // The editing and import surfaces are behind the `sheets` flag; reading is not.
    await context.addInitScript(() => {
      try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {}
      if (window === window.top) window.__TDOC_FLAGS__ = Object.assign({}, window.__TDOC_FLAGS__, { sheets: true });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const docFrame = () => page.frames().find((f) => f.url().includes('/frame'));
    const frameLoc = () => page.frameLocator('iframe[aria-label="Document content"]');
    // Each test starts from no saved view: a sheet's view is remembered per
    // browser, which is the feature, and would couple the tests.
    async function open(slug, hash = '', viewPage = page) {
      if (viewPage.url().startsWith(base)) await viewPage.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tdoc-sheet-view:')) localStorage.removeItem(k); });
      await viewPage.goto(`${base}/d/${slug}/v/1${hash}`);
      await viewPage.frameLocator('iframe[aria-label="Document content"]').locator('.tdoc-sheet .ts-row, .tdoc-sheet .ts-empty').first().waitFor({ timeout: 15000 });
      return viewPage.frames().find((f) => f.url().includes('/frame'));
    }
    const state = (frame) => frame.evaluate(() => ({ tabs: window.__tdocSheets.tabs(), active: window.__tdocSheets.active(), sel: window.__tdocSheets.selection() }));
    const firstCol = (frame, c = 0) => frame.evaluate((col) => Array.from(document.querySelectorAll('.ts-row')).map((r) => r.querySelector(`.ts-c[data-c="${col}"]`).textContent), c);
    const countText = (frame) => frame.evaluate(() => document.querySelector('.ts-count').textContent);

    await test('a sheet renders as a grid: tabs, typed headers, frozen header and first column, row count', async () => {
      const frame = await open('tracker');
      const info = await frame.evaluate(() => ({
        tabs: Array.from(document.querySelectorAll('.ts-tab')).map((t) => t.textContent),
        headers: Array.from(document.querySelectorAll('.ts-h b')).map((b) => b.textContent),
        glyphs: Array.from(document.querySelectorAll('.ts-h .ts-glyph')).map((g) => g.getAttribute('aria-label')),
        hiddenTable: getComputedStyle(document.querySelector('table[data-tdoc-sheet]')).display,
        headSticky: getComputedStyle(document.querySelector('.ts-head')).position,
        firstSticky: getComputedStyle(document.querySelector('.ts-c[data-c="0"]')).position,
        tags: Array.from(document.querySelectorAll('.ts-row .ts-tag')).length,
        caption: !!document.querySelector('table[data-tdoc-sheet] caption'),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      }));
      assert(JSON.stringify(info.tabs) === '["Tasks","People"]', JSON.stringify(info.tabs));
      assert(info.headers.join() === 'Task,Owner,Points,Due,Status,Done,Link', info.headers.join());
      assert(info.glyphs.join() === 'Text,Text,Number,Date,Tags,Checkbox,Link', info.glyphs.join());
      assert(info.hiddenTable === 'none', 'the author table is hidden');
      assert(info.headSticky === 'sticky' && info.firstSticky === 'sticky', JSON.stringify(info));
      assert(info.tags > 20 && info.caption, JSON.stringify(info));
      assert(info.pageOverflow <= 1, `page scrolls sideways: ${info.pageOverflow}`);
      assert(await countText(frame) === '30 rows', await countText(frame));
      await shot(page, 'sheet-desktop');
    });

    await test('search filters to matching rows, highlights them, and steps through matches', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('task 1');
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '11 of 30 rows');
      assert(await frame.evaluate(() => document.querySelectorAll('.ts-row mark').length) === 11, 'every match is highlighted');
      await f.getByRole('searchbox', { name: 'Search this sheet' }).press('Enter');
      await frame.waitForFunction(() => /^1 of 11$/.test(document.querySelector('.ts-search output').textContent));
      await f.getByRole('button', { name: 'Next match' }).click();
      await frame.waitForFunction(() => /^2 of 11$/.test(document.querySelector('.ts-search output').textContent));
      await f.getByRole('button', { name: 'Previous match' }).click();
      await f.getByRole('button', { name: 'Previous match' }).click();
      await frame.waitForFunction(() => /^11 of 11$/.test(document.querySelector('.ts-search output').textContent));
      assert(await frame.evaluate(() => !!document.querySelector('.ts-c.is-hit-on')), 'the current match is marked');
      await page.waitForFunction(() => /sheet=/.test(location.hash));
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('');
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '30 rows');
    });

    await test('sort: header click asc → desc, shift-click adds a second key; numbers sort numerically', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      await f.locator('.ts-h[data-c="2"] .ts-hname').click();
      await frame.waitForFunction(() => document.querySelector('.ts-h[data-c="2"]').getAttribute('aria-sort') === 'ascending');
      const pts = (await firstCol(frame, 2)).map(Number);
      assert(pts.every((v, i) => !i || v >= pts[i - 1]), `ascending: ${pts}`);
      await f.locator('.ts-h[data-c="1"] .ts-hname').click({ modifiers: ['Shift'] });
      const both = await frame.evaluate(() => window.__tdocSheets.tabs()[0].query.sort);
      assert(JSON.stringify(both) === '[{"col":2,"dir":"asc"},{"col":1,"dir":"asc"}]', JSON.stringify(both));
      const rows = await frame.evaluate(() => Array.from(document.querySelectorAll('.ts-row')).map((r) => [Number(r.querySelector('[data-c="2"]').textContent), r.querySelector('[data-c="1"]').textContent]));
      for (let i = 1; i < rows.length; i++) assert(rows[i][0] > rows[i - 1][0] || (rows[i][0] === rows[i - 1][0] && rows[i][1] >= rows[i - 1][1]), `two-key order at ${i}: ${JSON.stringify(rows)}`);
      await f.locator('.ts-h[data-c="2"] .ts-hname').click();
      await f.locator('.ts-h[data-c="2"] .ts-hname').click();
      const after = await frame.evaluate(() => window.__tdocSheets.tabs()[0].query.sort);
      assert(after.length === 0, `a third plain click clears the sort: ${JSON.stringify(after)}`);
      // The document itself never moved: sort is a view.
      const doc = await frame.evaluate(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet] tbody tr')).slice(0, 3).map((tr) => tr.getAttribute('data-row')).join());
      assert(doc === 'r1,r2,r3', doc);
    });

    await test('filters: value, tag (any of), number range, checkbox; chips; clear all', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      // Owner = Ann, from the column menu.
      await f.getByRole('button', { name: 'Owner column menu' }).click();
      await f.getByRole('menuitem', { name: 'Filter…' }).click();
      await f.locator('.ts-pop .ts-val', { hasText: 'Ann' }).locator('input').check();
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '10 of 30 rows');
      await f.locator('.ts-pop').getByRole('button', { name: 'Done' }).click();
      assert(await f.locator('.ts-chip', { hasText: 'Owner: Ann' }).count() === 1, 'chip');
      // Status has the tag "urgent" (rows 5, 10, …, 30), of which Ann has 10, 25.
      await f.getByRole('button', { name: 'Status column menu' }).click();
      await f.getByRole('menuitem', { name: 'Filter…' }).click();
      await f.locator('.ts-pop .ts-val', { hasText: 'urgent' }).locator('input').check();
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '2 of 30 rows');
      assert((await firstCol(frame)).join() === 'Task 10,Task 25', (await firstCol(frame)).join());
      await shot(page, 'sheet-filter-desktop');
      await page.keyboard.press('Escape');
      await f.getByRole('button', { name: 'Clear all' }).click();
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '30 rows');
      // Points between 10 and 15.
      await f.getByRole('button', { name: 'Points column menu' }).click();
      await f.getByRole('menuitem', { name: 'Filter…' }).click();
      await f.getByLabel('From Points').fill('10');
      await f.getByLabel('To Points').fill('15');
      await f.getByLabel('To Points').press('Enter');
      await frame.waitForFunction(() => /of 30 rows/.test(document.querySelector('.ts-count').textContent));
      const pts = (await firstCol(frame, 2)).map(Number);
      assert(pts.length && pts.every((v) => v >= 10 && v <= 15), `range: ${pts}`);
      await f.getByRole('button', { name: 'Remove filter on Points' }).click();
      // Checked only.
      await f.getByRole('button', { name: 'Done column menu' }).click();
      await f.getByRole('menuitem', { name: 'Filter…' }).click();
      await f.locator('.ts-pop').getByRole('button', { name: 'Checked', exact: true }).click();
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '10 of 30 rows');
      await page.keyboard.press('Escape');
    });

    await test('the view (filters, sort, tab) is in the #hash: a reload or a shared link restores it', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      await f.getByRole('button', { name: 'Owner column menu' }).click();
      await f.getByRole('menuitem', { name: 'Filter…' }).click();
      await f.locator('.ts-pop .ts-val', { hasText: 'Bo' }).locator('input').check();
      await page.keyboard.press('Escape');
      await f.locator('.ts-h[data-c="0"] .ts-hname').click();
      await f.locator('.ts-h[data-c="0"] .ts-hname').click();
      await frame.waitForFunction(() => document.querySelector('.ts-h[data-c="0"]').getAttribute('aria-sort') === 'descending');
      await page.waitForFunction(() => /sheet=/.test(location.hash));
      const link = page.url();
      const other = await context.newPage();
      const again = await open('tracker', new URL(link).hash, other);
      await again.waitForFunction(() => window.__tdocSheets.tabs()[0].query.sort.length === 1);
      const tabs = await again.evaluate(() => window.__tdocSheets.tabs());
      assert(tabs[0].query.sort[0].dir === 'desc', JSON.stringify(tabs[0].query));
      assert(tabs[0].shown === 10 && tabs[0].query.filters[1].values.join() === 'Bo', `the filter came along: ${JSON.stringify(tabs[0])}`);
      await other.close();
      // Clear for the tests after this one.
      await f.getByRole('button', { name: 'Clear all' }).click();
      await page.goto(`${base}/d/tracker/v/1`);
      await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tdoc-sheet-view:')) localStorage.removeItem(k); });
    });

    await test('keyboard: arrows, Tab, Home/End, ⌘↓/⌘↑, shift-extend; tabs switch', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="0"]').click();
      for (const k of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'Tab']) await page.keyboard.press(k);
      let s = (await state(frame)).sel;
      assert(s.r === 2 && s.c === 2, JSON.stringify(s));
      await page.keyboard.press('End');
      assert((await state(frame)).sel.c === 6, 'End → last column');
      await page.keyboard.press('Home');
      await page.keyboard.press(`${MOD}+ArrowDown`);
      s = (await state(frame)).sel;
      assert(s.r === 29 && s.c === 0, `⌘↓ → last row: ${JSON.stringify(s)}`);
      await page.keyboard.press(`${MOD}+ArrowUp`);
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowRight');
      s = (await state(frame)).sel;
      assert(s.r === 0 && s.r2 === 1 && s.c2 === 1, JSON.stringify(s));
      assert(await frame.evaluate(() => document.querySelectorAll('.ts-c.is-sel').length) === 4, 'a 2×2 range is shown');
      await page.keyboard.press('Escape');
      await f.getByRole('tab', { name: 'People' }).click();
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '3 rows');
      assert((await state(frame)).active === 1, 'tab switched');
    });

    await test('a cell comment anchors to the row id and stays on its cell through a sort', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      await page.getByRole('button', { name: /Document mode:/ }).waitFor();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      await f.locator('.ts-row[data-i="4"] .ts-c[data-c="1"]').click();
      await f.getByRole('button', { name: 'Comment on Tasks!B5' }).click();
      await page.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
      await page.fill('.tdoc-popup textarea', 'Is Bo really on this?');
      await page.click('.tdoc-popup .submit');
      const commentsFile = path.join(root, 'tracker', 'comments.json');
      const deadline = Date.now() + 5000;
      let saved = [];
      while (Date.now() < deadline) { try { saved = JSON.parse(fs.readFileSync(commentsFile, 'utf8')); } catch {} if (saved.length) break; await page.waitForTimeout(100); }
      assert(saved.length === 1, `saved: ${saved.length}`);
      const anchor = saved[0].anchor;
      assert(anchor.kind === 'element' && anchor.selector === 'table[data-tdoc-sheet][data-name="Tasks"] tr[data-row="r5"] > :nth-child(2)', JSON.stringify(anchor));
      assert(anchor.sheet && anchor.sheet.table === 'Tasks' && anchor.sheet.row === 'r5' && anchor.sheet.key === 'c2', `row id + column key: ${JSON.stringify(anchor.sheet)}`);
      if (anchor.label) assert(/B5/.test(anchor.label), `labelled with the cell: ${anchor.label}`);
      // Sort descending by Task: row 5 moves; its marker follows it.
      await frame.waitForFunction(() => document.querySelectorAll('.ts-c.has-comment').length === 1);
      await f.locator('.ts-h[data-c="0"] .ts-hname').click();
      await f.locator('.ts-h[data-c="0"] .ts-hname').click();
      const marked = await frame.evaluate(() => { const c = document.querySelector('.ts-c.has-comment'); return c && [c.parentElement.querySelector('[data-c="0"]').textContent, c.getAttribute('data-c')]; });
      assert(marked && marked[0] === 'Task 5' && marked[1] === '1', `marker: ${JSON.stringify(marked)}`);
      // The pin sits on the grid, not at the end of the page.
      const pins = await page.evaluate(() => Array.from(document.querySelectorAll('[data-pin-id], .tdoc-pin')).length);
      assert(pins >= 1, 'a pin is drawn');
      await shot(page, 'sheet-comment-desktop');
      await f.getByRole('button', { name: 'Clear all' }).click().catch(() => {});
    });

    await test('a cell comment stays on its cell when a column is inserted before it, live and after Save', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      const marked = () => frame.evaluate(() => Array.from(document.querySelectorAll('.ts-c.has-comment')).map((c) => [c.parentElement.querySelector('[data-c="0"]').textContent, c.getAttribute('data-c'), document.querySelectorAll('.ts-h b')[Number(c.getAttribute('data-c'))].textContent]));
      await frame.waitForFunction(() => document.querySelectorAll('.ts-c.has-comment').length === 1);
      assert(JSON.stringify(await marked()) === '[["Task 5","1","Owner"]]', JSON.stringify(await marked()));
      await page.getByRole('button', { name: /Document mode:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Edit' }).click();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'edit');
      await f.getByRole('button', { name: 'Owner column menu' }).click();
      await f.getByRole('menuitem', { name: 'Insert column left' }).click();
      await f.getByRole('textbox', { name: 'Column name' }).fill('Priority');
      await page.keyboard.press('Enter');
      const keys = await frame.evaluate(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet][data-name="Tasks"] thead th')).map((th) => th.getAttribute('data-key')).join());
      assert(keys === 'c1,c8,c2,c3,c4,c5,c6,c7', `the new column takes a fresh key, the rest keep theirs: ${keys}`);
      await frame.waitForFunction(() => { const c = document.querySelector('.ts-c.has-comment'); return c && c.getAttribute('data-c') === '2'; });
      assert(JSON.stringify(await marked()) === '[["Task 5","2","Owner"]]', `live: ${JSON.stringify(await marked())}`);
      await page.waitForFunction(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Save'); return b && !b.disabled; });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(/\/d\/tracker\/v\/2/, { timeout: 10000 });
      await page.goto(`${base}/d/tracker/v/2`);
      const v2 = page.frames().find((x) => x.url().includes('/frame')) || await (async () => { await page.waitForTimeout(300); return page.frames().find((x) => x.url().includes('/frame')); })();
      await frameLoc().locator('.ts-row').first().waitFor();
      await v2.waitForFunction(() => document.querySelectorAll('.ts-c.has-comment').length === 1);
      const after = await v2.evaluate(() => { const c = document.querySelector('.ts-c.has-comment'); return [c.parentElement.querySelector('[data-c="0"]').textContent, c.getAttribute('data-c'), document.querySelectorAll('.ts-h b')[2].textContent]; });
      assert(JSON.stringify(after) === '["Task 5","2","Owner"]', `after Save, on v2: ${JSON.stringify(after)}`);
      // Scrolled out of the grid, the comment is counted at the edge it is
      // past, the pin sits there, and the marker takes you back to it.
      await page.setViewportSize({ width: 1280, height: 520 });
      await v2.evaluate(() => { const g = document.querySelector('.ts-grid'); g.scrollTop = g.scrollHeight; g.dispatchEvent(new Event('scroll')); });
      await v2.waitForFunction(() => { const b = document.querySelectorAll('.ts-off')[0]; return b && !b.hidden && /1 comment above/.test(b.textContent); });
      await page.waitForTimeout(600);
      const where = await v2.evaluate(() => { const b = document.querySelectorAll('.ts-off')[0].getBoundingClientRect(), g = document.querySelector('.ts-grid').getBoundingClientRect(); return { badge: b.top + scrollY, gridTop: g.top + scrollY, cell: null }; });
      const pin = await page.evaluate(() => { const pins = Array.from(document.querySelectorAll('.tdoc-pin, [data-pin-id]')); const r = pins[0] && pins[0].getBoundingClientRect(); return r ? r.top : null; });
      const frameTop = (await page.locator('.tdoc-doc-frame').boundingBox()).y;
      assert(pin !== null && Math.abs(pin - frameTop - (where.badge - await v2.evaluate(() => scrollY))) < 40, `pin beside the "above" marker: pin ${pin}, marker ${where.badge}, frame ${frameTop}`);
      await shot(page, 'sheet-offscreen-comment');
      await v2.evaluate(() => document.querySelectorAll('.ts-off')[0].click());
      await v2.waitForFunction(() => { const c = document.querySelector('.ts-c.has-comment'); const g = document.querySelector('.ts-grid').getBoundingClientRect(); if (!c) return false; const r = c.getBoundingClientRect(); return r.top >= g.top && r.bottom <= g.bottom; });
      await page.setViewportSize({ width: 1280, height: 860 });
    });

    await test('Edit mode: edit a cell, pick a tag, add a row, paste a range, undo; Save writes a new version', async () => {
      const frame = await open('editable');
      const f = frameLoc();
      const trigger = page.getByRole('button', { name: /Document mode:/ });
      await trigger.click();
      await page.getByRole('menuitemradio', { name: 'Edit' }).click();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'edit');
      await f.getByRole('button', { name: 'Add row' }).waitFor();
      // Type over a cell.
      await f.locator('.ts-row[data-i="2"] .ts-c[data-c="0"]').click();
      await page.keyboard.type('Renamed task');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('table[data-tdoc-sheet] tr[data-row="r3"] td').textContent === 'Renamed task');
      assert((await state(frame)).sel.r === 3, 'Enter moves down');
      // Pick a new tag for row 1's Status.
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="4"]').click();
      await page.keyboard.press('Enter');
      await f.getByRole('textbox', { name: 'Add a tag' }).fill('shipped');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      const tags = await frame.evaluate(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet] tr[data-row="r1"] td:nth-child(5) [data-tag]')).map((s) => s.textContent).join());
      assert(tags === 'open', `Escape cancels the picker: ${tags}`);
      // A second click on the active tag cell opens the picker too.
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="4"]').click();
      await f.getByRole('textbox', { name: 'Add a tag' }).fill('shipped');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet] tr[data-row="r1"] td:nth-child(5) [data-tag]')).map((s) => s.textContent).join() === 'open,shipped');
      // Toggle a checkbox with Space (a click beside the box selects), then
      // with a click on the box itself.
      const doneCell = () => frame.evaluate(() => document.querySelector('table[data-tdoc-sheet] tr[data-row="r1"] td:nth-child(6)').textContent);
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="5"]').click({ position: { x: 6, y: 6 } });
      await page.keyboard.press(' ');
      await frame.waitForFunction(() => document.querySelector('table[data-tdoc-sheet] tr[data-row="r1"] td:nth-child(6)').textContent === '✓');
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="5"] .ts-check').click();
      assert(await doneCell() === '', 'a click on the box unchecks it');
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="5"] .ts-check').click();
      assert(await doneCell() === '✓', 'and checks it again');
      // Add a row: it gets the next id.
      await f.getByRole('button', { name: 'Add row' }).click();
      await frame.waitForFunction(() => !!document.querySelector('table[data-tdoc-sheet] tr[data-row="r31"]'));
      // Paste a 2×2 range from a spreadsheet into the new row; it adds one more.
      await frame.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'Pasted A\tBo\nPasted B\tCy\n');
        document.querySelector('.ts-grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await frame.waitForFunction(() => document.querySelector('table[data-tdoc-sheet] tr[data-row="r32"] td').textContent === 'Pasted B');
      // Undo the paste, redo it.
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => !document.querySelector('table[data-tdoc-sheet] tr[data-row="r32"]'));
      await page.keyboard.press(`${MOD}+Shift+z`);
      await frame.waitForFunction(() => !!document.querySelector('table[data-tdoc-sheet] tr[data-row="r32"]'));
      await shot(page, 'sheet-edit-desktop');
      // Save: the editor's own path, a new version.
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await save.waitFor();
      await page.waitForFunction(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Save'); return b && !b.disabled; });
      await save.click();
      await page.waitForURL(/\/d\/editable\/v\/2/, { timeout: 10000 });
      const v2 = fs.readFileSync(path.join(root, 'editable', 'v2', 'index.html'), 'utf8');
      assert(/<tr data-row="r3"><td>Renamed task<\/td>/.test(v2), 'the edited cell is in v2');
      assert(/<span data-tag="">shipped<\/span>|<span data-tag>shipped<\/span>/.test(v2), 'the new tag is in v2');
      assert(/data-row="r32"><td>Pasted B<\/td><td>Cy<\/td>/.test(v2), 'the pasted row is in v2');
      assert(!/data-tdoc-provider|ts-grid|contenteditable/.test(v2), 'no viewer markup is saved');
      assert(!/#sheet=|aria-sort|is-active/.test(v2), `no view state is saved: ${(v2.match(/.{40}(#sheet=|aria-sort|is-active).{40}/) || [''])[0]}`);
    });

    await test('an agent\'s sheets through the CLI render: tdoc-new --from-csv, and hand-written markup', async () => {
      let frame = await open('expenses');
      const info = await frame.evaluate(() => ({
        glyphs: Array.from(document.querySelectorAll('.ts-h .ts-glyph')).map((g) => g.getAttribute('aria-label')).join(),
        vendor: document.querySelector('.ts-row[data-i="0"] .ts-c[data-c="1"]').textContent,
        tags: Array.from(document.querySelectorAll('.ts-row[data-i="2"] .ts-tag')).map((t) => t.textContent).join(),
        count: document.querySelector('.ts-count').textContent,
      }));
      assert(info.glyphs === 'Date,Text,Number,Tags,Checkbox', info.glyphs);
      assert(info.vendor === 'Acme, Inc.' && info.tags === 'travel,hotel' && info.count === '3 rows', JSON.stringify(info));
      frame = await open('handwritten');
      const hand = await frame.evaluate(() => ({ headers: Array.from(document.querySelectorAll('.ts-h b')).map((b) => b.textContent).join(), rows: document.querySelector('.ts-count').textContent, tabs: document.querySelector('.ts-tabs').hidden }));
      assert(hand.headers === 'Item,Qty,Where' && hand.rows === '2 rows' && hand.tabs, JSON.stringify(hand));
    });

    await test('import: a CSV chosen from Create a doc becomes a typed sheet doc', async () => {
      await page.goto(`${base}/`);
      await page.getByRole('button', { name: 'Create a doc' }).click();
      await page.getByRole('menuitem', { name: /Import a spreadsheet/ }).waitFor();
      await page.keyboard.press('Escape');
      await page.setInputFiles('[data-testid="sheet-import-input"]', importCsv);
      await page.waitForURL(/\/d\/[^/]+\/v\/\d+/, { timeout: 15000 });
      const frame = docFrame() || await (async () => { await page.waitForTimeout(500); return docFrame(); })();
      await frameLoc().locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      const info = await frame.evaluate(() => ({
        h1: document.querySelector('h1').textContent,
        glyphs: Array.from(document.querySelectorAll('.ts-h .ts-glyph')).map((g) => g.getAttribute('aria-label')).join(),
        count: document.querySelector('.ts-count').textContent,
      }));
      assert(info.h1 === 'q3 budget' && info.glyphs === 'Text,Number,Text,Tags' && info.count === '3 rows', JSON.stringify(info));
      const slug = new URL(page.url()).pathname.split('/')[2];
      const meta = JSON.parse(fs.readFileSync(path.join(root, slug, 'meta.json'), 'utf8'));
      assert(meta.versions.length === 1 && !meta.versions[0].blank, `the import replaced the blank scaffold: ${JSON.stringify(meta.versions)}`);
      assert(meta.title === 'q3 budget', `titled from the heading: ${meta.title}`);
    });

    await test('import: an .xlsx with two worksheets becomes two tabs (SheetJS loads only now)', async () => {
      if (!xlsxReady) { console.log('    (skipped: npm ci for SheetJS)'); return; }
      const loaded = [];
      page.on('request', (r) => { if (/xlsx\.mini/.test(r.url())) loaded.push(r.url()); });
      await page.goto(`${base}/`);
      assert(!loaded.length, 'SheetJS is not part of the page until an .xlsx is chosen');
      await page.setInputFiles('[data-testid="sheet-import-input"]', xlsxFile);
      await page.waitForURL(/\/d\/[^/]+\/v\/\d+/, { timeout: 15000 });
      await frameLoc().locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      assert(loaded.length === 1, `SheetJS chunk fetched once: ${loaded}`);
      const frame = docFrame();
      const info = await frame.evaluate(() => ({ tabs: Array.from(document.querySelectorAll('.ts-tab')).map((t) => t.textContent).join(), dates: Array.from(document.querySelectorAll('.ts-row .ts-c[data-c="2"]')).map((c) => c.textContent).join() }));
      assert(info.tabs === 'Budget,People' && info.dates === '2026-01-31,2026-02-07', JSON.stringify(info));
    });

    await test('import: a CSV dropped on My docs asks "Import as sheet", then imports', async () => {
      await page.goto(`${base}/`);
      await page.getByRole('button', { name: 'Create a doc' }).waitFor();
      const text = fs.readFileSync(dropCsv, 'utf8');
      await page.evaluate((body) => {
        const dt = new DataTransfer();
        dt.items.add(new File([body], 'dropped.csv', { type: 'text/csv' }));
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, text);
      await page.locator('.sheet-drop-hint').waitFor();
      await shot(page, 'hub-drop-desktop');
      await page.evaluate((body) => {
        const dt = new DataTransfer();
        dt.items.add(new File([body], 'dropped.csv', { type: 'text/csv' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, text);
      await page.getByRole('dialog', { name: 'Import as sheet' }).waitFor();
      await shot(page, 'hub-import-dialog-desktop');
      await page.getByRole('button', { name: 'Import as sheet' }).click();
      await page.waitForURL(/\/d\/[^/]+\/v\/\d+/, { timeout: 15000 });
      await frameLoc().locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      // A file that is not a spreadsheet is refused with a message, no dialog.
      await page.goto(`${base}/`);
      await page.getByRole('button', { name: 'Create a doc' }).waitFor();
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await page.getByText('Drop a .csv, .tsv or .xlsx file to import it as a sheet').waitFor();
      assert(await page.getByRole('dialog', { name: 'Import as sheet' }).count() === 0, 'no dialog for a pdf');
    });

    await test('import: a friendly error for a file that cannot be a sheet', async () => {
      const bad = path.join(files, 'empty.csv');
      fs.writeFileSync(bad, '\n\n');
      await page.goto(`${base}/`);
      await page.setInputFiles('[data-testid="sheet-import-input"]', bad);
      await page.getByRole('dialog', { name: 'Could not import this file' }).waitFor();
      assert(/no rows to import/.test(await page.getByRole('alert').textContent()), 'says why');
      await page.getByRole('button', { name: 'Cancel' }).click();
    });

    await test('10,000 rows × 20 columns: imports through the browser, loads, scrolls inside a frame budget, sorts, searches, saves', async () => {
      await page.goto(`${base}/`);
      const ti = Date.now();
      await page.setInputFiles('[data-testid="sheet-import-input"]', bigCsv);
      await page.waitForURL(/\/d\/[^/]+\/v\/\d+/, { timeout: 60000 });
      const importMs = Date.now() - ti;
      const bigSlug = new URL(page.url()).pathname.split('/')[2];
      const stored = fs.statSync(path.join(root, bigSlug, 'v1', 'index.html')).size;
      assert(stored > 2 * 1024 * 1024 && stored < 8 * 1024 * 1024, `stored as one sheet doc over the old 2 MB cap: ${stored} bytes`);
      await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tdoc-sheet-view:')) localStorage.removeItem(k); });
      const t0 = Date.now();
      const frame = await open(bigSlug);
      const loadMs = Date.now() - t0;
      assert(await countText(frame) === '10,000 rows', await countText(frame));
      const domRows = await frame.evaluate(() => document.querySelectorAll('.ts-row').length);
      assert(domRows < 80, `virtualized: ${domRows} rows in the DOM`);
      const scroll = await frame.evaluate(() => new Promise((resolve) => {
        const grid = document.querySelector('.ts-grid');
        const gaps = [];
        let last = performance.now(), n = 0;
        function step(now) {
          gaps.push(now - last); last = now;
          grid.scrollTop += 1400;
          if (++n < 120) requestAnimationFrame(step);
          else {
            gaps.shift();
            gaps.sort((a, b) => a - b);
            resolve({ p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps[gaps.length - 1], at: grid.scrollTop, rows: document.querySelectorAll('.ts-row').length, first: document.querySelector('.ts-row .ts-c').textContent });
          }
        }
        requestAnimationFrame(step);
      }));
      assert(scroll.p95 < 50, `scroll frames: p95 ${scroll.p95.toFixed(1)}ms (max ${scroll.max.toFixed(1)}ms)`);
      assert(scroll.at > 100000 && scroll.rows < 80 && /^Customer \d+$/.test(scroll.first), JSON.stringify(scroll));
      const sortMs = await frame.evaluate(() => new Promise((resolve) => {
        const t = performance.now();
        document.querySelector('.ts-h[data-c="1"] .ts-hname').click();
        requestAnimationFrame(() => resolve(performance.now() - t));
      }));
      assert(sortMs < 600, `sort took ${sortMs.toFixed(0)}ms`);
      const searchMs = await frame.evaluate(() => new Promise((resolve) => {
        const input = document.querySelector('.ts-search input');
        input.value = 'customer 77';
        const t = performance.now();
        input.dispatchEvent(new Event('input'));
        const wait = () => (/of 10,000 rows/.test(document.querySelector('.ts-count').textContent) ? resolve(performance.now() - t - 140) : requestAnimationFrame(wait));
        wait();
      }));
      assert(searchMs < 600, `search took ${searchMs.toFixed(0)}ms past its debounce`);
      await shot(page, 'sheet-10k-desktop');
      // Edit one cell and Save: a new version of a multi-megabyte sheet.
      const trigger = page.getByRole('button', { name: /Document mode:/ });
      await trigger.click();
      await page.getByRole('menuitemradio', { name: 'Edit' }).click();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'edit');
      await frame.evaluate(() => { const i = document.querySelector('.ts-search input'); i.value = ''; i.dispatchEvent(new Event('input')); });
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '10,000 rows');
      await frame.evaluate(() => { const g = document.querySelector('.ts-grid'); g.scrollTop = 0; g.dispatchEvent(new Event('scroll')); });
      await page.frameLocator('iframe[aria-label="Document content"]').locator('.ts-row[data-i="0"] .ts-c[data-c="0"]').click();
      await page.keyboard.type('Edited at 10k');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Save'); return b && !b.disabled; }, null, { timeout: 20000 });
      const ts = Date.now();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(new RegExp(`/d/${bigSlug}/v/2`), { timeout: 60000 });
      const saveMs = Date.now() - ts;
      const v2 = fs.readFileSync(path.join(root, bigSlug, 'v2', 'index.html'), 'utf8');
      assert(/<td>Edited at 10k<\/td>/.test(v2) && (v2.match(/<tr data-row=/g) || []).length === 10000, 'v2 has the edit and every row');
      console.log(`    (10k × 20: import ${importMs}ms, ${(stored / 1048576).toFixed(1)} MB, open ${loadMs}ms, scroll p95 ${scroll.p95.toFixed(1)}ms, sort ${sortMs.toFixed(0)}ms, search ${searchMs.toFixed(0)}ms, save ${saveMs}ms)`);
    });

    await test('a phone: no sideways page scroll, the grid scrolls itself, menus are bottom sheets', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const p = await phone.newPage();
      const frame = await open('tracker', '', p);
      const f = p.frameLocator('iframe[aria-label="Document content"]');
      const m = await frame.evaluate(() => {
        const grid = document.querySelector('.ts-grid').getBoundingClientRect();
        const search = document.querySelector('.ts-search').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth - innerWidth, gridRight: grid.right, vw: innerWidth, gridScrolls: document.querySelector('.ts-grid').scrollWidth > document.querySelector('.ts-grid').clientWidth, searchW: search.width, gridW: grid.width };
      });
      assert(m.overflow <= 1, `page scrolls sideways: ${JSON.stringify(m)}`);
      assert(m.gridRight <= m.vw + 1 && m.gridScrolls, JSON.stringify(m));
      assert(m.searchW >= m.gridW - 2, `search spans the width: ${JSON.stringify(m)}`);
      await f.locator('.ts-row[data-i="1"] .ts-c[data-c="0"]').tap();
      const s = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(s.r === 1 && s.c === 0, JSON.stringify(s));
      await shot(p, 'sheet-phone');
      await f.getByRole('button', { name: 'Status column menu' }).tap();
      const menu = await f.locator('.ts-pop').boundingBox();
      assert(menu && Math.abs(menu.x) < 1 && Math.abs(menu.width - 390) < 2 && menu.y + menu.height > 844 - 2, `bottom sheet: ${JSON.stringify(menu)}`);
      await f.getByRole('menuitem', { name: 'Filter…' }).tap();
      await f.locator('.ts-pop .ts-val', { hasText: 'urgent' }).locator('input').tap();
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '6 of 30 rows');
      await shot(p, 'sheet-phone-filter');
      await phone.close();
    });

    await test('no page errors', async () => {
      assert(!errors.length, errors.join('\n'));
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(files, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
