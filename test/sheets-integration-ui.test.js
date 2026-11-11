// Sheets release 2026-11-11d: how cell formatting and merges (#1018), groups,
// hidden rows/columns and freeze (#1019), and find & replace, conditional
// formatting and the fill handle (#1020) work together, in the browser
// against the local server (desktop):
//   - merges x hidden rows and columns, collapsed groups and frozen rows: a
//     merge is drawn merged only while the view shows all of its rows in
//     order, its top-left column is shown and the frozen edge does not cut
//     it; a hidden column inside a merge adds no width
//   - conditional formatting x a cell's own fill: the rule's fill wins (as in
//     Google Sheets); the cell's own fill shows where no rule matches
//   - find & replace x hidden columns and collapsed groups: Find never lands
//     in a hidden column and opens a collapsed group; Replace all changes
//     hidden cells too and the count says so
//   - the fill handle x hidden rows, hidden columns and merges
//   - insert / delete rows x merges x groups x rules
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheets-integration-ui.test.js');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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

// A sheet doc written by hand: merges, formats, structure and rules are all
// attributes in the markup.
function doc(title, table) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>\n${table}\n</main></body></html>`;
}
const HEAD = '<thead><tr><th data-key="c1" data-type="text">Group</th><th data-key="c2" data-type="text">Item</th><th data-key="c3" data-type="number">Points</th><th data-key="c4" data-type="text"%HID%>Notes</th><th data-key="c5" data-type="text">Owner</th></tr></thead>';
const RULES = `data-format-rules='[{"cols":["c3"],"when":"gt","value":"100","fill":"red"}]'`;
// Rows (document order, r1..r12):
//   r1-r2  Group merged down two rows (rowspan), r1 Points has its own yellow fill and 120 (> 100: the rule)
//   r3-r4  a level-1 group; r3's Group+Item merged across (colspan 2)
//   r5     hidden
//   r6     Notes+Owner merged across (the top-left in the hidden Notes column)
//   r7     Item..Notes merged across (colspan 3, the hidden Notes inside)
//   r8-r10 Group merged down three rows across the hidden r9
function body() {
  return [
    '<tr data-row="r1"><td rowspan="2" data-fill="green">Hardware</td><td>Laptops</td><td data-fill="yellow">120</td><td>note one</td><td>Ann</td></tr>',
    '<tr data-row="r2"><td>Monitors</td><td>40</td><td>note two</td><td>Bob</td></tr>',
    '<tr data-row="r3" data-group="1"><td colspan="2">Software</td><td data-fill="yellow">70</td><td>note three</td><td>Cy</td></tr>',
    '<tr data-row="r4" data-group="1"><td>Software</td><td>Licences</td><td>5</td><td>note four</td><td>Dee</td></tr>',
    '<tr data-row="r5" data-hidden><td>Old</td><td>Old line</td><td>999</td><td>note five</td><td>Eve</td></tr>',
    '<tr data-row="r6"><td>Misc</td><td>Cables</td><td>12</td><td colspan="2">across hidden</td></tr>',
    '<tr data-row="r7"><td>Misc</td><td colspan="3">Wide item</td><td>Fay</td></tr>',
    '<tr data-row="r8"><td rowspan="3">Tall</td><td>t1</td><td>1</td><td>n8</td><td>Gus</td></tr>',
    '<tr data-row="r9" data-hidden><td>t2</td><td>2</td><td>n9</td><td>Hal</td></tr>',
    '<tr data-row="r10"><td>t3</td><td>3</td><td>n10</td><td>Ida</td></tr>',
  ].join('\n');
}
function combo({ freeze = false } = {}) {
  return doc('Combo', `<table data-tdoc-sheet data-name="Combo" ${RULES}${freeze ? ' data-freeze-rows="1"' : ''}>${HEAD.replace('%HID%', ' data-hidden')}<tbody>\n${body()}\n</tbody></table>`);
}
// The fill handle: Points 1, 2, (hidden 99), then empty rows; a Points cell
// filled right steps over the hidden Notes column into Owner.
function fillDoc() {
  const rows = [
    '<tr data-row="r1"><td>a</td><td>x</td><td>1</td><td>n</td><td>o</td></tr>',
    '<tr data-row="r2"><td>b</td><td>x</td><td>2</td><td>n</td><td>o</td></tr>',
    '<tr data-row="r3" data-hidden><td>c</td><td>x</td><td>99</td><td>n</td><td>o</td></tr>',
    '<tr data-row="r4"><td>d</td><td>x</td><td></td><td>n</td><td>o</td></tr>',
    '<tr data-row="r5"><td>e</td><td>x</td><td></td><td>n</td><td>o</td></tr>',
    '<tr data-row="r6"><td colspan="2">merged</td><td>7</td><td>n</td><td>o</td></tr>',
    '<tr data-row="r7"><td>g</td><td>x</td><td></td><td>n</td><td>o</td></tr>',
  ].join('\n');
  return doc('Fill', `<table data-tdoc-sheet data-name="Fill">${HEAD.replace('%HID%', ' data-hidden')}<tbody>\n${rows}\n</tbody></table>`);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheets-integration-'));
  const writeDoc = (slug, html) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  writeDoc('combo', combo());
  writeDoc('frozen', combo({ freeze: true }));
  writeDoc('find', combo());
  writeDoc('rows', combo());
  writeDoc('fill', fillDoc());

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheets: formatting x structure x rules (release 2026-11-11d)');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.stack || e.message));
    const frameLoc = () => page.frameLocator('iframe[aria-label="Document content"]');
    async function open(slug) {
      await page.goto('about:blank');
      await page.goto(`${base}/d/${slug}/v/1`);
      await frameLoc().locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      const frame = page.frames().find((f) => f.url().includes('/frame'));
      await frame.waitForFunction(() => !!document.documentElement.getAttribute('data-tdoc-interaction-mode'));
      return frame;
    }
    const frameMode = (frame, m) => frame.waitForFunction((x) => document.documentElement.getAttribute('data-tdoc-interaction-mode') === x, m);
    async function edit(slug) { const frame = await open(slug); await chooseMode(page, 'Edit'); await frameMode(frame, 'edit'); return frame; }
    async function dragTo(from, to) {
      const a = await from.boundingBox(), b = await to.boundingBox();
      const x = a.x + a.width / 2, y = a.y + a.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let k = 1; k <= 8; k++) await page.mouse.move(x + ((b.x + b.width / 2 - x) * k) / 8, y + ((b.y + b.height / 2 - y) * k) / 8);
      await page.waitForTimeout(50);
      await page.mouse.up();
    }
    // The grid cell of document row `row` (r1…) and column c, as drawn.
    const gridCell = (frame, row, c) => frame.evaluate(([n, cc]) => {
      const rowEl = Array.from(document.querySelectorAll('.ts-rows .ts-row')).find((x) => x.querySelector('.ts-n').textContent.trim() === String(n));
      const el = rowEl && rowEl.querySelector(`.ts-c[data-c="${cc}"]`);
      // a covered slot below a merge is a placeholder without a column
      const cov = !el && rowEl && Array.from(rowEl.querySelectorAll('.fx-cov'));
      if (!el) return rowEl ? (cov.length ? { cls: cov[0].className, covered: cov.length } : { missing: true }) : null;
      return { cls: el.className, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, bg: getComputedStyle(el).backgroundColor, text: el.textContent };
    }, [Number(row.slice(1)), c]);
    const headW = (frame, c) => frame.evaluate((cc) => { const h = document.querySelector(`.ts-h[data-c="${cc}"]`); return h ? h.getBoundingClientRect().width : 0; }, c);
    // A cell's text in the document, by column key (merges leave cells out of the markup).
    const docText = (frame, row, c) => frame.evaluate(([r, cc]) => {
      const tr = document.querySelector(`table[data-tdoc-sheet] tr[data-row="${r}"]`);
      let col = 0;
      for (const td of tr.cells) { const span = Number(td.getAttribute('colspan') || 1); if (cc >= col && cc < col + span) return cc === col ? td.textContent : ''; col += span; }
      return undefined;
    }, [row, c]);
    const tint = (frame, name) => frame.evaluate((n) => {
      const probe = document.createElement('div'); probe.className = 'ts-c fx-fill fx-f-' + n; probe.style.cssText = 'position:absolute;left:-999px';
      const host = document.querySelector('.tdoc-sheet'); host.appendChild(probe);
      const bg = getComputedStyle(probe).backgroundColor; probe.remove(); return bg;
    }, name);
    const RED = 'rgb(253, 232, 231)';

    await test('merges x hidden rows/columns and groups: drawn merged only when the view shows all of them; hidden columns add no width', async () => {
      const frame = await open('combo');
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      // r1-r2 down: one tall cell, r2's slot a placeholder.
      const a = await gridCell(frame, 'r1', 0), b = await gridCell(frame, 'r2', 0);
      assert(/fx-span/.test(a.cls) && /fx-tall/.test(a.cls) && a.h > 50, `r1-r2 merged: ${JSON.stringify(a)}`);
      assert(b && /fx-cov/.test(b.cls), `r2's slot is covered: ${JSON.stringify(b)}`);
      // r7: Item..Notes with Notes hidden: as wide as Item + Points.
      const w = await gridCell(frame, 'r7', 1), w1 = await headW(frame, 1), w2 = await headW(frame, 2);
      assert(/fx-span/.test(w.cls) && Math.abs(w.w - (w1 + w2)) <= 2, `r7 merge width ${w.w} vs ${w1}+${w2}`);
      // r6: the merge's top-left is in the hidden Notes column: Owner is a cell of its own (empty), not swallowed.
      const o = await gridCell(frame, 'r6', 4);
      assert(o && !o.missing && !/fx-cov|fx-span/.test(o.cls), `r6 Owner drawn as itself: ${JSON.stringify(o)}`);
      // r8-r10 down across hidden r9: drawn cell by cell (r10's Group is an empty cell, not a placeholder).
      const t8 = await gridCell(frame, 'r8', 0), t10 = await gridCell(frame, 'r10', 0);
      assert(!/fx-span/.test(t8.cls) && t8.text === 'Tall' && t10 && !/fx-cov/.test(t10.cls), `r8-r10 unmerged: ${JSON.stringify([t8, t10])}`);
      // r3 (colspan) is in a group: collapsed, it is gone; open again, merged again.
      await frameLoc().getByRole('button', { name: /Collapse rows 3–4/ }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 6);
      assert((await gridCell(frame, 'r3', 0)) === null, 'r3 hidden in its collapsed group');
      await frameLoc().getByRole('button', { name: /Expand rows 3–4/ }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 8);
      const s3 = await gridCell(frame, 'r3', 0);
      assert(/fx-span/.test(s3.cls) && s3.text === 'Software', `r3 merged again: ${JSON.stringify(s3)}`);
      // Sorted, the r1-r2 merge parts and draws cell by cell.
      await frameLoc().getByRole('button', { name: 'Points column menu' }).click();
      await frameLoc().getByRole('menuitem', { name: 'Sort descending' }).click();
      await frame.waitForFunction(() => window.__tdocSheets.tabs()[0].query.sort.length === 1);
      const sorted = await gridCell(frame, 'r1', 0);
      assert(!/fx-span/.test(sorted.cls), `sorted: unmerged ${JSON.stringify(sorted)}`);
    });

    await test('merges x freeze: a merge the frozen rows\' edge cuts through is drawn cell by cell, and the frozen row stays one row tall', async () => {
      const frame = await open('frozen');
      await frame.waitForFunction(() => window.__tdocSheets.structure().frozenRows === 1);
      const a = await gridCell(frame, 'r1', 0);
      assert(!/fx-span|fx-tall/.test(a.cls) && a.text === 'Hardware' && a.h < 50, `r1 not merged under a frozen edge: ${JSON.stringify(a)}`);
      const frozenH = await frame.evaluate(() => { const fr = document.querySelector('.ts-frozen, [class*="frozen"]'); return fr ? fr.getBoundingClientRect().height : -1; });
      assert(frozenH < 60, `frozen band one row: ${frozenH}`);
      // The r7 merge (not cut) is still merged.
      assert(/fx-span/.test((await gridCell(frame, 'r7', 1)).cls), 'r7 still merged');
    });

    await test('conditional formatting x a cell\'s own fill: the rule\'s fill wins; the own fill shows where no rule matches', async () => {
      const frame = await open('combo');
      const yellow = await tint(frame, 'yellow');
      const r1 = await gridCell(frame, 'r1', 2), r3 = await gridCell(frame, 'r3', 2), r2 = await gridCell(frame, 'r2', 2);
      assert(r1.bg === RED && !/fx-f-yellow/.test(r1.cls), `120 > 100: red over its own yellow: ${JSON.stringify(r1)}`);
      assert(r3.bg === yellow, `70: its own yellow (${yellow}): ${JSON.stringify(r3)}`);
      assert(r2.bg !== RED && r2.bg !== yellow, `40: no fill: ${JSON.stringify(r2)}`);
      // The merged, own-filled Group cell keeps its own green (no rule on that column).
      assert(/fx-f-green/.test((await gridCell(frame, 'r1', 0)).cls), 'own fill on a merge kept');
    });

    await test('find & replace x hidden columns and collapsed groups: Find skips hidden columns and opens a group; Replace all counts and changes hidden cells', async () => {
      const frame = await edit('find');
      const f = frameLoc();
      await f.getByRole('button', { name: /Collapse rows 3–4/ }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 6);
      await f.locator('.ts-rows .ts-row[data-i="0"] .ts-c[data-c="1"]').click();
      await page.keyboard.press(`${MOD}+Shift+h`);
      const pop = f.locator('.ts-find');
      await pop.waitFor();
      // Only the hidden Notes column says "note": counted as hidden, never stepped onto.
      await pop.getByRole('textbox', { name: 'Find' }).fill('note');
      await frame.waitForFunction(() => /^5 matches \(incl\. 5 hidden\)$/.test(document.querySelector('.ts-find-st').textContent));
      await pop.getByRole('button', { name: 'Find', exact: true }).click();
      await frame.waitForFunction(() => /No matches/.test(document.querySelector('.ts-find-st').textContent));
      assert(await frame.evaluate(() => window.__tdocSheets.selection().c) !== 3, 'never on the hidden column');
      // "Licences" is in the collapsed group: Find opens it and lands there.
      await pop.getByRole('textbox', { name: 'Find' }).fill('Licences');
      await pop.getByRole('button', { name: 'Find', exact: true }).click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 8);
      const s = await frame.evaluate(() => window.__tdocSheets.selection());
      const row = await frame.evaluate((i) => document.querySelector(`.ts-rows .ts-row[data-i="${i}"] .ts-n`).textContent.trim(), s.r);
      assert(row === '4' && s.c === 1, `on r4 Item: ${JSON.stringify(s)} row ${row}`);
      // Replace all reaches the hidden column (and the hidden row r5).
      await pop.getByRole('textbox', { name: 'Find' }).fill('note');
      await pop.getByRole('textbox', { name: 'Replace with' }).fill('memo');
      await pop.getByRole('button', { name: 'Replace all' }).click();
      await frame.waitForFunction(() => /Replaced 5 cells/.test(document.querySelector('.ts-find-st').textContent));
      assert(await docText(frame, 'r5', 3) === 'memo five', 'hidden row, hidden column replaced');
      await page.keyboard.press('Escape');
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r5"]').cells[3].textContent === 'note five');
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    await test('fill handle x hidden rows, hidden columns and merges', async () => {
      const frame = await edit('fill');
      const f = frameLoc();
      const cell = (i, c) => f.locator(`.ts-rows .ts-row[data-i="${i}"] .ts-c[data-c="${c}"]`);
      // View rows: r1 r2 r4 r5 r6 r7 (r3 hidden). Points 1, 2 dragged down two rows: r4 = 3, r5 = 4; hidden r3 keeps 99.
      await cell(0, 2).click();
      await page.keyboard.press('Shift+ArrowDown');
      await dragTo(f.locator('.ts-fill'), cell(3, 2));
      await frame.waitForFunction(() => ['r4', 'r5'].map((r) => document.querySelector(`tr[data-row="${r}"]`).cells[2].textContent).join() === '3,4');
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r3"]').cells[2].textContent) === '99', 'the hidden row is not filled');
      // Dragged right one shown column from Points: Owner is filled, the hidden Notes is stepped over.
      await cell(0, 0).click();
      await dragTo(f.locator('.ts-fill'), cell(0, 1));
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"]').cells[1].textContent === 'a');
      await cell(1, 2).click();
      await dragTo(f.locator('.ts-fill'), cell(1, 4));
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"]').cells[4].textContent !== 'o');
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r2"]').cells[3].textContent) === 'n', 'the hidden column is not filled');
      // A merged cell selected: the handle sits at the merge's far corner.
      await cell(4, 0).click();
      const m = await cell(4, 0).boundingBox(), dot = await f.locator('.ts-fill').boundingBox();
      assert(Math.abs(dot.x + dot.width / 2 - (m.x + m.width)) <= 3, `handle at the merge's right edge: dot ${dot.x} merge ${m.x}+${m.width}`);
      // Dragged down: the merge's value fills the next row; the merge is not extended, nothing is written to a covered slot.
      await dragTo(f.locator('.ts-fill'), cell(5, 0));
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r7"]').cells[0].textContent === 'merged');
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r6"]').cells[0].getAttribute('colspan')) === '2', 'merge kept');
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r6"]').cells.length) === 4, 'no covered cell written into r6');
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    await test('insert / delete rows x merges x groups x rules', async () => {
      const frame = await edit('rows');
      const f = frameLoc();
      const rowN = (n) => f.locator('.ts-rows .ts-row', { has: f.locator('.ts-n', { hasText: new RegExp(`^${n}$`) }) }).first().locator('.ts-n');
      // A row inserted under r1 lands inside the r1-r2 merge: it grows to three rows.
      await rowN(1).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Insert row below' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"]').cells[0].getAttribute('rowspan') === '3');
      const newId = await frame.evaluate(() => document.querySelector('tr[data-row="r1"]').nextElementSibling.getAttribute('data-row'));
      assert(await frame.evaluate((id) => document.querySelector(`tr[data-row="${id}"]`).cells.length, newId) === 4, 'the new row has no cell under the merge');
      // A row inserted under r3 (in the group) joins it.
      const pos = (id) => frame.evaluate((x) => Array.from(document.querySelectorAll('table[data-tdoc-sheet] tbody tr')).findIndex((tr) => tr.getAttribute('data-row') === x) + 1, id);
      await rowN(await pos('r3')).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Insert row below' }).click();
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r3"]').nextElementSibling.getAttribute('data-row') !== 'r4');
      const grouped = await frame.evaluate(() => { const tr = document.querySelector('tr[data-row="r3"]').nextElementSibling; return [tr.getAttribute('data-row'), tr.getAttribute('data-group')]; });
      assert(grouped[1] === '1', `joins the group: ${grouped}`);
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 10);
      // The rule colours a value typed into the new row.
      const newRowI = (await pos(grouped[0])) - 1;
      const c = f.locator(`.ts-rows .ts-row[data-i="${newRowI}"] .ts-c[data-c="2"]`);
      await c.click();
      await page.keyboard.type('500');
      await page.keyboard.press('Enter');
      await frame.waitForFunction((i) => getComputedStyle(document.querySelector(`.ts-rows .ts-row[data-i="${i}"] .ts-c[data-c="2"]`)).backgroundColor === 'rgb(253, 232, 231)', newRowI);
      // The group folds with its new row (three rows).
      await f.getByRole('button', { name: /Collapse rows/ }).first().click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 7);
      await f.getByRole('button', { name: /Expand rows/ }).first().click();
      await frame.waitForFunction(() => window.__tdocSheets.structure().shown === 10);
      // Deleting the merge's top row: the merge shrinks to the two rows left.
      await rowN(1).click({ button: 'right' });
      await f.getByRole('menuitem', { name: 'Delete row' }).click();
      await frame.waitForFunction(() => !document.querySelector('tr[data-row="r1"]'));
      const left = await frame.evaluate(() => Array.from(document.querySelectorAll('table[data-tdoc-sheet] tbody tr')).slice(0, 2).map((tr) => tr.cells.length + ':' + (tr.cells[0].getAttribute('rowspan') || '1')));
      assert(/^5:2,4:1$/.test(left.join()), `the rest of the merge is merged over two rows: ${left}`);
      // Undo (from the grid) puts r1 and its merge back.
      await f.locator('.ts-rows .ts-row[data-i="1"] .ts-c[data-c="1"]').click();
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"]') && document.querySelector('tr[data-row="r1"]').cells[0].getAttribute('rowspan') === '3');
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    await test('no page errors', async () => { assert(!errors.length, errors.join('\n')); });
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
