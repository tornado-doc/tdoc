// Browser acceptance for modeless editing on SHEETS (flag modelessEdit):
// someone who may edit a sheet has no Read / Comment / Edit switch and no
// Save bar. A click selects a cell, typing or a double-click edits it,
// Enter / Tab / arrows move, the structure menus are there, and the change
// autosaves through the doc's modeless path (EditorSaveStatus, a version in
// place). Comments still work without a mode (the cell's pill, the cell's
// menu, a commented cell opens its thread); a search / filter view in the
// #hash keeps working while editing. Someone who may only comment is
// unchanged; flag off is today's Read / Comment / Edit.
// Run with: node test/sheet-modeless-edit-ui.test.js
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { chromium, devices } = requirePlaywrightOrSkip('sheet-modeless-edit-ui.test.js');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

let pass = 0, fail = 0;
async function test(name, operation) {
  if (process.env.TDOC_TEST_FILTER && !name.includes(process.env.TDOC_TEST_FILTER)) return;
  try { await operation(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
async function until(check, timeout) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function waitForServer(port, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const request = http.get({ host: '127.0.0.1', port, path: '/' }, (response) => { response.resume(); resolve(); });
      request.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('local server did not start'));
        else setTimeout(poll, 80);
      });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheet-modeless-'));
  const slug = 'roadmap';
  const docRoot = path.join(root, slug);
  const OWNERS = ['Ana', 'Bea', 'Cai', 'Dee', 'Eli', 'Fay'];
  const SHEET_HTML = M.sheetDocumentHtml({ title: 'Roadmap', sheets: [{ name: 'Tasks', columns: [
    { name: 'Task', type: 'text' }, { name: 'Owner', type: 'text' }, { name: 'Points', type: 'number' }, { name: 'Status', type: 'tags' },
  ], rows: Array.from({ length: 12 }, (_, k) => ({ id: `r${k + 1}`, cells: [`Task ${k + 1}`, OWNERS[k % OWNERS.length], String((k + 1) * 2), [k % 3 ? 'open' : 'done']] })) }] });
  const reset = () => {
    fs.rmSync(docRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(docRoot, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(docRoot, 'v1', 'index.html'), SHEET_HTML);
    fs.writeFileSync(path.join(docRoot, 'meta.json'), JSON.stringify({ slug, title: 'Roadmap', versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  const versions = () => JSON.parse(fs.readFileSync(path.join(docRoot, 'meta.json'))).versions.map((v) => Number(v.n));
  const latest = () => Math.max(...versions());
  const readComments = () => { try { return JSON.parse(fs.readFileSync(path.join(docRoot, 'comments.json'), 'utf8')); } catch { return []; } };
  const versionHtml = (n) => fs.readFileSync(path.join(docRoot, `v${n}`, 'index.html'), 'utf8');

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  // As the published doc page would be (modeless-edit-ui.test.js): the local
  // server's boot is patched to "published".
  async function newContext({ flag = true, idleMs = 120_000, shell = {}, mobile = false } = {}) {
    const context = await browser.newContext(mobile
      ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }
      : { viewport: { width: 1280, height: 800 } });
    await context.addInitScript(([flagOn, idle]) => {
      window.__TDOC_FLAGS__ = { modelessEdit: flagOn };
      window.__TDOC_MODELESS_IDLE_MS = idle;
      window.__TDOC_LIVE_SYNC_MS = 700;
      try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {}
    }, [flag, idleMs]);
    await context.route(new RegExp(`/d/${slug}(/v/\\d+)?(\\?.*)?$`), async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/window\.__TDOC_SHELL__ = (.*?);<\/script>/,
        (_, json) => `window.__TDOC_SHELL__ = ${JSON.stringify({ ...JSON.parse(json), mode: 'published', historyVisible: true, ...shell })};</script>`);
      await route.fulfill({ response, body });
    });
    return context;
  }
  async function openSheet(context, { address = null, page: given = null } = {}) {
    const page = given || await context.newPage();
    if (!page.errors) {
      page.errors = [];
      page.on('pageerror', (error) => page.errors.push(error.message));
    }
    await page.goto(address || `${base}/d/${slug}/v/${latest()}`, { waitUntil: 'networkidle' });
    const handle = await page.locator('iframe.tdoc-doc-frame').elementHandle();
    const frame = await handle.contentFrame();
    await frame.locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
    await frame.waitForFunction(() => !!document.documentElement.getAttribute('data-tdoc-interaction-mode'));
    return { page, frame };
  }
  const cell = (frame, i, c) => frame.locator(`.ts-row[data-i="${i}"] .ts-c[data-c="${c}"]`);
  const cellText = (frame, i, c) => cell(frame, i, c).innerText();
  const tdText = (frame, r, c) => frame.evaluate(([rr, cc]) => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[rr].children[cc].textContent, [r, c]);
  const hide = (page) => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    await test('flag off: a sheet keeps Read / Comment / Edit; Comment mode edits nothing; Edit has Save', async () => {
      reset();
      const context = await newContext({ flag: false });
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('comment')).waitFor();
      await cell(frame, 1, 1).click();
      await page.keyboard.type('Zed');
      await page.waitForTimeout(300);
      assert(await tdText(frame, 1, 1) === 'Bea', 'Comment mode edited a cell');
      assert(await page.locator('.tdoc-editor-autosave').count() === 0, 'the autosave status showed with the flag off');
      await page.keyboard.press('Escape');
      await chooseMode(page, 'Edit');
      await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
      await cell(frame, 1, 1).click();
      await page.keyboard.type('Zed');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[1].children[1].textContent === 'Zed');
      assert(await page.locator('.tdoc-editor-autosave').count() === 0, 'Edit mode showed the autosave status');
      assert(latest() === 1, 'Edit mode published without Save');
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('an editor edits a cell at once: no mode switch, no Save; autosave publishes; the edit is there after reload', async () => {
      reset();
      const context = await newContext({ idleMs: 2500 });
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('edit')).waitFor();
      assert(await frame.evaluate(() => document.documentElement.hasAttribute('data-tdoc-modeless')), 'the frame was not told it is modeless');
      assert(await page.locator('.tdoc-editor-toolbar:not(.tdoc-editor-bubble)').count() === 0, 'the Edit bar is there');
      assert(await page.getByRole('button', { name: 'Save', exact: true }).count() === 0, 'a Save button is there');
      // Click selects; typing replaces; Enter commits and moves down.
      await cell(frame, 0, 1).click();
      await page.keyboard.type('Gil');
      await frame.locator('.ts-editor').waitFor();
      await shot(page, 'sheet-modeless-typing');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[0].children[1].textContent === 'Gil');
      const at = await frame.evaluate(() => window.__tdocSheets.selection());
      assert(at.r === 1 && at.c === 1, `Enter did not move down: ${JSON.stringify(at)}`);
      // Tab moves right; a double-click edits in place.
      await page.keyboard.press('Tab');
      assert((await frame.evaluate(() => window.__tdocSheets.selection())).c === 2, 'Tab did not move right');
      await cell(frame, 2, 0).dblclick();
      await frame.locator('.ts-editor').waitFor();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type(' (urgent)');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[2].children[0].textContent === 'Task 3 (urgent)');
      await page.locator('.tdoc-editor-autosave').waitFor();
      await shot(page, 'sheet-modeless-saving');
      assert(versions().length === 1, 'a version was published before the pause');
      await until(() => latest() === 2, 10000);
      assert(latest() === 2, 'the autosave did not publish a version');
      const saved = versionHtml(2);
      assert(saved.includes('>Gil<') && saved.includes('Task 3 (urgent)'), 'the cell edits are not in the version');
      assert(!/data-tdoc-modeless|data-tdoc-interaction-mode|contenteditable/.test(saved), 'editor markup leaked into the version');
      await page.locator('.tdoc-editor-autosave').waitFor({ state: 'detached', timeout: 5000 });
      // Reload: the edit is the doc now.
      await page.reload({ waitUntil: 'networkidle' });
      const again = await (await page.locator('iframe.tdoc-doc-frame').elementHandle()).contentFrame();
      await again.locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      assert(await cellText(again, 0, 1) === 'Gil', 'the edit is gone after reload');
      // No mode switch in ⋯.
      await page.locator('.tdoc-bar #tdoc-more-btn').click();
      await page.locator('[role="menu"]').waitFor();
      assert(await page.getByRole('menuitemradio', { name: 'Edit', exact: true }).count() === 0, 'the mode switch is still in ⋯');
      await page.keyboard.press('Escape');
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('structure is there without a mode: add row, column menu Insert, cell menu', async () => {
      reset();
      const context = await newContext();
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('edit')).waitFor();
      assert(!(await frame.evaluate(() => document.querySelector('.ts-add-row').hidden)), 'Add row is hidden');
      assert(await frame.locator('[data-act="addcol"]').count() === 1, 'Add column is missing');
      await cell(frame, 3, 0).click({ button: 'right' });
      const menu = frame.locator('[role="menu"]');
      await menu.waitFor();
      const items = await menu.innerText();
      assert(/Insert row above/.test(items) && /Delete row/.test(items) && /Comment/.test(items), `the cell menu: ${items}`);
      await frame.getByRole('menuitem', { name: 'Insert row below' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr').length === 13);
      await page.locator('.tdoc-editor-autosave').waitFor();
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('comments without a mode: the cell pill and the cell menu open the composer; a commented cell opens its thread', async () => {
      reset();
      const context = await newContext();
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('edit')).waitFor();
      // A plain click selects; it opens no composer (that is for typing).
      await cell(frame, 4, 1).click();
      await page.waitForTimeout(300);
      assert(await page.locator('.tdoc-popup textarea').count() === 0, 'a click on a cell opened a composer');
      const pill = frame.locator('.ts-c .tdoc-comment-pill');
      await pill.waitFor();
      await pill.click();
      const composer = page.locator('.tdoc-popup textarea').first();
      await composer.waitFor({ timeout: 5000 });
      await composer.fill('Who owns this one?');
      await shot(page, 'sheet-modeless-comment');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await frame.locator('.ts-row[data-i="4"] .ts-c[data-c="1"].has-comment').waitFor({ timeout: 8000 });
      await page.locator('.tdoc-popup textarea').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await page.mouse.click(5, 400);
      await page.waitForTimeout(300);
      // The commented cell, clicked, opens its thread and is marked.
      await cell(frame, 0, 0).click();
      await page.waitForTimeout(200);
      await cell(frame, 4, 1).click();
      await frame.waitForFunction(() => !!document.querySelector('.ts-row[data-i="4"] .ts-c[data-c="1"].is-comment-on'), null, { timeout: 5000 });
      await page.getByText('Who owns this one?').first().waitFor({ timeout: 5000 });
      await shot(page, 'sheet-modeless-comment-open');
      // The cell's menu comments on the cell pressed.
      await page.keyboard.press('Escape');
      await cell(frame, 6, 0).click({ button: 'right' });
      await frame.getByRole('menuitem', { name: 'Comment', exact: true }).click();
      await page.locator('.tdoc-popup textarea').first().waitFor({ timeout: 5000 });
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('a comment on a row just inserted and typed publishes the draft first and anchors to that cell after reload', async () => {
      reset();
      const context = await newContext(); // no idle publish during the test
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('edit')).waitFor();
      await cell(frame, 2, 0).click({ button: 'right' });
      await frame.getByRole('menuitem', { name: 'Insert row below' }).click();
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr').length === 13);
      await cell(frame, 3, 0).click();
      await page.keyboard.type('Brand new task');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[3].children[0].textContent === 'Brand new task');
      const rowId = await frame.evaluate(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[3].getAttribute('data-row'));
      assert(rowId, 'the inserted row has no id');
      assert(latest() === 1, 'the draft published before the comment');
      // The pill on the new cell: the draft becomes v2 before the composer opens.
      await cell(frame, 3, 0).click();
      await frame.locator('.ts-c .tdoc-comment-pill').click();
      const composer = page.locator('.tdoc-popup textarea').first();
      await composer.waitFor({ timeout: 10000 });
      assert(latest() === 2 && versionHtml(2).includes('Brand new task'), 'the composer opened before the draft was published');
      await composer.fill('Is this one real?');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      let saved = null;
      for (let k = 0; k < 50 && !saved; k++) { saved = readComments().find((c) => c.text === 'Is this one real?'); if (!saved) await page.waitForTimeout(100); }
      assert(saved, 'the comment was not saved');
      assert(Number(saved.version) === 2, `the comment was filed on v${saved.version}, not the version with its row`);
      assert(JSON.stringify(saved.anchor || {}).includes(rowId), `the comment does not name the new row ${rowId}: ${JSON.stringify(saved.anchor)}`);
      // ⌘⌥M on a cell typed just now publishes it too.
      await cell(frame, 5, 1).click();
      await page.keyboard.type('Quinn');
      await page.keyboard.press('Enter');
      await cell(frame, 5, 1).click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyM' : 'Control+Alt+KeyM');
      await page.locator('.tdoc-popup textarea').first().waitFor({ timeout: 10000 });
      assert(latest() === 3 && versionHtml(3).includes('>Quinn<'), '⌘⌥M opened the composer before the draft was published');
      await page.keyboard.press('Escape');
      // Reload: the comment marks the new row's cell.
      await page.reload({ waitUntil: 'networkidle' });
      const fresh = await (await page.locator('iframe.tdoc-doc-frame').elementHandle()).contentFrame();
      await fresh.locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      await fresh.locator('.ts-row[data-i="3"] .ts-c[data-c="0"].has-comment').waitFor({ timeout: 8000 });
      assert(await cellText(fresh, 3, 0) === 'Brand new task', 'the commented row is not the new one');
      await cell(fresh, 3, 0).click();
      await fresh.waitForFunction(() => !!document.querySelector('.ts-row[data-i="3"] .ts-c[data-c="0"].is-comment-on'), null, { timeout: 5000 });
      await page.getByText('Is this one real?').first().waitFor({ timeout: 5000 });
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('the comment pill hides while a cell is being typed in', async () => {
      reset();
      const context = await newContext();
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('edit')).waitFor();
      await cell(frame, 1, 1).click();
      await frame.locator('.ts-c .tdoc-comment-pill').waitFor();
      await cell(frame, 1, 1).dblclick();
      await frame.locator('.ts-editor').waitFor();
      assert(await frame.locator('.tdoc-comment-pill').count() === 0, 'the pill stayed on the cell being edited');
      await page.keyboard.press('Escape');
      await context.close();
    });

    await test('a version published elsewhere: the "just published" strip, without loading that version in a hidden frame', async () => {
      reset();
      const writer = await newContext({ idleMs: 1500 });
      const reader = await newContext();
      const a = await openSheet(writer);
      const c = await openSheet(reader);
      const loads = [];
      c.page.on('request', (r) => { if (/\/v\/\d+\/frame/.test(r.url())) loads.push(r.url()); });
      await cell(a.frame, 0, 1).click();
      await a.page.keyboard.type('Elsewhere');
      await a.page.keyboard.press('Enter');
      await until(() => latest() === 2, 10000);
      assert(latest() === 2, 'the writer did not publish');
      await c.page.locator('.tdoc-oldver-strip').waitFor({ timeout: 15000 });
      await c.page.waitForTimeout(1500);
      assert(!loads.length, `the sheet loaded the newer version to swap it: ${loads.join(', ')}`);
      await writer.close(); await reader.close();
    });

    await test('a search view in the #hash keeps working while editing', async () => {
      reset();
      const context = await newContext({ idleMs: 2500 });
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('edit')).waitFor();
      await frame.locator('.ts-search input').fill('Bea');
      await page.waitForFunction(() => /sheet=/.test(location.hash), null, { timeout: 5000 });
      await frame.waitForFunction(() => window.__tdocSheets.tabs()[0].query.search === 'Bea');
      await frame.waitForFunction(() => document.querySelectorAll('.ts-row.is-hit, .ts-c.is-hit, mark').length > 0, null, { timeout: 3000 }).catch(() => {});
      const hash = await page.evaluate(() => location.hash);
      await cell(frame, 1, 2).click();
      await page.keyboard.type('99');
      await page.keyboard.press('Enter');
      // The view's second row is Task 8 (table row 8).
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[7].children[2].textContent === '99');
      assert(await cellText(frame, 1, 0) === 'Task 8', 'the search view did not stay on');
      assert(await page.evaluate(() => location.hash) === hash, 'editing dropped the view from the hash');
      assert((await frame.evaluate(() => window.__tdocSheets.tabs()[0].query.search)) === 'Bea', 'editing cleared the search');
      await until(() => latest() === 2, 10000);
      assert(latest() === 2 && versionHtml(2).includes('>99<'), 'the edit under a search did not publish');
      assert(!/#sheet=/.test(versionHtml(2)), 'the view leaked into the version');
      // Opening the link with the view: the view applies, and it is still editable.
      const { frame: again } = await openSheet(context, { address: `${base}/d/${slug}${hash}`, page });
      await again.waitForFunction(() => window.__tdocSheets.tabs()[0].query.search === 'Bea');
      assert(await page.locator(modeSelector('edit')).count() === 1, 'the linked view is not modeless');
      await context.close();
    });

    await test('someone who may only comment cannot edit a cell; a click comments as before', async () => {
      reset();
      const context = await newContext({ shell: { canEdit: false } });
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('comment')).waitFor();
      assert(!(await frame.evaluate(() => document.documentElement.hasAttribute('data-tdoc-modeless'))), 'a commenter is modeless');
      await cell(frame, 1, 1).click();
      await page.locator('.tdoc-popup textarea').first().waitFor({ timeout: 5000 });
      await page.keyboard.press('Escape');
      await cell(frame, 2, 1).dblclick();
      await page.keyboard.type('Zed');
      await page.waitForTimeout(400);
      assert(await tdText(frame, 2, 1) === 'Cai', 'a commenter edited a cell');
      assert(await frame.locator('.ts-editor').count() === 0, 'a commenter got a cell editor');
      assert(await page.locator('.tdoc-editor-autosave').count() === 0, 'a commenter sees the autosave status');
      assert(latest() === 1, 'a version was published');
      await context.close();
    });

    await test('phone: tap a cell, type, it saves', async () => {
      reset();
      const context = await newContext({ mobile: true, idleMs: 2500 });
      const { page, frame } = await openSheet(context);
      await page.locator(modeSelector('edit')).waitFor();
      await cell(frame, 0, 1).tap();
      await page.keyboard.type('Pho');
      await frame.locator('.ts-editor').waitFor();
      await shot(page, 'sheet-modeless-phone');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => document.querySelectorAll('table[data-tdoc-sheet] tbody tr')[0].children[1].textContent === 'Pho');
      await until(() => latest() === 2, 10000);
      assert(latest() === 2 && versionHtml(2).includes('>Pho<'), 'the phone edit did not publish');
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
