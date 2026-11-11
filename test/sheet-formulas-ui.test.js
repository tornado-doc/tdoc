// Sheets, formulas, in the browser against the local server:
//   - Read: formula cells show computed values (a stale value in the HTML is
//     recomputed); the document is not touched; no formula bar
//   - Edit: typing =… makes a formula (data-formula on the <td>, its value as
//     the text); an edit recomputes what depends on it, across tabs; the
//     formula bar shows the active cell's formula and edits it; Save keeps
//     formula and value; '=… is text
//   - insert / delete rows and columns shift references; undo puts them back
//   - fill down and copy/paste move relative references
//   - a renamed tab is renamed in formulas; a cycle shows #CYCLE!
//   - a hostile sheet (heavy formulas) opens and stays usable: #BUSY!
//   - 10,000 formulas open in budget
//   - a phone: Read and Edit with the formula bar
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheet-formulas-ui.test.js');
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
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

(async () => {
  const M = await import('../shared/sheet-markup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheet-formulas-'));
  const writeDoc = (slug, html) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  // A small budget: items, quantities, prices, line totals, and a Summary
  // tab that reads it. The SUM's text in the HTML is stale on purpose.
  const budget = () => M.sheetDocumentHtml({ title: 'Budget', sheets: [
    { name: 'Items', columns: [
      { name: 'Item', type: 'text' }, { name: 'Qty', type: 'number' }, { name: 'Price', type: 'number' }, { name: 'Total', type: 'number' }, { name: 'Note', type: 'text' },
    ], rows: [
      { id: 'r1', cells: ['Paper', '3', '4.5', '13.5', ''], formulas: [null, null, null, '=B1*C1'] },
      { id: 'r2', cells: ['Pens', '10', '1.2', '12', ''], formulas: [null, null, null, '=B2*C2'] },
      { id: 'r3', cells: ['Ink', '2', '20', '40', ''], formulas: [null, null, null, '=B3*C3'] },
      { id: 'r4', cells: ['Total', '', '', '0', ''], formulas: [null, null, null, '=SUM(D1:D3)', '=IF(D4>50,"over","ok")'] },
      { id: 'r5', cells: ['', '', '', '', ''] },
    ] },
    { name: 'Summary', columns: [{ name: 'What', type: 'text' }, { name: 'Value', type: 'text' }], rows: [
      { id: 'r1', cells: ['Spend', ''], formulas: [null, '=Items!D4'] },
      { id: 'r2', cells: ['Biggest', ''], formulas: [null, '=INDEX(Items!A1:A3,MATCH(MAX(Items!D1:D3),Items!D1:D3,0))'] },
      { id: 'r3', cells: ['Today', ''], formulas: [null, '=TEXT(TODAY(),"yyyy")'] },
      { id: 'r4', cells: ['Loop', ''], formulas: [null, '=B4+1'] },
    ] },
  ] });
  for (const slug of ['read', 'edit', 'shift', 'fill', 'rename', 'phone']) writeDoc(slug, budget());
  // Hostile: 3,000 formulas that each read 20,000 long cells many ways.
  writeDoc('hostile', M.sheetDocumentHtml({ title: 'Heavy', sheets: [{ name: 'H', columns: [{ name: 'Text', type: 'text' }, { name: 'F', type: 'text' }], rows: Array.from({ length: 20000 }, (_, k) => ({ id: `r${k + 1}`, cells: ['x'.repeat(300), ''], formulas: [null, k < 3000 ? '=CONCAT(A:A)&COUNTIF(A:A,"*x*x*x*x*x*y")&SUM(A:A)' : null] })) }] }));
  // 10,000 formulas.
  writeDoc('big', M.sheetDocumentHtml({ title: 'Big', sheets: [{ name: 'Rows', columns: [{ name: 'Name', type: 'text' }, { name: 'Qty', type: 'number' }, { name: 'Price', type: 'number' }, { name: 'Total', type: 'number' }], rows: Array.from({ length: 10000 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Item ${k}`, String(k % 50), String((k % 7) + 0.25), ''], formulas: [null, null, null, `=B${k + 1}*C${k + 1}`] })) }] }));

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheets: formulas in the browser');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const frameLoc = (p = page) => p.frameLocator('iframe[aria-label="Document content"]');
    async function open(slug, { viewPage = page } = {}) {
      await viewPage.goto('about:blank');
      await viewPage.goto(`${base}/d/${slug}/v/1`);
      await frameLoc(viewPage).locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 20000 });
      const frame = viewPage.frames().find((f) => f.url().includes('/frame'));
      await frame.waitForFunction(() => !!document.documentElement.getAttribute('data-tdoc-interaction-mode'));
      return frame;
    }
    const frameMode = (frame, m) => frame.waitForFunction((x) => document.documentElement.getAttribute('data-tdoc-interaction-mode') === x, m);
    const shown = (frame, t, r, c) => frame.evaluate(([a, b, d]) => window.__tdocSheets.shown(a, b, d), [t, r, c]);
    const tdOf = (frame, table, row, col) => frame.evaluate(([t, r, c]) => {
      const td = document.querySelectorAll('table[data-tdoc-sheet]')[t].querySelector(`tr[data-row="${r}"]`).cells[c];
      return { text: td.textContent, f: td.getAttribute('data-formula') };
    }, [table, row, col]);
    const saved = (slug, v) => fs.readFileSync(path.join(root, slug, `v${v}`, 'index.html'), 'utf8');
    async function save(slug, v) {
      await page.waitForFunction(() => { const b = document.querySelector('.tdoc-editor-toolbar button.primary'); return b && !b.disabled; });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(new RegExp(`/d/${slug}/v/${v}`), { timeout: 10000 });
    }
    const cell = (i, c, p = page) => frameLoc(p).locator(`.ts-row[data-i="${i}"] .ts-c[data-c="${c}"]`);
    const tab = (name, p = page) => frameLoc(p).getByRole('tab', { name });

    await test('Read: values are computed, stale text replaced on screen only, cross-tab, #CYCLE!; no formula bar', async () => {
      const frame = await open('read');
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      assert(await shown(frame, 0, 3, 3) === '65.5', `SUM shown: ${await shown(frame, 0, 3, 3)}`);
      assert(await shown(frame, 0, 3, 4) === 'over', 'IF');
      assert((await tdOf(frame, 0, 'r4', 3)).text === '0', 'Read leaves the document as it is');
      await cell(3, 3).click();
      assert(await frame.evaluate(() => document.querySelector('.ts-fx').hidden), 'no formula bar in Read');
      await shot(page, 'formulas-read-desktop');
      await tab('Summary').click();
      assert(await shown(frame, 1, 0, 1) === '65.5', 'cross-tab');
      assert(await shown(frame, 1, 1, 1) === 'Ink', 'INDEX/MATCH/MAX');
      assert(await shown(frame, 1, 2, 1) === String(new Date().getFullYear()), 'TODAY');
      assert(await shown(frame, 1, 3, 1) === '#CYCLE!', 'cycle');
    });

    await test('Edit: =… makes a formula, edits recompute dependents across tabs, the formula bar shows and edits, Save keeps formula + value', async () => {
      const frame = await open('edit');
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await cell(0, 3).click();
      await frame.waitForFunction(() => !document.querySelector('.ts-fx').hidden);
      assert(await frame.evaluate(() => document.querySelector('.ts-fx input').value) === '=B1*C1', 'formula bar');
      await shot(page, 'formulas-edit-desktop');
      // A plain cell: the hint, no bar.
      await cell(0, 0).click();
      assert(await frame.evaluate(() => document.querySelector('.ts-fx').hidden), 'no bar on a value');
      // Change a quantity: its line and the totals follow, on both tabs.
      await cell(0, 1).click();
      await page.keyboard.type('5');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"]').cells[3].textContent === '22.5');
      assert((await tdOf(frame, 0, 'r4', 3)).text === '74.5', 'SUM written into its cell with the edit');
      assert((await tdOf(frame, 1, 'r1', 1)).text === '74.5', 'the other tab too');
      // Type a formula in an empty cell.
      await cell(4, 3).click();
      await page.keyboard.type('=D4/2');
      await frame.waitForFunction(() => document.querySelector('.ts-editor'));
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').cells[3].getAttribute('data-formula') === '=D4/2');
      assert((await tdOf(frame, 0, 'r5', 3)).text === '37.25', `typed formula: ${JSON.stringify(await tdOf(frame, 0, 'r5', 3))}`);
      // Edit it in the formula bar.
      await cell(4, 3).click();
      await frameLoc().locator('.ts-fx input').fill('=D4*2');
      await frameLoc().locator('.ts-fx input').press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').cells[3].textContent === '149');
      // Double-click edits the formula, not the value.
      await cell(4, 3).dblclick();
      assert(await frame.evaluate(() => document.querySelector('.ts-editor').value) === '=D4*2', 'editor holds the formula');
      await page.keyboard.press('Escape');
      // '=… is text.
      await cell(4, 0).click();
      await page.keyboard.type("'=not a formula");
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').cells[0].textContent === '=not a formula');
      assert(!(await tdOf(frame, 0, 'r5', 0)).f, 'no data-formula');
      // A bad formula is #ERROR!, a missing function #NAME?.
      await cell(4, 4).click();
      await page.keyboard.type('=SUM(1');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').cells[4].textContent === '#ERROR!');
      // Undo takes the edit and its values back.
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').cells[4].textContent === '' && !document.querySelector('tr[data-row="r5"]').cells[4].hasAttribute('data-formula'));
      await save('edit', 2);
      const html = saved('edit', 2);
      assert(/<td data-formula="=SUM\(D1:D3\)">74\.5<\/td>/.test(html), 'saved: SUM with its value');
      assert(/<td data-formula="=D4\*2">149<\/td>/.test(html), 'saved: the typed formula');
      assert(/<td data-formula="=Items!D4">74\.5<\/td>/.test(html), 'saved: the other tab');
    });

    await test('insert / delete rows and columns shift references; undo puts them back', async () => {
      const frame = await open('shift');
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      // Insert a row above row 2.
      await cell(1, 0).click({ button: 'right' });
      await frameLoc().getByRole('menuitem', { name: 'Insert row above' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet]')[0].tBodies[0].rows.length === 6);
      assert((await tdOf(frame, 0, 'r4', 3)).f === '=SUM(D1:D4)', `SUM grows: ${(await tdOf(frame, 0, 'r4', 3)).f}`);
      assert((await tdOf(frame, 0, 'r2', 3)).f === '=B3*C3', `refs below move: ${(await tdOf(frame, 0, 'r2', 3)).f}`);
      assert((await tdOf(frame, 1, 'r1', 1)).f === '=Items!D5', `the other tab: ${(await tdOf(frame, 1, 'r1', 1)).f}`);
      assert(await shown(frame, 0, 4, 3) === '65.5', 'values unchanged');
      // Delete the row with Paper (row 1).
      await cell(0, 0).click({ button: 'right' });
      await frameLoc().getByRole('menuitem', { name: 'Delete row' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet]')[0].tBodies[0].rows.length === 5);
      assert((await tdOf(frame, 0, 'r4', 3)).f === '=SUM(D1:D3)', `SUM shrinks: ${(await tdOf(frame, 0, 'r4', 3)).f}`);
      assert((await tdOf(frame, 0, 'r4', 3)).text === '52', `total: ${(await tdOf(frame, 0, 'r4', 3)).text}`);
      assert((await tdOf(frame, 1, 'r1', 1)).text === '52', 'the other tab follows');
      // Insert a column left of Qty: every reference to B and on moves right.
      await frameLoc().getByRole('button', { name: 'Qty column menu' }).click();
      await frameLoc().getByRole('menuitem', { name: 'Insert column left' }).click();
      await page.keyboard.press('Escape');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"]').cells.length === 6);
      assert((await tdOf(frame, 0, 'r2', 4)).f === '=C2*D2', `columns move: ${(await tdOf(frame, 0, 'r2', 4)).f}`);
      assert((await tdOf(frame, 1, 'r1', 1)).f === '=Items!E4', `other tab, column: ${(await tdOf(frame, 1, 'r1', 1)).f}`);
      // Undo, three times: back to where it started.
      for (let k = 0; k < 3; k++) await page.locator('.tdoc-editor-toolbar button[aria-label="Undo"]').click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet]')[0].tBodies[0].rows.length === 5 && document.querySelector('tr[data-row="r4"]').cells[3].getAttribute('data-formula') === '=SUM(D1:D3)' && document.querySelector('tr[data-row="r1"]').cells.length === 5);
      assert((await tdOf(frame, 1, 'r1', 1)).f === '=Items!D4', `other tab undone: ${(await tdOf(frame, 1, 'r1', 1)).f}`);
      assert(await shown(frame, 0, 3, 3) === '65.5', 'value back');
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    await test('fill down and copy/paste move relative references; a renamed tab is renamed in formulas', async () => {
      const frame = await open('fill');
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      // Note column: =B1&"x" filled down rows 1-3.
      await cell(0, 4).click();
      await page.keyboard.type('=A1&" x"&$B$1');
      await page.keyboard.press('Enter');
      await cell(0, 4).click();
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press(`${MOD}+d`);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r3"]').cells[4].getAttribute('data-formula') === '=A3&" x"&$B$1');
      assert((await tdOf(frame, 0, 'r3', 4)).text === 'Ink x3', `filled: ${(await tdOf(frame, 0, 'r3', 4)).text}`);
      // Copy D1, paste into D5: =B5*C5.
      await cell(0, 3).click();
      await frame.evaluate(() => { const g = document.querySelector('.ts-grid'); const dt = new DataTransfer(); const e = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }); g.dispatchEvent(e); window.__copied = dt.getData('text/plain'); });
      await cell(4, 3).click();
      await frame.evaluate(() => { const g = document.querySelector('.ts-grid'); const dt = new DataTransfer(); dt.setData('text/plain', window.__copied); g.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').cells[3].getAttribute('data-formula') === '=B5*C5');
      // Rename the Items tab.
      await tab('Items').dblclick();
      await frameLoc().getByRole('textbox', { name: 'Tab name' }).fill('Q3 items');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet]')[1].querySelector('tr[data-row="r1"]').cells[1].getAttribute('data-formula') === "='Q3 items'!D4");
      assert(await shown(frame, 1, 0, 1) === '65.5', 'still computes');
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    await test('a hostile sheet opens and stays usable: what is over budget shows #BUSY!', async () => {
      const t0 = Date.now();
      const frame = await open('hostile');
      const ms = Date.now() - t0;
      const stats = await frame.evaluate(() => window.__tdocSheets.formulaStats());
      assert(stats && stats.busy, `stopped: ${JSON.stringify(stats)}`);
      assert(ms < 15000, `opened in ${ms} ms`);
      // The page answers.
      const t1 = Date.now();
      await frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
      assert(Date.now() - t1 < 1000, 'responsive');
      console.log(`    (hostile: opened in ${ms} ms, formulas stopped after ${stats.ms} ms)`);
    });

    await test('10,000 formulas open in budget', async () => {
      const t0 = Date.now();
      const frame = await open('big');
      const ms = Date.now() - t0;
      const stats = await frame.evaluate(() => window.__tdocSheets.formulaStats());
      assert(stats.formulas === 10000 && !stats.busy, JSON.stringify(stats));
      assert(await shown(frame, 0, 9999, 3) === String((9999 % 50) * ((9999 % 7) + 0.25)), 'last row');
      assert(stats.ms < 200, `compute ${stats.ms} ms`);
      // An edit in Edit mode: the cell and its formula follow in budget.
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await cell(0, 1).click();
      const e0 = Date.now();
      await page.keyboard.type('7');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"]').cells[3].textContent === '1.75');
      const editMs = Date.now() - e0;
      assert(editMs < 1500, `edit ${editMs} ms`);
      console.log(`    (10,000 formulas: page open ${ms} ms, compute ${stats.ms} ms, an edit end to end ${editMs} ms)`);
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    await test('a phone: Read shows values, Edit shows the formula bar', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
      const p = await phone.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      let frame = await open('phone', { viewPage: p });
      await chooseMode(p, 'Read');
      await frameMode(frame, 'read');
      assert(await shown(frame, 0, 3, 3) === '65.5', 'computed');
      await shot(p, 'formulas-read-phone');
      await chooseMode(p, 'Edit');
      await frameMode(frame, 'edit');
      // Once the editor's bar is in and the layout settled.
      await frame.waitForFunction(() => !document.querySelector('.ts-add-row').hidden);
      await p.waitForTimeout(300);
      await cell(3, 3, p).tap();
      await frame.waitForFunction(() => !document.querySelector('.ts-fx').hidden, null, { timeout: 5000 }).catch(async (e) => {
        throw new Error(`no formula bar: ${JSON.stringify(await frame.evaluate(() => ({ sel: window.__tdocSheets.selection(), mode: document.documentElement.getAttribute('data-tdoc-interaction-mode') })))}`);
      });
      const box = await frame.evaluate(() => { const r = document.querySelector('.ts-fx').getBoundingClientRect(); return { w: r.width, right: r.right, vw: innerWidth }; });
      assert(box.right <= box.vw + 1, `formula bar fits: ${JSON.stringify(box)}`);
      await shot(p, 'formulas-edit-phone');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `no sideways page scroll: ${overflow}`);
      await phone.close();
    });

    await test('no page errors', async () => {
      assert(!errors.length, errors.join('\n'));
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
