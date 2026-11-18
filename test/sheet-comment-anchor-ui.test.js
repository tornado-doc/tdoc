// A comment on a sheet cell lands on that cell, by its row id and column
// key, never by position, end to end against the local server:
//   - a sheet in a prose doc, wider than the reading column, two frozen
//     columns: a comment stored on K1 (row r1, key c11; the shape a reader's
//     comment has) is marked on K1 when its pin is pressed, the grid scrolls
//     to it, and it ends left of the pin and its card; closing the card clears it
//   - a sheet doc, sorted, filtered and with a hidden column: a cell comment
//     stores the row id and key of the cell clicked, its label names that
//     cell, and after a reload the mark is on the same cell
//   - the same sheet embedded in a page (sheetEmbeds): the embed's comment
//     count goes to the sheet, where the comment marks its cell
//   - a hand-written table whose rows have no ids: a body cell's comment is
//     that cell, not its column's header
//   - a link to a cell comment, the grid drawn only after it opened (a slow
//     load): the cell is still marked
//   - a phone: a link to the comment shows its cell
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheet-comment-anchor-ui.test.js');
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
  const Q = await import('../shared/sheet-query.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheet-anchor-ui-'));
  const writeDoc = (slug, html, title, comments) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title, versions: [{ n: 1, created: new Date().toISOString() }] }, null, 2));
    if (comments) fs.writeFileSync(path.join(root, slug, 'comments.json'), JSON.stringify(comments, null, 2));
  };
  const readComments = (slug) => { try { return JSON.parse(fs.readFileSync(path.join(root, slug, 'comments.json'), 'utf8')); } catch { return []; } };
  const now = new Date().toISOString();

  // (c) Hand-written sheet tables in a prose doc. "Tasks" is wider than the
  // reading column, with two frozen columns, like the report this is for;
  // every cell says where it is (R<row>C<column key number>).
  const wideCols = 15;
  const head = Array.from({ length: wideCols }, (_, c) => `<th data-key="c${c + 1}" data-type="text"${c === 2 ? ' data-wrap="wrap"' : ''}>Column ${c + 1}</th>`).join('');
  const body = Array.from({ length: 12 }, (_, r) => `<tr data-row="r${r + 1}">${Array.from({ length: wideCols }, (_, c) => `<td>${c === 2 ? `A long description for row ${r + 1} that wraps over a few lines in a wide column` : `R${r + 1}C${c + 1}`}</td>`).join('')}</tr>`).join('');
  const notes = `<table data-tdoc-sheet data-name="Notes"><thead><tr><th data-key="n1">Item</th><th data-key="n2">Note</th></tr></thead><tbody>${[1, 2, 3, 4].map((k) => `<tr><td>N${k}A</td><td>N${k}B</td></tr>`).join('')}</tbody></table>`;
  writeDoc('wide', `<!doctype html><html><head><meta charset="utf-8"><title>Task list</title></head><body><main>
<h1>Task list</h1>
<p>Every task, one row each. The columns past the frozen two scroll sideways.</p>
<div class="tdoc-table-scroll"><table data-tdoc-sheet data-name="Tasks" data-freeze-cols="2"><caption>Tasks</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
${notes}
<p>That is all.</p>
</main></body></html>`, 'Task list', [
    // The stored shape of a reader's comment on K1 (position and key agree).
    { id: 'c_k1', text: 'Is this count right?', status: 'open', author: { login: 'owner' }, created: now, version: 1,
      anchor: { kind: 'element', selector: 'table[data-tdoc-sheet][data-name="Tasks"] tr[data-row="r1"] > :nth-child(11)', label: 'Tasks!K1 · Column 11', tag: 'td', text: 'R1C11', sheet: { table: 'Tasks', row: 'r1', key: 'c11' } } },
  ]);

  // (a) A sheet doc: Notes (c3) is a hidden column.
  const statuses = ['open', 'done'];
  const rows = Array.from({ length: 12 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Task ${k + 1}`, ['Ann', 'Bo', 'Cy'][k % 3], `note ${k + 1}`, [statuses[k % 2]], String((k * 7) % 13)] }));
  const trackerHtml = M.sheetDocumentHtml({ title: 'Tracker', sheets: [
    { name: 'Tasks', columns: [{ name: 'Task', type: 'text' }, { name: 'Owner', type: 'text' }, { name: 'Notes', type: 'text' }, { name: 'Status', type: 'tags' }, { name: 'Points', type: 'number' }], rows },
  ] }).replace('<th data-key="c3"', '<th data-key="c3" data-hidden');
  assert(/data-key="c3" data-hidden/.test(trackerHtml), 'the Notes column is hidden');
  writeDoc('tracker', trackerHtml, 'Tracker');
  // (b) A page embedding it.
  writeDoc('weekly', `<!doctype html><html><head><meta charset="utf-8"><title>Weekly</title></head><body><main><h1>Weekly</h1><p>The open tasks:</p>
<figure data-tdoc-embed="sheet" data-src="/d/tracker" data-rows="4"><a href="/d/tracker">Tracker</a></figure><p>End.</p></main></body></html>`, 'Weekly');

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheet cell comments land on their cell');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const openShadows = () => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) { return attach.call(this, Object.assign({}, init, { mode: 'open' })); };
    };
    async function newContext(viewport) {
      const context = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      await context.addInitScript(openShadows);
      await context.addInitScript(() => {
        window.__TDOC_FLAGS__ = Object.assign(window.__TDOC_FLAGS__ || {}, { sheetEmbeds: true });
        try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {}
      });
      return context;
    }
    const desktop = await newContext({ width: 1280, height: 900 });
    const page = await desktop.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const frameOf = (p) => p.frames().find((f) => f.url().includes('/frame'));
    const frameLoc = (p = page) => p.frameLocator('iframe[aria-label="Document content"]');
    async function open(p, url) {
      await p.goto(`${base}${url}`);
      await frameLoc(p).locator('.tdoc-sheet .ts-row, .ts-flat td, .ts-flat .ts-card').first().waitFor({ timeout: 15000 });
      return frameOf(p);
    }
    // The cell the open comment is marked on, as the grid shows it.
    const marked = (frame) => frame.evaluate(() => {
      const c = document.querySelector('.tdoc-sheet .is-comment-on');
      if (!c) return null;
      const grid = c.closest('.ts-grid, .ts-flat') || document.body;
      const g = grid.getBoundingClientRect(), r = c.getBoundingClientRect();
      const row = c.closest('.ts-row');
      return {
        text: c.textContent.trim(), c: c.getAttribute('data-c'),
        first: row ? row.querySelector('[data-c="0"]').textContent.trim() : null,
        left: r.left, right: r.right, inGrid: r.left >= g.left - 1 && r.right <= g.right + 1 && r.width > 0,
        // Seen, not only placed: no frozen column drawn over it.
        onTop: c.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12))),
      };
    });
    const pinFor = async (p) => { await p.locator('.tdoc-pin').first().waitFor({ timeout: 8000 }); return p.locator('.tdoc-pin').first(); };

    await test('a sheet wider than the reading column: pressing the pin of a K1 comment marks K1 and scrolls the grid to it, clear of the pin', async () => {
      const frame = await open(page, '/d/wide/v/1');
      await frame.waitForFunction(() => window.__tdocElementHooks && typeof window.__tdocElementHooks.activate === 'function');
      // Unopened: no mark, and K1 is off to the right of the grid.
      assert(await marked(frame) === null, 'nothing marked before the comment opens');
      const off = await frame.evaluate(() => {
        const td = window.__tdocElementHooks.resolve({ sheet: { table: 'Tasks', row: 'r1', key: 'c11' } });
        const cell = window.__tdocElementHooks.proxy(td);
        return { src: td && td.textContent, left: cell.getBoundingClientRect().left, gridRight: document.querySelector('.ts-grid').getBoundingClientRect().right };
      });
      assert(off.src === 'R1C11', `the anchor resolves to K1 by row and key: ${off.src}`);
      assert(off.left > off.gridRight, `K1 starts out of the grid's view: ${JSON.stringify(off)}`);
      await shot(page, 'wide-before-open');
      const pin = await pinFor(page);
      const pinBox = await pin.boundingBox();
      await pin.click();
      await frame.waitForFunction(() => !!document.querySelector('.tdoc-sheet .is-comment-on'));
      const m = await marked(frame);
      assert(m.text === 'R1C11' && m.c === '10' && m.first === 'R1C1', `the marked cell is K1: ${JSON.stringify(m)}`);
      assert(m.inGrid && m.onTop, `K1 is in the grid's view: ${JSON.stringify(m)}`);
      const frameX = (await page.locator('iframe[aria-label="Document content"]').boundingBox()).x;
      assert(m.right + frameX <= pinBox.x + 2, `K1 ends left of the pin (cell right ${m.right + frameX}, pin ${pinBox.x})`);
      const sel = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(sel.r === 0 && sel.c === 10, `the grid's selection is K1: ${JSON.stringify(sel)}`);
      await shot(page, 'wide-pin-open');
      // Closing the card clears the mark.
      await page.keyboard.press('Escape');
      await frame.waitForFunction(() => !document.querySelector('.tdoc-sheet .is-comment-on'), null, { timeout: 5000 });
    });

    await test('a cell in a row without an id: its comment is that cell, not the column header, after a reload', async () => {
      const frame = await open(page, '/d/wide/v/1');
      await chooseMode(page, 'Comment');
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      const f = frameLoc();
      await f.getByRole('tab', { name: 'Notes' }).click();
      await f.locator('.ts-row[data-i="2"] .ts-c[data-c="1"]').click();
      await page.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
      await page.fill('.tdoc-popup textarea', 'Which note?');
      await page.click('.tdoc-popup .submit');
      let saved;
      for (let k = 0; k < 50; k++) { saved = readComments('wide').find((c) => c.text === 'Which note?'); if (saved) break; await page.waitForTimeout(100); }
      assert(saved, 'saved');
      assert(saved.anchor.sheet && saved.anchor.sheet.table === 'Notes' && saved.anchor.sheet.key === 'n2' && !saved.anchor.sheet.row, JSON.stringify(saved.anchor));
      assert(/^Notes!B3\b/.test(saved.anchor.label || ''), `labelled with the cell: ${saved.anchor.label}`);
      const reloaded = await open(page, `/d/wide/v/1?comment=${saved.id}`);
      await reloaded.waitForFunction(() => !!document.querySelector('.tdoc-sheet .is-comment-on'), null, { timeout: 8000 });
      const m = await marked(reloaded);
      assert(m.text === 'N3B' && m.first === 'N3A', `the marked cell is B3, not the header: ${JSON.stringify(m)}`);
      const src = await reloaded.evaluate((a) => { const el = window.__tdocElementHooks.resolve(a); return el && [el.tagName, el.textContent]; }, saved.anchor);
      assert(src && src[0] === 'TD' && src[1] === 'N3B', JSON.stringify(src));
      await page.keyboard.press('Escape');
    });

    let trackerComment = null;
    await test('a sheet doc, sorted, filtered, a hidden column: the comment keeps the clicked cell\'s row id and key, its label, and lands on it after a reload', async () => {
      const view = Q.encodeView({ active: 'Tasks', tabs: { Tasks: { search: '', filters: { 3: { values: ['open'] } }, sort: [{ col: 4, dir: 'desc' }], totals: {} } } });
      const frame = await open(page, `/d/tracker/v/1#sheet=${encodeURIComponent(view)}`);
      await chooseMode(page, 'Comment');
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      await frame.waitForFunction(() => document.querySelector('.ts-count') && /^6 of 12 rows/.test(document.querySelector('.ts-count').textContent));
      assert(await frame.evaluate(() => !document.querySelector('.ts-h[data-c="2"]') || document.querySelector('.ts-h[data-c="2"]').getBoundingClientRect().width === 0), 'Notes is hidden');
      // The second row shown, its Points cell.
      const target = await frame.evaluate(() => { const row = document.querySelector('.ts-row[data-i="1"]'); return { task: row.querySelector('[data-c="0"]').textContent.trim(), points: row.querySelector('[data-c="4"]').textContent.trim() }; });
      const k = Number(target.task.replace('Task ', ''));
      assert(k !== 2 && k > 0, `the sort moved rows: ${target.task}`);
      await frameLoc().locator('.ts-row[data-i="1"] .ts-c[data-c="4"]').click();
      await page.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
      await page.fill('.tdoc-popup textarea', 'Points right?');
      await page.click('.tdoc-popup .submit');
      for (let n = 0; n < 50 && !trackerComment; n++) { trackerComment = readComments('tracker').find((c) => c.text === 'Points right?'); if (!trackerComment) await page.waitForTimeout(100); }
      assert(trackerComment, 'saved');
      const a = trackerComment.anchor;
      assert(a.sheet.table === 'Tasks' && a.sheet.row === `r${k}` && a.sheet.key === 'c5', `row id and key of the clicked cell: ${JSON.stringify(a.sheet)}`);
      assert(/^E\d+\b/.test(a.label) && a.label.startsWith(`E${k} `), `the label names the cell clicked (E${k}): ${a.label}`);
      // A reload with the same sort and filter: the pin opens it on that cell.
      await page.reload();
      await frameLoc().locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      const again = frameOf(page);
      await (await pinFor(page)).click();
      await again.waitForFunction(() => !!document.querySelector('.tdoc-sheet .is-comment-on'), null, { timeout: 8000 });
      const m = await marked(again);
      assert(m.first === target.task && m.text === target.points && m.c === '4', `marked ${JSON.stringify(m)}, expected ${JSON.stringify(target)}`);
      await shot(page, 'sheet-doc-sorted-filtered-open');
      await page.keyboard.press('Escape');
      await chooseMode(page, 'Read');
    });

    await test('a page embedding the sheet: the comment count goes to the sheet, where the comment marks its cell', async () => {
      assert(trackerComment, 'the sheet doc test left a comment');
      await page.goto(`${base}/d/weekly/v/1`);
      await frameLoc().locator('h1').first().waitFor({ timeout: 15000 });
      const frame = frameOf(page);
      await frame.waitForFunction(() => window.__tdocSheetEmbeds && window.__tdocSheetEmbeds.list().length === 1 && window.__tdocSheetEmbeds.list()[0].state === 'live', null, { timeout: 15000 });
      const link = await frame.evaluate(() => { const a = document.querySelector('[data-tdoc-embed-host]').shadowRoot.querySelector('.se-comments'); return a && { text: a.textContent.trim(), href: a.getAttribute('href') }; });
      assert(link && /^1\b/.test(link.text) && /\/d\/tracker/.test(link.href), JSON.stringify(link));
      await shot(page, 'embed-page');
      const href = new URL(link.href, base);
      href.searchParams.set('comment', trackerComment.id);
      const sheet = await open(page, href.pathname + href.search + href.hash);
      await sheet.waitForFunction(() => !!document.querySelector('.tdoc-sheet .is-comment-on'), null, { timeout: 8000 });
      const m = await marked(sheet);
      const k = trackerComment.anchor.sheet.row.slice(1);
      assert(m.first === `Task ${k}` && m.c === '4', `marked ${JSON.stringify(m)}`);
      await page.keyboard.press('Escape');
    });

    // On a slow load the comments arrive, and the link opens its comment,
    // before the sheets viewer has drawn the grid. The frame keeps what is
    // open and hands it to the viewer once it mounts (this flaked on CI).
    await test('a link to a cell comment marks the cell when the grid draws after the comment opened', async () => {
      const ctx = await newContext({ width: 1280, height: 900 });
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      await ctx.route(/\/sheets-viewer\.js/, async (route) => { await held; await route.continue(); });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      try {
        await p.goto(`${base}/d/wide/v/1?comment=c_k1`, { waitUntil: 'commit' }); // the frame's load waits on the held viewer
        // The card is open while the viewer is still held back.
        await p.getByText('Is this count right?').first().waitFor({ timeout: 15000 });
        const frame = frameOf(p);
        assert(await frame.evaluate(() => !document.querySelector('.tdoc-sheet')), 'the grid has not drawn yet');
        release();
        await frame.waitForFunction(() => !!document.querySelector('.tdoc-sheet .is-comment-on'), null, { timeout: 15000 });
        const m = await marked(frame);
        assert(m.text === 'R1C11' && m.first === 'R1C1', `the marked cell is K1: ${JSON.stringify(m)}`);
        assert(m.inGrid && m.onTop, `K1 is in the grid's view: ${JSON.stringify(m)}`);
      } finally {
        release();
        await ctx.close();
      }
    });

    await test('a phone: a link to the K1 comment shows K1 marked, in view', async () => {
      const phone = await newContext({ width: 390, height: 844 });
      const p = await phone.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      const frame = await open(p, '/d/wide/v/1?comment=c_k1');
      await frame.waitForFunction(() => !!document.querySelector('.tdoc-sheet .is-comment-on'), null, { timeout: 10000 });
      // The grid takes its phone width as the page loads; the cell is brought in once it has.
      await frame.waitForFunction(() => { const c = document.querySelector('.tdoc-sheet .is-comment-on'), g = document.querySelector('.ts-grid').getBoundingClientRect(), r = c.getBoundingClientRect(); return r.left >= g.left - 1 && r.right <= g.right + 1 && c.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 12)); }, null, { timeout: 3000 }).catch(() => {});
      // Two frozen columns wider than the phone's grid: one stays frozen, so the rest can be seen.
      const st = await frame.evaluate(() => window.__tdocSheets.structure());
      assert(st && st.frozenCols < 2, `frozen as drawn: ${JSON.stringify(st && st.frozenCols)}`);
      const m = await marked(frame);
      assert(m.text === 'R1C11', `marked ${JSON.stringify(m)}`);
      assert(m.inGrid && m.onTop, `in view, not under the frozen columns: ${JSON.stringify(m)}`);
      await shot(p, 'wide-phone-open');
      await p.locator('.tdoc-drawer-handle').first().click().catch(() => {});
      await p.waitForTimeout(500);
      await shot(p, 'wide-phone-drawer-closed');
      await phone.close();
    });

    assert(!errors.length, `page errors: ${errors.join('\n')}`);
  } catch (error) {
    console.log(`  ✗ setup\n    ${error.stack || error.message}`);
    fail++;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
