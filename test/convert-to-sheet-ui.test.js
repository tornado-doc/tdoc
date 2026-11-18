// ⋯ › "Convert to Sheet" (flag convertToSheet): a prose doc holding a sheet
// becomes a sheet doc, the standalone full-page sheet of #1077, as a new
// version. End to end against the local server, desktop and phone, on a
// copy shaped like a real task list (a title, a paragraph, one sheet with
// comments on two cells):
//   - the menu offers it to an editor of that doc only: not on a sheet doc,
//     not with the flag off (on by default; the flag is the off switch),
//     not on a doc without a sheet
//   - it asks first, in one sentence; Convert publishes v2 and opens it
//   - v2 is a sheet doc: no "Open the doc", no expand, the title kept, the
//     paragraph kept above the grid as the sheet's note, the page width of a
//     sheet doc (not the 720px reading column)
//   - the cell comments are still on their cells (row id + column key)
//   - v1 is intact in the history and still the prose doc it was
// And the conversion itself (document/convert-to-sheet.js), in the browser:
// short prose -> a visible note, longer prose -> a collapsed note, sheets
// lifted out of non-structural wrappers, tables kept byte for byte, every
// result a sheet doc by shared/doc-type.mjs.
// TDOC_TEST_SCREENSHOTS=<dir> saves before / after screenshots.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('convert-to-sheet-ui.test.js');
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

