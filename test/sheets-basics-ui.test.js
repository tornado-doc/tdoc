// Sheets, the spreadsheet basics, in the browser against the local server:
//   - Read / Comment / Edit on a sheet behave as on a doc: Read edits
//     nothing and shows no comment affordance, a click in Comment mode
//     comments on the cell, Edit edits it
//   - column resize: drag a header's edge (the frozen first column too),
//     double-click it to fit; row resize by the row number's edge
//   - an owner's column resize in Read or Comment mode is saved as a new
//     version (data-width, a browser edit by them) 1.5 s after the last
//     change, so a burst of resizes is one version, and at once when Edit
//     mode opens: no Edit mode, no Save bar, no reload, the address as it
//     was; the same in a prose doc's flat view, where a table wider than its
//     box scrolls sideways inside it
//   - in Edit mode a resize goes into the editor's draft: Save writes
//     data-width / data-height; the editor bar's Undo takes it back
//   - a reader who may not edit gets no column grip (grid or flat view)
//   - Wrap text / Clip and Left / Center / Right per column; wrapped rows grow
//   - line breaks: Alt/Option+Enter and Ctrl+Enter in a cell, Enter commits;
//     a multi-line cell pasted from Excel / Sheets keeps its breaks; saved as <br>
//   - fill down (⌘/Ctrl+D), ⌘/Ctrl+arrow to the data's edge, Shift+Space /
//     header click select a row / column, Esc cancels an edit
//   - a phone: modes, a touch drag resizes a column in Read mode (grid and
//     flat view), saved the same way
//   - 10,000 rows with a wrapped column: wrap applies and scrolls in budget
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheets-basics-ui.test.js');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheets-basics-'));
  const writeDoc = (slug, html, versions = 1) => {
    for (let v = 1; v <= versions; v++) {
      fs.mkdirSync(path.join(root, slug, `v${v}`), { recursive: true });
      fs.writeFileSync(path.join(root, slug, `v${v}`, 'index.html'), html);
    }
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: Array.from({ length: versions }, (_, i) => ({ n: i + 1, created: new Date().toISOString() })) }));
  };
  const LONG = 'A long note that will not fit in one line of this column, so wrapping it makes the row taller.';
  const sheet = (rows = 30) => M.sheetDocumentHtml({ title: 'Basics', sheets: [{ name: 'Tasks', columns: [
    { name: 'Task', type: 'text' }, { name: 'Notes', type: 'text' }, { name: 'Points', type: 'number' }, { name: 'Status', type: 'tags' },
  ], rows: Array.from({ length: rows }, (_, k) => ({ id: `r${k + 1}`, cells: [k === 5 ? '' : `Task ${k + 1}`, k % 3 === 0 ? LONG : `note ${k + 1}`, String(k * 3), [k % 2 ? 'open' : 'done']] })) }] });
  for (const slug of ['modes', 'resize', 'resize-edit', 'rows', 'wrap', 'lines', 'keys', 'phone']) writeDoc(slug, sheet());
  // A small sheet in a prose doc: the flat view in Read and Comment mode.
  const prose = (cols) => `<!doctype html><html><head><meta charset="utf-8"><title>Prose</title></head><body><main><h1>Runs</h1><p>One.</p><p>Two.</p><p>Three.</p>${M.tableHtml({ name: 'Runs', columns: cols.map((name) => ({ name, type: 'text' })), rows: Array.from({ length: 6 }, (_, k) => ({ id: `r${k + 1}`, cells: cols.map((n) => `${n} ${k + 1}`) })) })}<p>After.</p></main></body></html>`;
  writeDoc('flat', prose(['Run', 'Notes', 'Owner', 'State', 'Result']));
  writeDoc('flat-reader', prose(['Run', 'Notes', 'Owner', 'State', 'Result']), 2);
  writeDoc('flat-phone', prose(['Run', 'Notes', 'Owner']));
  // A prose doc with a sheet, for full screen and its own page (?sheet=1).
  writeDoc('fullpage', `<!doctype html><html><head><meta charset="utf-8"><title>Full</title></head><body><main><h1>Full</h1><p id="before">Before the sheet.</p>${M.tableHtml({ name: 'Runs', columns: [{ name: 'Run', type: 'text' }, { name: 'Notes', type: 'text' }], rows: Array.from({ length: 8 }, (_, k) => ({ id: `r${k + 1}`, cells: [`run ${k + 1}`, 'n'] })) })}<p>After.</p></main></body></html>`);
  // A reader who may not edit: an older version (local canEdit is latest-only).
  writeDoc('reader', sheet(), 2);
  // 10,000 rows, one long text column.
  writeDoc('big', M.sheetDocumentHtml({ title: 'Big', sheets: [{ name: 'Rows', columns: [{ name: 'Name', type: 'text' }, { name: 'Notes', type: 'text' }, { name: 'N', type: 'number' }], rows: Array.from({ length: 10000 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Customer ${k}`, k % 4 ? `short ${k}` : `${LONG} ${LONG.slice(0, (k * 7) % LONG.length)}`, String(k)] })) }] }));

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheets: modes, resize, wrap, line breaks, spreadsheet basics');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const frameLoc = (p = page) => p.frameLocator('iframe[aria-label="Document content"]');
    async function open(slug, { v = 1, viewPage = page, hash = '' } = {}) {
      await viewPage.goto('about:blank');
      await viewPage.goto(`${base}/d/${slug}/v/${v}${hash}`);
      await frameLoc(viewPage).locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      const frame = viewPage.frames().find((f) => f.url().includes('/frame'));
      await frame.waitForFunction(() => !!document.documentElement.getAttribute('data-tdoc-interaction-mode'));
      return frame;
    }
    const frameMode = (frame, m) => frame.waitForFunction((x) => document.documentElement.getAttribute('data-tdoc-interaction-mode') === x, m);
    const th = (frame, c, attr) => frame.evaluate(([cc, a]) => document.querySelectorAll('table[data-tdoc-sheet] thead th')[cc].getAttribute(a), [c, attr]);
    const saved = (slug, v) => fs.readFileSync(path.join(root, slug, `v${v}`, 'index.html'), 'utf8');
    async function save(slug, v) {
      const button = page.getByRole('button', { name: 'Save', exact: true });
      await page.waitForFunction(() => { const b = document.querySelector('.tdoc-editor-toolbar button.primary'); return b && !b.disabled; });
      await button.click();
      await page.waitForURL(new RegExp(`/d/${slug}/v/${v}`), { timeout: 10000 });
    }
    async function dragBy(p, locator, dx, dy) {
      const box = await locator.boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await p.mouse.move(x, y);
      await p.mouse.down();
      for (let k = 1; k <= 6; k++) await p.mouse.move(x + (dx * k) / 6, y + (dy * k) / 6);
      await p.mouse.up();
    }

    // ---- modes -------------------------------------------------------------
    await test('Read: nothing edits, no comment affordance; Comment: a click on a cell comments on it; Edit: a cell edits', async () => {
      const frame = await open('modes');
      const f = frameLoc();
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      const cell = f.locator('.ts-row[data-i="1"] .ts-c[data-c="0"]');
      await cell.click();
      await page.keyboard.type('x');
      await cell.dblclick();
      await page.waitForTimeout(200);
      const read = await frame.evaluate(() => ({ editor: !!document.querySelector('.ts-editor'), pill: !!document.querySelector('.ts-c .tdoc-comment-pill'), comment: !!document.querySelector('.ts-bar [aria-label="Comment on sheet"]'), add: !document.querySelector('.ts-add-row').hidden }));
      assert(!read.editor && !read.pill && !read.comment && !read.add, `read: ${JSON.stringify(read)}`);
      assert(!(await page.locator('.tdoc-popup textarea').count()), 'no composer in Read');
      await shot(page, 'mode-read-desktop');

      await chooseMode(page, 'Comment');
      await frameMode(frame, 'comment');
      await f.locator('.ts-row[data-i="2"] .ts-c[data-c="1"]').click();
      await page.waitForSelector('.tdoc-popup textarea', { timeout: 5000 });
      await shot(page, 'mode-comment-desktop');
      // Comment mode is the one way in: no extra "Comment on sheet" button.
      assert(await frame.evaluate(() => !document.querySelector('.ts-bar [aria-label="Comment on sheet"]')), 'no "Comment on sheet" button in Comment mode');
      await page.keyboard.press('Escape');
      // A drag over cells selects a range and opens nothing.
      await page.locator('.tdoc-popup').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});

      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await f.locator('.ts-row[data-i="1"] .ts-c[data-c="0"]').dblclick();
      await f.locator('.ts-editor').waitFor();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.type('Edited');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"] td').textContent === 'Edited');
      await shot(page, 'mode-edit-desktop');
      // Esc cancels an edit.
      await f.locator('.ts-row[data-i="3"] .ts-c[data-c="0"]').click();
      await page.keyboard.type('nope');
      await page.keyboard.press('Escape');
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r4"] td').textContent === 'Task 4'), 'Esc cancels');
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    // ---- column resize -----------------------------------------------------
    const versionOf = (slug) => JSON.parse(fs.readFileSync(path.join(root, slug, 'meta.json'), 'utf8')).versions;
    const waitForVersion = async (slug, n) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { if (fs.existsSync(path.join(root, slug, `v${n}`, 'index.html')) && versionOf(slug).some((v) => v.n === n)) return; await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(`${slug} v${n} was not saved`);
    };
    await test('column resize in Comment and Read mode (owner): saved at once as a new version, no Edit mode, no Save bar, no reload', async () => {
      const frame = await open('resize');
      const f = frameLoc();
      await chooseMode(page, 'Comment');
      await frameMode(frame, 'comment');
      await frame.evaluate(() => { window.__sameFrame = true; });
      const w0 = await frame.evaluate(() => document.querySelector('.ts-h[data-c="1"]').getBoundingClientRect().width);
      // The toast comes after the save's answer reaches the page, and goes by
      // itself: wait for it from the start.
      const toast = page.locator('.tdoc-shell-toast', { hasText: /^Column width saved$/ }).waitFor();
      toast.catch(() => {});
      await dragBy(page, f.locator('.ts-h[data-c="1"] .ts-resize'), 90, 0);
      await waitForVersion('resize', 2);
      const v2 = saved('resize', 2);
      const w1 = Number((v2.match(/<th[^>]*data-key="c2"[^>]*data-width="(\d+)"/) || [])[1]);
      assert(Math.abs(w1 - (w0 + 90)) <= 2, `width ${w0} → ${w1}`);
      const meta2 = versionOf('resize').find((v) => v.n === 2);
      assert(meta2.source === 'browser' && meta2.author === 'owner', `a browser edit by the owner: ${JSON.stringify(meta2)}`);
      assert(new URL(page.url()).pathname === '/d/resize/v/1', `the address is left as it was: ${page.url()}`);
      await toast;
      assert(await page.locator(modeSelector('comment')).count(), 'still Comment mode');
      assert(!(await page.locator('.tdoc-editor-toolbar').count()), 'no Save bar');
      assert(await frame.evaluate(() => window.__sameFrame === true), 'no reload');
      const shown = await frame.evaluate(() => document.querySelector('.ts-row .ts-c[data-c="1"]').getBoundingClientRect().width);
      assert(Math.abs(shown - w1) <= 1, `the cells follow: ${shown}`);
      await shot(page, 'resize-column-comment-desktop');
      // Read mode too; the next save is based on the version this page wrote.
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      await dragBy(page, f.locator('.ts-h[data-c="0"] .ts-resize'), 40, 0);
      await waitForVersion('resize', 3);
      assert(/<th[^>]*data-key="c1"[^>]*data-width="\d+"/.test(saved('resize', 3)) && /<th[^>]*data-key="c2"[^>]*data-width="\d+"/.test(saved('resize', 3)), 'v3 holds both widths');
      // Double-click the edge: fit, saved the same way.
      await f.locator('.ts-h[data-c="1"] .ts-resize').dblclick();
      await waitForVersion('resize', 4);
      // Edit mode afterwards starts from the saved page: nothing to save.
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await page.waitForTimeout(500);
      assert(await page.locator('.tdoc-editor-toolbar button.primary').isDisabled(), 'Edit mode: no changes to save');
      await chooseMode(page, 'Read');
    });

    await test('a burst of resizes is one version; widths still waiting are saved when Edit mode opens', async () => {
      writeDoc('resize-burst', sheet());
      const frame = await open('resize-burst');
      const f = frameLoc();
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      // One after another in the page: the save goes out 1.5 s after the last
      // drag, and three drags from here take longer than that on a busy machine.
      await frame.evaluate(() => {
        for (const c of [0, 1, 2]) {
          const grip = document.querySelector(`.ts-h[data-c="${c}"] .ts-resize`);
          const r = grip.getBoundingClientRect();
          const at = (type, dx) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 });
          grip.dispatchEvent(at('pointerdown', 0));
          document.body.dispatchEvent(at('pointermove', 30));
          document.body.dispatchEvent(at('pointerup', 30));
        }
      });
      await waitForVersion('resize-burst', 2);
      await page.waitForTimeout(2500);
      assert(!fs.existsSync(path.join(root, 'resize-burst', 'v3')), 'three resizes in a row: one version');
      assert((saved('resize-burst', 2).match(/<th[^>]*data-width="\d+"/g) || []).length === 3, 'v2 holds all three widths');
      // Drag, then open Edit mode before the wait is over: saved at once,
      // and Edit mode has nothing of it left to save.
      await dragBy(page, f.locator('.ts-h[data-c="3"] .ts-resize'), 30, 0);
      await chooseMode(page, 'Edit');
      await waitForVersion('resize-burst', 3);
      assert(/<th[^>]*data-key="c4"[^>]*data-width="\d+"/.test(saved('resize-burst', 3)), 'v3 holds the fourth width');
      await frameMode(frame, 'edit');
      await page.waitForTimeout(500);
      assert(await page.locator('.tdoc-editor-toolbar button.primary').isDisabled(), 'Edit mode: no changes to save');
      // The next Save is based on v3.
      await f.locator('.ts-row[data-i="1"] .ts-c[data-c="0"]').dblclick();
      await f.locator('.ts-editor').waitFor();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.type('After');
      await page.keyboard.press('Enter');
      await save('resize-burst', 4);
      assert(/<th[^>]*data-key="c4"[^>]*data-width="\d+"/.test(saved('resize-burst', 4)) && saved('resize-burst', 4).includes('After'), 'v4: the edit on top of the widths');
    });

    await test('column resize in Edit mode: the editor draft and Save write data-width; Undo takes it back', async () => {
      const frame = await open('resize-edit');
      const f = frameLoc();
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      const w0 = await frame.evaluate(() => document.querySelector('.ts-h[data-c="1"]').getBoundingClientRect().width);
      await dragBy(page, f.locator('.ts-h[data-c="1"] .ts-resize'), 90, 0);
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th')[1].hasAttribute('data-width'));
      assert(!fs.existsSync(path.join(root, 'resize-edit', 'v2')), 'nothing saved before Save');
      const w1 = Number(await th(frame, 1, 'data-width'));
      assert(Math.abs(w1 - (w0 + 90)) <= 2, `width ${w0} → ${w1}`);
      const shown = await frame.evaluate(() => document.querySelector('.ts-row .ts-c[data-c="1"]').getBoundingClientRect().width);
      assert(Math.abs(shown - w1) <= 1, `the cells follow: ${shown}`);
      // The frozen first column resizes the same way.
      await dragBy(page, f.locator('.ts-h[data-c="0"] .ts-resize'), 40, 0);
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th')[0].hasAttribute('data-width'));
      await shot(page, 'resize-column-desktop');
      // Undo on the editor bar undoes the sheet's last change.
      await page.locator('.tdoc-editor-toolbar button[aria-label="Undo"]').click();

      await frame.waitForFunction(() => !document.querySelectorAll('table[data-tdoc-sheet] thead th')[0].hasAttribute('data-width'));
      // Double-click the edge: fit to the longest note.
      await f.locator('.ts-h[data-c="1"] .ts-resize').dblclick();
      // Fitted: wider than the dragged width and the longest note shows whole
      // (how much wider depends on the system font, so no fixed margin).
      await frame.waitForFunction((w) => Number(document.querySelectorAll('table[data-tdoc-sheet] thead th')[1].getAttribute('data-width')) > w, w1);
      const fit = await frame.evaluate(() => {
        const cell = [...document.querySelectorAll('.ts-row .ts-c[data-c="1"]')].find((c) => c.textContent.startsWith('A long'));
        const t = cell && (cell.querySelector('.ts-t') || cell);
        return t ? { sw: t.scrollWidth, cw: t.clientWidth } : null;
      });
      assert(fit && fit.sw <= fit.cw, `the longest note shows whole: ${JSON.stringify(fit)}`);
      await save('resize-edit', 2);
      const html = saved('resize-edit', 2);
      assert(/<th[^>]*data-key="c2"[^>]*data-width="\d+"/.test(html), 'v2 holds the width');
      assert(!/<th[^>]*data-key="c1"[^>]*data-width/.test(html), 'the undone width is not saved');
    });

    await test('full screen leaves nothing in the document: ?sheet=1 in Edit, resize, export and Save hold no viewer state', async () => {
      await page.goto('about:blank');
      await page.goto(`${base}/d/fullpage/v/1?sheet=1`);
      await frameLoc().locator('.tdoc-sheet.is-expanded .ts-row').first().waitFor({ timeout: 15000 });
      const frame = page.frames().find((x) => x.url().includes('/frame'));
      const f = frameLoc();
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      // The rest of the page is out of reach under it, by a provider style.
      const hidden = await frame.evaluate(() => ({ p: getComputedStyle(document.getElementById('before')).visibility, grid: getComputedStyle(document.querySelector('.ts-grid')).visibility, inert: document.querySelectorAll('[inert]').length, attr: document.documentElement.hasAttribute('data-tdoc-sheet-expanded') }));
      assert(hidden.p === 'hidden' && hidden.grid === 'visible' && !hidden.inert && !hidden.attr, JSON.stringify(hidden));
      // Entering Edit mode draws the header and its grips again a few frames
      // after the mode is set: drag the grip that stays (the same element
      // through several frames in a row).
      await frame.evaluate(() => new Promise((resolve) => {
        let el = null, same = 0;
        (function look() {
          const now = document.querySelector('.ts-h[data-c="1"] .ts-resize');
          same = now && now === el ? same + 1 : 0;
          el = now;
          if (same >= 10) resolve(); else requestAnimationFrame(look);
        })();
      }));
      await dragBy(page, f.locator('.ts-h[data-c="1"] .ts-resize'), 60, 0);
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th')[1].hasAttribute('data-width'));
      // Export while full screen (Download & copy builds from this HTML).
      const exported = await page.evaluate(() => new Promise((resolve) => {
        const iframe = document.querySelector('iframe[aria-label="Document content"]');
        const on = (e) => { if (e.data && e.data.type === 'tdoc:exportHtml' && e.data.requestId === 'probe-test') { window.removeEventListener('message', on); resolve(e.data.html); } };
        window.addEventListener('message', on);
        iframe.contentWindow.postMessage({ source: 'tdoc-shell', type: 'tdoc:exportHtml', requestId: 'probe-test' }, '*');
      }));
      const clean = (html, where) => {
        assert(!/\sinert(=|\s|>)/.test(html), `${where}: no inert`);
        assert(!/data-tdoc-sheet-expanded/.test(html), `${where}: no data-tdoc-sheet-expanded`);
        assert(!/is-expanded|visibility:hidden!important/.test(html), `${where}: no full-screen style`);
        assert(/data-width="\d+"/.test(html), `${where}: the resize is there`);
      };
      clean(exported, 'export');
      await save('fullpage', 2);
      clean(saved('fullpage', 2), 'saved v2');
    });

    await test('a reader who may not edit gets no column grip (grid and flat view); their own fitted width is kept across a reload, never in the document', async () => {
      const frame = await open('reader', { v: 1 });
      const f = frameLoc();
      assert(!(await f.locator('.ts-resize').count()), 'no grip in the grid for a reader');
      const before = await frame.evaluate(() => document.querySelector('table[data-tdoc-sheet]').outerHTML);
      await f.getByRole('button', { name: 'Notes column menu' }).click();
      await f.getByRole('menuitem', { name: 'Fit width to content' }).click();
      await page.waitForTimeout(400);
      assert(!(await page.locator(modeSelector('edit')).count()), 'no Edit mode for a reader');
      assert(!(await page.locator('.tdoc-editor-toolbar').count()), 'no Save bar');
      const w = await frame.evaluate(() => document.querySelector('.ts-h[data-c="1"]').getBoundingClientRect().width);
      assert(await frame.evaluate(() => document.querySelector('table[data-tdoc-sheet]').outerHTML) === before, 'the document is untouched');
      await page.reload();
      await frameLoc().locator('.ts-row').first().waitFor();
      const again = page.frames().find((x) => x.url().includes('/frame'));
      await again.waitForFunction((x) => Math.abs(document.querySelector('.ts-h[data-c="1"]').getBoundingClientRect().width - x) <= 1, w);
      assert(!fs.existsSync(path.join(root, 'reader', 'v3')), 'no version saved');
      // The flat view (a small sheet in a prose doc), in Read and Comment mode.
      await page.goto('about:blank');
      await page.goto(`${base}/d/flat-reader/v/1`);
      await frameLoc().locator('.ts-flat th').first().waitFor({ timeout: 15000 });
      for (const m of ['Read', 'Comment']) {
        await chooseMode(page, m);
        assert(!(await frameLoc().locator('.ts-resize').count()), `${m}: no grip in the flat view for a reader`);
      }
      await shot(page, 'flat-reader-desktop');
    });

    await test('flat view (a small sheet in a prose doc), owner in Read mode: drag a header edge, saved at once; wider than its box, the table scrolls sideways inside it', async () => {
      await page.goto('about:blank');
      await page.goto(`${base}/d/flat`);
      const f = frameLoc();
      await f.locator('.ts-flat th').first().waitFor({ timeout: 15000 });
      const frame = page.frames().find((x) => x.url().includes('/frame'));
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      assert(await frame.evaluate(() => document.querySelector('.tdoc-sheet').classList.contains('is-flat')), 'the flat view');
      const thw = () => frame.evaluate(() => document.querySelector('.ts-flat th[data-c="1"]').getBoundingClientRect().width);
      const loadedAt = page.url();
      const w0 = await thw();
      await f.locator('.ts-flat th[data-c="1"]').hover();
      await shot(page, 'flat-grip-hover-desktop');
      await dragBy(page, f.locator('.ts-flat th[data-c="1"] .ts-resize'), 120, 0);
      await waitForVersion('flat', 2);
      const w1 = Number((saved('flat', 2).match(/<th[^>]*data-key="c2"[^>]*data-width="(\d+)"/) || [])[1]);
      assert(Math.abs(w1 - (w0 + 120)) <= 2, `width ${w0} → ${w1}`);
      await frame.waitForFunction((w) => Math.abs(document.querySelector('.ts-flat th[data-c="1"]').getBoundingClientRect().width - w) <= 1, w1);
      assert(await page.locator(modeSelector('read')).count(), 'still Read mode');
      assert(!(await page.locator('.tdoc-editor-toolbar').count()), 'no Save bar');
      // Every column far wider: the table scrolls inside its box, the page does not.
      for (let c = 4; c >= 0; c--) {
        await f.locator('.ts-flat').evaluate((el) => { el.scrollLeft = 0; });
        await dragBy(page, f.locator(`.ts-flat th[data-c="${c}"] .ts-resize`), 160, 0);
        await page.waitForTimeout(150);
      }
      await frame.waitForFunction(() => [...document.querySelectorAll('.ts-flat th')].every((t) => t.classList.contains('is-set')), null, { timeout: 8000 })
        .catch(async (e) => { throw new Error(`${e.message}: ${await frame.evaluate(() => [...document.querySelectorAll('.ts-flat th')].map((t) => t.className + ':' + Math.round(t.getBoundingClientRect().right)).join(' '))}`); });
      const box = await frame.evaluate(() => { const el = document.querySelector('.ts-flat'); return { sw: el.scrollWidth, cw: el.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
      assert(box.sw > box.cw + 100 && box.page <= 1, `scrolls inside its box: ${JSON.stringify(box)}`);
      await shot(page, 'flat-wide-desktop');
      // Every save is in (one at a time; the last drags wait for the one before).
      const latestHtml = () => { const n = Math.max(...versionOf('flat').map((v) => v.n)); return saved('flat', n); };
      const deadline = Date.now() + 10000;
      while ((latestHtml().match(/data-width="\d+"/g) || []).length < 5 && Date.now() < deadline) await page.waitForTimeout(100);
      assert((latestHtml().match(/data-width="\d+"/g) || []).length === 5, 'the latest version holds all five widths');
      // The address is left as it was (no new /v/N in it), and the doc's own
      // address shows the latest version: the widths are the document's.
      assert(page.url() === loadedAt, `the address is left as it was: ${loadedAt} → ${page.url()}`);
      await page.goto(`${base}/d/flat`);
      await f.locator('.ts-flat th').first().waitFor({ timeout: 15000 });
      const again = page.frames().find((x) => x.url().includes('/frame'));
      await again.waitForFunction(() => [...document.querySelectorAll('.ts-flat th')].every((t) => t.classList.contains('is-set')));
    });

    await test('row resize: drag a row number\'s edge (Save writes data-height); double-click fits it again', async () => {
      const frame = await open('rows');
      const f = frameLoc();
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await dragBy(page, f.locator('.ts-row[data-i="1"] .ts-rresize'), 0, 40);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"]').getAttribute('data-height') === '72');
      const hgt = await frame.evaluate(() => document.querySelector('.ts-row[data-i="1"]').getBoundingClientRect().height);
      assert(Math.abs(hgt - 72) <= 1, `row drawn ${hgt}px`);
      const next = await frame.evaluate(() => document.querySelector('.ts-row[data-i="2"]').getBoundingClientRect().top - document.querySelector('.ts-row[data-i="1"]').getBoundingClientRect().top);
      assert(Math.abs(next - 72) <= 1, `the next row starts below it: ${next}`);
      await shot(page, 'resize-row-desktop');
      await dragBy(page, f.locator('.ts-row[data-i="3"] .ts-rresize'), 0, 20);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r4"]').hasAttribute('data-height'));
      await f.locator('.ts-row[data-i="3"] .ts-rresize').dblclick();
      await frame.waitForFunction(() => !document.querySelector('tr[data-row="r4"]').hasAttribute('data-height'));
      await save('rows', 2);
      assert(/<tr data-row="r2" data-height="72">/.test(saved('rows', 2)), 'v2 holds the height');
    });

    // ---- wrap and alignment ------------------------------------------------
    await test('Wrap text / Clip and alignment per column, from the column menu; wrapped rows grow; saved', async () => {
      const frame = await open('wrap');
      const f = frameLoc();
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await f.getByRole('button', { name: 'Notes column menu' }).click();
      await f.getByRole('menuitemradio', { name: 'Wrap text' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th')[1].getAttribute('data-wrap') === 'wrap');
      const grown = await frame.evaluate(() => {
        const cell = document.querySelector('.ts-row[data-i="0"] .ts-c[data-c="1"]');
        const t = cell.querySelector('.ts-t');
        return { row: cell.parentElement.getBoundingClientRect().height, other: document.querySelector('.ts-row[data-i="1"]').getBoundingClientRect().height, fits: t.getBoundingClientRect().bottom <= cell.getBoundingClientRect().bottom + 1 };
      });
      assert(grown.row > 40 && grown.fits && grown.other === 32, `a long note's row grows to show it, short rows stay: ${JSON.stringify(grown)}`);
      await shot(page, 'wrap-desktop');
      await f.getByRole('button', { name: 'Points column menu' }).click();
      await f.getByRole('menuitemradio', { name: 'Center' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] thead th')[2].getAttribute('data-align') === 'center');
      assert(await frame.evaluate(() => getComputedStyle(document.querySelector('.ts-row .ts-c[data-c="2"]')).justifyContent === 'center'), 'centered');
      await save('wrap', 2);
      const html = saved('wrap', 2);
      assert(/data-key="c2"[^>]*data-wrap="wrap"/.test(html) && /data-key="c3"[^>]*data-align="center"/.test(html), 'v2 holds wrap and alignment');
      // Clip again.
      const v2 = await open('wrap', { v: 2 });
      await chooseMode(page, 'Edit');
      await frameMode(v2, 'edit');
      await frameLoc().getByRole('button', { name: 'Notes column menu' }).click();
      await frameLoc().getByRole('menuitemradio', { name: 'Clip' }).click();
      await v2.waitForFunction(() => document.querySelector('.ts-row[data-i="0"]').getBoundingClientRect().height === 32);
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    // ---- line breaks -------------------------------------------------------
    await test('line breaks: Alt+Enter and Ctrl+Enter in a cell, Enter commits; a multi-line paste keeps them; saved as <br>', async () => {
      const frame = await open('lines');
      const f = frameLoc();
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="0"]').dblclick();
      await f.locator('textarea.ts-editor').waitFor();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.type('line one');
      await page.keyboard.press('Alt+Enter');
      await page.keyboard.type('line two');
      await page.keyboard.press('Control+Enter');
      await page.keyboard.type('three');
      await shot(page, 'newline-editing-desktop');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r1"] td').innerHTML === 'line one<br>line two<br>three');
      const cell = await frame.evaluate(() => { const c = document.querySelector('.ts-row[data-i="0"] .ts-c[data-c="0"]'); return { ml: c.classList.contains('is-ml'), text: c.querySelector('.ts-t').textContent, sel: window.__tdocSheets.selection().r }; });
      assert(cell.ml && cell.text === 'line one\nline two\nthree' && cell.sel === 1, `shown with its breaks, Enter moved down: ${JSON.stringify(cell)}`);
      // A range from Excel / Sheets: a quoted cell with a break, then a tab.
      await f.locator('.ts-row[data-i="2"] .ts-c[data-c="0"]').click();
      await frame.evaluate(() => {
        const dt = new DataTransfer(); dt.setData('text/plain', '"pasted\nacross lines"\tsecond\r\nnext row\tx\r\n');
        document.querySelector('.ts-grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r3"] td').innerHTML === 'pasted<br>across lines');
      assert(await frame.evaluate(() => document.querySelector('tr[data-row="r3"] td:nth-child(2)').textContent === 'second' && document.querySelector('tr[data-row="r4"] td').textContent === 'next row'), 'the rest of the range lands beside and below');
      // Wrapped, the row shows every line.
      await f.getByRole('button', { name: 'Task column menu' }).click();
      await f.getByRole('menuitemradio', { name: 'Wrap text' }).click();
      await frame.waitForFunction(() => document.querySelector('.ts-row[data-i="0"]').getBoundingClientRect().height >= 3 * 18);
      await shot(page, 'newline-wrapped-desktop');
      await save('lines', 2);
      assert(/<tr data-row="r1"><td>line one<br>line two<br>three<\/td>/.test(saved('lines', 2)), 'v2 holds <br>');
    });

    // ---- spreadsheet basics ------------------------------------------------
    await test('fill down, ⌘/Ctrl+arrow to the data edge, Shift+Space, header click selects a column in Edit', async () => {
      const frame = await open('keys');
      const f = frameLoc();
      await chooseMode(page, 'Edit');
      await frameMode(frame, 'edit');
      const sel = () => frame.evaluate(() => window.__tdocSheets.selection());
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="0"]').click();
      // Task 6 (row 6) is blank: ⌘↓ stops at row 5, then jumps past the gap.
      await page.keyboard.press(`${MOD}+ArrowDown`);
      assert((await sel()).r === 4, `stops before the blank: ${JSON.stringify(await sel())}`);
      await page.keyboard.press(`${MOD}+ArrowDown`);
      assert((await sel()).r === 6, `jumps to the next filled: ${JSON.stringify(await sel())}`);
      await page.keyboard.press(`${MOD}+ArrowDown`);
      assert((await sel()).r === 29, 'then to the end');
      // Fill down: select r1..r3 in Points, ⌘D.
      await page.keyboard.press(`${MOD}+ArrowUp`);
      await f.locator('.ts-row[data-i="0"] .ts-c[data-c="2"]').click();
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press(`${MOD}+d`);
      await frame.waitForFunction(() => ['r2', 'r3'].every((id) => document.querySelector(`tr[data-row="${id}"] td:nth-child(3)`).textContent === '0'));
      // Shift+Space: the whole row.
      await page.keyboard.press('Shift+Space');
      let s = await sel();
      assert(s.c === 0 && s.c2 === 3, `row: ${JSON.stringify(s)}`);
      // Header click in Edit mode: the column.
      await f.locator('.ts-h[data-c="1"] .ts-hname').click();
      s = await sel();
      assert(s.c === 1 && s.c2 === 1 && s.r === 0 && s.r2 === 29, `column: ${JSON.stringify(s)}`);
      assert(await frame.evaluate(() => window.__tdocSheets.tabs()[0].query.sort.length === 0), 'no sort in Edit mode');
      // Delete clears it; ⌘Z brings it back.
      await page.keyboard.press('Delete');
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"] td:nth-child(2)').textContent === '');
      await page.keyboard.press(`${MOD}+z`);
      await frame.waitForFunction(() => document.querySelector('tr[data-row="r2"] td:nth-child(2)').textContent === 'note 2');
      await page.getByRole('button', { name: /Discard/ }).click().catch(() => {});
    });

    // ---- phone -------------------------------------------------------------
    await test('a phone: modes, a tap comments, a touch drag on a header edge resizes the column', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
      const p = await phone.newPage();
      let frame = await open('phone', { viewPage: p });
      const f = frameLoc(p);
      await chooseMode(p, 'Read');
      await frameMode(frame, 'read');
      await f.locator('.ts-row[data-i="1"] .ts-c[data-c="0"]').tap();
      await p.waitForTimeout(300);
      assert(!(await p.locator('.tdoc-popup textarea, [role="dialog"] textarea').count()), 'Read: a tap opens nothing');
      await shot(p, 'mode-read-phone');
      await chooseMode(p, 'Comment');
      await frameMode(frame, 'comment');
      await f.locator('.ts-row[data-i="2"] .ts-c[data-c="0"]').tap();
      await p.locator('textarea').first().waitFor({ timeout: 5000 });
      await shot(p, 'mode-comment-phone');
      // A fresh load for the drag, with nothing open over the page: an
      // owner's drag in Read mode is saved as it is on a desktop.
      frame = await open('phone', { viewPage: p });
      await chooseMode(p, 'Read');
      await frameMode(frame, 'read');
      // A finger drag (CDP touch events) on the frozen first column's edge.
      const grip = await f.locator('.ts-h[data-c="0"] .ts-resize').boundingBox();
      const iframeBox = await p.locator('iframe[aria-label="Document content"]').boundingBox();
      const w0 = await frame.evaluate(() => document.querySelector('.ts-h[data-c="0"]').getBoundingClientRect().width);
      const cdp = await phone.newCDPSession(p);
      const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
      assert(grip.width >= 20, `a finger-sized grip: ${grip.width}px`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      for (let k = 1; k <= 6; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + k * 10, y, id: 1 }] }); await p.waitForTimeout(30); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitForVersion('phone', 2);
      const w1 = Number((saved('phone', 2).match(/<th[^>]*data-key="c1"[^>]*data-width="(\d+)"/) || [])[1]);
      assert(Math.abs(w1 - (w0 + 60)) <= 3, `touch resize ${w0} → ${w1} (frame at ${iframeBox.y})`);
      assert(!(await p.locator('.tdoc-editor-toolbar').count()), 'phone: no Save bar');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `no sideways page scroll: ${overflow}`);
      await shot(p, 'resize-column-phone');
      // The flat view on a phone (three columns read as a table): the same.
      await p.goto('about:blank');
      await p.goto(`${base}/d/flat-phone/v/1`);
      await frameLoc(p).locator('.ts-flat th').first().waitFor({ timeout: 15000 });
      frame = p.frames().find((x) => x.url().includes('/frame'));
      await chooseMode(p, 'Read');
      await frameMode(frame, 'read');
      const fg = await frameLoc(p).locator('.ts-flat th[data-c="1"] .ts-resize').boundingBox();
      assert(fg && fg.width >= 20, `a finger-sized grip in the flat view: ${fg && fg.width}px`);
      const fw0 = await frame.evaluate(() => document.querySelector('.ts-flat th[data-c="1"]').getBoundingClientRect().width);
      const fx = fg.x + fg.width / 2, fy = fg.y + fg.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fx, y: fy, id: 2 }] });
      for (let k = 1; k <= 6; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fx + k * 10, y: fy, id: 2 }] }); await p.waitForTimeout(30); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitForVersion('flat-phone', 2);
      const fw1 = Number((saved('flat-phone', 2).match(/<th[^>]*data-key="c2"[^>]*data-width="(\d+)"/) || [])[1]);
      assert(Math.abs(fw1 - (fw0 + 60)) <= 3, `flat touch resize ${fw0} → ${fw1}`);
      const overflow2 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow2 <= 1, `no sideways page scroll: ${overflow2}`);
      await shot(p, 'flat-resize-phone');
      await phone.close();
    });

    // ---- 10,000 rows -------------------------------------------------------
    await test('10,000 rows: wrapping a column and scrolling stay inside a frame budget', async () => {
      const t0 = Date.now();
      const frame = await open('big');
      const openMs = Date.now() - t0;
      await chooseMode(page, 'Read');
      await frameMode(frame, 'read');
      const scrollRun = () => frame.evaluate(() => new Promise((resolve) => {
        const grid = document.querySelector('.ts-grid');
        grid.scrollTop = 0;
        const gaps = [];
        let last = performance.now(), n = 0;
        function step(now) {
          gaps.push(now - last); last = now;
          grid.scrollTop += 1400;
          if (++n < 120) requestAnimationFrame(step);
          else {
            gaps.shift(); gaps.sort((a, b) => a - b);
            resolve({ median: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)], rows: document.querySelectorAll('.ts-row').length, at: grid.scrollTop });
          }
        }
        requestAnimationFrame(step);
      }));
      const plain = await scrollRun();
      // Wrap the Notes column (the owner, from Read mode: into Edit mode and
      // the editor's draft, the path a reader's own view takes too).
      const w0 = Date.now();
      await frameLoc().getByRole('button', { name: 'Notes column menu' }).click();
      await frameLoc().getByRole('menuitemradio', { name: 'Wrap text' }).click();
      await frame.waitForFunction(() => document.querySelector('.ts-c.is-wrap'));
      const wrapMs = Date.now() - w0;
      const wrapped = await scrollRun();
      const total = await frame.evaluate(() => parseFloat(document.querySelector('.ts-body').style.height));
      console.log(`    (10k rows: open ${openMs}ms; scroll p95 ${plain.p95.toFixed(1)}ms clipped, ${wrapped.p95.toFixed(1)}ms wrapped (median ${wrapped.median.toFixed(1)}ms); wrap applied in ${wrapMs}ms; body ${Math.round(total)}px)`);
      assert(total > 10000 * 32 + 2000 * 18, `wrapped rows are taller: ${total}`);
      assert(wrapped.median < 34 && wrapped.p95 < 80 && wrapped.rows < 120, `wrapped scroll frames: ${JSON.stringify(wrapped)}`);
      assert(wrapMs < 1500, `wrap applied in ${wrapMs}ms`);
      await shot(page, 'wrap-10k-desktop');
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
