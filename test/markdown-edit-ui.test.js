// Browser acceptance for Edit as Markdown (flag markdownEditMode): while a
// prose doc is being edited, one switch shows it as Markdown source in the
// page's place and back. Typing there reaches the page (Save, drafts and
// autosave are the editor's own); blocks Markdown can't show stay HTML
// behind a placeholder line and come back byte for byte; an edited block
// keeps its id; raw HTML typed in Markdown stays text; the choice is
// remembered; a doc made only of house blocks has the switch disabled with
// the reason; sheets have no switch; flag off: no switch. Desktop + phone,
// with screenshots of both views (TDOC_SHOTS=<dir> keeps them).
// Run with: node test/markdown-edit-ui.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { chromium, devices } = requirePlaywrightOrSkip('markdown-edit-ui.test.js');

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

const CARDS = '<div class="tdoc-cards"><div class="tdoc-card"><h3>Reader</h3><p>Ships <b>Monday</b>.</p></div><div class="tdoc-card"><h3>Editor</h3><p>Ships later.</p></div></div>';
const PROSE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Launch notes</title></head>
<body><main>
<h1>Launch notes</h1>
<p id="intro">We ship the <strong>new</strong> reader on <em>Monday</em>.</p>
${CARDS}
<h2>Plan</h2>
<ul><li>Write the notes</li><li>Review with <code>tdoc</code></li></ul>
<p>Read more at <a href="https://tdoc.dev">tdoc.dev</a>.</p>
<p id="last">The end.</p>
</main></body></html>`;
const HOUSE_ONLY = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dashboard</title></head>
<body><main>
<div class="tdoc-tiles"><div class="tdoc-tile"><p>Users</p><p>1,204</p></div></div>
<figure><svg viewBox="0 0 10 10" width="40" height="40"><rect width="10" height="10"></rect></svg><figcaption>Chart</figcaption></figure>
</main></body></html>`;
const SHEET = `<!doctype html>
<html><head><meta charset="utf-8"><title>Budget</title></head>
<body><main>
<h1>Budget</h1>
<table data-tdoc-sheet><thead><tr><th>Item</th><th>Cost</th></tr></thead><tbody><tr><td>Laptop</td><td>1200</td></tr></tbody></table>
</main></body></html>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-md-edit-'));
  const shots = process.env.TDOC_SHOTS || '';
  const docs = { notes: PROSE, dash: HOUSE_ONLY, budget: SHEET };
  const reset = (slug) => {
    const docRoot = path.join(root, slug);
    fs.rmSync(docRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(docRoot, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(docRoot, 'v1', 'index.html'), docs[slug]);
    fs.writeFileSync(path.join(docRoot, 'meta.json'), JSON.stringify({ slug, title: slug, versions: [{ n: 1, created: new Date().toISOString() }] }));
  };
  const versions = (slug) => JSON.parse(fs.readFileSync(path.join(root, slug, 'meta.json'))).versions.map((v) => Number(v.n));
  const latest = (slug) => Math.max(...versions(slug));
  const versionHtml = (slug, n) => fs.readFileSync(path.join(root, slug, `v${n}`, 'index.html'), 'utf8');

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  async function newContext({ flag = true, modeless = false, idleMs = 120_000, mobile = false, storage = null } = {}) {
    const context = await browser.newContext(mobile
      ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }
      : { viewport: { width: 1280, height: 800 } });
    await context.addInitScript(([flagOn, modelessOn, idle, stored]) => {
      window.__TDOC_FLAGS__ = { markdownEditMode: flagOn, modelessEdit: modelessOn };
      window.__TDOC_MODELESS_IDLE_MS = idle;
      if (stored && !sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
      }
    }, [flag, modeless, idleMs, storage]);
    await context.route(/\/d\/[a-z]+\/v\/\d+(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/window\.__TDOC_SHELL__ = (.*?);<\/script>/,
        (_, json) => `window.__TDOC_SHELL__ = ${JSON.stringify({ ...JSON.parse(json), mode: 'published' })};</script>`);
      await route.fulfill({ response, body });
    });
    return context;
  }
  async function openDoc(context, slug, query = '') {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.errors = errors;
    await page.goto(`${base}/d/${slug}/v/${latest(slug)}${query}`, { waitUntil: 'networkidle' });
    const handle = await page.locator('iframe.tdoc-doc-frame').elementHandle();
    const frame = await handle.contentFrame();
    await frame.waitForSelector('main', { state: 'attached' });
    return { page, frame };
  }
  const source = (page) => page.locator('.tdoc-md-source textarea');
  const mdSwitch = (page) => page.getByRole('switch', { name: 'Markdown' });
  const shot = async (page, name) => { if (shots) await page.mouse.move(1, 400).then(() => page.waitForTimeout(300)).then(() => page.screenshot({ path: path.join(shots, `${name}.png`) })); };

  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    await test('flag off: Edit mode has no Markdown switch', async () => {
      reset('notes');
      const context = await newContext({ flag: false });
      const { page } = await openDoc(context, 'notes');
      await chooseMode(page, 'Edit');
      await page.locator('.tdoc-editor-toolbar').waitFor();
      await page.waitForTimeout(500);
      assert(await mdSwitch(page).count() === 0, 'the switch shows with the flag off');
      await context.close();
    });

    await test('Edit mode: Markdown shows the doc as source, house blocks as one placeholder; edits save; untouched blocks stay byte for byte', async () => {
      reset('notes');
      const context = await newContext();
      const { page, frame } = await openDoc(context, 'notes');
      await chooseMode(page, 'Edit');
      await shot(page, 'desktop-rich');
      assert(await mdSwitch(page).count() === 1, 'no Markdown switch in the editor bar');
      assert(await page.locator('.tdoc-md-source').count() === 0, 'the source view opened unasked');
      await mdSwitch(page).click();
      await source(page).waitFor();
      const md = await source(page).inputValue();
      assert(md.startsWith('# Launch notes\n\nWe ship the **new** reader on *Monday*.'), `unexpected Markdown:\n${md}`);
      assert(/<!-- tdoc:keep 1 · cards: Reader Ships Monday/.test(md), `the cards are not one placeholder:\n${md}`);
      assert(md.includes('- Write the notes\n- Review with `tdoc`'), 'the list is not Markdown');
      assert(md.includes('[tdoc.dev](https://tdoc.dev)'), 'the link is not Markdown');
      assert(await page.locator('iframe.tdoc-doc-frame').isHidden(), 'the page shows under the source');
      assert(await page.getByRole('button', { name: 'Bold' }).count() === 0, 'the page\'s formatting tools still show');
      assert(await page.evaluate(() => document.activeElement?.tagName) === 'TEXTAREA', 'the source view does not take the caret');
      await shot(page, 'desktop-markdown');
      // Switching without typing changes nothing.
      assert(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'opening Markdown made a draft');
      // Edit the first paragraph and add a section, with raw HTML that must stay text.
      await source(page).fill(md
        .replace('reader on *Monday*.', 'reader on *Tuesday*.')
        .replace('The end.', 'The end.\n\n## Next\n\nShip <script>alert(1)</script> and [this](javascript:alert(1)).'));
      await page.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('.tdoc-editor-commit button.primary')?.disabled, null, { timeout: 4000 });
      // The page followed, under the source.
      assert((await frame.evaluate(() => document.querySelector('#intro').innerHTML)).includes('<em>Tuesday</em>'), 'the page did not follow the Markdown');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const firstPublish = page.getByRole('button', { name: 'Save and publish' });
      await firstPublish.waitFor({ timeout: 1500 }).catch(() => {});
      if (await firstPublish.isVisible().catch(() => false)) await firstPublish.click();
      await until(() => latest('notes') === 2, 8000);
      const v2 = versionHtml('notes', 2);
      assert(v2.includes('<p id="intro"') && /<p id="intro"[^>]*>We ship the <strong>new<\/strong> reader on <em>Tuesday<\/em>\.<\/p>/.test(v2), 'the edited paragraph lost its id or its words');
      assert(v2.includes(CARDS), 'the cards did not come back byte for byte');
      assert(v2.includes('<h2>Next</h2>'), 'the new heading is missing');
      assert(v2.includes('Ship &lt;script&gt;alert(1)&lt;/script&gt; and this.'), 'raw HTML or a javascript: link got through');
      assert(!/<script>alert/.test(v2) && !/javascript:/.test(v2), 'markup typed in Markdown reached the page');
      // The choice is remembered: the saved page reopens in Markdown.
      await page.waitForURL(/edit=1|\/v\/2/, { timeout: 8000 }).catch(() => {});
      await source(page).waitFor({ timeout: 8000 });
      assert((await source(page).inputValue()).includes('*Tuesday*'), 'the reopened view is not v2');
      // And back to the page.
      await mdSwitch(page).click();
      await page.locator('.tdoc-md-source').waitFor({ state: 'detached' });
      assert(await page.locator('iframe.tdoc-doc-frame').isVisible(), 'the page did not come back');
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('a placeholder deleted in Markdown removes that block, and says so', async () => {
      reset('notes');
      const context = await newContext({ storage: { 'tdoc-edit-view:owner': 'markdown' } });
      const { page, frame } = await openDoc(context, 'notes', '?edit=1');
      await source(page).waitFor();
      const md = await source(page).inputValue();
      await source(page).fill(md.replace(/<!-- tdoc:keep 1[^\n]*-->\n\n/, ''));
      await page.waitForTimeout(600);
      await mdSwitch(page).click();
      await page.locator('.tdoc-toast, [role="status"]', { hasText: 'kept as HTML was deleted' }).first().waitFor({ timeout: 3000 });
      assert(await frame.evaluate(() => !document.querySelector('.tdoc-cards')), 'the deleted block is still on the page');
      await context.close();
    });

    await test('a doc made only of house blocks: the switch is disabled and says why', async () => {
      reset('dash');
      const context = await newContext();
      const { page } = await openDoc(context, 'dash');
      await chooseMode(page, 'Edit');
      await page.waitForFunction(() => document.querySelector('.tdoc-md-switch[title*="Markdown can"]'), null, { timeout: 4000 });
      assert(await mdSwitch(page).isDisabled(), 'the switch is enabled on a doc Markdown cannot show');
      await context.close();
    });

    await test('a sheet doc has no Markdown switch', async () => {
      reset('budget');
      const context = await newContext();
      const { page } = await openDoc(context, 'budget');
      await chooseMode(page, 'Edit');
      await page.locator('.tdoc-editor-toolbar').waitFor();
      await page.waitForTimeout(600);
      assert(await mdSwitch(page).count() === 0, 'a sheet doc shows the switch');
      await context.close();
    });

    await test('modeless editing: the switch sits beside the autosave status; Markdown edits publish as a version', async () => {
      reset('notes');
      const context = await newContext({ modeless: true, idleMs: 1500 });
      const { page } = await openDoc(context, 'notes');
      await page.locator(modeSelector('edit')).waitFor();
      await mdSwitch(page).waitFor();
      await shot(page, 'modeless-rich');
      await mdSwitch(page).click();
      await source(page).waitFor();
      await shot(page, 'modeless-markdown');
      await source(page).press('End');
      await source(page).evaluate((el) => { el.setSelectionRange(el.value.length, el.value.length); });
      await page.keyboard.type('\nOne more line.');
      await until(() => latest('notes') === 2, 8000);
      assert(latest('notes') === 2 && versionHtml('notes', 2).includes('One more line.'), 'the Markdown edit did not publish');
      assert(versionHtml('notes', 2).includes(CARDS), 'the cards changed');
      assert(!page.errors.length, page.errors.join('\n'));
      await context.close();
    });

    await test('phone: the switch and the source view fit the screen', async () => {
      reset('notes');
      const context = await newContext({ mobile: true });
      const { page } = await openDoc(context, 'notes');
      await chooseMode(page, 'Edit');
      await shot(page, 'phone-rich');
      await mdSwitch(page).click();
      await source(page).waitFor();
      const box = await page.locator('.tdoc-md-source textarea').boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 390 + 1, 'the source view is wider than the phone');
      const sw = await page.locator('.tdoc-md-switch').boundingBox();
      assert(sw && sw.x + sw.width <= 390 + 1, 'the switch is off screen');
      await shot(page, 'phone-markdown');
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