const STATUS = ['To do', 'In progress', 'Done', 'Blocked'];
const OWNERS = ['julie', 'claude', 'codex'];
function taskTable() {
  const rows = Array.from({ length: 14 }, (_, k) => `<tr data-row="r${k + 1}"><td>T${k + 1}: ${['Port the harness', 'Seed fixtures', 'Score runs', 'Write the README', 'Flaky retry', 'Nightly job', 'Cost report'][k % 7]}</td><td><span data-tag>${STATUS[k % 4]}</span></td><td>${OWNERS[k % 3]}</td><td>2026-12-${String(1 + k).padStart(2, '0')}</td><td>${(k * 3) % 8 + 1}</td></tr>`).join('\n');
  return `<div class="tdoc-table-scroll">
<table data-tdoc-sheet data-name="Tasks">
<thead><tr><th data-key="c1" data-type="text">Task</th><th data-key="c2" data-type="tags" data-palette="Done:green, In progress:blue, Blocked:red, To do:gray">Status</th><th data-key="c3" data-type="text">Owner</th><th data-key="c4" data-type="date">Due</th><th data-key="c5" data-type="number">Points</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>`;
}
const TASK_LIST = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Raftbench task list</title></head>
<body><main class="wrap">
<h1>Raftbench task list</h1>
<p>Every open task for the benchmark, one row each. Owners update their own rows.</p>
${taskTable()}
</main></body></html>
`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-convert-sheet-'));
  const now = new Date().toISOString();
  const writeDoc = (slug, title, html, comments) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title, versions: [{ n: 1, created: now }] }, null, 2));
    if (comments) fs.writeFileSync(path.join(root, slug, 'comments.json'), JSON.stringify(comments, null, 2));
  };
  const cellComment = (id, text, row, key, col, cell) => ({
    id, text, status: 'open', author: { login: 'julie' }, created: now, version: 1,
    anchor: { kind: 'element', selector: `table[data-tdoc-sheet][data-name="Tasks"] tr[data-row="${row}"] > :nth-child(${col})`, label: `Tasks!${'ABCDE'[col - 1]}${row.slice(1)}`, tag: 'td', text: cell, sheet: { table: 'Tasks', row, key } },
  });
  for (const label of ['desktop', 'phone']) {
    writeDoc(`task-list-${label}`, 'Raftbench task list', TASK_LIST, [
      cellComment('c_owner', 'Is codex still on this?', 'r3', 'c3', 3, 'codex'),
      cellComment('c_due', 'This slips a week.', 'r6', 'c4', 4, '2026-12-06'),
    ]);
  }
  writeDoc('plan', 'Raftbench plan', TASK_LIST.replace('<p>Every open task', '<h2>Context</h2><p>Why the benchmark exists, in a few lines of prose that go on long enough that they would push the sheet down the page if they stayed above it as they are.</p><ul><li>Runs nightly</li><li>Scores each agent</li></ul><p>Every open task'));
  writeDoc('folded', 'Folded', TASK_LIST.replace(/<p>Every open task[^<]*<\/p>/, '<details class="sheet-note"><summary>Notes</summary><p>The scoring rubric lives in the repo.</p></details>'), [
    { id: 'c_rubric', text: 'Link it?', status: 'open', author: { login: 'julie' }, created: now, version: 1,
      anchor: { kind: 'text', text: 'scoring rubric', context_before: 'The ', context_after: ' lives in the repo.' } },
  ]);
  const M = await import('../shared/sheet-markup.mjs');
  writeDoc('budget', 'Budget', M.sheetDocumentHtml({ title: 'Budget', sheets: [{ name: 'Spend', columns: [{ name: 'Item', type: 'text' }], rows: [{ id: 'r1', cells: ['Rent'] }] }] }));
  writeDoc('essay', 'Essay', '<!doctype html><html><head><meta charset="utf-8"><title>Essay</title></head><body><main><h1>Essay</h1><p>Only prose.</p></main></body></html>');

  // The conversion, bundled for the browser as the shell bundles it.
  const esbuild = require('esbuild');
  const bundle = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'shell', 'src', 'document', 'convert-to-sheet.js')], bundle: true, write: false, format: 'iife', globalName: 'ConvertToSheet' }).outputFiles[0].text;
  const elementJs = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'shell', 'src', 'comments', 'selection', 'anchors', 'element.js')], bundle: true, write: false, format: 'iife', globalName: 'Elem' }).outputFiles[0].text;
  const docType = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'shared', 'doc-type.mjs')], bundle: true, write: false, format: 'iife', globalName: 'DocType' }).outputFiles[0].text;

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('Convert to Sheet');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    // ---- the conversion on its own -----------------------------------------
    {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><title>x</title>');
      await page.addScriptTag({ content: bundle });
      await page.addScriptTag({ content: docType });
      await page.addScriptTag({ content: elementJs });
      const run = (html, comments) => page.evaluate(([h, comments]) => {
        try {
          const r = window.ConvertToSheet.convertToSheetHtml(h, { comments: comments || [] });
          const d = new DOMParser().parseFromString(r.html, 'text/html');
          const note = d.querySelector('.sheet-note');
          return {
            moved: r.moved, sheetOnly: window.DocType.htmlIsSheetOnly(r.html), type: window.DocType.docTypeFromHtml(r.html),
            note: note ? { tag: note.tagName, open: note.hasAttribute('open'), text: note.textContent.replace(/\s+/g, ' ').trim(), afterTitle: note.previousElementSibling && note.previousElementSibling.tagName } : null,
            h1: (d.querySelector('h1') || {}).textContent || '',
            tables: Array.from(d.querySelectorAll('table[data-tdoc-sheet]')).map((t) => t.outerHTML),
            order: Array.from(d.body.querySelectorAll('h1, .sheet-note, table[data-tdoc-sheet]')).map((e) => e.matches('table') ? 'T:' + e.getAttribute('data-name') : e.matches('.sheet-note') ? 'note' : 'h1'),
            main: !!d.querySelector('main > h1'),
            head: d.head.innerHTML,
          };
        } catch (error) { return { error: error.message }; }
      }, [html, comments]);
      const tablesOf = (html) => page.evaluate((h) => Array.from(new DOMParser().parseFromString(h, 'text/html').querySelectorAll('table[data-tdoc-sheet]')).map((t) => t.outerHTML), html);

      await test('a title, a paragraph and a sheet: the paragraph becomes a visible note under the title; the sheet is kept as it was', async () => {
        const r = await run(TASK_LIST);
        assert(!r.error, r.error);
        assert(r.sheetOnly && r.type === 'sheet', `a sheet doc by shared/doc-type.mjs: ${JSON.stringify(r)}`);
        assert(r.note && r.note.tag === 'DIV' && /^Every open task/.test(r.note.text) && r.note.afterTitle === 'H1', `visible note under the title: ${JSON.stringify(r.note)}`);
        assert(r.h1 === 'Raftbench task list' && r.main, 'the title, still in <main>');
        assert(JSON.stringify(r.tables) === JSON.stringify(await tablesOf(TASK_LIST)), 'the sheet table, byte for byte');
        assert(/<title>Raftbench task list<\/title>/.test(r.head), 'the head is kept');
      });

      await test('longer prose (headings, lists, a plain table, a figure) folds into a collapsed Notes note, in order', async () => {
        const html = `<!doctype html><html><head><title>Plan</title></head><body><main><h1>Plan</h1><p>Intro.</p><h2>Context</h2><ul><li>One</li><li>Two</li></ul>
          ${taskTable()}<p>Afterword with <b>bold</b>.</p><table><tr><td>plain</td></tr></table><figure><img src="x.png" alt=""><figcaption>Fig</figcaption></figure></main></body></html>`;
        const r = await run(html);
        assert(!r.error && r.sheetOnly, JSON.stringify(r));
        assert(r.note.tag === 'DETAILS' && !r.note.open, `a collapsed details: ${JSON.stringify(r.note)}`);
        assert(/^Notes Intro\. Context OneTwo Afterword with bold\. plain Fig$/.test(r.note.text), `all prose, in order: ${r.note.text}`);
        assert(JSON.stringify(r.order) === JSON.stringify(['h1', 'note', 'T:Tasks']), JSON.stringify(r.order));
        assert(r.moved === 6, `moved ${r.moved}`); // p, h2, ul, p, table, figure
      });

      await test('sheets inside a section, a list item or a details are lifted out; several tabs keep their order; no h1: the note goes before the first sheet', async () => {
        const two = (name) => `<table data-tdoc-sheet data-name="${name}"><thead><tr><th data-key="c1">A</th></tr></thead><tbody><tr data-row="r1"><td>${name}1</td></tr></tbody></table>`;
        const html = `<!doctype html><html><head><title>T</title></head><body><section><h2>First</h2>${two('One')}</section><ul><li>Item ${two('Two')}</li></ul><details><summary>More</summary>${two('Three')}</details></body></html>`;
        const r = await run(html);
        assert(!r.error && r.sheetOnly, JSON.stringify(r));
        assert(JSON.stringify(r.order) === JSON.stringify(['note', 'T:One', 'T:Two', 'T:Three']), JSON.stringify(r.order));
        assert(/First/.test(r.note.text) && /Item/.test(r.note.text) && /More/.test(r.note.text), r.note.text);
      });

      const LONG = `<!doctype html><html><head><title>G</title></head><body><main><h1>Gallery</h1><p>Why the benchmark exists, in more words than a short intro holds, so that this note folds away into a details block below the title.</p>
        <figure><img src="a.png" alt="Chart A"></figure><figure><img src="b.png" alt="Chart B"></figure>${taskTable()}</main></body></html>`;
      await test('a comment on prose that folds into the note writes the note open; with none it stays closed', async () => {
        assert((await run(LONG)).note.open === false, 'no comments: closed');
        assert((await run(LONG, [{ kind: 'text', text: 'in more words than a short intro' }])).note.open === true, 'a comment on its words: open');
        assert((await run(LONG, [{ kind: 'element', selector: 'main > figure:nth-of-type(1) > img', tag: 'img', text: '', accessible_name: 'Chart A' }])).note.open === true, 'a comment on an image in it: open');
        assert((await run(LONG, [{ kind: 'element', sheet: { table: 'Tasks', row: 'r1', key: 'c1' } }, { kind: 'document' }, { kind: 'text', text: 'not in the doc' }])).note.open === false, 'cell, doc and elsewhere comments: closed');
      });

      await test('an image comment by its old path is found on the same image after the move (by its alt), never on another', async () => {
        const out = await page.evaluate((h) => {
          const before = new DOMParser().parseFromString(h, 'text/html');
          const imgB = before.querySelectorAll('img')[1];
          const anchor = { kind: 'element', ...window.Elem.describeElement(imgB) };
          const after = new DOMParser().parseFromString(window.ConvertToSheet.convertToSheetHtml(h).html, 'text/html');
          const hit = window.Elem.resolveElement(anchor, { root: after });
          // Its path, read in the converted doc, is now some other element or none.
          let byPath = null; try { byPath = after.querySelector(anchor.selector); } catch {}
          const ghost = window.Elem.resolveElement({ ...anchor, accessible_name: 'Chart Z' }, { root: after });
          return { selector: anchor.selector, alt: hit.element && hit.element.getAttribute('alt'), approximate: hit.approximate, byPath: byPath && byPath.getAttribute('alt'), ghost: !!ghost.element };
        }, LONG);
        assert(out.alt === 'Chart B' && !out.approximate, JSON.stringify(out));
        assert(!out.ghost, `a name found nowhere attaches to nothing: ${JSON.stringify(out)}`);
      });

      await test('a doc with no sheet table is refused; a sheet doc converts to itself', async () => {
        assert(/no sheet/.test((await run('<!doctype html><html><body><h1>x</h1><p>y</p></body></html>')).error || ''), 'no sheet: refused');
        const sheet = M.sheetDocumentHtml({ title: 'B', sheets: [{ name: 'S', columns: [{ name: 'A', type: 'text' }], rows: [{ id: 'r1', cells: ['x'] }] }], note: 'A note.' });
        const r = await run(sheet);
        assert(!r.error && r.sheetOnly && r.moved === 0, JSON.stringify(r));
      });
      await page.close();
    }

    // ---- end to end ---------------------------------------------------------
    const open = async (page, url) => {
      await page.goto(`${base}${url}`);
      await page.locator('.tdoc-document-app').waitFor();
      await page.frameLocator('iframe[aria-label="Document content"]').locator('.tdoc-sheet').first().waitFor({ timeout: 15000 });
      const doc = page.frames().find((f) => f.url().includes('/frame'));
      await doc.waitForFunction(() => window.__tdocSheets && document.querySelector('.tdoc-sheet .ts-row, .tdoc-sheet .ts-flat'));
      await page.waitForTimeout(300);
      return doc;
    };
    const chrome = (doc) => doc.evaluate(() => {
      const shown = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
      const named = (re) => Array.from(document.querySelectorAll('.tdoc-sheet a, .tdoc-sheet button')).filter((el) => shown(el) && re.test(el.getAttribute('aria-label') || el.textContent || ''));
      const note = document.querySelector('.sheet-note');
      return {
        expanded: window.__tdocSheets.expanded(),
        back: named(/^Open the doc$/).length,
        expand: named(/^Expand sheet/).length,
        title: (document.querySelector('h1') || {}).textContent || '',
        note: note && shown(note) ? note.textContent.trim() : null,
      };
    });
    const menu = async (page) => {
      await page.locator('.tdoc-bar [aria-label="More actions"], .tdoc-bar [aria-label="More"], .tdoc-bar .tdoc-more-trigger').first().click();
      await page.locator('[data-action="history"], [data-action="download-pdf"], .tdoc-export-submenu-trigger').first().waitFor();
      const has = await page.locator('[data-action="convert-to-sheet"]').count();
      return has;
    };
    const shot = async (page, name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    // The cell a comment's anchor resolves to now, as the frame reads it.
    const cellOf = (doc, anchor) => doc.evaluate((a) => { const el = window.__tdocElementHooks.resolve(a); return el ? el.textContent.trim() : null; }, anchor);

    for (const [label, viewport, mobile] of [['desktop', { width: 1280, height: 860 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      const slug = `task-list-${label}`;
      const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
      await context.addInitScript(() => { window.__TDOC_FLAGS__ = Object.assign(window.__TDOC_FLAGS__ || {}, { convertToSheet: true }); });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));

      await test(`${label}: the menu offers Convert to Sheet on a prose doc holding a sheet, not on a sheet doc or a doc without one`, async () => {
        let doc = await open(page, `/d/${slug}`);
        const c = await chrome(doc);
        assert(!c.expanded.sheetOnly && c.expand === 1, `before: an embedded sheet: ${JSON.stringify(c)}`);
        await shot(page, `before-${label}`);
        assert(await menu(page) === 1, 'offered on the task list');
        await shot(page, `menu-${label}`);
        await page.keyboard.press('Escape');
        doc = await open(page, '/d/budget');
        assert(await menu(page) === 0, 'not on a sheet doc');
        await page.keyboard.press('Escape');
        await page.goto(`${base}/d/essay`);
        await page.frameLocator('iframe[aria-label="Document content"]').locator('h1').waitFor();
        await page.waitForTimeout(400);
        assert(await menu(page) === 0, 'not on a doc without a sheet');
        await page.keyboard.press('Escape');
      });

      await test(`${label}: on by default; with the flag off it is not offered`, async () => {
        const plain = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
        await plain.addInitScript(() => { window.__TDOC_FLAGS__ = Object.assign(window.__TDOC_FLAGS__ || {}, { convertToSheet: false }); });
        const p = await plain.newPage();
        await open(p, `/d/${slug}`);
        assert(await menu(p) === 0, 'hidden');
        await plain.close();
        // Unpinned: on by default.
        const byDefault = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
        const q = await byDefault.newPage();
        await open(q, `/d/${slug}`);
        assert(await menu(q) === 1, 'on by default');
        await byDefault.close();
      });

      await test(`${label}: Convert asks first, then publishes v2: a standalone sheet with its title, its paragraph as the note, the comments on their cells`, async () => {
        let doc = await open(page, `/d/${slug}`);
        // Before: both comments resolve to their cells.
        await doc.waitForFunction(() => window.__tdocElementHooks && typeof window.__tdocElementHooks.resolve === 'function');
        const comments = JSON.parse(fs.readFileSync(path.join(root, slug, 'comments.json'), 'utf8'));
        assert(await cellOf(doc, comments[0].anchor) === 'codex' && await cellOf(doc, comments[1].anchor) === '2026-12-06', 'before: on their cells');
        await menu(page);
        await page.locator('[data-action="convert-to-sheet"]').click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        const text = (await dialog.textContent()).replace(/\s+/g, ' ');
        assert(/Convert to Sheet\?/.test(text) && text.includes('Turns this doc into a standalone sheet. The current version stays in history.'), `the dialog: ${text}`);
        await shot(page, `confirm-${label}`);
        // Cancel leaves the doc alone.
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert(!fs.existsSync(path.join(root, slug, 'v2')), 'nothing published on Cancel');
        await menu(page);
        await page.locator('[data-action="convert-to-sheet"]').click();
        await page.locator('[data-action="confirm-convert-to-sheet"]').click();
        await page.waitForURL(/\/v\/2\b/, { timeout: 15000 });
        doc = await open(page, page.url().replace(base, ''));
        const c = await chrome(doc);
        assert(c.expanded.sheetOnly && !c.expanded.on, `a sheet doc: ${JSON.stringify(c.expanded)}`);
        assert(!c.back && !c.expand, `no back, no expand: ${JSON.stringify(c)}`);
        assert(c.title === 'Raftbench task list', `title kept: ${c.title}`);
        assert(/^Every open task for the benchmark/.test(c.note || ''), `the paragraph is the note: ${c.note}`);
        // A sheet page, not a reading column: as wide as a sheet doc tdoc makes (72rem), all five columns in view.
        const widths = await doc.evaluate(() => { const g = document.querySelector('.tdoc-sheet .ts-grid'); const heads = Array.from(document.querySelectorAll('.tdoc-sheet .ts-h')); const last = heads[heads.length - 1]; return { sheet: document.querySelector('.tdoc-sheet').getBoundingClientRect().width, lastRight: last ? last.getBoundingClientRect().right : 0, gridRight: g.getBoundingClientRect().right, view: innerWidth }; });
        if (!mobile) assert(widths.sheet > 1000 && widths.lastRight <= widths.gridRight + 1, `full page width, every column in view: ${JSON.stringify(widths)}`);
        else assert(widths.sheet > widths.view - 80, `the phone's width: ${JSON.stringify(widths)}`);
        // The comments: still listed, still on their cells.
        await doc.waitForFunction(() => window.__tdocElementHooks && typeof window.__tdocElementHooks.resolve === 'function');
        assert(await cellOf(doc, comments[0].anchor) === 'codex', 'Owner comment on r3 / Owner');
        assert(await cellOf(doc, comments[1].anchor) === '2026-12-06', 'Due comment on r6 / Due');
        // A desktop shows a pin beside each commented row (a phone, a count in the bar).
        if (!mobile) {
          await page.locator('.tdoc-pin').first().waitFor({ timeout: 8000 });
          assert(await page.locator('.tdoc-pin').count() === 2, 'two pins beside the grid');
        }
        await shot(page, `after-${label}`);
        // Open one from its link: the cell is marked.
        doc = await open(page, `/d/${slug}?comment=c_owner`);
        await doc.waitForFunction(() => !!document.querySelector('.tdoc-sheet .is-comment-on'), null, { timeout: 10000 });
        const marked = await doc.evaluate(() => { const c = document.querySelector('.tdoc-sheet .is-comment-on'); return { text: c.textContent.trim(), first: c.closest('.ts-row, tr, .ts-card') ? (c.closest('.ts-row, tr, .ts-card').querySelector('[data-c="0"]') || {}).textContent : null }; });
        assert(marked.text === 'codex', `the marked cell: ${JSON.stringify(marked)}`);
        await shot(page, `after-comment-${label}`);
        await page.keyboard.press('Escape');
        // No Convert on the sheet doc it is now.
        await open(page, `/d/${slug}`);
        assert(await menu(page) === 0, 'not offered again');
        await page.keyboard.press('Escape');
      });

      await test(`${label}: v1 is intact in the history and still a prose doc with its sheet embedded`, async () => {
        const meta = JSON.parse(fs.readFileSync(path.join(root, slug, 'meta.json'), 'utf8'));
        assert(meta.versions.map((v) => v.n).join(',') === '1,2', JSON.stringify(meta.versions));
        assert(fs.readFileSync(path.join(root, slug, 'v1', 'index.html'), 'utf8') === TASK_LIST, 'v1 byte for byte');
        const v2 = fs.readFileSync(path.join(root, slug, 'v2', 'index.html'), 'utf8');
        assert(/class="sheet-note"/.test(v2) && /data-row="r3"/.test(v2) && /data-key="c4"/.test(v2), 'v2: the note and the keyed table');
        const doc = await open(page, `/d/${slug}/v/1`);
        const c = await chrome(doc);
        assert(!c.expanded.sheetOnly && c.expand === 1, `v1 is the prose doc: ${JSON.stringify(c)}`);
      });

      await test(`${label}: no page errors`, async () => { assert(!errors.length, errors.join('; ')); });
      await context.close();
    }
    await test('a comment inside a folded note: its link opens the note and lands on its words (desktop + phone)', async () => {
      for (const [viewport, mobile] of [[{ width: 1280, height: 860 }, false], [{ width: 390, height: 844 }, true]]) {
        const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        let doc = await open(page, '/d/folded');
        assert(await doc.evaluate(() => window.__tdocSheets.expanded().sheetOnly && !document.querySelector('details.sheet-note').open), 'a sheet doc, its note folded');
        doc = await open(page, '/d/folded?comment=c_rubric');
        await doc.waitForFunction(() => document.querySelector('details.sheet-note').open, null, { timeout: 8000 });
        await context.close();
      }
    });

    await test('desktop: longer prose converts into a collapsed Notes note above the sheet, which opens', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await context.addInitScript(() => { window.__TDOC_FLAGS__ = Object.assign(window.__TDOC_FLAGS__ || {}, { convertToSheet: true }); });
      const page = await context.newPage();
      await open(page, '/d/plan');
      await menu(page);
      await page.locator('[data-action="convert-to-sheet"]').click();
      await page.locator('[data-action="confirm-convert-to-sheet"]').click();
      await page.waitForURL(/\/v\/2\b/, { timeout: 15000 });
      const doc = await open(page, '/d/plan');
      const c = await chrome(doc);
      assert(c.expanded.sheetOnly && !c.back, JSON.stringify(c));
      const note = await doc.evaluate(() => { const d = document.querySelector('details.sheet-note'); return d && { open: d.open, summary: d.querySelector('summary').textContent }; });
      assert(note && !note.open && note.summary === 'Notes', JSON.stringify(note));
      await shot(page, 'after-long-notes-desktop');
      await doc.locator('details.sheet-note summary').click();
      await page.waitForTimeout(300);
      await shot(page, 'after-long-notes-open-desktop');
      await context.close();
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
