// Sheets, structure, in the browser against the local server:
//   - Read: the author's outline (nested row groups, a collapsed default),
//     hidden rows and columns and frozen rows render; Read shows no hidden
//     markers
//   - collapse / expand: anyone's view (kept across a reload, never in the
//     document); in Edit mode the document's default (data-collapsed)
//   - Edit: group rows (row menu, Alt+Shift+→), ungroup (Alt+Shift+←),
//     hide / unhide rows and columns (menus, the marker on the line), Undo,
//     Save writes the attributes
//   - a cell comment keeps its cell through grouping, collapsing and hiding
//     the rows around it, live and after Save
//   - freeze rows and columns from the menus; a reader's own freeze
//   - tabs: rename, drag to reorder, move from the menu, delete with Undo in the toast
//   - insert several rows and columns at once
//   - a small sheet in a prose doc: a collapsed group is one summary row, a
//     card on a phone; a phone taps toggles, the corner menu and the tab menu
//   - 10,000 rows in nested groups: collapse all / expand all and scrolling in budget
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheets-structure-ui.test.js');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheets-structure-'));
  const writeDoc = (slug, html, versions = 1) => {
    for (let v = 1; v <= versions; v++) {
      fs.mkdirSync(path.join(root, slug, `v${v}`), { recursive: true });
      fs.writeFileSync(path.join(root, slug, `v${v}`, 'index.html'), html);
    }
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: Array.from({ length: versions }, (_, i) => ({ n: i + 1, created: new Date().toISOString() })) }));
  };
  const columns = [{ name: 'Task', type: 'text' }, { name: 'Notes', type: 'text' }, { name: 'Points', type: 'number' }, { name: 'Status', type: 'tags' }];
  const rowsOf = (n) => Array.from({ length: n }, (_, k) => ({ id: `r${k + 1}`, cells: [`Task ${k + 1}`, `note ${k + 1}`, String(k * 3), [k % 2 ? 'open' : 'done']] }));
  const plain = (n = 30, extra = []) => M.sheetDocumentHtml({ title: 'Structure', sheets: [{ name: 'Tasks', columns, rows: rowsOf(n) }].concat(extra) });
  // The author's structure, written by hand as an agent would.
  const withStructure = (html) => {
    html = html.replace('data-name="Tasks"', 'data-name="Tasks" data-freeze-rows="1"');
    for (let k = 2; k <= 6; k++) html = html.replace(`<tr data-row="r${k}"`, `<tr data-row="r${k}" data-group="${k === 4 || k === 5 ? 2 : 1}"`);
    for (let k = 8; k <= 12; k++) html = html.replace(`<tr data-row="r${k}"`, `<tr data-row="r${k}" data-group="1"${k === 8 ? ' data-collapsed="1"' : ''}`);
    html = html.replace('<tr data-row="r15"', '<tr data-row="r15" data-hidden');
    html = html.replace('<th data-key="c4"', '<th data-key="c4" data-hidden');
    return html;
  };
  const people = { name: 'People', columns: [{ name: 'Name', type: 'text' }], rows: [{ id: 'r1', cells: ['Ana'] }, { id: 'r2', cells: ['Bo'] }] };
  writeDoc('outline', withStructure(plain(30, [people])));
  writeDoc('reader', withStructure(plain(30)), 2);
  for (const slug of ['group', 'hide', 'comment', 'freeze', 'insert']) writeDoc(slug, plain(30));
  writeDoc('tabs', plain(10, [people, { ...people, name: 'Places' }]));
  writeDoc('phone', withStructure(plain(30, [people])));
  // A small sheet in a prose doc: the flat view (cards on a phone).
  const small = M.tableHtml({ name: 'Budget', columns, rows: rowsOf(8) })
    .replace('<tr data-row="r3"', '<tr data-row="r3" data-group="1" data-collapsed="1"').replace('<tr data-row="r4"', '<tr data-row="r4" data-group="1"').replace('<tr data-row="r5"', '<tr data-row="r5" data-group="1"')
    .replace('<tr data-row="r7"', '<tr data-row="r7" data-hidden');
  writeDoc('prose', `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>Plan</h1><p>One.</p><p>Two.</p><p>Three.</p><div class="tdoc-table-scroll">${small}</div><p>After.</p></main></body></html>`);
  // 10,000 rows: every 10 rows a level-1 group of 9 holding a level-2 group of 4.
  let big = M.sheetDocumentHtml({ title: 'Big', sheets: [{ name: 'Rows', columns: [{ name: 'Name', type: 'text' }, { name: 'N', type: 'number' }], rows: Array.from({ length: 10000 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Customer ${k}`, String(k)] })) }] });
  big = big.replace(/<tr data-row="r(\d+)"/g, (m, d) => { const k = (Number(d) - 1) % 10; return k === 0 ? m : `${m} data-group="${k >= 3 && k <= 6 ? 2 : 1}"`; });
  writeDoc('big', big);

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheets: groups, hidden, freeze, tabs');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const frameLoc = (p = page) => p.frameLocator('iframe[aria-label="Document content"]');
    async function open(slug, { v = 1, viewPage = page, selector = '.tdoc-sheet .ts-row' } = {}) {
      await viewPage.goto('about:blank');
      await viewPage.goto(`${base}/d/${slug}/v/${v}`);
      await frameLoc(viewPage).locator(selector).first().waitFor({ timeout: 15000 });
      const frame = viewPage.frames().find((f) => f.url().includes('/frame'));
      await frame.waitForFunction(() => !!document.documentElement.getAttribute('data-tdoc-interaction-mode'));
      return frame;
    }
    const frameMode = (frame, m) => frame.waitForFunction((x) => document.documentElement.getAttribute('data-tdoc-interaction-mode') === x, m);
    const st = (frame) => frame.evaluate(() => window.__tdocSheets.structure());
    const attr = (frame, sel, a) => frame.evaluate(([s, x]) => { const el = document.querySelector(s); return el ? el.getAttribute(x) : undefined; }, [sel, a]);
    const rowOrder = (frame) => frame.evaluate(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet] tbody tr')).map((tr) => tr.getAttribute('data-row')));
    const saved = (slug, v) => fs.readFileSync(path.join(root, slug, `v${v}`, 'index.html'), 'utf8');
    async function save(slug, v, p = page) {
      await p.waitForFunction(() => { const b = document.querySelector('.tdoc-editor-toolbar button.primary'); return b && !b.disabled; });
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await p.waitForURL(new RegExp(`/d/${slug}/v/${v}`), { timeout: 10000 });
    }
    async function edit(frame, p = page) { await chooseMode(p, 'Edit'); await frameMode(frame, 'edit'); }
    async function drag(p, from, to, { steps = 8 } = {}) { // a mouse drag in steps
      const a = await from.boundingBox();
      const x = a.x + a.width / 2, y = a.y + a.height / 2;
      await p.mouse.move(x, y);
      await p.mouse.down();
      for (let k = 1; k <= steps; k++) await p.mouse.move(x + ((to.x - x) * k) / steps, y + ((to.y - y) * k) / steps);
      await p.mouse.up();
    }
    const rowNum = (f, i) => f.locator(`.ts-rows .ts-row[data-i="${i}"] .ts-n`);

    // ---- Read --------------------------------------------------------------------
    await test('Read: the author\'s outline, hidden rows and columns and a frozen row render; no markers', async () => {
      const frame = await open('outline');
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      const s = await st(frame);
      assert(s.rowLevels === 2 && s.frozenRows === 1 && s.hiddenRows === 1 && s.hiddenCols === 1, JSON.stringify(s));
      assert(s.shown === 30 - 1 - 5 && s.rows === 29, `collapsed by default and hidden: ${s.shown} / ${s.rows}`);
      const ui = await frame.evaluate(() => ({
        heads: Array.from(document.querySelectorAll('.ts-h b')).map((b) => b.textContent),
        toggles: document.querySelectorAll('.ts-outline .ts-otog').length,
        plus: document.querySelectorAll('.ts-outline .ts-otog[aria-expanded="false"]').length,
        markers: document.querySelectorAll('.ts-hid').length,
        frozen: document.querySelectorAll('.ts-frozen .ts-row').length,
        count: document.querySelector('.ts-count').textContent,
        gutter: document.querySelector('.ts-corner').getBoundingClientRect().width,
      }));
      assert(ui.heads.join() === 'Task,Notes,Points', `the hidden column is out: ${ui.heads}`);
      assert(ui.toggles === 3 && ui.plus === 1, `toggles: ${JSON.stringify(ui)}`);
      assert(ui.markers === 0, `Read stays clean: ${JSON.stringify(ui)}`);
      assert(ui.frozen === 1 && ui.count === '29 rows', JSON.stringify(ui));
      assert(ui.gutter === 48 + 2 * 12 + 4, `a thin gutter for two levels: ${ui.gutter}`);
      await shot(page, 'structure-read-desktop');
      // Collapse rows 2–6: the owner's view, outside Edit mode, never the document.
      const before = await frame.evaluate(() => document.querySelector('table[data-tdoc-sheet]').outerHTML);
      await frameLoc().getByRole('button', { name: 'Collapse rows 2–6' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 19);
      assert(!(await page.locator(modeSelector('edit')).count()), 'no Edit mode for a view change');
      assert(await frame.evaluate(() => document.querySelector('table[data-tdoc-sheet]').outerHTML) === before, 'the document is untouched');
      // Expand rows 8–12 (collapsed by the author).
      await frameLoc().getByRole('button', { name: /Expand rows 8–12/ }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 24);
      await page.waitForTimeout(400);
      const again = await open('outline');
      await again.waitForTimeout(100);
      const s2 = await st(again);
      assert(s2.shown === 24 && s2.view && s2.view.r['1:r2'] === true && s2.view.r['1:r8'] === false, `kept across a reload: ${JSON.stringify(s2)}`);
    });

    await test('a reader who may not edit: collapse and freeze are their own, kept across a reload, never in the document', async () => {
      const frame = await open('reader', { v: 1 });
      const f = frameLoc();
      const before = await frame.evaluate(() => document.querySelector('table[data-tdoc-sheet]').outerHTML);
      await f.getByRole('button', { name: /Expand rows 8–12/ }).click();
      await f.locator('.ts-cmenu').click();
      await f.getByRole('menuitemradio', { name: '2 rows' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().frozenRows === 2);
      await page.waitForTimeout(400);
      assert(!(await page.locator(modeSelector('edit')).count()), 'no Edit mode');
      assert(await frame.evaluate(() => document.querySelector('table[data-tdoc-sheet]').outerHTML) === before, 'the document is untouched');
      const again = await open('reader', { v: 1 });
      const s = await st(again);
      assert(s.frozenRows === 2 && s.shown === 29, `kept: ${JSON.stringify(s)}`);
      assert(await again.evaluate(() => document.querySelectorAll('.ts-frozen .ts-row').length) === 2, 'two frozen rows drawn');
    });

    // ---- Edit: group, collapse default, ungroup -------------------------------------
    await test('Edit: group rows (row menu, Alt+Shift+→), ungroup (Alt+Shift+←); collapsing in Edit saves the default', async () => {
      const frame = await open('group');
      const f = frameLoc();
      await edit(frame);
      await rowNum(f, 2).click();
      await rowNum(f, 6).click({ modifiers: ['Shift'] });
      await rowNum(f, 4).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Group rows 3–7' }).click();
      await frame.waitForFunction(() => ['r3', 'r4', 'r5', 'r6', 'r7'].every((id) => document.querySelector(`tr[data-row="${id}"]`).getAttribute('data-group') === '1'));
      assert(await attr(frame, 'tr[data-row="r2"]', 'data-group') === null, 'r2 is not in it');
      // A nested group with the keyboard.
      await f.locator('.ts-rows .ts-row[data-i="3"] .ts-c[data-c="0"]').click();
      await f.locator('.ts-rows .ts-row[data-i="4"] .ts-c[data-c="1"]').click({ modifiers: ['Shift'] });
      await page.keyboard.press('Alt+Shift+ArrowRight');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r4"]').getAttribute('data-group') === '2' && document.querySelector('tr[data-row="r5"]').getAttribute('data-group') === '2');
      await shot(page, 'structure-group-edit-desktop');
      // Collapse the outer group in Edit: the document's default.
      await f.getByRole('button', { name: 'Collapse rows 3–7' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r3"]').getAttribute('data-collapsed') === '1');
      assert((await st(frame)).shown === 25, 'five rows folded away');
      // Undo on the editor bar opens it again; collapse again for the save.
      await page.locator('.tdoc-editor-toolbar button[aria-label="Undo"]').click();
      await frame.waitForFunction(() => !document.querySelector('tr[data-row="r3"]').hasAttribute('data-collapsed'));
      // Ungroup r5 one level with the keyboard.
      await f.locator('.ts-rows .ts-row[data-i="4"] .ts-c[data-c="0"]').click();
      await page.keyboard.press('Alt+Shift+ArrowLeft');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').getAttribute('data-group') === '1');
      await f.getByRole('button', { name: 'Collapse rows 3–7' }).click();
      await shot(page, 'structure-collapsed-edit-desktop');
      await save('group', 2);
      const html = saved('group', 2);
      assert(/<tr data-row="r3" data-group="1" data-collapsed="1">/.test(html), 'v2: the group and its default');
      assert(/<tr data-row="r4" data-group="2">/.test(html) && /<tr data-row="r5" data-group="1">/.test(html), 'v2: nesting');
    });

    // ---- hide / unhide -----------------------------------------------------------------
    await test('hide and unhide rows and columns: menus, the marker on the line unhides; Read shows no marker; saved', async () => {
      const frame = await open('hide');
      const f = frameLoc();
      await edit(frame);
      await rowNum(f, 5).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Hide row' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r6"]').hasAttribute('data-hidden'));
      await f.getByRole('button', { name: 'Unhide row 6' }).waitFor();
      await f.getByRole('button', { name: 'Notes column menu' }).click();
      await f.getByRole('menuitem', { name: 'Hide column B' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th')[1].hasAttribute('data-hidden'));
      assert((await frame.evaluate(() => Array.from(document.querySelectorAll('.ts-h b')).map((b) => b.textContent).join())) === 'Task,Points,Status', 'B is out');
      await shot(page, 'structure-hidden-edit-desktop');
      await f.getByRole('button', { name: 'Unhide column B' }).click();
      await frame.waitForFunction(() => !document.querySelectorAll('table[data-tdoc-sheet] thead th')[1].hasAttribute('data-hidden'));
      // Arrow keys skip a hidden column.
      await f.getByRole('button', { name: 'Points column menu' }).click();
      await f.getByRole('menuitem', { name: 'Hide column C' }).click();
      await f.locator('.ts-rows .ts-row[data-i="0"] .ts-c[data-c="1"]').click();
      await page.keyboard.press('ArrowRight');
      assert((await frame.evaluate(() => window.__tdocSheets.selection().c)) === 3, 'past the hidden column');
      await page.locator('.tdoc-editor-toolbar button[aria-label="Undo"]').click();
      await frame.waitForFunction(() => !document.querySelectorAll('table[data-tdoc-sheet] thead th')[2].hasAttribute('data-hidden'));
      await save('hide', 2);
      assert(/<tr data-row="r6" data-hidden="">/.test(saved('hide', 2)), 'v2 holds the hidden row');
      const v2 = await open('hide', { v: 2 });
      await chooseMode(page, 'Read');
      await frameMode(v2, 'read');
      assert(await v2.evaluate(() => document.querySelectorAll('.ts-hid').length) === 0, 'no marker in Read');
      assert((await st(v2)).rows === 29, 'the row stays hidden');
    });

    // ---- comments keep their cells -------------------------------------------------------
    await test('a cell comment keeps its cell through grouping, collapsing and hiding the rows around it, live and after Save', async () => {
      const frame = await open('comment');
      const f = frameLoc();
      await chooseMode(page, 'Comment');
      await frameMode(frame, 'comment');
      await f.locator('.ts-rows .ts-row[data-i="9"] .ts-c[data-c="1"]').click();
      await page.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
      await page.fill('.tdoc-popup textarea', 'Check this note');
      await page.click('.tdoc-popup .submit');
      const marked = (fr = frame) => fr.evaluate(() => Array.from(document.querySelectorAll('.ts-rows .ts-c.has-comment')).map((c) => [c.parentElement.querySelector('[data-c="0"]').textContent, c.parentElement.querySelector('.ts-n').textContent, c.getAttribute('data-c')]));
      await frame.waitForFunction(() => document.querySelectorAll('.ts-c.has-comment').length === 1);
      await edit(frame);
      // Group rows 3–5 and collapse them; hide row 7: the commented cell (row 10) moves up the view.
      await rowNum(f, 2).click();
      await rowNum(f, 4).click({ modifiers: ['Shift'] });
      await rowNum(f, 3).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Group rows 3–5' }).click();
      await f.getByRole('button', { name: 'Collapse rows 3–5' }).click();
      await rowNum(f, 3).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Hide row' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r7"]').hasAttribute('data-hidden'));
      await frame.waitForFunction(() => document.querySelectorAll('.ts-rows .ts-c.has-comment').length === 1);
      assert(JSON.stringify(await marked()) === '[["Task 10","10","1"]]', `live: ${JSON.stringify(await marked())}`);
      assert(await frame.evaluate(() => document.querySelector('.ts-rows .ts-c.has-comment').parentElement.getAttribute('data-i')) === '5', 'four rows fewer above it');
      await shot(page, 'structure-comment-edit-desktop');
      await save('comment', 2);
      const v2 = await open('comment', { v: 2 });
      await v2.waitForFunction(() => document.querySelectorAll('.ts-rows .ts-c.has-comment').length === 1, null, { timeout: 8000 });
      assert(JSON.stringify(await marked(v2)) === '[["Task 10","10","1"]]', `after Save: ${JSON.stringify(await marked(v2))}`);
    });

    // ---- freeze ---------------------------------------------------------------------------
    await test('freeze rows and columns from the menus; frozen rows and columns stay put while scrolling; saved', async () => {
      const frame = await open('freeze');
      const f = frameLoc();
      await edit(frame);
      await f.locator('.ts-cmenu').click();
      await f.getByRole('menuitemradio', { name: '2 rows' }).click();
      await frame.waitForFunction(() => document.querySelector('table[data-tdoc-sheet]').getAttribute('data-freeze-rows') === '2');
      await f.locator('.ts-cmenu').click();
      await f.getByRole('menuitemradio', { name: '2 columns' }).click();
      await frame.waitForFunction(() => document.querySelector('table[data-tdoc-sheet]').getAttribute('data-freeze-cols') === '2');
      const stuck = await frame.evaluate(async () => {
        const g = document.querySelector('.ts-grid');
        const y0 = document.querySelector('.ts-frozen .ts-row[data-i="1"]').getBoundingClientRect().top;
        const x0 = document.querySelector('.ts-h[data-c="1"]').getBoundingClientRect().left;
        g.style.width = '520px';
        g.scrollTop = 400; g.scrollLeft = 200;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const y1 = document.querySelector('.ts-frozen .ts-row[data-i="1"]').getBoundingClientRect().top;
        const x1 = document.querySelector('.ts-h[data-c="1"]').getBoundingClientRect().left;
        const out = { dy: y1 - y0, dx: x1 - x0, scrolled: g.scrollTop };
        g.scrollTop = 0; g.scrollLeft = 0; g.style.width = '';
        return out;
      });
      assert(Math.abs(stuck.dy) < 1 && Math.abs(stuck.dx) < 1 && stuck.scrolled > 0, `frozen: ${JSON.stringify(stuck)}`);
      await shot(page, 'structure-freeze-edit-desktop');
      // The row menu freezes up to its row.
      await rowNum(f, 5).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Freeze up to row 6' }).click();
      await frame.waitForFunction(() => document.querySelector('table[data-tdoc-sheet]').getAttribute('data-freeze-rows') === '6');
      assert(await frame.evaluate(() => document.querySelectorAll('.ts-frozen .ts-row').length) === 6, 'six frozen rows drawn');
      await save('freeze', 2);
      assert(/data-freeze-rows="6" data-freeze-cols="2"/.test(saved('freeze', 2)), 'v2 holds the freeze');
    });

    // ---- tabs ------------------------------------------------------------------------------
    await test('tabs: rename, drag to reorder, move from the menu, delete with Undo in the toast; saved', async () => {
      const frame = await open('tabs');
      const f = frameLoc();
      await edit(frame);
      const names = () => frame.evaluate(() => window.__tdocSheets.tabs().map((t) => t.name).join());
      await f.getByRole('tab', { name: 'Places' }).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Rename…' }).click();
      await f.getByRole('textbox', { name: 'Tab name' }).fill('Sites');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => window.__tdocSheets.tabs().map((t) => t.name).join() === 'Tasks,People,Sites');
      // Drag People before Tasks.
      const first = await f.getByRole('tab', { name: 'Tasks', exact: true }).boundingBox();
      await drag(page, f.getByRole('tab', { name: 'People' }), { x: first.x + 4, y: first.y + first.height / 2 });
      await frame.waitForFunction(() => window.__tdocSheets.tabs().map((t) => t.name).join() === 'People,Tasks,Sites');
      assert(await frame.evaluate(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet]')).map((t) => t.getAttribute('data-name')).join()) === 'People,Tasks,Sites', 'the tables moved in the document');
      // Move left from the menu (the keyboard and touch way).
      await f.getByRole('tab', { name: 'Sites' }).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Move left' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.tabs().map((t) => t.name).join() === 'People,Sites,Tasks');
      await shot(page, 'structure-tabs-edit-desktop');
      // Delete, then Undo from the toast.
      await f.getByRole('tab', { name: 'Sites' }).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Delete tab' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.tabs().length === 2);
      await f.locator('.ts-toast').getByRole('button', { name: 'Undo' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.tabs().map((t) => t.name).join() === 'People,Sites,Tasks');
      await f.getByRole('tab', { name: 'Sites' }).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Delete tab' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.tabs().length === 2);
      assert((await names()) === 'People,Tasks', await names());
      await save('tabs', 2);
      const html = saved('tabs', 2);
      assert(html.indexOf('data-name="People"') < html.indexOf('data-name="Tasks"') && !/Sites|Places/.test(html), 'v2: People first, Sites gone');
    });

    // ---- insert several -----------------------------------------------------------------------
    await test('insert several rows and columns at once: as many as are selected', async () => {
      const frame = await open('insert');
      const f = frameLoc();
      await edit(frame);
      await rowNum(f, 2).click();
      await rowNum(f, 4).click({ modifiers: ['Shift'] });
      await rowNum(f, 3).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Insert 3 rows above' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr').length === 33);
      const order = await rowOrder(frame);
      assert(order.slice(0, 6).join() === 'r1,r2,r31,r32,r33,r3', order.slice(0, 6).join());
      await f.locator('.ts-h[data-c="1"] .ts-hname').click();
      await f.locator('.ts-h[data-c="2"] .ts-hname').click({ modifiers: ['Shift'] });
      await f.getByRole('button', { name: 'Notes column menu' }).click();
      await f.getByRole('menuitem', { name: 'Insert 2 columns left' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th').length === 6);
      const keys = await frame.evaluate(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet] thead th')).map((th) => th.getAttribute('data-key')).join());
      assert(keys === 'c1,c5,c6,c2,c3,c4', keys);
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r1"]').cells.length) === 6, 'every row has the new cells');
    });

    // ---- flat view, phone ----------------------------------------------------------------------
    await test('a small sheet in a prose doc: a collapsed group is one summary row; a click opens it and a toggle folds it again', async () => {
      const frame = await open('prose', { selector: '.ts-flat tr' });
      const f = frameLoc();
      const flat = () => frame.evaluate(() => ({ rows: document.querySelectorAll('.ts-flat tbody tr:not(.ts-fsum)').length, sum: Array.from(document.querySelectorAll('.ts-fsum')).map((x) => x.textContent) }));
      let s = await flat();
      assert(s.rows === 4 && s.sum.length === 1 && /^3 rows · Task 3/.test(s.sum[0]), `collapsed: ${JSON.stringify(s)}`);
      await shot(page, 'structure-flat-desktop');
      await f.locator('.ts-fsum button').click();
      await frame.waitForFunction(() => document.querySelectorAll('.ts-flat tbody tr').length === 7);
      await f.locator('.ts-ftog').click();
      await frame.waitForFunction(() => document.querySelectorAll('.ts-fsum').length === 1);
      s = await flat();
      assert(s.rows === 4, JSON.stringify(s));
    });

    await test('a phone: cards with a summary card; taps on a toggle, the corner menu (a bottom sheet) and the open tab\'s menu in Edit', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await phone.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
      const p = await phone.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      try {
        let frame = await open('prose', { viewPage: p, selector: '.ts-flat .ts-card' });
        const cards = await frame.evaluate(() => ({ cards: document.querySelectorAll('.ts-card:not(.ts-fsum)').length, sum: document.querySelectorAll('.ts-card.ts-fsum').length }));
        assert(cards.cards === 4 && cards.sum === 1, JSON.stringify(cards));
        await shot(p, 'structure-cards-phone');
        await frameLoc(p).locator('.ts-card.ts-fsum button').tap();
        await frame.waitForFunction(() => document.querySelectorAll('.ts-card:not(.ts-fsum)').length === 7);

        frame = await open('phone', { viewPage: p });
        const f = frameLoc(p);
        await f.getByRole('button', { name: 'Collapse rows 2–6' }).tap();
        await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 19);
        await shot(p, 'structure-grid-phone');
        await f.locator('.ts-cmenu').tap();
        const sheet = await f.locator('.ts-pop').boundingBox();
        assert(sheet && Math.abs(sheet.y + sheet.height - 844) < 80 && sheet.width > 380, `a bottom sheet: ${JSON.stringify(sheet)}`);
        await shot(p, 'structure-view-menu-phone');
        await f.getByRole('menuitem', { name: 'Expand all' }).tap();
        await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 29);
        await chooseMode(p, 'Edit');
        await frameMode(frame, 'edit');
        await f.getByRole('tab', { name: 'Tasks' }).tap();
        await f.getByRole('menuitem', { name: 'Rename…' }).waitFor({ timeout: 5000 });
        await shot(p, 'structure-tab-menu-phone');
        await p.keyboard.press('Escape');
      } finally { await phone.close(); }
    });

    // ---- 10,000 rows -------------------------------------------------------------------------------
    await test('10,000 rows in 2,000 nested groups: opens, collapses and expands all, and scrolls inside a frame budget', async () => {
      const t0 = Date.now();
      const frame = await open('big');
      const openMs = Date.now() - t0;
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      const f = frameLoc();
      const scrollRun = () => frame.evaluate(() => new Promise((resolve) => {
        const grid = document.querySelector('.ts-grid');
        grid.scrollTop = 0;
        const gaps = [];
        let last = performance.now(), n = 0;
        function step(now) {
          gaps.push(now - last); last = now;
          grid.scrollTop += 1400;
          if (++n < 120) requestAnimationFrame(step);
          else { gaps.shift(); gaps.sort((a, b) => a - b); resolve({ median: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)], toggles: document.querySelectorAll('.ts-otog').length }); }
        }
        requestAnimationFrame(step);
      }));
      const open1 = await scrollRun();
      const c0 = Date.now();
      await f.locator('.ts-cmenu').click();
      await f.getByRole('menuitem', { name: 'Collapse all' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 1000);
      const collapseMs = Date.now() - c0;
      const closed = await scrollRun();
      const e0 = Date.now();
      await f.locator('.ts-cmenu').click();
      await f.getByRole('menuitem', { name: 'Collapse level 2' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 6000);
      const levelMs = Date.now() - e0;
      // Search finds a row inside a collapsed group; stepping there opens it.
      await f.locator('.ts-search input').fill('Customer 9994');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('.ts-c.is-hit-on'));
      console.log(`    (10k rows, 2k groups: open ${openMs}ms; scroll p95 ${open1.p95.toFixed(1)}ms open, ${closed.p95.toFixed(1)}ms collapsed; collapse all ${collapseMs}ms; level 2 ${levelMs}ms)`);
      assert(open1.median < 34 && open1.p95 < 80 && open1.toggles < 80, `scroll: ${JSON.stringify(open1)}`);
      assert(closed.median < 34 && closed.p95 < 80, `scroll collapsed: ${JSON.stringify(closed)}`);
      assert(collapseMs < 2500 && levelMs < 2500, `collapse ${collapseMs}ms, level ${levelMs}ms`);
      await shot(page, 'structure-10k-desktop');
    });

    await test('no page errors', async () => { assert(!errors.length, errors.join('\n')); });
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
