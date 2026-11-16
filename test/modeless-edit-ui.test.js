// Browser acceptance for modeless editing (flag modelessEdit): someone who may
// edit types into the page with no Edit mode; the draft saves in the browser
// and publishes itself as a version; a selection brings up the format bubble,
// "/" the block menu; plain tables are typed into; a reader stays a reader;
// two editors never overwrite each other; a version published elsewhere
// replaces the page in place (no reload), marked for a moment. Flag off:
// today's Edit mode, untouched.
// Run with: node test/modeless-edit-ui.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { chromium, devices } = requirePlaywrightOrSkip('modeless-edit-ui.test.js');

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

const FILLER = Array.from({ length: 14 }, (_, i) => `<p>Background paragraph ${i + 1}: enough text to make the page scroll on a laptop screen, so the reader has a position to keep.</p>`).join('\n');
const DOC_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Launch notes</title></head>
<body><main>
<h1>Launch notes</h1>
<p id="intro">We ship the new reader on Monday.</p>
<p id="second">Comments now anchor to the exact words you select.</p>
<table><thead><tr><th>Area</th><th>Owner</th></tr></thead>
<tbody><tr><td id="cell-a">Reader</td><td id="cell-b">Ana</td></tr></tbody></table>
<p id="third">Should drafts publish on their own?</p>
${FILLER}
<p id="last">The end.</p>
</main></body></html>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-modeless-'));
  const slug = 'modeless';
  const docRoot = path.join(root, slug);
  const reset = () => {
    fs.rmSync(docRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(docRoot, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(docRoot, 'v1', 'index.html'), DOC_HTML);
    fs.writeFileSync(path.join(docRoot, 'meta.json'), JSON.stringify({ slug, title: 'Launch notes', versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  const versions = () => JSON.parse(fs.readFileSync(path.join(docRoot, 'meta.json'))).versions.map((v) => Number(v.n));
  const latest = () => Math.max(...versions());
  const versionHtml = (n) => fs.readFileSync(path.join(docRoot, `v${n}`, 'index.html'), 'utf8');

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  // A browser context as the published doc page would be: the local server
  // calls itself "local" (no version poll, no Edited line), so the boot is
  // patched to "published", as reply-activity-ui does.
  async function newContext({ flag = true, idleMs = 120_000, shell = {}, mobile = false, reducedMotion, extraCommands = null } = {}) {
    const context = await browser.newContext(mobile
      ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, reducedMotion }
      : { viewport: { width: 1280, height: 800 }, reducedMotion });
    await context.addInitScript(([flagOn, idle, extra]) => {
      window.__TDOC_FLAGS__ = { modelessEdit: flagOn };
      window.__TDOC_MODELESS_IDLE_MS = idle;
      window.__TDOC_LIVE_SYNC_MS = 700;
      if (extra) window.__TDOC_BLOCK_COMMANDS_EXTRA__ = extra;
    }, [flag, idleMs, extraCommands]);
    await context.route(new RegExp(`/d/${slug}/v/\\d+(\\?.*)?$`), async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/window\.__TDOC_SHELL__ = (.*?);<\/script>/,
        (_, json) => `window.__TDOC_SHELL__ = ${JSON.stringify({ ...JSON.parse(json), mode: 'published', historyVisible: true, ...shell })};</script>`);
      await route.fulfill({ response, body });
    });
    return context;
  }
  async function openDoc(context) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (process.env.TDOC_DEBUG) {
      page.on('console', (m) => console.log('    [console]', m.text()));
      page.on('response', async (r) => { if (r.request().method() === 'POST') console.log('    [post]', r.status(), r.url(), (await r.text().catch(() => '')).slice(0, 200)); });
    }
    page.errors = errors;
    await page.goto(`${base}/d/${slug}/v/${latest()}`, { waitUntil: 'networkidle' });
    const handle = await page.locator('iframe.tdoc-doc-frame').elementHandle();
    const frame = await handle.contentFrame();
    await frame.waitForSelector('main');
    // A reload or a navigation drops this marker; replacing the address
    // (history.replaceState) keeps it.
    await page.evaluate(() => { window.__tdocSamePage = true; });
    page.reloaded = async () => !(await page.evaluate(() => window.__tdocSamePage === true));
    return { page, frame };
  }
  async function caretAtEnd(frame, selector) {
    await frame.click(selector);
    await frame.evaluate((sel) => {
      const el = document.querySelector(sel);
      const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, selector);
  }
  async function selectWords(frame, selector, from, to) {
    await frame.evaluate(([sel, a, b]) => {
      const text = document.querySelector(sel).firstChild;
      const range = document.createRange(); range.setStart(text, a); range.setEnd(text, b);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, [selector, from, to]);
  }
  const hide = (page) => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    await test('flag off: Read / Comment / Edit and the editor bar with Save are unchanged', async () => {
      reset();
      const context = await newContext({ flag: false });
      const { page, frame } = await openDoc(context);
      await page.locator(modeSelector('comment')).waitFor();
      assert(await frame.evaluate(() => document.querySelector('main').getAttribute('contenteditable')) === null, 'the page was editable in Comment mode');
      await chooseMode(page, 'Edit');
      await page.locator('.tdoc-editor-toolbar:not(.tdoc-editor-bubble)').waitFor();
      await frame.waitForFunction(() => document.querySelector('main').getAttribute('contenteditable') === 'true');
      assert(await page.getByRole('button', { name: 'Save' }).count() === 1, 'Save is missing from the editor bar');
      assert(await frame.evaluate(() => document.querySelector('table').getAttribute('contenteditable')) === 'false', 'tables stopped being atomic in Edit mode');
      assert(await page.locator('.tdoc-editor-autosave').count() === 0, 'the autosave status showed with the flag off');
      await context.close();
    });

    await test('an editor types at once: no Edit mode, no bar, no Save; autosave drafts, then folds into a version in place', async () => {
      reset();
      const context = await newContext({ idleMs: 2500 });
      const { page, frame } = await openDoc(context);
      await page.locator(modeSelector('edit')).waitFor();
      assert(await page.locator('.tdoc-editor-toolbar:not(.tdoc-editor-bubble)').count() === 0, 'the Edit bar is still there');
      assert(await page.getByRole('button', { name: 'Save' }).count() === 0, 'a Save button is still there');
      assert(await frame.evaluate(() => document.querySelector('main').getAttribute('contenteditable')) === 'true', 'the page is not editable');
      assert(await frame.evaluate(() => document.activeElement === document.body || !document.activeElement.isContentEditable), 'opening the doc took focus (a phone keyboard would pop up)');
      await caretAtEnd(frame, '#intro');
      await page.keyboard.type(' Ana posts the notes.');
      await page.locator('.tdoc-editor-autosave', { hasText: 'Saving…' }).waitFor();
      const draftStatus = page.locator('.tdoc-editor-autosave', { hasText: 'Draft · only you can see' });
      await draftStatus.waitFor({ timeout: 4000 });
      assert(await draftStatus.getAttribute('title') === 'Publishes after 2 min idle or when you leave', 'the draft status does not say when it publishes');
      assert(!/v\d/.test(await page.locator('.tdoc-bar').innerText()), 'the bar names a version number');
      const draft = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tdoc-draft:')).map((k) => localStorage.getItem(k)).join(''));
      assert(draft.includes('Ana posts the notes.'), 'the draft is not in the browser');
      assert(versions().length === 1, 'a version was published before the pause');
      await page.waitForFunction(() => !location.pathname.includes('/v/'), null, { timeout: 8000 });
      // Published: the status gives the slot back and "Edited just now" lights up.
      await page.locator('#tdoc-version-toggle[data-just-updated]').waitFor({ timeout: 3000 });
      assert((await page.locator('#tdoc-version-toggle').innerText()).includes('just now'), 'Edited does not say just now');
      await page.locator('.tdoc-editor-autosave').waitFor({ state: 'detached', timeout: 3000 });
      assert(latest() === 2 && versionHtml(2).includes('Ana posts the notes.'), 'the draft did not become v2');
      assert(!(await page.reloaded()), 'publishing reloaded the page');
      await page.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith('tdoc-draft:') && (localStorage.getItem(k) || '').includes('bodyHtml')), null, { timeout: 3000 });
      // Typing again publishes v3 from v2, not over it.
      await caretAtEnd(frame, '#third');
      await page.keyboard.type(' Yes.');
      await hide(page);
      await until(() => latest() === 3, 5000);
      assert(latest() === 3 && versionHtml(3).includes('Ana posts the notes.') && versionHtml(3).includes('Yes.'), 'hiding the tab did not publish v3 on top of v2');
      await page.locator('.tdoc-bar #tdoc-more-btn').click();
      await page.locator('[role="menu"]').waitFor();
      assert(await page.getByRole('menuitemradio', { name: 'Edit', exact: true }).count() === 0, 'the mode switch is still in ⋯');
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('the selection bubble formats and comments; the bar tools are the editor bar\'s', async () => {
      reset();
      const context = await newContext();
      const { page, frame } = await openDoc(context);
      await selectWords(frame, '#second', 0, 8);
      const bubble = page.locator('.tdoc-editor-bubble');
      await bubble.waitFor();
      await bubble.getByRole('button', { name: 'Bold' }).click();
      await frame.waitForFunction(() => /<(b|strong)>Comments<\/(b|strong)>/.test(document.querySelector('#second').innerHTML));
      // Turn into: the dropdown names the block (Text), picks a level by
      // keyboard, then names the new one (H1); Text turns it back.
      await selectWords(frame, '#third', 0, 6);
      await bubble.waitFor();
      const level = bubble.locator('button.tdoc-block-level');
      assert((await level.innerText()).trim() === 'Text', `the dropdown says ${await level.innerText()}`);
      await level.focus();
      await page.keyboard.press('Enter');
      await page.locator('.tdoc-turn-into-menu').waitFor();
      await page.waitForFunction(() => document.activeElement && document.activeElement.closest('.tdoc-turn-into-menu'));
      const turnItems = await page.locator('.tdoc-turn-into-menu [role^="menuitem"]').allInnerTexts();
      assert(['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'Quote'].every((label) => turnItems.some((t) => t.includes(label))), `turn-into items: ${turnItems}`);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await frame.waitForFunction(() => Array.from(document.querySelectorAll('h1')).some((h) => h.textContent.startsWith('Should drafts')), null, { timeout: 5000 });
      await frame.evaluate(() => {
        const h = Array.from(document.querySelectorAll('h1')).find((el) => el.textContent.startsWith('Should drafts'));
        const r = document.createRange(); r.setStart(h.firstChild, 0); r.setEnd(h.firstChild, 6);
        getSelection().removeAllRanges(); getSelection().addRange(r);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('.tdoc-editor-bubble button.tdoc-block-level')?.innerText.trim() === 'H1');
      await bubble.locator('button.tdoc-block-level').click();
      await page.getByRole('menuitemradio', { name: 'Text' }).click();
      await frame.waitForFunction(() => Array.from(document.querySelectorAll('main p')).some((p) => p.textContent.startsWith('Should drafts')));
      // ···: the registry's insert items, after the selection's block.
      await selectWords(frame, '#intro', 0, 2);
      await bubble.waitFor();
      await bubble.getByRole('button', { name: 'More blocks' }).click();
      await page.locator('.tdoc-insert-menu').waitFor();
      const moreItems = await page.locator('.tdoc-insert-menu [role="menuitem"]').allInnerTexts();
      assert(['Table', 'Image', 'Divider'].every((label) => moreItems.some((t) => t.includes(label))), `··· items: ${moreItems}`);
      await page.getByRole('menuitem', { name: 'Divider' }).click();
      await frame.waitForFunction(() => document.querySelector('#intro + hr'));
      await selectWords(frame, '#intro', 3, 7);
      await bubble.waitFor();
      await bubble.getByRole('button', { name: 'Comment' }).click();
      await page.locator('.tdoc-popup').waitFor({ timeout: 5000 });
      assert(latest() === 2, 'commenting on a draft did not publish it first');
      await context.close();
    });

    await test('"/" on an empty line opens the block menu: heading, table, divider', async () => {
      reset();
      const context = await newContext();
      const { page, frame } = await openDoc(context);
      const slash = async () => {
        await caretAtEnd(frame, '#third');
        await page.keyboard.press('Enter');
        await page.keyboard.type('/');
        await page.locator('.tdoc-slash-menu').waitFor();
        // The keys are the menu's once it has focus.
        await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('tdoc-slash-menu'));
      };
      // The choice lands once the doc has focus back and the "/" is gone.
      const applied = () => frame.waitForFunction(() => !document.querySelector('main').textContent.includes('/'));
      await slash();
      await page.getByRole('menuitem', { name: 'Heading 2' }).click();
      await applied();
      await page.keyboard.type('New section');
      await frame.waitForFunction(() => Array.from(document.querySelectorAll('h2')).some((h) => h.textContent === 'New section'));
      assert(!(await frame.evaluate(() => document.querySelector('main').textContent.includes('/New'))), 'the "/" stayed in the text');
      await slash();
      await page.keyboard.type('ta'); // the menu's own type-to-find
      await page.keyboard.press('Enter');
      await applied();
      await frame.waitForFunction(() => document.querySelectorAll('table').length === 2);
      await page.keyboard.type('Name');
      await frame.waitForFunction(() => document.querySelectorAll('table')[1].querySelector('th').textContent.includes('Name'));
      await slash();
      await page.getByRole('menuitem', { name: 'Divider' }).click();
      await frame.waitForFunction(() => document.querySelector('main hr'));
      // Esc leaves the "/" where it was.
      await slash();
      await page.keyboard.press('Escape');
      await page.locator('.tdoc-slash-menu').waitFor({ state: 'detached' });
      // The caret goes back after the menu's own focus return.
      await frame.waitForFunction(() => document.hasFocus() && document.activeElement && document.activeElement.isContentEditable
        && getSelection().anchorNode && getSelection().anchorNode.textContent === '/');
      await page.keyboard.type('x');
      await frame.waitForFunction(() => document.querySelector('main').textContent.includes('/x'));
      await context.close();
    });

    await test('one item added to the block registry shows in both "/" and the toolbar\'s ···', async () => {
      reset();
      const context = await newContext({ extraCommands: [{ id: 'callout-test', label: 'Callout test', kind: 'insert', command: 'divider' }] });
      const { page, frame } = await openDoc(context);
      await caretAtEnd(frame, '#third');
      await page.keyboard.press('Enter');
      await page.keyboard.type('/');
      await page.locator('.tdoc-slash-menu').waitFor();
      assert(await page.locator('.tdoc-slash-menu [role="menuitem"]', { hasText: 'Callout test' }).count() === 1, 'not in the "/" menu');
      await page.keyboard.press('Escape');
      await page.locator('.tdoc-slash-menu').waitFor({ state: 'detached' });
      await page.waitForTimeout(400);
      await selectWords(frame, '#intro', 0, 2);
      await page.locator('.tdoc-editor-bubble').waitFor();
      await page.waitForTimeout(300); // the bubble settles over the new selection
      await page.locator('.tdoc-editor-bubble').getByRole('button', { name: 'More blocks' }).click();
      await page.locator('.tdoc-insert-menu').waitFor();
      const item = page.locator('.tdoc-insert-menu [role="menuitem"]', { hasText: 'Callout test' });
      assert(await item.count() === 1, 'not in the toolbar ···');
      await item.click();
      await frame.waitForFunction(() => document.querySelector('#intro + hr'));
      await context.close();
    });

    await test('a table cell is typed into in place; Tab moves on; only that cell is ringed; reading look unchanged', async () => {
      reset();
      const context = await newContext();
      const { page, frame } = await openDoc(context);
      const ring = () => frame.evaluate(() => getComputedStyle(document.querySelector('#cell-a')).outlineStyle);
      assert(await ring() === 'none', 'a cell is ringed before anyone is typing in it');
      await caretAtEnd(frame, '#cell-a');
      await page.keyboard.type(' app');
      await frame.waitForFunction(() => document.querySelector('#cell-a').textContent === 'Reader app');
      await frame.waitForFunction(() => document.querySelector('#cell-a').hasAttribute('data-tdoc-cell-caret'), null, { timeout: 2000 }).catch(() => {});
      assert(await ring() === 'solid', 'the cell being typed in is not ringed');
      await page.keyboard.press('Tab');
      await page.keyboard.type('Bea');
      await frame.waitForFunction(() => document.querySelector('#cell-b').textContent === 'Bea');
      await frame.waitForFunction(() => !document.querySelector('#cell-a').hasAttribute('data-tdoc-cell-caret'), null, { timeout: 2000 }).catch(() => {});
      assert(await ring() === 'none', 'the cell left behind is still ringed');
      await hide(page);
      await until(() => latest() === 2, 5000);
      const saved = versionHtml(latest());
      assert(saved.includes('Reader app') && saved.includes('>Bea<'), 'the cell edits were not published');
      assert(!/data-tdoc-cell-caret|contenteditable/.test(saved), 'editor markup leaked into the version');
      await context.close();
    });

    await test('someone who may only comment cannot type; comments work as before', async () => {
      reset();
      const context = await newContext({ shell: { canEdit: false } });
      const { page, frame } = await openDoc(context);
      await page.locator(modeSelector('comment')).waitFor();
      assert(await frame.evaluate(() => document.querySelector('main').getAttribute('contenteditable')) === null, 'a commenter can edit');
      await selectWords(frame, '#second', 0, 8);
      await page.locator('.tdoc-popup').waitFor({ timeout: 5000 });
      assert(await page.locator('.tdoc-editor-bubble').count() === 0, 'a commenter got the format bubble');
      assert(await page.locator('.tdoc-editor-autosave').count() === 0, 'a commenter sees the autosave status');
      await context.close();
    });

    await test('two editors: the later one gets the conflict notice, nothing is overwritten', async () => {
      reset();
      const first = await newContext();
      const second = await newContext();
      const a = await openDoc(first);
      const b = await openDoc(second);
      await caretAtEnd(b.frame, '#second'); await b.page.keyboard.type(' From B.');
      await caretAtEnd(a.frame, '#third'); await a.page.keyboard.type(' From A.');
      await hide(a.page);
      await until(() => latest() === 2, 5000);
      await hide(b.page);
      // No dialog: the strip says it, in words without version numbers.
      const strip = b.page.locator('.tdoc-oldver-strip');
      await strip.waitFor({ timeout: 5000 });
      assert((await strip.innerText()).includes('Someone else just edited this doc. Your changes are kept.'), `the conflict strip says: ${await strip.innerText()}`);
      assert(await strip.getByRole('link', { name: 'Show latest' }).count() === 1, 'the strip has no Show latest');
      assert(await b.page.getByRole('dialog').count() === 0, 'a conflict dialog opened');
      assert(latest() === 2 && versionHtml(2).includes('From A.') && !versionHtml(2).includes('From B.'), 'B overwrote A');
      await b.page.locator('.tdoc-editor-autosave', { hasText: 'Draft · not published' }).waitFor({ timeout: 3000 });
      const draft = await b.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tdoc-draft:')).map((k) => localStorage.getItem(k)).join(''));
      assert(draft.includes('From B.'), 'B\'s draft is gone');
      await first.close(); await second.close();
    });

    await test('a version published elsewhere replaces the page in place: no reload, scroll kept, changes marked, Edited lights up', async () => {
      reset();
      const writer = await newContext();
      const reader = await newContext();
      const a = await openDoc(writer);
      const c = await openDoc(reader);
      await c.frame.evaluate(() => window.scrollTo(0, 400));
      await caretAtEnd(a.frame, '#intro'); await a.page.keyboard.type(' Swapped in place.');
      await hide(a.page);
      await c.frame.waitForFunction(() => document.querySelector('#intro').textContent.includes('Swapped in place.'), null, { timeout: 15000 });
      assert(!(await c.page.reloaded()), 'the reader page navigated');
      assert(await c.frame.evaluate(() => Math.round(scrollY)) === 400, 'the scroll position moved');
      assert(await c.frame.evaluate(() => document.documentElement.getAttribute('data-tdoc-swap-marked')) === '1', 'the change is not marked');
      await c.page.locator('#tdoc-version-toggle[data-just-updated]').waitFor({ timeout: 2000 });
      assert(await c.page.locator('.tdoc-oldver-strip').count() === 0, 'the "was just published" strip stayed after the swap');
      await c.frame.waitForFunction(() => !document.documentElement.hasAttribute('data-tdoc-swap-marked'), null, { timeout: 6000 });
      // Not while typing: C's own draft is never replaced.
      await caretAtEnd(c.frame, '#third'); await c.page.keyboard.type(' C typing.');
      await caretAtEnd(a.frame, '#second'); await a.page.keyboard.type(' Second round.');
      await hide(a.page);
      await c.page.waitForTimeout(3000);
      assert(!(await c.frame.evaluate(() => document.querySelector('#second').textContent.includes('Second round.'))), 'the page was swapped under someone typing');
      assert(await c.frame.evaluate(() => document.querySelector('#third').textContent.includes('C typing.')), 'C lost what it typed');
      assert((await c.page.locator('.tdoc-oldver-strip').innerText()).includes('Someone else just edited this doc.'), 'the person typing is not told');
      await writer.close(); await reader.close();
    });

    await test('reduced motion: the change mark is static and clears', async () => {
      reset();
      const writer = await newContext();
      const reader = await newContext({ reducedMotion: 'reduce' });
      const a = await openDoc(writer);
      const c = await openDoc(reader);
      await caretAtEnd(a.frame, '#intro'); await a.page.keyboard.type(' Calm.');
      await hide(a.page);
      await c.frame.waitForFunction(() => document.documentElement.hasAttribute('data-tdoc-swap-marked'), null, { timeout: 15000 });
      const css = await c.frame.evaluate(() => document.getElementById('tdoc-provider-swap-mark').textContent);
      assert(css.includes('rgba(37,168,91,0.16)'), `not the compare's insertion colour: ${css}`);
      await c.page.waitForTimeout(1500);
      assert((await c.frame.evaluate(() => document.getElementById('tdoc-provider-swap-mark').textContent)) === css, 'the mark faded with reduced motion');
      await c.frame.waitForFunction(() => !document.documentElement.hasAttribute('data-tdoc-swap-marked'), null, { timeout: 4000 });
      await writer.close(); await reader.close();
    });

    await test('phone: tap to type, the bubble stays on screen below the selection', async () => {
      reset();
      const context = await newContext({ mobile: true });
      const { page, frame } = await openDoc(context);
      await caretAtEnd(frame, '#intro');
      await page.keyboard.type(' Phone.');
      await frame.waitForFunction(() => document.querySelector('#intro').textContent.includes('Phone.'));
      await selectWords(frame, '#second', 0, 8);
      const bubble = page.locator('.tdoc-editor-bubble');
      await bubble.waitFor();
      const box = await bubble.boundingBox();
      const frameBox = await page.locator('iframe.tdoc-doc-frame').boundingBox();
      const selTop = await frame.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().top);
      assert(box.x >= 0 && box.x + box.width <= 390, `the bubble runs off the screen: ${JSON.stringify(box)}`);
      assert(box.y > frameBox.y + selTop, 'the bubble is not below the selection on a phone');
      await bubble.getByRole('button', { name: 'Italic' }).click();
      await frame.waitForFunction(() => /<(i|em)>Comments<\/(i|em)>/.test(document.querySelector('#second').innerHTML));
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
