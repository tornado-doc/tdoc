// Sheets in the browser, end to end against the local server:
//   - a CSV and an .xlsx chosen from New › Sheet, and a CSV dropped on My
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
//   - a sheet in a prose doc expands to full screen and back with its view
//     (search, sort, scroll) intact, #expand=1 opens it so, Esc closes, cell
//     comments work there; ?sheet=<n> is that tab on its own page; a doc that
//     is only a sheet has no expand button
//   - the summary row: Sum / Average / Count / Unique per column, over the
//     rows the filters leave, in the #hash, never in the document
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
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
  // 250 rows: past the 200 the frame lays out before the viewer arrives.
  writeDoc('twofifty', M.sheetDocumentHtml({ title: 'Two fifty', sheets: [{ name: 'Rows', columns: [{ name: 'N', type: 'number' }], rows: Array.from({ length: 250 }, (_, i) => ({ cells: [String(i + 1)] })) }] }), 'Two fifty');
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
  // A prose doc with two sheets in it (the RaftBench shape).
  writeDoc('prose', `<!doctype html><html><head><meta charset="utf-8"><title>Runs report</title></head><body><main><h1>Runs report</h1>
<p>What we ran and what came out of it. The tables below can be searched, filtered and sorted.</p>
${M.tableHtml({ name: 'Runs', columns: [{ name: 'Run', type: 'text' }, { name: 'Tasks', type: 'number' }, { name: 'Product', type: 'tags' }], rows: Array.from({ length: 60 }, (_, k) => ({ id: `r${k + 1}`, cells: [`run ${k + 1}`, String((k * 7) % 23), [k % 2 ? 'Raft' : 'Claude Code']] })) })}
${M.tableHtml({ name: 'Notes', columns: [{ name: 'Note', type: 'text' }], rows: [{ id: 'r1', cells: ['first'] }, { id: 'r2', cells: ['second'] }] })}
<h2>What next</h2><p>Three options, below.</p></main></body></html>`, 'Runs report');
  // A status update with sheets in it (the ji.market shape): five suppliers,
  // an 18-step plan and a 21-row inventory, as tabs.
  writeDoc('brief', `<!doctype html><html><head><meta charset="utf-8"><title>Supplier follow up</title></head><body><main><h1>Supplier follow up</h1>
<p>EGI and Potato are the two suppliers we are pricing first.</p>
${M.tableHtml({ name: 'Suppliers', columns: [{ name: 'Supplier', type: 'text' }, { name: 'Status', type: 'tags' }, { name: 'Next action', type: 'text' }, { name: 'Updated', type: 'date' }], rows: ['EGI', 'Potato', 'Mighty', 'Via', 'Great Buy'].map((n, k) => ({ id: `r${k + 1}`, cells: [n, [k < 2 ? 'Active' : 'Paused'], `Confirm per-SKU prices, case pack and minimum order with ${n}, then ask whether they allow listing on the marketplace and how often stock updates.`, `2026-11-${String(10 - k).padStart(2, '0')}`] })) })}
${M.tableHtml({ name: 'Plan', columns: [{ name: 'Step', type: 'text' }, { name: 'Detail', type: 'text' }], rows: Array.from({ length: 18 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Step ${k + 1}`, 'Route back to the old region with DNS weights and keep the old cluster warm for a while'.slice(0, 40 + (k % 3) * 15)] })) })}
${M.tableHtml({ name: 'Inventory', columns: [{ name: 'Item', type: 'text' }, { name: 'Qty', type: 'number' }], rows: Array.from({ length: 21 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Item ${k + 1}`, String(k * 3)] })) })}
<h2>Next</h2><p>Call EGI on Thursday.</p></main></body></html>`, 'Supplier follow up');
  // Eight columns, five rows: wider than the reading column.
  const eight = (attrs = '') => M.tableHtml({ name: 'Services', columns: ['Service', 'Owner', 'Region', 'Latency', 'Errors', 'Window', 'Fallback plan', 'Status'].map((name) => ({ name, type: 'text' })), rows: Array.from({ length: 5 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Service ${k + 1}`, 'Ana Ruiz', 'eu-west-2', '120 ms p95', '0.1%', 'Nov 18-20', 'Route back with DNS weights and keep the old cluster warm for three days.', 'Ready'] })) }).replace('<table data-tdoc-sheet', `<table data-tdoc-sheet${attrs}`);
  const proseAround = (body, root = '') => `<!doctype html><html${root}><head><meta charset="utf-8"><title>Services</title><style>main{max-width:660px;margin:0 auto}</style></head><body><main><h1>Services</h1><p>Where each service moves.</p>${body}<h2>Next</h2><p>Cut over on Monday.</p></main></body></html>`;
  writeDoc('wide-sheet', proseAround(eight()), 'Wide sheet');
  writeDoc('custom-sheet', proseAround(eight(), ' data-tdoc-design="custom"'), 'Custom sheet');
  writeDoc('fixed-sheet', proseAround(eight(' data-tdoc-table="fixed"')), 'Fixed sheet');
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
    // Editing and import are on for everyone (the `sheets` flag defaults on):
    // no flag is pinned here.
    await context.addInitScript(() => {
      try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {}
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
      await viewPage.frameLocator('iframe[aria-label="Document content"]').locator('.tdoc-sheet .ts-row, .tdoc-sheet .ts-empty, .ts-flat td, .ts-flat .ts-card').first().waitFor({ timeout: 15000 });
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

    await test('rows past 200 are only held back while the viewer is coming: never in compare mode, never if it fails', async () => {
      const frame = await open('twofifty');
      assert(await frame.evaluate(() => !document.getElementById('tdoc-sheets-pending')), 'the hold comes off once the viewer is mounted');
      // The viewer fails to load: the plain table shows every row.
      const failing = await context.newPage();
      await failing.route('**/sheets-viewer.js*', (r) => r.abort());
      await failing.goto(`${base}/d/twofifty/v/1`);
      await failing.frameLocator('iframe[aria-label="Document content"]').locator('table[data-tdoc-sheet]').waitFor({ timeout: 15000 });
      const ff = failing.frames().find((x) => x.url().includes('/frame'));
      await ff.waitForFunction(() => !document.getElementById('tdoc-sheets-pending'));
      const shown = await ff.evaluate(() => { const tr = document.querySelector('table[data-tdoc-sheet] tr[data-row="r250"]'); return getComputedStyle(tr).display; });
      assert(shown !== 'none', `row 250 shows without the viewer: ${shown}`);
      await failing.close();
      // Compare mode runs no viewer: every row shows there too.
      const cmp = await context.newPage();
      await cmp.goto(`${base}/d/twofifty/v/1`);
      await cmp.evaluate((src) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.id = 'cmp'; f.src = src; document.body.appendChild(f); }, `/d/twofifty/v/1/frame?tdoc_compare=1`);
      await cmp.waitForFunction(() => document.getElementById('cmp'));
      let cf = null;
      for (let k = 0; k < 50 && !cf; k++) { cf = cmp.frames().find((x) => x.url().includes('tdoc_compare=1')); if (!cf) await cmp.waitForTimeout(100); }
      await cf.waitForFunction(() => document.querySelector('table[data-tdoc-sheet] tr[data-row="r250"]') && !document.getElementById('tdoc-sheets-pending'));
      assert(await cf.evaluate(() => getComputedStyle(document.querySelector('table[data-tdoc-sheet] tr[data-row="r250"]')).display) !== 'none', 'compare mode shows row 250');
      assert(await cf.evaluate(() => !document.querySelector('.tdoc-sheet')), 'no grid in compare mode');
      await cmp.close();
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
      // Read mode: in Comment mode a click on a cell comments on it.
      await chooseMode(page, 'Read');
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'read');
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
      await chooseMode(page, 'Comment');
    });

    await test('a cell comment anchors to the row id and stays on its cell through a sort', async () => {
      const frame = await open('tracker');
      const f = frameLoc();
      await page.locator(modeSelector('comment')).waitFor();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      // Comment mode: a click on the cell is the comment on it.
      await f.locator('.ts-row[data-i="4"] .ts-c[data-c="1"]').click();
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
      await chooseMode(page, 'Edit');
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
      await chooseMode(page, 'Edit');
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
      // Copy quotes a cell Excel would run as a formula; a plain number stays.
      await frame.evaluate(() => { const g = document.querySelector('.ts-grid'); g.scrollTop = 0; g.dispatchEvent(new Event('scroll')); });
      await f.locator('.ts-row[data-i="5"] .ts-c[data-c="0"]').waitFor();
      await f.locator('.ts-row[data-i="5"] .ts-c[data-c="0"]').click();
      // (A leading ' makes it text: typed bare, =… is a formula now.)
      await page.keyboard.type('\'=HYPERLINK("http://evil.example")');
      await page.keyboard.press('Enter');
      await f.locator('.ts-row[data-i="5"] .ts-c[data-c="0"]').click();
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      const copied = await frame.evaluate(() => {
        const dt = new DataTransfer();
        document.querySelector('.ts-grid').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
        return dt.getData('text/plain');
      });
      assert(/^"?'=HYPERLINK/.test(copied) && /\tCy\t2$/.test(copied.split('\n')[0]), `copy guards formulas only: ${JSON.stringify(copied)}`);
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

    await test('import: a CSV chosen from New › Sheet becomes a typed sheet doc', async () => {
      await page.goto(`${base}/`);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Sheet', exact: true }).click();
      await page.getByRole('menuitem', { name: /Import CSV or Excel/ }).waitFor();
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
      // Dates are stored ISO; a cell's own Excel date format (m/d/yy) is
      // kept as its number format and shows that way.
      const info = await frame.evaluate(() => ({ tabs: Array.from(document.querySelectorAll('.ts-tab')).map((t) => t.textContent).join(), dates: Array.from(document.querySelectorAll('.ts-row .ts-c[data-c="2"]')).map((c) => c.textContent).join(), stored: Array.from(document.querySelectorAll('table[data-tdoc-sheet] tbody tr')).slice(0, 2).map((tr) => tr.cells[2].textContent + (tr.cells[2].getAttribute('data-num') || '')).join() }));
      assert(info.tabs === 'Budget,People' && info.dates === '2026-01-31,2/7/2026' && info.stored === '2026-01-31,2026-02-07date:us', JSON.stringify(info));
    });

    await test('import: a CSV dropped on My docs asks "Import as sheet", then imports', async () => {
      await page.goto(`${base}/`);
      await page.getByRole('button', { name: 'New', exact: true }).waitFor();
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
      await page.getByRole('button', { name: 'New', exact: true }).waitFor();
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await page.getByText('Drop a .csv, .tsv or .xlsx file to import it as a sheet').waitFor();
      assert(await page.getByRole('dialog', { name: 'Import as sheet' }).count() === 0, 'no dialog for a pdf');
    });

    await test('New sheet: a blank sheet with typed columns opens straight into Edit mode', async () => {
      await page.goto(`${base}/`);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Sheet', exact: true }).click();
      const item = page.getByRole('menuitem', { name: /Blank sheet/ });
      await item.waitFor();
      const items = await page.getByRole('menuitem').allTextContents();
      const at = items.findIndex((x) => /Blank sheet/.test(x));
      assert(at >= 0 && /Import CSV or Excel/.test(items[at + 1] || ''), `Blank sheet sits next to Import: ${JSON.stringify(items)}`);
      await shot(page, 'hub-new-sheet-menu-desktop');
      await item.click();
      await page.waitForURL(/\/d\/[^/]+\/v\/1(?:[?#]|$)/, { timeout: 15000 });
      await frameLoc().locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      const frame = docFrame();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'edit');
      const info = await frame.evaluate(() => ({
        glyphs: Array.from(document.querySelectorAll('.ts-h .ts-glyph')).map((g) => g.getAttribute('aria-label')).join(),
        keys: Array.from(document.querySelectorAll('table[data-tdoc-sheet] th')).map((th) => th.getAttribute('data-key')).join(),
        count: document.querySelector('.ts-count').textContent,
        addRow: !!document.querySelector('.ts-add-row:not([hidden])'),
      }));
      assert(info.glyphs === 'Text,Tags,Date,Number,Checkbox' && info.keys === 'c1,c2,c3,c4,c5' && info.count === '5 rows' && info.addRow, JSON.stringify(info));
      await frameLoc().locator('.ts-row[data-i="0"] .ts-c[data-c="0"]').click();
      await page.keyboard.type('First item');
      await page.keyboard.press('Enter');
      await shot(page, 'new-sheet-edit-desktop');
      await page.waitForFunction(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Save'); return b && !b.disabled; });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(/\/v\/2/, { timeout: 15000 });
      const slug = new URL(page.url()).pathname.split('/')[2];
      assert(/<td>First item<\/td>/.test(fs.readFileSync(path.join(root, slug, 'v2', 'index.html'), 'utf8')), 'saved');
      assert(JSON.parse(fs.readFileSync(path.join(root, slug, 'meta.json'), 'utf8')).title === 'Untitled sheet');
      // Phone: the same menu, the same sheet.
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const p2 = await phone.newPage();
      await p2.goto(`${base}/`);
      await p2.getByRole('button', { name: 'New', exact: true }).tap();
      await p2.getByRole('menuitem', { name: 'Sheet', exact: true }).tap();
      await p2.getByRole('menuitem', { name: /Blank sheet/ }).waitFor();
      await shot(p2, 'hub-new-sheet-menu-phone');
      await p2.getByRole('menuitem', { name: /Blank sheet/ }).tap();
      await p2.waitForURL(/\/d\/[^/]+\/v\/1(?:[?#]|$)/, { timeout: 15000 });
      await p2.frameLocator('iframe[aria-label="Document content"]').locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      await p2.waitForTimeout(400);
      await shot(p2, 'new-sheet-edit-phone');
      await phone.close();
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
            resolve({ median: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps[gaps.length - 1], at: grid.scrollTop, rows: document.querySelectorAll('.ts-row').length, first: document.querySelector('.ts-row .ts-c').textContent });
          }
        }
        requestAnimationFrame(step);
      }));
      // Each frame jumps 1,400px (every row re-rendered): the worst case. The
      // median frame holds ~30fps on a shared CI runner; p95 catches stalls.
      assert(scroll.median < 34 && scroll.p95 < 80, `scroll frames: median ${scroll.median.toFixed(1)}ms, p95 ${scroll.p95.toFixed(1)}ms (max ${scroll.max.toFixed(1)}ms)`);
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
      await chooseMode(page, 'Edit');
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

    await test('full screen: a sheet in a prose doc expands and closes with its view intact; #expand=1 opens it so', async () => {
      // A doc that is only its sheet has no expand button: nothing to hide.
      let frame = await open('tracker');
      assert(await frame.evaluate(() => window.__tdocSheets.expanded().sheetOnly), 'tracker is a sheet-only doc');
      assert(!(await frameLoc().getByRole('button', { name: 'Expand sheet to full screen' }).isVisible()), 'no expand button on a sheet-only doc');

      frame = await open('prose');
      const f = frameLoc();
      assert(!(await frame.evaluate(() => window.__tdocSheets.expanded().sheetOnly)), 'prose is not sheet-only');
      await shot(page, 'sheet-expand-before');
      // A view to carry over: a search, a sort, a scrolled grid, a selected cell.
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('run');
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '60 rows');
      await f.locator('.ts-h[data-c="1"] .ts-hname').click();
      await frame.waitForFunction(() => window.__tdocSheets.tabs()[0].query.sort.length === 1);
      // (after the search's debounce, which scrolls to the top)
      await page.waitForTimeout(300);
      await frame.evaluate(() => { document.querySelector('.ts-grid').scrollTop = 400; });
      await page.waitForTimeout(100);
      const before = await frame.evaluate(() => ({ q: window.__tdocSheets.tabs()[0].query, top: document.querySelector('.ts-grid').scrollTop, first: document.querySelector('.ts-row .ts-c').textContent }));
      assert(before.top >= 390, `scrolled: ${before.top}`);

      await f.getByRole('button', { name: 'Expand sheet to full screen' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.expanded().on);
      // The page's top bar stays (mode, comments, share, ⋯): full screen is
      // the doc frame's whole area, as on every doc type.
      assert(!(await page.locator('.tdoc-document-app[data-visual-open]').count()), 'the shell is not covered');
      await page.locator('.tdoc-bar #tdoc-more-btn').waitFor();
      await page.waitForFunction(() => /(^#|&)expand=1(&|$)/.test(location.hash));
      await page.waitForTimeout(150);
      const big = await frame.evaluate(() => {
        const g = document.querySelector('.ts-grid').getBoundingClientRect();
        return { q: window.__tdocSheets.tabs()[0].query, top: document.querySelector('.ts-grid').scrollTop, search: document.querySelector('.ts-search input').value, w: g.width, h: g.height, vw: innerWidth, vh: innerHeight, close: !!document.querySelector('.ts-xhead button[aria-label^="Close full screen"]') };
      });
      const frameBox = await page.locator('iframe[aria-label="Document content"]').boundingBox();
      const barBox = await page.locator('.tdoc-bar').first().boundingBox();
      assert(frameBox.y >= barBox.y + barBox.height - 1 && frameBox.width === 1280, `the frame sits under the top bar: ${JSON.stringify({ frameBox, barBox })}`);
      assert(big.w > 1200 && big.h > 560 && big.vh === Math.round(frameBox.height), `the grid fills the frame: ${JSON.stringify(big)}`);
      assert(JSON.stringify(big.q) === JSON.stringify(before.q) && big.search === 'run', `search and sort carry in: ${JSON.stringify(big)}`);
      assert(Math.abs(big.top - before.top) < 2, `scroll carries in: ${big.top} vs ${before.top}`);
      await shot(page, 'sheet-expanded-desktop');

      // Change the view full screen, then Esc: the doc gets it back.
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('run 1');
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '11 of 60 rows');
      await f.locator('.ts-row[data-i="2"] .ts-c[data-c="0"]').click();
      await page.keyboard.press('Escape');
      await frame.waitForFunction(() => !window.__tdocSheets.expanded().on);
      await page.waitForFunction(() => !/expand=1/.test(location.hash));
      const back = await frame.evaluate(() => ({ count: document.querySelector('.ts-count').textContent, search: document.querySelector('.ts-search input').value, sel: window.__tdocSheets.selection(), inert: document.querySelectorAll('[inert]').length, expandShown: !document.querySelector('.ts-expand').hidden }));
      assert(back.count === '11 of 60 rows' && back.search === 'run 1' && back.sel.r === 2, `the view carries out: ${JSON.stringify(back)}`);
      assert(back.inert === 0 && back.expandShown, JSON.stringify(back));
      assert(await page.evaluate(() => /(^#|&)sheet=/.test(location.hash)), 'the view is still in the hash');

      // A link with #expand=1 opens the sheet full screen, view and all.
      await page.waitForTimeout(400);
      const link = await page.evaluate(() => location.href.split('#')[0] + location.hash + '&expand=1');
      const p2 = await context.newPage();
      await p2.goto(link);
      await p2.frameLocator('iframe[aria-label="Document content"]').locator('.tdoc-sheet.is-expanded').waitFor({ timeout: 15000 });
      const fr2 = p2.frames().find((x) => x.url().includes('/frame'));
      await fr2.waitForFunction(() => window.__tdocSheets && window.__tdocSheets.expanded().on && document.querySelector('.ts-count').textContent === '11 of 60 rows');
      // The close button exits too.
      await p2.frameLocator('iframe[aria-label="Document content"]').getByRole('button', { name: 'Close full screen (Esc)' }).click();
      await fr2.waitForFunction(() => !window.__tdocSheets.expanded().on);
      await p2.close();
    });

    await test('full screen keeps commenting: a cell comment there anchors to its cell', async () => {
      // A fresh load (not a hash change on the page already open), no saved view.
      await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tdoc-sheet-view:')) localStorage.removeItem(k); });
      await page.goto('about:blank');
      const frame = await open('prose', '#expand=1');
      await frame.waitForFunction(() => window.__tdocSheets.expanded().on);
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      const f = frameLoc();
      // Once the frame has grown to the window and the grid with it.
      await frame.waitForFunction(() => innerHeight > 700 && document.querySelector('.ts-grid').getBoundingClientRect().height > 560);
      await page.waitForTimeout(100);
      await f.locator('.ts-row[data-i="3"] .ts-c[data-c="0"]').click();
      await page.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
      assert(await page.locator('.tdoc-popup textarea').isVisible(), 'the composer shows over the full-screen sheet');
      await page.fill('.tdoc-popup textarea', 'Why only this run?');
      await page.click('.tdoc-popup .submit');
      const file = path.join(root, 'prose', 'comments.json');
      let saved = [];
      for (let k = 0; k < 50 && !saved.length; k++) { try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} if (!saved.length) await page.waitForTimeout(100); }
      assert(saved.length === 1 && saved[0].anchor.sheet && saved[0].anchor.sheet.table === 'Runs' && saved[0].anchor.sheet.row === 'r4', JSON.stringify(saved[0] && saved[0].anchor));
      await frame.waitForFunction(() => document.querySelector('.ts-row[data-i="3"] .ts-c[data-c="0"]').classList.contains('has-comment'));
    });

    await test('full screen, open on its own: ?sheet=<n> is that tab of the same doc, full page, with its comments', async () => {
      const frame = await open('prose');
      const f = frameLoc();
      await f.getByRole('tab', { name: 'Notes' }).click();
      await f.getByRole('tab', { name: 'Runs' }).click();
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('run 4');
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '11 of 60 rows');
      await f.getByRole('button', { name: 'Expand sheet to full screen' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.expanded().on);
      const alone = f.getByRole('link', { name: 'Open this sheet on its own page' });
      await alone.hover();
      const href = await alone.getAttribute('href');
      assert(/^\/d\/prose\/v\/1\?sheet=1#sheet=/.test(href), href);
      const [tab] = await Promise.all([context.waitForEvent('page'), alone.click()]);
      await tab.waitForLoadState();
      assert(new URL(tab.url()).pathname === '/d/prose/v/1' && new URL(tab.url()).searchParams.get('sheet') === '1', tab.url());
      const fl = tab.frameLocator('iframe[aria-label="Document content"]');
      await fl.locator('.tdoc-sheet.is-expanded .ts-row').first().waitFor({ timeout: 15000 });
      const tf = tab.frames().find((x) => x.url().includes('/frame'));
      const info = await tf.evaluate(() => ({ x: window.__tdocSheets.expanded(), count: document.querySelector('.ts-count').textContent, tabs: getComputedStyle(document.querySelector('.ts-tabs')).display, close: !document.querySelector('.ts-xhead button[aria-label^="Close"]').hidden, back: document.querySelector('.ts-xhead a[aria-label="Open the doc"]').getAttribute('href'), title: document.querySelector('.ts-xtitle').textContent }));
      assert(info.x.on && info.x.alone === 1 && info.count === '11 of 60 rows', `the view came along: ${JSON.stringify(info)}`);
      assert(info.tabs === 'none' && !info.close && /^\/d\/prose\/v\/1#sheet=/.test(info.back), JSON.stringify(info));
      assert(info.title === 'Runs report · Runs', info.title);
      // Its own page has the doc's top bar too: the mode switch is in ⋯.
      await tab.locator('.tdoc-bar #tdoc-more-btn').click();
      await tab.getByRole('menuitemradio', { name: 'Edit', exact: true }).waitFor({ timeout: 5000 });
      await tab.keyboard.press('Escape');
      // The same doc: the comment on Runs!A4 shows on its cell here. Esc does not leave.
      await fl.getByRole('searchbox', { name: 'Search this sheet' }).fill('');
      await tf.waitForFunction(() => document.querySelector('.ts-row[data-i="3"] .ts-c[data-c="0"]') && document.querySelector('.ts-row[data-i="3"] .ts-c[data-c="0"]').classList.contains('has-comment'));
      await tab.keyboard.press('Escape');
      await tab.waitForTimeout(150);
      assert(await tf.evaluate(() => window.__tdocSheets.expanded().on), 'Esc keeps the sheet page');
      await shot(tab, 'sheet-alone-desktop');
      // ?sheet=2 is the second tab, alone.
      await tab.goto(`${base}/d/prose/v/1?sheet=2`);
      await fl.locator('.tdoc-sheet.is-expanded .ts-row').first().waitFor({ timeout: 15000 });
      const tf2 = tab.frames().find((x) => x.url().includes('/frame'));
      assert(await tf2.evaluate(() => window.__tdocSheets.active() === 1 && document.querySelector('.ts-count').textContent === '2 rows'), 'tab 2 alone');
      // "Open the doc" goes back to the doc.
      await fl.getByRole('link', { name: 'Open the doc' }).click();
      await tab.waitForURL((u) => !u.search.includes('sheet='));
      await tab.close();
    });

    await test('full screen on a phone', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const p = await phone.newPage();
      const frame = await open('prose', '', p);
      const f = p.frameLocator('iframe[aria-label="Document content"]');
      await f.locator('.tdoc-sheet').scrollIntoViewIfNeeded();
      await shot(p, 'sheet-expand-phone-before');
      await f.getByRole('button', { name: 'Expand sheet to full screen' }).tap();
      await frame.waitForFunction(() => window.__tdocSheets.expanded().on);
      await p.waitForTimeout(200);
      const box = await p.locator('iframe[aria-label="Document content"]').boundingBox();
      assert(box.width === 390 && box.y >= 40 && box.y + box.height <= 845, JSON.stringify(box));
      assert(await p.locator('.tdoc-bar #tdoc-more-btn').isVisible(), 'the top bar stays on a phone');
      const m = await frame.evaluate(() => { const r = document.querySelector('.ts-grid').getBoundingClientRect(); return { w: r.width, h: r.height, overflow: document.documentElement.scrollWidth - innerWidth }; });
      assert(m.w > 340 && m.h > 450 && m.overflow <= 1, JSON.stringify(m));
      await shot(p, 'sheet-expanded-phone');
      await f.getByRole('button', { name: 'Close full screen (Esc)' }).tap();
      await frame.waitForFunction(() => !window.__tdocSheets.expanded().on);
      await phone.close();
    });

    await test('a small sheet in a prose doc reads as a fitted table (cards on a phone): text wraps, one short row of controls; a big one, full screen and a sheet doc keep the grid', async () => {
      const measure = (frame) => frame.evaluate(() => {
        const r = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : { width: 0, height: 0 }; };
        const flat = document.querySelector('.ts-flat'), grid = document.querySelector('.ts-grid');
        const long = flat.querySelector('td[data-c="2"], .ts-card-l[data-c="2"]');
        const lines = long ? Math.round(long.getBoundingClientRect().height / parseFloat(getComputedStyle(long).lineHeight || 20)) : 0;
        return { x: window.__tdocSheets.expanded(), flat: getComputedStyle(flat).display !== 'none', grid: getComputedStyle(grid).display !== 'none', cards: flat.classList.contains('is-cards'),
          flatScrollsX: flat.scrollWidth > flat.clientWidth + 1, flatScrollsY: flat.scrollHeight > flat.clientHeight + 1, lines, rows: flat.querySelectorAll('tbody tr, .ts-card').length,
          labels: [...flat.querySelectorAll('.ts-card-k')].slice(0, 3).map((k) => k.textContent), first: (flat.querySelector('tbody td, .ts-card-t') || {}).textContent,
          bar: r('.ts-bar').height, search: r('.ts-search').width, input: r('.ts-search input').width, sheetW: r('.tdoc-sheet').width, colW: document.querySelector('main').clientWidth, overflow: document.documentElement.scrollWidth - innerWidth };
      });
      for (const [name, vp] of [['desktop', null], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
        const ctx = vp ? await browser.newContext(vp) : context;
        const p = vp ? await ctx.newPage() : page;
        const frame = await open('brief', '', p);
        const f = p.frameLocator('iframe[aria-label="Document content"]');
        await f.locator('.tdoc-sheet').scrollIntoViewIfNeeded();
        await p.waitForTimeout(150);
        let m = await measure(frame);
        assert(m.x.embed && m.x.fit && m.x.flat && m.flat && !m.grid, `${name}: a small sheet in a prose doc is the flat view: ${JSON.stringify(m)}`);
        assert(m.cards === (name === 'phone'), `${name}: cards only on a phone: ${JSON.stringify(m)}`);
        assert(!m.flatScrollsX && m.lines >= 2 && m.rows === 5 && m.overflow <= 1, `${name}: fits the width, long text wraps: ${JSON.stringify(m)}`);
        if (m.cards) assert(m.first === 'EGI' && m.labels[0] === 'Status:' && m.labels[1] === 'Next action:', `card title and labels: ${JSON.stringify(m)}`);
        assert(m.bar <= 32 && m.search <= 30 && m.input < 1, `${name}: one short row of controls, search an icon: ${JSON.stringify(m)}`);
        await shot(p, `sheet-flat-${name}`);
        // Idle, nothing renders again: no flat re-render, no table relayout loop.
        const idle = await frame.evaluate(() => new Promise((done) => {
          const n = { flat: 0, layout: 0 };
          const style = document.querySelector('style#tdoc-provider-table-layout');
          const a = new MutationObserver(() => n.flat++); a.observe(document.querySelector('.ts-flat'), { childList: true });
          const b = new MutationObserver(() => n.layout++); if (style) b.observe(style, { childList: true, characterData: true, subtree: true });
          setTimeout(() => { a.disconnect(); b.disconnect(); done(n); }, 3000);
        }));
        assert(idle.flat <= 1 && idle.layout <= 1, `${name}: idle for 3 s: ${JSON.stringify(idle)}`);
        // Search filters the flat view; the icon opens it.
        await f.locator('.ts-search').click();
        await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('potato');
        await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '1 of 5 rows' && document.querySelectorAll('.ts-flat tbody tr, .ts-flat .ts-card').length === 1);
        await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('');
        await frame.waitForFunction(() => document.querySelectorAll('.ts-flat tbody tr, .ts-flat .ts-card').length === 5);
        await frame.evaluate(() => document.activeElement.blur());
        if (name === 'desktop') {
          // A header sorts.
          await f.locator('.ts-flat th button', { hasText: 'Updated' }).click();
          await frame.waitForFunction(() => document.querySelector('.ts-flat tbody td').textContent === 'Great Buy');
          await f.locator('.ts-flat th button', { hasText: 'Updated' }).click();
          await frame.waitForFunction(() => document.querySelector('.ts-flat tbody td').textContent === 'EGI');
          // A cell of the flat view takes a comment, anchored to its row and column like the grid's.
          await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
          await f.locator('.ts-flat td[data-i="1"][data-c="2"]').click();
          await p.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
          await p.fill('.tdoc-popup textarea', 'Who calls Potato?');
          await p.click('.tdoc-popup .submit');
          const file = path.join(root, 'brief', 'comments.json');
          let saved = [];
          for (let k = 0; k < 50 && !saved.length; k++) { try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} if (!saved.length) await p.waitForTimeout(100); }
          assert(saved.length === 1 && saved[0].anchor.sheet && saved[0].anchor.sheet.table === 'Suppliers' && saved[0].anchor.sheet.row === 'r2', JSON.stringify(saved[0] && saved[0].anchor));
          await frame.waitForFunction(() => document.querySelector('.ts-flat td[data-i="1"][data-c="2"]').classList.contains('has-comment'));
          await page.keyboard.press('Escape');
        }
        // 18 rows: at most 15 shown, the rest scroll inside.
        await f.getByRole('tab', { name: 'Plan' }).click();
        await p.waitForTimeout(100);
        m = await measure(frame);
        assert(m.flat && m.flatScrollsY && m.rows === 18, `${name}: 18 rows scroll after 15: ${JSON.stringify(m)}`);
        // The cap follows the width: narrower, the rows wrap taller and so does the 15-row cap.
        const capOk = () => frame.evaluate(() => { const f = document.querySelector('.ts-flat'), r = f.querySelectorAll('tbody tr, .ts-card')[14]; return { max: f.style.maxHeight, want: r.offsetTop + r.offsetHeight + (f.classList.contains('is-cards') ? 0 : 1) }; });
        let cap = await capOk();
        assert(cap.max === cap.want + 'px', `${name}: cap at the 15th row: ${JSON.stringify(cap)}`);
        if (name === 'desktop') {
          await p.setViewportSize({ width: 560, height: 860 });
          await frame.waitForFunction(() => innerWidth === 560);
          await p.waitForTimeout(400);
          cap = await capOk();
          assert(cap.max === cap.want + 'px', `after a resize: ${JSON.stringify(cap)}`);
          await p.setViewportSize({ width: 1280, height: 860 });
          await frame.waitForFunction(() => innerWidth === 1280);
          await p.waitForTimeout(300);
        }
        // Past 20 rows it is data to filter: the grid and the whole toolbar.
        await f.getByRole('tab', { name: 'Inventory' }).click();
        await p.waitForTimeout(100);
        m = await measure(frame);
        assert(m.grid && !m.flat && m.search > 200, `${name}: 21 rows get the grid: ${JSON.stringify(m)}`);
        // Full screen keeps the grid, for a small tab too.
        await f.getByRole('tab', { name: 'Suppliers' }).click();
        await f.getByRole('button', { name: 'Expand sheet to full screen' }).click();
        await frame.waitForFunction(() => window.__tdocSheets.expanded().on);
        await p.waitForTimeout(150);
        m = await measure(frame);
        assert(m.grid && !m.flat && m.search > 150, `${name}: full screen is the grid: ${JSON.stringify(m)}`);
        await f.getByRole('button', { name: 'Close full screen (Esc)' }).click();
        await frame.waitForFunction(() => !window.__tdocSheets.expanded().on && window.__tdocSheets.expanded().flat);
        // A sheet doc is unchanged.
        const sheetFrame = await open('tracker', '', p);
        m = await measure(sheetFrame);
        assert(!m.x.embed && m.x.sheetOnly && m.grid && !m.flat && m.search > 200, `${name}: a sheet doc is unchanged: ${JSON.stringify(m)}`);
        if (vp) await ctx.close();
      }
    });

    await test('a wide sheet in a prose doc takes the page width beside the column; a custom design and data-tdoc-table="fixed" keep the author\'s layout', async () => {
      let frame = await open('prose');
      let w = await frame.evaluate(() => ({ sheet: document.querySelector('.tdoc-sheet').getBoundingClientRect().width, col: document.querySelector('main').clientWidth, wide: document.querySelector('.tdoc-sheet').classList.contains('is-wide') }));
      assert(w.wide || w.sheet <= w.col + 1, JSON.stringify(w));
      frame = await open('wide-sheet');
      w = await frame.evaluate(() => ({ sheet: document.querySelector('.tdoc-sheet').getBoundingClientRect().width, col: document.querySelector('main').clientWidth, vw: innerWidth, flat: window.__tdocSheets.expanded().flat }));
      assert(w.flat && w.sheet > w.col + 100 && w.sheet <= Math.min(1200, w.vw - 48) + 1, `breaks out of the column: ${JSON.stringify(w)}`);
      await shot(page, 'sheet-flat-wide-desktop');
      for (const slug of ['custom-sheet', 'fixed-sheet']) {
        frame = await open(slug);
        w = await frame.evaluate(() => ({ x: window.__tdocSheets.expanded(), sheet: document.querySelector('.tdoc-sheet').getBoundingClientRect().width, col: document.querySelector('main').clientWidth, grid: getComputedStyle(document.querySelector('.ts-grid')).display }));
        assert(!w.x.fit && !w.x.flat && w.grid !== 'none' && w.sheet <= w.col + 1, `${slug}: the grid, in the column: ${JSON.stringify(w)}`);
      }
    });

    await test('the summary row: picked per column, follows the filters, rides in the #hash, is not an edit', async () => {
      const frame = await open('prose');
      const f = frameLoc();
      const tasks = Array.from({ length: 60 }, (_, k) => (k * 7) % 23);
      const sumOf = (ks) => ks.reduce((n, k) => n + tasks[k], 0);
      assert(await frame.evaluate(() => document.querySelector('.ts-foot').hidden), 'no summary row until one is asked for');
      await f.getByRole('button', { name: 'Tasks column menu' }).click();
      await f.getByRole('menuitemradio', { name: 'Sum' }).click();
      const footText = (c) => frame.evaluate((col) => document.querySelector(`.ts-fc[data-c="${col}"]`).textContent, c);
      await frame.waitForFunction(() => !document.querySelector('.ts-foot').hidden);
      assert(await footText(1) === `Sum${sumOf(tasks.map((_, k) => k)).toLocaleString('en-US')}`, await footText(1));
      // The foot stays in view at the grid's bottom while the rows scroll.
      const stuck = await frame.evaluate(() => { const g = document.querySelector('.ts-grid'); g.scrollTop = 300; const a = g.getBoundingClientRect(), b = document.querySelector('.ts-foot').getBoundingClientRect(); return Math.abs(a.bottom - b.bottom) < 4; });
      assert(stuck, 'the summary row sticks to the bottom');
      // A filter changes what is summed.
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('run 1');
      await frame.waitForFunction(() => document.querySelector('.ts-count').textContent === '11 of 60 rows');
      const shown = [0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
      await frame.waitForFunction((want) => document.querySelector('.ts-fc[data-c="1"]').textContent === want, `Sum${sumOf(shown)}`);
      // From the row itself: Unique on Product, then Average on Tasks.
      await f.locator('.ts-fc[data-c="2"]').click();
      await f.getByRole('menuitemradio', { name: 'Unique' }).click();
      await frame.waitForFunction(() => document.querySelector('.ts-fc[data-c="2"]').textContent === 'Unique2');
      assert(!(await f.getByRole('menuitemradio', { name: 'Sum' }).count()), 'menu closed');
      await f.locator('.ts-fc[data-c="1"]').click();
      const offered = await f.locator('.ts-pop [role="menuitemradio"]').allTextContents();
      assert(offered.join() === 'None,Sum,Average,Count', offered.join());
      await f.getByRole('menuitemradio', { name: 'Average' }).click();
      const avg = (sumOf(shown) / shown.length).toLocaleString('en-US', { maximumFractionDigits: 2 });
      await frame.waitForFunction((want) => document.querySelector('.ts-fc[data-c="1"]').textContent === want, `Average${avg}`);
      // In the hash; a reload brings it back.
      await page.waitForFunction(() => /%2522g%2522/.test(location.hash));
      await page.reload();
      await frameLoc().locator('.tdoc-sheet .ts-row').first().waitFor();
      const again = page.frames().find((x) => x.url().includes('/frame'));
      await again.waitForFunction((want) => document.querySelector('.ts-fc[data-c="1"]') && document.querySelector('.ts-fc[data-c="1"]').textContent === want, `Average${avg}`);
      // View state only: the author's table has no trace of it, nothing to save.
      assert(await again.evaluate(() => !document.querySelector('table[data-tdoc-sheet] .ts-foot, table[data-tdoc-sheet] [data-total]') && !/Average|Unique/.test(document.querySelector('table[data-tdoc-sheet]').outerHTML)), 'the document is untouched');
      await shot(page, 'sheet-summary-row');
      // None on both: the row goes away.
      for (const c of [1, 2]) {
        await frameLoc().locator(`.ts-fc[data-c="${c}"]`).click();
        await frameLoc().getByRole('menuitemradio', { name: 'None' }).click();
      }
      await again.waitForFunction(() => document.querySelector('.ts-foot').hidden);
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
