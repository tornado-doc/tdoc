// Sheet embeds in the browser, end to end against the local server: a page
// holding <figure data-tdoc-embed="sheet" data-src="/d/<slug>"> shows a
// live view of that sheet (title, the saved view's first rows, the comment
// count, Open), on a desktop and a phone; a sheet the reader cannot read is
// "You don't have access" with nothing of the sheet in it; Open goes to the
// sheet; with the flag off, in a frame the shell did not open, or for a
// request without the page's key, the figure stays its link.
// Screenshots for the PR: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chooseMode } = require('./helpers/doc-mode');
const { chromium } = requirePlaywrightOrSkip('sheet-embed-ui.test.js');
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
      const r = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      r.on('error', () => { if (Date.now() > deadline) reject(new Error('server did not start')); else setTimeout(poll, 80); });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-sheet-embed-ui-'));
  const writeDoc = (slug, html, title, comments) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title, versions: [{ n: 1, created: new Date().toISOString() }] }, null, 2));
    if (comments) fs.writeFileSync(path.join(root, slug, 'comments.json'), JSON.stringify(comments, null, 2));
  };
  const deals = [
    ['Acme Corp', ['won'], '48000', '2026-09-12', 'Ann'],
    ['Birch & Co', ['lost'], '12000', '2026-09-20', 'Bo'],
    ['Cobalt Labs', ['won', 'expansion'], '91500', '2026-10-02', 'Cy'],
    ['Dune Health', ['open'], '30000', '2026-10-15', 'Ann'],
    ['Elm Street <b>Bakery</b>', ['won'], '7200', '2026-10-21', 'Bo'],
    ['Fjord Systems', ['won'], '64000', '2026-11-03', 'Cy'],
    ['Granite AI', ['open'], '150000', '2026-11-08', 'Ann'],
  ].map((cells, i) => ({ id: `r${i + 1}`, cells }));
  writeDoc('q3-pipeline', M.sheetDocumentHtml({ title: 'Q3 pipeline', sheets: [
    { name: 'Deals', columns: [{ name: 'Account', type: 'text' }, { name: 'Stage', type: 'tags', palette: 'won:green, lost:red, open:blue' }, { name: 'Amount', type: 'number' }, { name: 'Close date', type: 'date' }, { name: 'Owner', type: 'text' }], rows: deals },
    { name: 'Owners', columns: [{ name: 'Name', type: 'text' }], rows: [{ cells: ['Ann'] }, { cells: ['Bo'] }, { cells: ['Cy'] }] },
  ] }), 'Q3 pipeline', [
    { id: 'c1', text: 'Is Granite real?', anchor: { kind: 'document' }, status: 'open', author: { login: 'owner' }, created: new Date().toISOString(), version: 1 },
    { id: 'c2', text: 'Cobalt closed', anchor: { kind: 'document' }, status: 'open', author: { login: 'owner' }, created: new Date().toISOString(), version: 1 },
    { id: 'c3', text: 'old', anchor: { kind: 'document' }, status: 'applied', applied_in: 1, author: { login: 'owner' }, created: new Date().toISOString(), version: 1 },
  ]);
  const wonByAmount = Q.encodeView({ active: 'Deals', tabs: { Deals: { search: '', filters: { 1: { values: ['won'] } }, sort: [{ col: 2, dir: 'desc' }], totals: {} } } });
  const figure = (src, attrs, label) => `<figure data-tdoc-embed="sheet" data-src="${src}"${attrs}>\n  <a href="${src}">${label}</a>\n</figure>`;
  writeDoc('weekly-update', `<!doctype html><html><head><meta charset="utf-8"><title>Weekly update</title></head><body><main>
<h1>Weekly update</h1>
<p>Four deals closed this quarter. The won deals, largest first, live in the pipeline sheet:</p>
${figure('/d/q3-pipeline', ` data-tab="Deals" data-view="${wonByAmount}" data-rows="3"`, 'Q3 pipeline: won deals')}
<p>Finance keeps its own forecast:</p>
${figure('/d/finance-forecast', ' data-rows="5"', 'Finance forecast')}
<h2>Next</h2><p>Close Granite before the end of the month.</p>
</main></body></html>`, 'Weekly update');

  // A page with two versions: only the latest embeds.
  {
    const html = fs.readFileSync(path.join(root, 'weekly-update', 'v1', 'index.html'), 'utf8');
    for (const n of [1, 2]) { fs.mkdirSync(path.join(root, 'two-versions', `v${n}`), { recursive: true }); fs.writeFileSync(path.join(root, 'two-versions', `v${n}`, 'index.html'), html); }
    fs.writeFileSync(path.join(root, 'two-versions', 'meta.json'), JSON.stringify({ slug: 'two-versions', title: 'Two versions', versions: [{ n: 1, created: new Date().toISOString() }, { n: 2, created: new Date().toISOString() }] }));
  }
  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('sheet embeds in the browser');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    // The embed's shadow root is closed in the product; here it is opened so
    // the test can read what a person sees. Nothing else changes.
    const openShadows = () => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) { return attach.call(this, Object.assign({}, init, { mode: 'open' })); };
    };
    async function newContext(viewport, flag = true) {
      const context = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      await context.addInitScript(openShadows);
      await context.addInitScript((on) => { window.__TDOC_FLAGS__ = Object.assign(window.__TDOC_FLAGS__ || {}, { sheetEmbeds: on }); }, flag);
      // The forecast belongs to somebody else: this reader may not read it.
      await context.route('**/api/embed/sheet?*slug=finance-forecast*', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'no_access', signed_in: false }) }));
      return context;
    }
    const frameOf = (page) => page.frames().find((f) => f.url().includes('/frame'));
    async function openPage(page, slug = 'weekly-update') {
      await page.goto(`${base}/d/${slug}/v/1`);
      await page.frameLocator('iframe[aria-label="Document content"]').locator('h1').first().waitFor({ timeout: 15000 });
      const frame = frameOf(page);
      return frame;
    }
    const settled = (frame, n = 2) => frame.waitForFunction((count) => window.__tdocSheetEmbeds
      && window.__tdocSheetEmbeds.list().length === count
      && window.__tdocSheetEmbeds.list().every((e) => e.state !== 'loading'), n, { timeout: 15000 });
    const embedText = (frame, i) => frame.evaluate((k) => {
      const host = document.querySelectorAll('[data-tdoc-embed-host]')[k];
      const root = host && host.shadowRoot;
      if (!root) return null;
      const q = (s) => Array.from(root.querySelectorAll(s)).map((n) => n.textContent.trim());
      return { all: root.textContent, title: q('.se-title b')[0] || '', heads: q('th'), rows: Array.from(root.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent.trim())), tags: q('.se-tag'), foot: q('.se-foot')[0] || '', actions: Array.from(root.querySelectorAll('.se-act .se-label')).map((n) => n.textContent.trim()), fallbackShown: getComputedStyle(host.parentElement.querySelector(':scope > a')).display !== 'none', box: host.getBoundingClientRect().toJSON() };
    }, i);

    const desktop = await newContext({ width: 1280, height: 900 });
    const page = await desktop.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await test('a page shows the embedded sheet live: title, the saved view\'s first rows, comment count, Open', async () => {
      const frame = await openPage(page);
      await settled(frame);
      const list = await frame.evaluate(() => window.__tdocSheetEmbeds.list());
      assert(list[0].state === 'live' && list[0].rows === 3, JSON.stringify(list));
      const e = await embedText(frame, 0);
      assert(e.title === 'Q3 pipeline', e.title);
      assert(e.heads.join() === 'Account,Stage,Amount,Close date,Owner', e.heads.join());
      // won only, by amount, largest first, three of them
      assert(e.rows.map((r) => r[0]).join('|') === 'Cobalt Labs|Fjord Systems|Acme Corp', JSON.stringify(e.rows));
      assert(e.tags.includes('expansion') && !e.tags.includes('lost'), e.tags.join());
      assert(/First 3 of 4 rows/.test(e.foot) && /filtered from 7/.test(e.foot) && /Sorted/.test(e.foot), e.foot);
      assert(e.actions.some((a) => a === '2 comments'), e.actions.join());
      assert(!e.fallbackShown, 'the fallback link hides once the view is live');
      // Nothing the page's CSS can see depends on the sheet: the host's size
      // comes from data-rows alone, in every state, and no state is an attribute.
      const boxes = await frame.evaluate(() => Array.from(document.querySelectorAll('[data-tdoc-embed-host]')).map((h) => ({ h: h.getBoundingClientRect().height, attrs: h.getAttributeNames().sort().join() })));
      const expect = (rows) => 2 + 44 + 33 + rows * 34 + 32;
      assert(boxes[0].h === expect(3) && boxes[1].h === expect(5), JSON.stringify(boxes));
      assert(boxes.every((b) => b.attrs === 'aria-label,contenteditable,data-tdoc-embed-host,data-tdoc-provider,role,tabindex'), JSON.stringify(boxes));
      // The same focus stops in every state: the host only, never a link inside.
      const focusables = await frame.evaluate(() => Array.from(document.querySelectorAll('[data-tdoc-embed-host]')).map((h) => [h.tabIndex, Array.from(h.shadowRoot.querySelectorAll('a,button,[tabindex]')).filter((n) => n.tabIndex >= 0).length].join(':')));
      assert(focusables.every((f) => f === '0:0'), JSON.stringify(focusables));
      const hostile = await frame.evaluate(() => {
        const st = document.createElement('style');
        st.textContent = '[data-tdoc-embed-host]{display:none!important;height:1px!important;contain:none!important;font-family:Evil!important}';
        document.head.appendChild(st);
        const r = document.querySelector('[data-tdoc-embed-host]').getBoundingClientRect().height;
        st.remove();
        return r;
      });
      assert(hostile === expect(3), `author CSS changed the card: ${hostile}`);
      const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `page scrolls sideways: ${overflow}`);
      await frame.evaluate(() => document.querySelector('[data-tdoc-embed-host]').scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(150);
      await shot(page, 'embed-desktop');
    });

    await test('cell text that looks like markup is text', async () => {
      const frame = frameOf(page);
      const injected = await frame.evaluate(() => document.querySelectorAll('[data-tdoc-embed-host] b, b').length);
      // Only the page's own <b>-free markup: no <b> from the sheet's "Elm Street <b>Bakery</b>" is in the DOM.
      assert(injected === 0, `markup from the sheet became elements: ${injected}`);
    });

    await test('a sheet the reader cannot read: "You don\'t have access", no title, no rows', async () => {
      const frame = frameOf(page);
      const list = await frame.evaluate(() => window.__tdocSheetEmbeds.list());
      assert(list[1].state === 'no-access', JSON.stringify(list));
      const e = await embedText(frame, 1);
      assert(/You don.t have access to this sheet/.test(e.all), e.all);
      assert(/Sign in/.test(e.all), 'a signed-out reader is told to sign in');
      assert(e.title === 'Sheet' && e.rows.length === 0 && !/forecast/i.test(e.all), e.all);
      await frame.evaluate(() => document.querySelectorAll('[data-tdoc-embed-host]')[1].scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      await shot(page, 'embed-no-access-desktop');
    });

    await test('the comment count and Open go to the sheet page, with the view', async () => {
      const frame = frameOf(page);
      await frame.evaluate(() => document.querySelector('[data-tdoc-embed-host]').scrollIntoView({ block: 'start' }));
      const href = await frame.evaluate(() => document.querySelector('[data-tdoc-embed-host]').shadowRoot.querySelector('.se-top .se-act:last-child').getAttribute('href'));
      assert(href.startsWith('/d/q3-pipeline?sheet=1#sheet=') || href.startsWith('/d/q3-pipeline#sheet='), href);
      await Promise.all([
        page.waitForURL((u) => u.pathname.startsWith('/d/q3-pipeline'), { timeout: 10000 }),
        frame.locator('[data-tdoc-embed-host] .se-top .se-act:last-child').click(),
      ]);
      assert(new URL(page.url()).pathname.startsWith('/d/q3-pipeline') && /sheet=/.test(new URL(page.url()).hash), page.url());
      await page.frameLocator('iframe[aria-label="Document content"]').locator('.tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
    });

    await test('Enter on the focused card opens the sheet', async () => {
      const frame = await openPage(page);
      await settled(frame);
      await frame.evaluate(() => document.querySelector('[data-tdoc-embed-host]').focus());
      await Promise.all([
        page.waitForURL((u) => u.pathname.startsWith('/d/q3-pipeline'), { timeout: 10000 }),
        page.keyboard.press('Enter'),
      ]);
    });

    await test('in Comment mode a click on the card\'s title still opens the sheet', async () => {
      const frame = await openPage(page);
      await settled(frame);
      await chooseMode(page, 'Comment');
      await frame.evaluate(() => document.querySelector('[data-tdoc-embed-host]').scrollIntoView({ block: 'start' }));
      await Promise.all([
        page.waitForURL((u) => u.pathname.startsWith('/d/q3-pipeline'), { timeout: 10000 }),
        frame.locator('[data-tdoc-embed-host] .se-title b').first().click(),
      ]);
    });

    await test('a request without the page\'s key gets no answer', async () => {
      const frame = await openPage(page);
      await settled(frame);
      const answered = await frame.evaluate(() => new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (ev) => resolve(ev.data);
        window.parent.postMessage({ source: 'tdoc-frame', type: 'tdoc:sheetEmbed', key: 'not-the-key-not-the-key', id: 'x', src: '/d/q3-pipeline', rows: '5' }, '*', [ch.port2]);
        setTimeout(() => resolve('no answer'), 1500);
      }));
      assert(answered === 'no answer', JSON.stringify(answered));
    });

    await test('a frame the shell did not open (the version compare) keeps the link', async () => {
      const raw = await desktop.newPage();
      await raw.goto(`${base}/d/weekly-update/v/1`);
      await raw.evaluate((src) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.id = 'cmp'; f.src = src; document.body.appendChild(f); }, '/d/weekly-update/v/1/frame?tdoc_compare=1');
      let cf = null;
      for (let k = 0; k < 50 && !cf; k++) { cf = raw.frames().find((x) => x.url().includes('tdoc_compare=1')); if (!cf) await raw.waitForTimeout(100); }
      await cf.waitForSelector('figure a');
      await raw.waitForTimeout(500);
      const info = await cf.evaluate(() => ({ hosts: document.querySelectorAll('[data-tdoc-embed-host]').length, link: getComputedStyle(document.querySelector('figure a')).display }));
      assert(info.hosts === 0 && info.link !== 'none', JSON.stringify(info));
      await raw.close();
    });

    await test('an old version of the page shows the links; the latest embeds', async () => {
      const p = await desktop.newPage();
      await p.goto(`${base}/d/two-versions/v/1`);
      await p.frameLocator('iframe[aria-label="Document content"]').locator('h1').first().waitFor({ timeout: 15000 });
      const old = frameOf(p);
      await old.waitForFunction(() => window.__tdocSheetEmbeds && window.__tdocSheetEmbeds.list().length === 2 && window.__tdocSheetEmbeds.list().every((e) => e.state === 'fallback'), null, { timeout: 15000 });
      const shown = await old.evaluate(() => Array.from(document.querySelectorAll('figure > a')).map((a) => getComputedStyle(a).display));
      assert(shown.every((d) => d !== 'none'), JSON.stringify(shown));
      await p.goto(`${base}/d/two-versions/v/2`);
      await p.frameLocator('iframe[aria-label="Document content"]').locator('h1').first().waitFor({ timeout: 15000 });
      const cur = frameOf(p);
      await settled(cur);
      assert((await cur.evaluate(() => window.__tdocSheetEmbeds.list()[0].state)) === 'live', 'latest embeds');
      await p.close();
    });

    await test('a page with an unnamed version: links, and its owner gets "Allow sheet embeds on this page"', async () => {
      const held = await newContext({ width: 1280, height: 900 });
      let allowed = false;
      await held.route('**/api/embed/sheet?*', (route) => allowed ? route.fallback() : route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'page_unattributed' }) }));
      let attested = null;
      await held.route('**/api/embed/attest', (route) => { attested = route.request().postDataJSON(); allowed = true; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
      const p = await held.newPage();
      const frame = await openPage(p);
      await frame.waitForFunction(() => window.__tdocSheetEmbeds && window.__tdocSheetEmbeds.list().length === 2 && window.__tdocSheetEmbeds.list().every((e) => e.state === 'fallback'), null, { timeout: 15000 });
      await p.locator('.tdoc-bar #tdoc-more-btn').click();
      const item = p.locator('[data-action="allow-embeds"]');
      await item.waitFor({ timeout: 5000 });
      await shot(p, 'embed-allow-menu');
      await item.click();
      await p.waitForFunction(() => document.querySelector('iframe[aria-label="Document content"]').src.includes('tdoc_load='), null, { timeout: 10000 });
      assert(attested && attested.slug === 'weekly-update', JSON.stringify(attested));
      const again = p.frames().find((f) => f.url().includes('tdoc_load='));
      await again.waitForFunction(() => window.__tdocSheetEmbeds && window.__tdocSheetEmbeds.list().some((e) => e.state === 'live'), null, { timeout: 15000 });
      await held.close();
    });

    await test('flag off: the figure is its link, and no data is asked for', async () => {
      const off = await newContext({ width: 1280, height: 900 }, false);
      const p = await off.newPage();
      const asked = [];
      p.on('request', (r) => { if (r.url().includes('/api/embed/sheet')) asked.push(r.url()); });
      const frame = await openPage(p);
      await frame.waitForFunction(() => window.__tdocSheetEmbeds && window.__tdocSheetEmbeds.list().every((e) => e.state === 'fallback'), null, { timeout: 15000 });
      const shown = await frame.evaluate(() => Array.from(document.querySelectorAll('figure > a')).map((a) => getComputedStyle(a).display));
      assert(shown.every((d) => d !== 'none') && asked.length === 0, JSON.stringify({ shown, asked }));
      await off.close();
    });

    await test('a phone: the embed fits, scrolls sideways inside itself, the page does not', async () => {
      const phone = await newContext({ width: 390, height: 844 });
      const p = await phone.newPage();
      const frame = await openPage(p);
      await settled(frame);
      const e = await embedText(frame, 0);
      assert(e.rows.length === 3 && e.box.width <= 390, JSON.stringify(e.box));
      const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `page scrolls sideways: ${overflow}`);
      await frame.evaluate(() => document.querySelector('[data-tdoc-embed-host]').scrollIntoView({ block: 'start' }));
      await p.waitForTimeout(150);
      await shot(p, 'embed-phone');
      await frame.evaluate(() => document.querySelectorAll('[data-tdoc-embed-host]')[1].scrollIntoView({ block: 'center' }));
      await p.waitForTimeout(150);
      await shot(p, 'embed-no-access-phone');
      await phone.close();
    });

    await test('the embed is the provider\'s: a saved page keeps only the reference', async () => {
      const frame = frameOf(page);
      const saved = await frame.evaluate(() => {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('[data-tdoc-provider]').forEach((n) => n.remove());
        return clone.querySelector('figure').outerHTML;
      });
      assert(!/data-tdoc-embed-host|Cobalt/.test(saved) && /data-src="\/d\/q3-pipeline"/.test(saved), saved);
      assert(errors.length === 0, errors.join('\n'));
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
