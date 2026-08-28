// React provider-UI smoke tests. Deep comment/frame behavior lives in
// artifact-shell.test.js; this suite protects the reusable menu/dialog facades,
// shell framing, and Docs Hub at desktop and phone widths.
const { requirePlaywrightOrSkip, resolveTarget } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('ui.test.js');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, error) { console.log(`  ✗ ${name}\n    ${error.message || error}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (error) { bad(name, error); } }

(async () => {
  const target = await resolveTarget();
  const url = target.url;
  const origin = new URL(url).origin;
  console.log(`testing ${url}\n`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });

  await t('React shell owns the top bar and isolates author HTML in a sandboxed frame', async () => {
    await page.waitForSelector('.tdoc-document-app .tdoc-bar');
    const state = await page.evaluate(() => {
      const frame = document.querySelector('.tdoc-doc-frame');
      return {
        root: Boolean(document.querySelector('#tdoc-shell-root > .tdoc-document-app')),
        frame: Boolean(frame),
        sandbox: frame?.getAttribute('sandbox'),
        authorOutside: Boolean(document.querySelector('main article, body > article')),
      };
    });
    if (!state.root || !state.frame) throw new Error('React shell or author frame missing');
    if (state.sandbox !== 'allow-scripts') throw new Error(`unexpected frame sandbox: ${state.sandbox}`);
    if (state.authorOutside) throw new Error('author DOM leaked into the provider shell');
  });

  await t('theme toggle persists and reaches the author frame', async () => {
    await page.evaluate(() => localStorage.removeItem('tdoc-theme'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#tdoc-theme-btn');
    await page.waitForFunction(() => document.documentElement.dataset.tdocTheme === 'dark');
    const stored = await page.evaluate(() => localStorage.getItem('tdoc-theme'));
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    const frameTheme = await frame.evaluate(() => document.documentElement.dataset.tdocTheme);
    if (stored !== 'dark' || frameTheme !== 'dark') throw new Error(`theme did not persist/bridge: ${stored}/${frameTheme}`);
  });

  await t('Base UI overflow menu exposes document actions and closes on Escape', async () => {
    await page.click('#tdoc-more-btn');
    await page.waitForSelector('.ui-menu-popup [data-action="copy"]');
    const labels = await page.$$eval('.ui-menu-popup .ui-menu-item', (items) => items.map((item) => item.textContent.trim()));
    if (!labels.includes('Copy as Markdown') || !labels.includes('Download HTML')) throw new Error(`actions missing: ${labels.join(', ')}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ui-menu-popup', { state: 'detached' });
  });

  await t('Copy as Markdown bridges from the frame and reports a toast', async () => {
    await page.click('#tdoc-more-btn');
    await page.click('.ui-menu-popup [data-action="copy"]');
    await page.waitForSelector('.tdoc-shell-toast');
    const toast = await page.textContent('.tdoc-shell-toast');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    if (!/Copied as Markdown/.test(toast) || !clipboard.includes('#')) throw new Error('copy bridge did not complete');
  });

  await t('Publish uses the shared Base UI dialog with focus and Escape behavior', async () => {
    await page.click('#tdoc-publish-btn');
    await page.waitForSelector('.ui-dialog-popup');
    const title = await page.textContent('.ui-dialog-title');
    if (!/Publish this doc/.test(title)) throw new Error(`unexpected dialog: ${title}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ui-dialog-popup', { state: 'detached' });
  });

  await t('author copy controls remain inside the framework-free frame', async () => {
    const copyUrl = `${origin}/d/copy-doc/v/1`;
    await page.goto(copyUrl, { waitUntil: 'networkidle' });
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    await frame.click('[data-tdoc-copy]');
    await frame.waitForSelector('[data-tdoc-copy].tdoc-copied');
  });

  await t('Docs Hub renders structured rows, search, sort, tabs, and create action', async () => {
    await page.goto(`${origin}/me`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.docs-hub .doc-row');
    for (const selector of ['[aria-label="Search docs"]', '[aria-label="Sort docs"]', '[role="tablist"]', '.mk-btn']) {
      if (!await page.$(selector)) throw new Error(`missing ${selector}`);
    }
  });

  await t('Docs Hub dialogs also use the shared Base UI facade', async () => {
    await page.click('.mk-btn');
    await page.waitForSelector('.ui-dialog-popup');
    const title = await page.textContent('.ui-dialog-title');
    if (title !== 'Create a doc') throw new Error(`unexpected dialog title: ${title}`);
    await page.keyboard.press('Escape');
  });

  await t('Docs Hub search filters rows without shifting page chrome', async () => {
    const before = await page.$$eval('.doc-row[data-slug]', (rows) => rows.length);
    await page.fill('[aria-label="Search docs"]', 'no-result-for-this-query');
    const after = await page.$$eval('.doc-row[data-slug]', (rows) => rows.length);
    if (!before || after !== 0) throw new Error(`search filter mismatch: ${before} -> ${after}`);
    if (!await page.$('.tdoc-bar')) throw new Error('page chrome disappeared');
  });

  await t('Docs Hub fits a phone viewport without horizontal overflow or clipped controls', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${origin}/me`, { waitUntil: 'networkidle' });
    const layout = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('button, input, select')].map((element) => element.getBoundingClientRect());
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        clipped: controls.some((rect) => rect.right > window.innerWidth + 1 || rect.left < -1),
      };
    });
    if (layout.scrollWidth > layout.innerWidth + 1) throw new Error(`horizontal overflow ${layout.scrollWidth}/${layout.innerWidth}`);
    if (layout.clipped) throw new Error('a control is clipped outside the viewport');
  });

  await context.close();
  await browser.close();
  await target.stop();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
