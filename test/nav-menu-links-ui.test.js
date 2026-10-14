// "My docs" from the account menu must never look like a dead click.
//
// Owner report (tdoc.dev, signed in, on the landing page): opening the
// account menu and choosing My docs "did nothing". The click did navigate;
// /me took seconds to answer (the doc index was being built on the request
// path, see test/bench/me-latency.js) and nothing on the page said a
// navigation had started. So, on the landing page, a document and My docs
// itself, at desktop and phone widths:
//   - the navigation rows (and the logo) are real links to their page, so
//     they work even if a script handler misfires and open in a new tab on a
//     modified click;
//   - while the next page is still on its way, the clicked row is marked busy
//     and the top-of-page progress bar is showing;
//   - the navigation lands on /me.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort, FIXTURE_ROOT } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('nav-menu-links-ui.test.js');

const root = path.join(__dirname, '..');

function waitFor(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); })
        .on('error', () => (Date.now() > deadline ? reject(new Error('server did not start')) : setTimeout(ping, 100)));
    })();
  });
}

(async () => {
  // The landing doc and a plain doc, side by side in a scratch library.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nav-links-'));
  fs.cpSync(path.join(root, 'landing', 'tornado-doc'), path.join(dir, 'tornado-doc'), { recursive: true });
  fs.cpSync(path.join(FIXTURE_ROOT, 'sample-doc'), path.join(dir, 'sample-doc'), { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'tornado-doc', 'meta.json'), 'utf8'));
  const landingV = Math.max(...meta.versions.map((v) => Number(v.n)));
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: dir, TDOC_PORT: String(port), TDOC_E2E_USER: 'alice' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    await waitFor(port);
    const pages = [
      ['landing', `${base}/d/tornado-doc/v/${landingV}`],
      ['document', `${base}/d/sample-doc/v/2`],
      ['My docs', `${base}/me`],
    ];
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const reports = [];
      await page.exposeBinding('__tdocNavReport', (_source, state) => { reports.push(state); });
      await page.addInitScript(() => {
        const report = () => {
          const busy = document.querySelector('.ui-menu-item[aria-busy="true"]');
          window.__tdocNavReport({
            navigating: document.documentElement.hasAttribute('data-tdoc-navigating'),
            busy: busy ? busy.getAttribute('href') : null,
            spinner: !!(busy && busy.querySelector('.ui-menu-item-spinner')),
            bar: document.body ? getComputedStyle(document.body, '::after').position : null,
          });
        };
        new MutationObserver(report).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-tdoc-navigating', 'aria-busy'] });
      });
      // A slow My docs, held until the test has looked at the page it left.
      let release = null;
      let held = 0;
      await page.route(`${base}/me`, async (route) => {
        if (route.request().resourceType() !== 'document' || !release) return route.continue();
        held += 1;
        await release;
        return route.continue();
      });
      for (const [name, url] of pages) {
        release = null;
        await page.goto(url);
        await page.locator('.tdoc-bar').waitFor();

        // The logo is a link to My docs.
        const mark = page.locator('.tdoc-bar a.tdoc-bar-mark');
        assert.equal(await mark.getAttribute('href'), '/me', `${name} ${width}px: logo is a link to /me`);

        if (width > 700) await page.locator('.tdoc-account-trigger').click();
        else await page.locator('#tdoc-more-btn').click();
        const item = page.getByRole('menuitem', { name: 'My docs', exact: true });
        await item.waitFor();
        assert.equal(await item.evaluate((el) => el.tagName), 'A', `${name} ${width}px: My docs is a real link`);
        assert.equal(await item.getAttribute('href'), '/me', `${name} ${width}px: My docs links to /me`);
        if (width <= 700) {
          await page.getByRole('menuitem', { name: 'My account' }).click();
        }
        const agents = page.getByRole('menuitem', { name: 'Agents', exact: true });
        await agents.waitFor();
        assert.equal(await agents.getAttribute('href'), '/me/agents', `${name} ${width}px: Agents is a real link`);
        if (width <= 700) await page.keyboard.press('Escape');

        // Hold /me, click, and look. Playwright cannot evaluate in a page
        // whose navigation is pending, so the page reports what it shows the
        // moment it changes (see the init script above).
        let open;
        release = new Promise((r) => { open = r; });
        const before = held;
        reports.length = 0;
        await item.click({ noWaitAfter: true });
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && (held === before || !reports.some((r) => r.navigating && r.busy && r.bar === 'fixed'))) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const shown = reports.find((r) => r.navigating && r.busy && r.bar === 'fixed');
        assert(shown, `${name} ${width}px: the click showed nothing while /me loads: ${JSON.stringify(reports)}`);
        assert.equal(shown.spinner, true, `${name} ${width}px: the busy row shows a spinner`);
        assert.equal(held - before, 1, `${name} ${width}px: the click requested /me`);
        open();
        await page.waitForURL(`${base}/me`);
        await page.locator('.tdoc-bar').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-tdoc-navigating')), false,
          `${name} ${width}px: the new page starts without the bar`);
        release = null;
        console.log(`  ✓ ${width}px ${name}: My docs is a link, shows progress at once, and lands on /me`);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
