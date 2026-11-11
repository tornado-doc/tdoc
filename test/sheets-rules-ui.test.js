// Sheets: find & replace, conditional formatting, dropdowns and the fill
// handle, in the browser against the local server:
//   - Read mode is clean: formats and dropdown chips render, nothing else (no
//     carets, no marks, no fill dot, no Replace button)
//   - Edit: a column's menu opens the rules panel; a "greater than" rule
//     colours cells, ⌘Z takes a rule back, Save writes data-format-rules
//     (JSON, no CSS) and nothing of the panel
//   - dropdowns: a chip opens its list, a typed value outside it is marked;
//     a dropdown added from the selection's menu
//   - Find and replace (⌘⇧H): Find, Replace, entire cell, Replace all over
//     this tab or every tab as one Undo
//   - the fill handle: drag down continues a series, Ctrl copies, right and
//     dates; under a sort it fills the rows as shown
//   - phone: formats render, the panel and the popover are bottom sheets
//   - 10,000 rows with rules: opens, scrolls and sorts in budget
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheets-rules-ui.test.js');
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
  const R = await import('../shared/sheet-rules.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheets-rules-'));
  const writeDoc = (slug, html) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  const withRules = (html, name, format, valid) => html.replace(`<table data-tdoc-sheet data-name="${name}"`,
    `<table data-tdoc-sheet data-name="${name}"` + (format ? ` data-format-rules='${R.formatFormatRules(format)}'` : '') + (valid ? ` data-validation='${R.formatValidation(valid)}'` : ''));
  const STATUS = ['Open', 'Done', 'Blocked'];
  const tasks = (n = 30) => Array.from({ length: n }, (_, k) => ({ id: `r${k + 1}`, cells: [`Task ${k + 1}`, STATUS[k % 3], String(k * 10), `2026-11-${String(1 + (k % 28)).padStart(2, '0')}`, [k % 2 ? 'web' : 'core']] }));
  const COLUMNS = [{ name: 'Task', type: 'text' }, { name: 'Status', type: 'text' }, { name: 'Points', type: 'number' }, { name: 'Due', type: 'date' }, { name: 'Team', type: 'tags' }];
  const sheet = (n) => M.sheetDocumentHtml({ title: 'Rules', sheets: [{ name: 'Tasks', columns: COLUMNS, rows: tasks(n) }, { name: 'Notes', columns: [{ name: 'Note', type: 'text' }], rows: [{ id: 'r1', cells: ['Task one note'] }, { id: 'r2', cells: ['nothing'] }] }] });
  const RULED_FORMAT = [{ cols: ['c3'], when: 'gt', value: '50', fill: 'red' }, { cols: ['c1'], when: 'textContains', value: 'task 1', fill: 'yellow' }];
  const RULED_VALID = [{ cols: ['c2'], kind: 'list', values: STATUS }];
  writeDoc('read', withRules(sheet(), 'Tasks', RULED_FORMAT, RULED_VALID));
  for (const slug of ['format', 'find', 'fill', 'phone']) writeDoc(slug, sheet());
  writeDoc('valid', withRules(sheet(), 'Tasks', null, RULED_VALID));
  writeDoc('hostile', sheet().replace('<table data-tdoc-sheet data-name="Tasks"', `<table data-tdoc-sheet data-name="Tasks" data-format-rules='[{"cols":["c3"],"when":"gt","value":"1","fill":"red\\u0022;background:url(x)"},{"__proto__":{"x":1},"cols":["c1"],"when":"textContains","value":"task","fill":"blue"}]' data-validation='not json'`));
  writeDoc('big', withRules(M.sheetDocumentHtml({ title: 'Big', sheets: [{ name: 'Rows', columns: COLUMNS, rows: tasks(10000) }] }), 'Rows',
    [{ cols: ['c3'], when: 'lt', value: '1000', fill: 'yellow' }, { cols: ['c3'], when: 'gt', value: '50000', fill: 'blue' }, { cols: ['c1'], when: 'textContains', value: '7', fill: 'gray' }],
    RULED_VALID));

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheets: find & replace, conditional formatting, dropdowns, fill handle');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const frameLoc = (p = page) => p.frameLocator('iframe[aria-label="Document content"]');
    async function open(slug, { viewPage = page, v = 1 } = {}) {
      await viewPage.goto('about:blank');
      await viewPage.goto(`${base}/d/${slug}/v/${v}`);
      await frameLoc(viewPage).locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      const frame = viewPage.frames().find((f) => f.url().includes('/frame'));
      await frame.waitForFunction(() => !!document.documentElement.getAttribute('data-tdoc-interaction-mode'));
      return frame;
    }
    const frameMode = (frame, m) => frame.waitForFunction((x) => document.documentElement.getAttribute('data-tdoc-interaction-mode') === x, m);
    async function edit(slug, viewPage = page) {
      const frame = await open(slug, { viewPage });
      await chooseMode(viewPage, 'Edit');
      await frameMode(frame, 'edit');
      return frame;
    }
    const cellSel = (i, c) => `.ts-row[data-i="${i}"] .ts-c[data-c="${c}"]`;
    const bg = (frame, i, c) => frame.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, cellSel(i, c));
    const td = (frame, row, c) => frame.evaluate(([r, cc]) => document.querySelector(`tr[data-row="${r}"]`).cells[cc].textContent, [row, c]);
    const saved = (slug, v) => fs.readFileSync(path.join(root, slug, `v${v}`, 'index.html'), 'utf8');
    async function save(slug, v) {
      await page.waitForFunction(() => { const b = document.querySelector('.tdoc-editor-toolbar button.primary'); return b && !b.disabled; });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForURL(new RegExp(`/d/${slug}/v/${v}`), { timeout: 10000 });
    }
    async function dragTo(p, from, to, modifier) {
      const a = await from.boundingBox(), b = await to.boundingBox();
      const x = a.x + a.width / 2, y = a.y + a.height / 2;
      await p.mouse.move(x, y);
      await p.mouse.down();
      if (modifier) await p.keyboard.down(modifier);
      for (let k = 1; k <= 8; k++) await p.mouse.move(x + ((b.x + b.width / 2 - x) * k) / 8, y + ((b.y + b.height / 2 - y) * k) / 8);
      await p.waitForTimeout(50);
      await p.mouse.up();
      if (modifier) await p.keyboard.up(modifier);
    }
    const RED = 'rgb(253, 232, 231)';

    // ---- Read ---------------------------------------------------------------
    await test('Read mode: formats and dropdown chips render; no carets, marks, fill dot or Replace', async () => {
      const frame = await open('read');
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      const f = frameLoc();
      await f.locator(cellSel(1, 0)).click();
      const r = await frame.evaluate(() => {
        const cell = (i, c) => document.querySelector(`.ts-row[data-i="${i}"] .ts-c[data-c="${c}"]`);
        return {
          over: getComputedStyle(cell(6, 2)).backgroundColor, under: getComputedStyle(cell(5, 2)).backgroundColor,
          text: getComputedStyle(cell(0, 0)).backgroundColor, other: getComputedStyle(cell(1, 0)).backgroundColor,
          chip: !!cell(1, 1).querySelector('.ts-dd'), chipBg: getComputedStyle(cell(1, 1).querySelector('.ts-dd')).backgroundColor,
          caret: document.querySelectorAll('.ts-dd i').length, inv: document.querySelectorAll('.ts-inv').length,
          dot: !!document.querySelector('.ts-fill:not([hidden])'), replace: !!document.querySelector('.ts-replace:not([hidden])'),
          styleAttr: document.querySelector('table[data-tdoc-sheet] [style]') !== null,
        };
      });
      assert(r.over === RED && r.under !== RED, `greater than 50 is red: ${JSON.stringify(r)}`);
      assert(r.text === 'rgb(253, 244, 207)' && r.other !== r.text, `text contains "task 1" is yellow: ${JSON.stringify(r)}`);
      assert(r.chip && r.chipBg === 'rgb(238, 240, 243)', `a soft gray chip: ${JSON.stringify(r)}`);
      assert(!r.caret && !r.inv && !r.dot && !r.replace, `nothing else in Read: ${JSON.stringify(r)}`);
      assert(!r.styleAttr, 'no CSS in the document');
      await shot(page, 'rules-read-desktop');
    });

    await test('hostile rule JSON in a document: colours never leave the palette, the bad half is dropped', async () => {
      const frame = await open('hostile');
      const r = await frame.evaluate(() => ({ s: document.querySelector('.ts-row[data-i="1"] .ts-c[data-c="2"]').getAttribute('style'), task: getComputedStyle(document.querySelector('.ts-row[data-i="1"] .ts-c[data-c="0"]')).backgroundColor, polluted: ({}).x }));
      assert(!/url|expression|background/.test(r.s) && r.task === 'rgb(227, 237, 253)' && r.polluted === undefined, JSON.stringify(r));
    });

    // ---- conditional formatting --------------------------------------------
    await test('conditional formatting from the column menu: a rule colours cells, ⌘Z undoes, Save writes JSON only', async () => {
      const frame = await edit('format');
      const f = frameLoc();
      await f.locator(cellSel(0, 2)).click();
      await shot(page, 'rules-edit-desktop');
      await f.getByRole('button', { name: 'Points column menu' }).click();
      await f.getByRole('menuitem', { name: 'Conditional formatting…' }).click();
      const side = f.locator('.ts-side');
      await side.waitFor();
      assert(await side.getByRole('textbox', { name: 'Apply to columns' }).inputValue() === 'C', 'applies to the column');
      await side.getByRole('button', { name: 'Condition', exact: true }).click();
      const conditions = await f.locator('.ts-pop[role="menu"] .ts-mi').allTextContents();
      assert(conditions.join('|') === 'Greater than|Less than|Is equal to|Text contains|Is empty', conditions.join('|'));
      await f.locator('.ts-pop[role="menu"] .ts-mi', { hasText: /^Greater than$/ }).click();
      await side.getByRole('textbox', { name: 'Value' }).fill('50');
      await side.getByRole('button', { name: 'red fill' }).click();
      await shot(page, 'rules-panel-format-desktop');
      await side.getByRole('button', { name: 'Done', exact: true }).click();
      await frame.waitForFunction(() => document.querySelector('table[data-tdoc-sheet]').hasAttribute('data-format-rules'));
      assert(await bg(frame, 6, 2) === RED && await bg(frame, 5, 2) !== RED, 'rows over 50 are red');
      assert(await side.locator('.ts-rule').count() === 1, 'listed in the panel');
      // A second rule from Add rule: Status is empty… none are; Task contains "1".
      await side.getByRole('button', { name: 'Add rule' }).click();
      await side.getByRole('textbox', { name: 'Apply to columns' }).fill('A');
      await side.getByRole('button', { name: 'Condition', exact: true }).click();
      await f.locator('.ts-pop[role="menu"] .ts-mi', { hasText: /^Text contains$/ }).click();
      await side.getByRole('textbox', { name: 'Value' }).fill('task 1');
      await side.getByRole('button', { name: 'blue fill' }).click();
      await side.getByRole('button', { name: 'Done', exact: true }).click();
      await frame.waitForFunction(() => /task 1/.test(document.querySelector('table[data-tdoc-sheet]').getAttribute('data-format-rules')));
      assert(await bg(frame, 0, 0) === 'rgb(227, 237, 253)' && await bg(frame, 1, 0) !== 'rgb(227, 237, 253)', 'text contains');
      await shot(page, 'rules-panel-list-desktop');
      // Undo takes the second rule back; the first stays.
      await f.locator(cellSel(2, 0)).click();
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => !/task 1/.test(document.querySelector('table[data-tdoc-sheet]').getAttribute('data-format-rules') || ''));
      assert(await bg(frame, 6, 2) === RED, 'the first rule is still there');
      await save('format', 2);
      const html = saved('format', 2);
      const attr = /data-format-rules="([^"]*)"/.exec(html) || /data-format-rules='([^']*)'/.exec(html);
      assert(attr, 'v2 holds the rules');
      const rules = R.parseFormatRules(attr[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert(rules.length === 1 && rules[0].when === 'gt' && rules[0].value === '50' && rules[0].fill === 'red', JSON.stringify(rules));
      assert(!/ts-side|ts-fill|tdoc-sheet"|style="background/.test(html), 'nothing of the viewer saved');
    });

    // ---- dropdowns -----------------------------------------------------------
    await test('dropdowns: a chip opens its list, a value outside it is marked; a dropdown added from the selection menu', async () => {
      const frame = await edit('valid');
      const f = frameLoc();
      await f.locator(cellSel(0, 1) + ' .ts-dd').click();
      await f.getByRole('option', { name: 'Blocked' }).waitFor();
      await shot(page, 'dropdown-desktop');
      await f.getByRole('option', { name: 'Blocked' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"]').cells[1].textContent === 'Blocked');
      // Enter on a dropdown cell opens its list too; Escape closes it.
      await f.locator(cellSel(1, 1)).click();
      await page.keyboard.press('Enter');
      await f.getByRole('listbox').waitFor();
      await page.keyboard.press('Escape');
      // Typed: written, and marked in Edit mode with its reason.
      await page.keyboard.type('Later');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"]').cells[1].textContent === 'Later');
      const mark = await frame.evaluate(() => { const m = document.querySelector('.ts-row[data-i="1"] .ts-c[data-c="1"] .ts-inv'); return m && m.getAttribute('title'); });
      assert(mark === 'Not in the list: Open, Done, Blocked', `mark: ${mark}`);
      await shot(page, 'dropdown-mark-desktop');
      // From the selection's menu on Points: a dropdown of its own values.
      await f.locator(cellSel(0, 2)).click();
      await f.locator(cellSel(0, 2)).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Dropdown…' }).click();
      const side = f.locator('.ts-side');
      await side.getByRole('textbox', { name: 'Values' }).fill('0, 10, 20');
      await shot(page, 'rules-panel-dropdown-desktop');
      await side.getByRole('button', { name: 'Done', exact: true }).click();
      await frame.waitForFunction(() => document.querySelectorAll('.ts-c[data-c="2"] .ts-dd').length > 5 && document.querySelectorAll('.ts-c[data-c="2"] .ts-inv').length > 5);
      await side.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    // ---- find & replace ----------------------------------------------------------
    await test('find and replace: Find, Replace, entire cell, Replace all over every tab as one Undo', async () => {
      const frame = await edit('find');
      const f = frameLoc();
      await f.locator(cellSel(0, 0)).click();
      await page.keyboard.press(`${MOD}+Shift+h`);
      const pop = f.locator('.ts-find');
      await pop.waitFor();
      assert(!(await pop.getByLabel('Regular expression').count()), 'no regular expressions yet');
      await pop.getByRole('textbox', { name: 'Find' }).fill('task 1');
      await pop.getByRole('textbox', { name: 'Replace with' }).fill('Job 1');
      await frame.waitForFunction(() => /11 matches/.test(document.querySelector('.ts-find-st').textContent));
      await shot(page, 'find-replace-desktop');
      // Find walks to the next match; Replace changes it and moves on.
      await pop.getByRole('button', { name: 'Find', exact: true }).click();
      await frame.waitForFunction(() => window.__tdocSheets.selection().r === 9);
      await pop.getByRole('button', { name: 'Replace', exact: true }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r10"]').cells[0].textContent === 'Job 10');
      // Match case: "task 1" no longer matches "Task 1".
      await pop.getByLabel('Match case').check();
      await frame.waitForFunction(() => /No matches/.test(document.querySelector('.ts-find-st').textContent));
      await pop.getByLabel('Match case').uncheck();
      // Entire cell: only "Task 1".
      await pop.getByLabel('Entire cell').check();
      await pop.getByRole('button', { name: 'Replace all' }).click();
      await frame.waitForFunction(() => /Replaced 1 cell/.test(document.querySelector('.ts-find-st').textContent));
      assert(await td(frame, 'r1', 0) === 'Job 1' && await td(frame, 'r11', 0) === 'Task 11', 'entire cell only');
      await pop.getByLabel('Entire cell').uncheck();
      // Every tab: "Task" in both tabs, one ⌘Z takes it all back.
      await pop.getByRole('textbox', { name: 'Find' }).fill('Task');
      await pop.getByRole('textbox', { name: 'Replace with' }).fill('Item');
      await pop.getByRole('button', { name: 'All tabs' }).click();
      await pop.getByRole('button', { name: 'Replace all' }).click();
      await frame.waitForFunction(() => /Replaced 2\d cells/.test(document.querySelector('.ts-find-st').textContent));
      assert(await td(frame, 'r30', 0) === 'Item 30', 'this tab');
      assert(await frame.evaluate(() => document.querySelectorAll('table[data-tdoc-sheet]')[1].querySelector('td').textContent) === 'Item one note', 'the other tab');
      await page.keyboard.press('Escape');
      await f.locator(cellSel(0, 0)).click();
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet]')[1].querySelector('td').textContent === 'Task one note' && document.querySelector('tr[data-row="r30"]').cells[0].textContent === 'Task 30');
      await save('find', 2);
      assert(/<td>Job 1<\/td>/.test(saved('find', 2)) && /<td>Job 10<\/td>/.test(saved('find', 2)) && /<td>Task 30<\/td>/.test(saved('find', 2)), 'v2 holds what was left');
    });

    // ---- fill handle -------------------------------------------------------------
    await test('fill handle: drag down continues a series, Ctrl copies, right and dates; under a sort it fills the rows shown', async () => {
      const frame = await edit('fill');
      const f = frameLoc();
      // Points r1..r2 (0, 10) dragged down three rows: 20, 30, 40.
      await f.locator(cellSel(0, 2)).click();
      await page.keyboard.press('Shift+ArrowDown');
      const dot = f.locator('.ts-fill');
      await dot.waitFor();
      const box = await dot.boundingBox();
      assert(box.width <= 14, `a small dot: ${box.width}px`);
      await shot(page, 'fill-handle-desktop');
      await dragTo(page, dot, f.locator(cellSel(4, 2)));
      await frame.waitForFunction(() => ['r3', 'r4', 'r5'].map((r) => document.querySelector(`tr[data-row="${r}"]`).cells[2].textContent).join() === '20,30,40');
      const s = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(s.r === 0 && s.r2 === 4, `the selection covers the fill: ${JSON.stringify(s)}`);
      // Ctrl: copy instead.
      await f.locator(cellSel(6, 2)).click();
      await page.keyboard.press('Shift+ArrowDown');
      await dragTo(page, f.locator('.ts-fill'), f.locator(cellSel(9, 2)), 'Control');
      await frame.waitForFunction(() => ['r9', 'r10'].map((r) => document.querySelector(`tr[data-row="${r}"]`).cells[2].textContent).join() === '60,70');
      // Due (dates) dragged down: +1 day; text dragged right is copied.
      await f.locator(cellSel(0, 3)).click();
      await dragTo(page, f.locator('.ts-fill'), f.locator(cellSel(2, 3)));
      await frame.waitForFunction(() => ['r2', 'r3'].map((r) => document.querySelector(`tr[data-row="${r}"]`).cells[3].textContent).join() === '2026-11-02,2026-11-03');
      await f.locator(cellSel(11, 0)).click();
      await dragTo(page, f.locator('.ts-fill'), f.locator(cellSel(11, 1)));
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r12"]').cells[1].textContent === 'Task 12');
      // Undo is one step per drag.
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r12"]').cells[1].textContent === 'Blocked');
      // Sorted by Points descending: the rows as shown are filled.
      await f.getByRole('button', { name: 'Points column menu' }).click();
      await f.getByRole('menuitem', { name: 'Sort descending' }).click();
      const top = await frame.evaluate(() => [0, 1, 2].map((i) => document.querySelector(`.ts-row[data-i="${i}"] .ts-n`).textContent.trim()));
      await f.locator(cellSel(0, 0)).click();
      await dragTo(page, f.locator('.ts-fill'), f.locator(cellSel(2, 0)), 'Control');
      await frame.waitForFunction((ids) => ids.every((n) => document.querySelectorAll('tr[data-row]')[Number(n) - 1].cells[0].textContent === document.querySelectorAll('tr[data-row]')[Number(ids[0]) - 1].cells[0].textContent), top);
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    // ---- phone -------------------------------------------------------------------
    await test('a phone: rules render; the rules panel and find & replace are bottom sheets', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
      const p = await phone.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      let frame = await open('read', { viewPage: p });
      assert(await frame.evaluate(() => getComputedStyle(document.querySelector('.ts-row[data-i="6"] .ts-c[data-c="2"]')).backgroundColor) === RED, 'formats on a phone');
      await shot(p, 'rules-read-phone');
      frame = await edit('phone', p);
      const f = frameLoc(p);
      await f.locator(cellSel(0, 1)).tap();
      await shot(p, 'rules-edit-phone');
      await f.getByRole('button', { name: 'Status column menu' }).tap();
      await f.getByRole('menuitem', { name: 'Dropdown…' }).tap();
      const side = f.locator('.ts-side');
      await side.waitFor();
      const rect = await frame.evaluate(() => { const r = document.querySelector('.ts-side').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight }; });
      assert(rect.left === 0 && Math.abs(rect.right - rect.w) <= 1 && Math.abs(rect.bottom - rect.h) <= 1, `a bottom sheet: ${JSON.stringify(rect)}`);
      await shot(p, 'rules-panel-phone');
      await side.getByRole('button', { name: 'Done', exact: true }).tap();
      await frame.waitForFunction(() => document.querySelectorAll('.ts-c[data-c="1"] .ts-dd').length > 5);
      await side.getByRole('button', { name: 'Close' }).tap();
      await f.locator('.ts-replace').tap();
      await f.locator('.ts-find').waitFor();
      const fr = await frame.evaluate(() => { const r = document.querySelector('.ts-find').getBoundingClientRect(); return { left: r.left, bottom: r.bottom, w: r.width, vw: innerWidth, h: innerHeight }; });
      assert(fr.left === 0 && Math.abs(fr.w - fr.vw) <= 1 && Math.abs(fr.bottom - fr.h) <= 1, `find is a bottom sheet: ${JSON.stringify(fr)}`);
      await shot(p, 'find-replace-phone');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `no sideways page scroll: ${overflow}`);
      await phone.close();
    });

    // ---- 10,000 rows ---------------------------------------------------------------
    await test('10,000 rows with rules and dropdowns: opens, scrolls and sorts inside the budget, formats follow their rows', async () => {
      const t0 = Date.now();
      const frame = await edit('big');
      const openMs = Date.now() - t0;
      const run = () => frame.evaluate(() => new Promise((resolve) => {
        const grid = document.querySelector('.ts-grid');
        grid.scrollTop = 0;
        const gaps = []; let last = performance.now(), n = 0;
        function step(now) {
          gaps.push(now - last); last = now; grid.scrollTop += 1400;
          if (++n < 120) requestAnimationFrame(step);
          else { gaps.shift(); gaps.sort((a, b) => a - b); resolve({ median: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)] }); }
        }
        requestAnimationFrame(step);
      }));
      const scroll = await run();
      const s0 = Date.now();
      await frameLoc().getByRole('button', { name: 'Points column menu' }).click();
      await frameLoc().getByRole('menuitem', { name: 'Sort descending' }).click();
      await frame.waitForFunction(() => { document.querySelector('.ts-grid').scrollTop = 0; const n = document.querySelector('.ts-row[data-i="0"] .ts-n'); return n && n.textContent.trim() === '10000'; });
      const sortMs = Date.now() - s0;
      // Row 10,000 (Points 99,990): over 50,000, blue.
      const top = await frame.evaluate(() => getComputedStyle(document.querySelector('.ts-row[data-i="0"] .ts-c[data-c="2"]')).backgroundColor);
      const e0 = Date.now();
      await frameLoc().locator(cellSel(0, 2)).dblclick();
      await frameLoc().locator('.ts-editor').waitFor();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.type('2000');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r10000"]').cells[2].textContent === '2000');
      const editMs = Date.now() - e0;
      // The edited row (now 2,000: neither band) is drawn where the sort put it.
      const after = await frame.evaluate(() => { const row = [...document.querySelectorAll('.ts-row')].find((x) => x.querySelector('.ts-n').textContent.trim() === '10000'); return row ? getComputedStyle(row.querySelector('.ts-c[data-c="2"]')).backgroundColor : 'not drawn'; });
      console.log(`    (10k rows with rules: open ${openMs}ms, scroll p95 ${scroll.p95.toFixed(1)}ms (median ${scroll.median.toFixed(1)}ms), sort ${sortMs}ms, edit + re-evaluate ${editMs}ms)`);
      assert(top === 'rgb(227, 237, 253)', `over 50,000 is blue: ${top}`);
      assert(after === 'rgb(255, 255, 255)', `re-evaluated after the edit: ${after}`);
      assert(scroll.median < 34 && scroll.p95 < 80, `scroll frames: ${JSON.stringify(scroll)}`);
      assert(sortMs < 2500 && editMs < 2500, `sort ${sortMs}ms, edit ${editMs}ms`);
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
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
