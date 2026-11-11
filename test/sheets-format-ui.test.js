// Sheets, cell formatting in the browser against the local server:
//   - Read mode shows the data formatted (bold, colours, fills, number
//     formats, borders, merges) and no toolbar; Edit mode shows one slim
//     format toolbar above the sheet
//   - the toolbar and shortcuts: bold / italic, text colour and fill from
//     the palette, currency / percent / decimals / the number format menu,
//     alignment, clear formatting;
//     each one undoable, all saved by the editor's Save as whitelisted
//     attributes (data-fmt, data-color, data-fill, data-num, …)
//   - merge all / horizontally / vertically and unmerge: the arrow keys step
//     over a merge, a covered cell selects the merge, copy gives the merge's
//     value once, a sorted view draws the cells apart; Save writes colspan /
//     rowspan and the reader draws them
//   - hostile attribute values in the markup draw nothing
//   - a phone: the toolbar's overflow goes into More; Read is data only
//   - 10,000 rows: open and scroll in the same budget as before formatting,
//     and a formatted 10,000-row sheet too
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheets-format-ui.test.js');
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
  const F = await import('../shared/sheet-format.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheets-format-'));
  const writeDoc = (slug, html) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  const columns = [
    { name: 'Item', type: 'text' }, { name: 'Team', type: 'tags', palette: 'Design:purple, Eng:blue, Ops:green' },
    { name: 'Amount', type: 'number' }, { name: 'Share', type: 'number' }, { name: 'Due', type: 'date' }, { name: 'Notes', type: 'text' },
  ];
  const ITEMS = ['Laptops', 'Licences', 'Offsite', 'Hosting', 'Contractors', 'Travel', 'Training', 'Hardware', 'Snacks', 'Books', 'Events', 'Swag'];
  const TEAMS = ['Eng', 'Design', 'Ops'];
  const plainRows = (n) => Array.from({ length: n }, (_, k) => ({ id: `r${k + 1}`, cells: [ITEMS[k % ITEMS.length], [TEAMS[k % 3]], String(1200 + k * 315.5), String(((k % 7) + 1) / 20), `2026-${String((k % 12) + 1).padStart(2, '0')}-${String((k % 27) + 1).padStart(2, '0')}`, k % 4 ? `note ${k + 1}` : 'Reviewed with finance'] }));
  // The formatted fixture: what an editor (or an import) leaves in the markup.
  const formatted = () => {
    const rows = plainRows(24);
    const fmt = (r, c, f) => { rows[r].attrs = rows[r].attrs || []; rows[r].attrs[c] = F.formatAttrString(f); };
    for (let r = 0; r < rows.length; r++) {
      fmt(r, 2, { num: 'currency:USD:2' });
      fmt(r, 3, { num: 'percent:0' });
      fmt(r, 4, { num: 'date:medium' });
    }
    fmt(0, 0, { b: true, fill: 'yellow' });
    fmt(2, 0, { b: true, color: 'red' });
    fmt(3, 0, { s: true, color: 'gray' });
    fmt(4, 0, { i: true, fill: 'teal', border: 't r b l' });
    fmt(5, 2, { num: 'currency:EUR:0', fill: 'green', b: true });
    fmt(0, 5, { valign: 'middle', align: 'center', fill: 'blue' });
    return M.sheetDocumentHtml({ title: 'Budget 2026', note: 'Spend by item, with the team that owns it.', sheets: [{ name: 'Budget', columns, rows, merges: [{ r: 0, c: 5, rs: 3, cs: 1 }, { r: 6, c: 0, rs: 1, cs: 2 }] }] });
  };
  writeDoc('fmt-read', formatted());
  writeDoc('fmt-phone', formatted());
  for (const slug of ['fmt-edit', 'fmt-merge', 'fmt-one']) writeDoc(slug, M.sheetDocumentHtml({ title: 'Budget 2026', sheets: [{ name: 'Budget', columns, rows: plainRows(24) }] }));
  // A small formatted sheet in a prose doc: the flat view (and phone cards).
  const small = plainRows(6);
  small[0].attrs = [F.formatAttrString({ b: true, fill: 'yellow' }), '', F.formatAttrString({ num: 'currency:USD:0' })];
  writeDoc('fmt-flat', `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>Plan</h1><p>One.</p><p>Two.</p><p>Three.</p>${M.tableHtml({ name: 'Budget', columns, rows: small, merges: [{ r: 1, c: 4, rs: 2, cs: 2 }] })}<p>After.</p></main></body></html>`);
  // Hostile attributes: every value outside the whitelist draws nothing.
  writeDoc('fmt-hostile', `<!doctype html><html><head><meta charset="utf-8"><title>H</title></head><body><main><h1>H</h1><table data-tdoc-sheet data-name="H"><thead><tr><th data-key="c1">A</th><th data-key="c2">B</th></tr></thead><tbody>
<tr data-row="r1"><td data-color="red;background:url(https://example.com/x)" data-fill="#f00" data-num="currency:XX:2" data-align="justify">12</td><td data-fmt="b onmouseover" colspan="0">x</td></tr>
<tr data-row="r2"><td data-num="number:2" rowspan="99999">1234.5</td><td data-fill="expression(alert(1))">y</td></tr></tbody></table></main></body></html>`);
  // 10,000 rows, plain and formatted.
  const bigRows = () => Array.from({ length: 10000 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Customer ${k}`, [TEAMS[k % 3]], String(k * 3.25), String((k % 100) / 100), '2026-03-01', `note ${k}`] }));
  writeDoc('big-plain', M.sheetDocumentHtml({ title: 'Big', sheets: [{ name: 'Rows', columns, rows: bigRows() }] }));
  const fr = bigRows();
  fr.forEach((row, k) => { row.attrs = [k % 5 ? '' : F.formatAttrString({ b: true, fill: 'yellow' }), '', F.formatAttrString({ num: 'currency:USD:2' }), F.formatAttrString({ num: 'percent:0' }), F.formatAttrString({ num: 'date:medium' })]; });
  writeDoc('big-fmt', M.sheetDocumentHtml({ title: 'Big', sheets: [{ name: 'Rows', columns, rows: fr, merges: Array.from({ length: 200 }, (_, k) => ({ r: k * 50, c: 5, rs: 3, cs: 1 })) }] }));

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheets: cell formatting, merges, the format toolbar');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const frameLoc = (p = page) => p.frameLocator('iframe[aria-label="Document content"]');
    async function open(slug, { viewPage = page, wait = '.tdoc-sheet .ts-row' } = {}) {
      await viewPage.goto('about:blank');
      await viewPage.goto(`${base}/d/${slug}/v/1`);
      await frameLoc(viewPage).locator(wait).first().waitFor({ timeout: 20000 });
      const frame = viewPage.frames().find((f) => f.url().includes('/frame'));
      await frame.waitForFunction(() => !!document.documentElement.getAttribute('data-tdoc-interaction-mode'));
      return frame;
    }
    const frameMode = (frame, m) => frame.waitForFunction((x) => document.documentElement.getAttribute('data-tdoc-interaction-mode') === x, m);
    const saved = (slug, v) => fs.readFileSync(path.join(root, slug, `v${v}`, 'index.html'), 'utf8');
    async function save(slug, v) {
      await page.waitForFunction(() => { const b = document.querySelector('.tdoc-editor-toolbar button.primary'); return b && !b.disabled; });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(new RegExp(`/d/${slug}/v/${v}`), { timeout: 10000 });
    }
    const cellSel = (i, c) => `.ts-row[data-i="${i}"] .ts-c[data-c="${c}"]`;
    const attr = (frame, row, c, name) => frame.evaluate(([r, cc, n]) => { const tr = document.querySelector(`tr[data-row="${r}"]`); const x = tr && tr.cells[cc]; return x ? x.getAttribute(n) : null; }, [row, c, name]);
    const tool = (name) => frameLoc().locator(`.ts-fbar button[aria-label="${name}"]`);
    async function editMode(frame) { await chooseMode(page, 'Edit'); await frameMode(frame, 'edit'); await frameLoc().locator('.ts-fbar:not([hidden])').waitFor(); }

    // ---- reading --------------------------------------------------------------
    await test('Read: formats and merges draw from the markup, number formats show, no toolbar', async () => {
      const frame = await open('fmt-read');
      const f = frameLoc();
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      const got = await frame.evaluate(() => {
        const c = (i, cc) => document.querySelector(`.ts-row[data-i="${i}"] .ts-c[data-c="${cc}"]`);
        const cs = (el) => getComputedStyle(el);
        return {
          bar: !!document.querySelector('.ts-fbar:not([hidden])'),
          bold: cs(c(0, 0)).fontWeight, fill: cs(c(0, 0)).backgroundColor,
          red: cs(c(2, 0)).color, strike: cs(c(3, 0).querySelector('.ts-t')).textDecorationLine,
          italic: cs(c(4, 0)).fontStyle, amount: c(1, 2).textContent, eur: c(5, 2).textContent, share: c(1, 3).textContent, due: c(1, 4).textContent,
          amountAlign: cs(c(1, 2)).justifyContent,
          mergeH: c(0, 5).getBoundingClientRect().height, rowH: c(1, 0).getBoundingClientRect().height, mergeText: c(0, 5).textContent,
          covered: !!c(1, 5), wideW: c(6, 0).getBoundingClientRect().width, colW: document.querySelector('.ts-h[data-c="0"]').getBoundingClientRect().width + document.querySelector('.ts-h[data-c="1"]').getBoundingClientRect().width,
          wideNext: !!c(6, 1),
        };
      });
      assert(!got.bar, 'no toolbar in Read');
      assert(Number(got.bold) >= 600 && got.fill !== 'rgba(0, 0, 0, 0)' && got.fill !== 'rgb(255, 255, 255)', `bold + fill: ${JSON.stringify(got)}`);
      assert(got.red === 'rgb(163, 38, 29)' && got.strike === 'line-through' && got.italic === 'italic', `colour, strike, italic: ${JSON.stringify(got)}`);
      assert(got.amount === '$1,515.50' && got.eur === '€2,778' && got.share === '10%' && got.due === 'Feb 2, 2026', `number formats: ${JSON.stringify(got)}`);
      assert(got.amountAlign === 'flex-end', 'numbers stay right-aligned');
      assert(got.mergeText === 'Reviewed with finance' && got.mergeH > got.rowH * 2.5 && !got.covered, `a vertical merge spans its rows: ${JSON.stringify(got)}`);
      assert(Math.abs(got.wideW - got.colW) <= 1 && !got.wideNext, `a horizontal merge spans its columns: ${JSON.stringify(got)}`);
      // Arrow keys step over a merge; a covered cell selects it.
      await f.locator(cellSel(0, 4)).click();
      await page.keyboard.press('ArrowRight');
      let s = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(s.r === 0 && s.c === 5, `onto the merge: ${JSON.stringify(s)}`);
      await page.keyboard.press('ArrowDown');
      s = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(s.r === 3 && s.c === 5, `down leaves it from its bottom: ${JSON.stringify(s)}`);
      await page.keyboard.press('ArrowUp');
      s = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(s.r === 0 && s.c === 5, `up into it selects its top: ${JSON.stringify(s)}`);
      await f.locator(cellSel(6, 0)).click();
      await page.keyboard.press('ArrowRight');
      s = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(s.r === 6 && s.c === 2, `right over a horizontal merge: ${JSON.stringify(s)}`);
      // Copy: a merge's value once, its covered cells blank (as Sheets does).
      await f.locator(cellSel(0, 4)).click();
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press(`${MOD}+c`);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      assert(clip === '2026-01-01\tReviewed with finance\n2026-02-02\t', `copy: ${JSON.stringify(clip)}`);
      await shot(page, 'after-read-desktop');
      // Sorted, the merge's rows part: drawn one by one.
      await f.getByRole('button', { name: 'Amount column menu' }).click();
      await f.getByRole('menuitem', { name: 'Sort descending' }).click();
      const parted = await frame.evaluate(() => !document.querySelector('.ts-c.fx-span[data-c="5"]') && !document.querySelector('.ts-c.fx-cov'));
      assert(parted, 'a sorted view draws merged rows apart');
      await f.getByRole('button', { name: 'Amount column menu' }).click();
      await f.getByRole('menuitem', { name: 'Sort ascending' }).click();
    });

    await test('flat view (a small sheet in a prose doc): formats, number formats and merges as a table', async () => {
      const frame = await open('fmt-flat', { wait: '.ts-flat table' });
      const got = await frame.evaluate(() => {
        const td = (i, c) => document.querySelector(`.ts-flat td[data-i="${i}"][data-c="${c}"]`);
        return { bold: td(0, 0).className, money: td(0, 2).textContent, span: td(1, 4).getAttribute('colspan') + 'x' + td(1, 4).getAttribute('rowspan'), covered: !!td(1, 5) || !!td(2, 4), fill: getComputedStyle(td(0, 0)).backgroundColor };
      });
      assert(/fx-b/.test(got.bold) && /fx-f-yellow/.test(got.bold) && got.fill === 'rgb(253, 244, 207)', `flat format: ${JSON.stringify(got)}`);
      assert(got.money === '$1,200' && got.span === '2x2' && !got.covered, `flat number format and merge: ${JSON.stringify(got)}`);
      await shot(page, 'after-flat-desktop');
    });

    await test('hostile attribute values draw nothing and break nothing', async () => {
      const frame = await open('fmt-hostile');
      const got = await frame.evaluate(() => {
        const c = (i, cc) => document.querySelector(`.ts-row[data-i="${i}"] .ts-c[data-c="${cc}"]`);
        return { a: c(0, 0).className, styleA: c(0, 0).getAttribute('style'), b: c(0, 1).className, n: c(1, 0).textContent, nClass: c(1, 0).className, fill: c(1, 1).className, spans: document.querySelectorAll('.fx-span').length, rows: document.querySelectorAll('.ts-row').length };
      });
      assert(!/fx-/.test(got.a) && !/url|background|#f00/.test(got.styleA), `junk colour/fill/align draws nothing: ${JSON.stringify(got)}`);
      assert(got.b === 'ts-c fx-b' && !/fx-/.test(got.fill), `only the valid token of a list: ${JSON.stringify(got)}`);
      assert(got.n === '1,234.50', `the valid format still applies: ${JSON.stringify(got)}`);
      // rowspan past the table is cut to it: one merge of the last row only = no merge.
      assert(got.rows === 2, `rows: ${JSON.stringify(got)}`);
    });

    // ---- the toolbar -------------------------------------------------------------
    await test('Edit: the toolbar formats the selection; shortcuts; Undo; Save writes whitelisted attributes', async () => {
      const frame = await open('fmt-edit');
      const f = frameLoc();
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      await shot(page, 'after-read-plain-desktop');
      await editMode(frame);
      await shot(page, 'after-edit-desktop');
      const bar = await frame.evaluate(() => { const b = document.querySelector('.ts-fbar').getBoundingClientRect(); return { h: b.height, more: !document.querySelector('.ts-fbar .fx-more').hidden, buttons: document.querySelectorAll('.ts-fbar .fx-g:not([hidden]) button').length }; });
      assert(bar.h <= 40 && !bar.more && bar.buttons === 12, `one slim row, everything fits on desktop: ${JSON.stringify(bar)}`);
      // Bold by button over a range.
      await f.locator(cellSel(0, 0)).click();
      await page.keyboard.press('Shift+ArrowDown');
      await tool('Bold').click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"] td').getAttribute('data-fmt') === 'b');
      assert(await attr(frame, 'r1', 0, 'data-fmt') === 'b', 'both cells');
      assert(await tool('Bold').getAttribute('aria-pressed') === 'true', 'Bold shows pressed');
      // Italic by keyboard.
      await page.keyboard.press(`${MOD}+i`);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"] td').getAttribute('data-fmt') === 'b i');
      // Text colour and fill from the palette.
      await tool('Text colour').click();
      await f.locator('.ts-pop button[aria-label="Red"]').click();
      await tool('Fill colour').click();
      await shot(page, 'after-edit-fill-popover-desktop');
      await f.locator('.ts-pop button[aria-label="Yellow"]').click();
      await frame.waitForFunction(() => { const x = document.querySelector('tr[data-row="r2"] td'); return x.getAttribute('data-color') === 'red' && x.getAttribute('data-fill') === 'yellow'; });
      // Currency on the Amount column, then one decimal fewer.
      await f.locator('.ts-h[data-c="2"] .ts-hname').click();
      await tool('Format as currency').click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r24"]').cells[2].getAttribute('data-num') === 'currency:USD:2');
      assert(await f.locator(cellSel(1, 2)).textContent() === '$1,515.50', 'shown as currency');
      await tool('Decrease decimal places').click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"]').cells[2].getAttribute('data-num') === 'currency:USD:1');
      // A date format from the 123 menu on the Due column.
      await f.locator('.ts-h[data-c="4"] .ts-hname').click();
      await tool('More number formats').click();
      await shot(page, 'after-edit-number-menu-desktop');
      await f.getByRole('menuitemradio', { name: /Date \(short month\)/ }).click();
      await frame.waitForFunction(() => document.querySelector('.ts-row[data-i="0"] .ts-c[data-c="4"]').textContent === 'Jan 1, 2026');
      // Alignment.
      await f.locator(cellSel(2, 1)).click();
      await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowRight');
      await tool('Align').click();
      await f.getByRole('menuitemradio', { name: 'Center' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r3"]').cells[1].getAttribute('data-align') === 'center');
      // Clear formatting (⌘\) on one cell; Undo on the editor bar brings it back.
      await f.locator(cellSel(0, 0)).click();
      await page.keyboard.press(`${MOD}+\\`);
      await frame.waitForFunction(() => !document.querySelector('tr[data-row="r1"] td').hasAttribute('data-fmt'));
      await page.locator('.tdoc-editor-toolbar button[aria-label="Undo"]').click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"] td').getAttribute('data-fmt') === 'b i');
      // Editing a value keeps the cell's format.
      await f.locator(cellSel(0, 0)).dblclick();
      await f.locator('.ts-editor').waitFor();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.type('Desks');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"] td').textContent === 'Desks');
      assert(await attr(frame, 'r1', 0, 'data-fmt') === 'b i', 'the format stays with the cell');
      await f.locator(cellSel(4, 0)).click();
      await shot(page, 'after-edit-formatted-desktop');
      await save('fmt-edit', 2);
      const html = saved('fmt-edit', 2);
      assert(/<td data-fmt="b i" data-color="red" data-fill="yellow">Desks<\/td>/.test(html), 'saved: the first cell');
      assert(/data-num="currency:USD:1"/.test(html) && /data-num="date:medium"/.test(html) && /data-align="center"/.test(html), 'saved: number formats, align');
      assert(!/style="[^"]/.test(html.split("<table")[1].split("</table>")[0]), "no inline style in the sheet");
      assert(!/fx-|ts-fbar/.test(html), 'no viewer classes or toolbar saved');
    });

    await test('one formatting row: a sheet-only doc in Edit shows no prose formatting buttons; the editor bar keeps Undo, Redo, Save', async () => {
      const frame = await open('fmt-one');
      await editMode(frame);
      const bar = await page.evaluate(() => {
        const t = document.querySelector('.tdoc-editor-toolbar');
        const has = (name) => !!t.querySelector(`button[aria-label="${name}"]`);
        return { prose: ['Bold', 'Italic', 'Heading 1', 'Heading 2', 'Heading 3', 'Bullet list', 'Numbered list', 'Quote', 'Inline code', 'Add link', 'Insert diagram'].filter(has), undo: has('Undo'), redo: has('Redo'), save: has('Save'), discard: has('Discard draft') };
      });
      assert(!bar.prose.length, `no prose tools on a sheet doc: ${bar.prose.join(', ')}`);
      assert(bar.undo && bar.redo && bar.save && bar.discard, `the editor bar keeps its commit tools: ${JSON.stringify(bar)}`);
      assert(await frame.evaluate(() => !!document.querySelector('.ts-fbar:not([hidden]):not(.fx-float)')), 'the sheet row is shown, in place');
      await shot(page, 'after-edit-sheet-only-one-row-desktop');
    });

    await test('a sheet in a prose doc: the prose row stays; the sheet row floats in only while a cell is selected', async () => {
      const frame = await open('fmt-flat', { wait: '.ts-flat table' });
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await frameLoc().locator('.ts-row').first().waitFor();
      assert(await page.locator('.tdoc-editor-toolbar button[aria-label="Heading 1"]').count() === 1, 'prose tools stay in a prose doc');
      const shown = () => frame.evaluate(() => !!document.querySelector('.ts-fbar:not([hidden])'));
      assert(!(await shown()), 'no sheet row before a cell is selected');
      const top0 = await frame.evaluate(() => document.querySelector('.ts-grid').getBoundingClientRect().top);
      await frameLoc().locator(cellSel(1, 0)).click();
      await frame.waitForFunction(() => !!document.querySelector('.ts-fbar.fx-float:not([hidden])'));
      const top1 = await frame.evaluate(() => document.querySelector('.ts-grid').getBoundingClientRect().top);
      assert(Math.abs(top1 - top0) < 1, `the grid does not move: ${top0} → ${top1}`);
      await shot(page, 'after-edit-embedded-cell-selected-desktop');
      await tool('Bold').click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"] td').getAttribute('data-fmt') === 'b');
      // Into the prose: the sheet row goes.
      await frameLoc().locator('p', { hasText: 'One.' }).click();
      await frame.waitForFunction(() => !document.querySelector('.ts-fbar:not([hidden])'));
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    await test('merge all / horizontally / vertically, unmerge; Save writes colspan and rowspan', async () => {
      const frame = await open('fmt-merge');
      const f = frameLoc();
      await editMode(frame);
      await f.locator(cellSel(0, 0)).click();
      await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowRight');
      await tool('Merge cells').click();
      await shot(page, 'after-edit-merge-menu-desktop');
      await f.getByRole('menuitem', { name: 'Merge all' }).click();
      await frame.waitForFunction(() => { const x = document.querySelector('tr[data-row="r1"] td'); return x.getAttribute('colspan') === '2' && x.getAttribute('rowspan') === '2'; });
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r2"]').cells.length) === 4, 'covered cells are out of the markup');
      const toastText = await frame.evaluate(() => (document.querySelector('.ts-toast') || {}).textContent || '');
      assert(/top-left value/.test(toastText), `says what a merge keeps: ${toastText}`);
      // Typing into the merge edits its top-left cell.
      await page.keyboard.type('Merged');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"] td').textContent === 'Merged');
      let s = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(s.r === 2 && s.c === 0, `Enter leaves the merge from its bottom: ${JSON.stringify(s)}`);
      // Horizontally and vertically.
      await f.locator(cellSel(4, 0)).click();
      await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
      await tool('Merge cells').click();
      await f.getByRole('menuitem', { name: 'Merge horizontally' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"] td').getAttribute('colspan') === '3' && document.querySelector('tr[data-row="r6"] td').getAttribute('colspan') === '3');
      await f.locator(cellSel(8, 5)).click();
      await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
      await tool('Merge cells').click();
      await f.getByRole('menuitem', { name: 'Merge vertically' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r9"]').cells[5] && document.querySelector('tr[data-row="r9"]').cells[5].getAttribute('rowspan') === '3');
      await shot(page, 'after-edit-merged-desktop');
      // A row inserted inside a merge grows it (the structure's own menu).
      await f.locator('.ts-row[data-i="9"] .ts-n').click();
      await f.locator('.ts-row[data-i="9"] .ts-n').click();
      await f.getByRole('menuitem', { name: 'Insert row above' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r9"]').cells[5].getAttribute('rowspan') === '4');
      // Unmerge the first.
      await f.locator(cellSel(0, 0)).click();
      await tool('Merge cells').click();
      await f.getByRole('menuitem', { name: 'Unmerge' }).click();
      await frame.waitForFunction(() => !document.querySelector('tr[data-row="r1"] td').hasAttribute('colspan') && document.querySelector('tr[data-row="r2"]').cells.length === 6);
      await save('fmt-merge', 2);
      const html = saved('fmt-merge', 2);
      assert(/<tr data-row="r5"><td colspan="3">Contractors<\/td>/.test(html), 'saved: a horizontal merge');
      assert(/<td rowspan="4">Reviewed with finance<\/td>/.test(html), 'saved: a vertical merge, grown');
      assert(!/<td colspan="2" rowspan="2">/.test(html), 'saved: the unmerged one');
    });

    // ---- phone ---------------------------------------------------------------------
    await test('a phone: Read is data only; Edit\'s toolbar keeps one row, the rest under More', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
      const p = await phone.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      const frame = await open('fmt-phone', { viewPage: p });
      await chooseMode(p, 'Read');
      await frameMode(frame, 'read');
      assert(!(await frame.evaluate(() => !!document.querySelector('.ts-fbar:not([hidden])'))), 'no toolbar in Read');
      await shot(p, 'after-read-phone');
      await chooseMode(p, 'Edit');
      await frameMode(frame, 'edit');
      await frameLoc(p).locator('.ts-fbar:not([hidden])').waitFor();
      const bar = await frame.evaluate(() => { const b = document.querySelector('.ts-fbar'); return { h: b.getBoundingClientRect().height, sw: b.scrollWidth, cw: b.clientWidth, more: !b.querySelector('.fx-more').hidden }; });
      assert(bar.h <= 40 && bar.sw <= bar.cw + 1 && bar.more, `one row with More: ${JSON.stringify(bar)}`);
      await shot(p, 'after-edit-phone');
      await frameLoc(p).locator(cellSel(1, 0)).tap();
      await frameLoc(p).locator('.ts-fbar .fx-more').tap();
      await shot(p, 'after-edit-more-phone');
      // Text style and colour keep their place; the least used go under More.
      await frameLoc(p).getByRole('menuitem', { name: /Clear formatting/ }).waitFor();
      assert(await frameLoc(p).locator('.ts-fbar button[aria-label="Bold"]').isVisible(), 'Bold stays on the row');
      await frameLoc(p).getByRole('menuitem', { name: /Increase decimal places/ }).tap();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"]').cells[0].getAttribute('data-num') === 'number:1');
      await frameLoc(p).locator('.ts-fbar button[aria-label="Fill colour"]').tap();
      await frameLoc(p).locator('.ts-pop button[aria-label="Pink"]').tap();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"] td').getAttribute('data-fill') === 'pink');
      await phone.close();
    });

    // ---- 10,000 rows -----------------------------------------------------------------
    async function scrollRun(frame) {
      return frame.evaluate(() => new Promise((resolve) => {
        const g = document.querySelector('.ts-grid');
        const times = []; let last = performance.now(), n = 0;
        function step() {
          const now = performance.now(); times.push(now - last); last = now;
          g.scrollTop += 900;
          if (++n < 60) requestAnimationFrame(step);
          else { times.sort((a, b) => a - b); resolve({ median: times[30], p95: times[57], rows: document.querySelectorAll('.ts-row').length }); }
        }
        requestAnimationFrame(step);
      }));
    }
    await test('10,000 rows: a plain sheet and a formatted one (formats, number formats, 200 merges) open and scroll in budget', async () => {
      const t0 = Date.now();
      const plainFrame = await open('big-plain');
      const plainOpen = Date.now() - t0;
      const plain = await scrollRun(plainFrame);
      const t1 = Date.now();
      const fmtFrame = await open('big-fmt');
      const fmtOpen = Date.now() - t1;
      const formatted = await scrollRun(fmtFrame);
      const shown = await fmtFrame.evaluate(() => document.querySelector('.ts-row .ts-c[data-c="2"]').textContent);
      console.log(`    (10k rows: open ${plainOpen}ms plain, ${fmtOpen}ms formatted; scroll median/p95 ${plain.median.toFixed(1)}/${plain.p95.toFixed(1)}ms plain, ${formatted.median.toFixed(1)}/${formatted.p95.toFixed(1)}ms formatted)`);
      assert(/^\$/.test(shown), `number format shown: ${shown}`);
      assert(plain.median < 34 && plain.p95 < 80 && plain.rows < 120, `plain scroll frames: ${JSON.stringify(plain)}`);
      assert(formatted.median < 34 && formatted.p95 < 80 && formatted.rows < 120, `formatted scroll frames: ${JSON.stringify(formatted)}`);
      assert(fmtOpen < plainOpen * 1.6 + 800, `formatted opens within budget: ${fmtOpen}ms vs ${plainOpen}ms`);
      await shot(page, 'after-10k-formatted-desktop');
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
