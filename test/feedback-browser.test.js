// Browser acceptance for product feedback (#564): a localhost app on one
// port, the feedback client loaded the way the bookmarklet loads it, the
// connect popup on the tdoc origin, and a comment that lands in the
// feedback space and shows in the doc.
// Run with: node test/feedback-browser.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const esbuild = require('esbuild');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium, webkit } = requirePlaywrightOrSkip('feedback-browser.test.js');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, error) { console.log(`  ✗ ${name}\n    ${error.message || error}`); fail++; }
async function test(name, operation) {
  try { await operation(); ok(name); } catch (error) { bad(name, error); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function waitForServer(port, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const request = http.get({ host: '127.0.0.1', port, path: '/api/ping' }, (response) => {
        response.resume(); resolve();
      });
      request.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('local server did not start'));
        else setTimeout(poll, 80);
      });
    })();
  });
}

// Somebody's app: not tdoc, knows nothing about tdoc.
const APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Acme dashboard</title>
<style>body{font:16px system-ui;margin:0}main{max-width:640px;margin:80px auto 40px;padding:0 24px}nav{position:fixed;z-index:2147483644;top:0;left:0;right:0;height:48px;padding:0 24px;display:flex;align-items:center;background:#fff;border-bottom:1px solid #ddd}.card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:0 0 12px}button{background:#111;color:#fff;border:0;padding:8px 14px;border-radius:6px}</style>
</head><body><main>
<nav><b>Dashboard</b> · Projects · Settings</nav>
<section class="card"><h2>Weekly active users</h2><p>1,284 · +12%</p></section>
<section class="card"><h2>Invite teammates</h2><button id="invite">Send invite</button> <button id="open-modal">Settings</button></section>
</main><script>
window.__fbRoot = () => document.getElementById('tdoc-feedback-root')?.shadowRoot?.getElementById('tdoc-feedback-root');
window.__fb = (selector) => window.__fbRoot()?.querySelector(selector);
window.__fbAll = (selector) => window.__fbRoot()?.querySelectorAll(selector) || [];
</script></body></html>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-feedback-'));
  const tdocPort = await reservePort();
  const appPort = await reservePort();
  const tdocBase = `http://localhost:${tdocPort}`;
  const appBase = `http://127.0.0.1:${appPort}`;
  const libraryBundle = (await esbuild.build({
    entryPoints: [path.join(__dirname, 'fixtures', 'feedback-host-libraries.jsx')],
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  })).outputFiles[0].contents;

  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(tdocPort), TDOC_E2E_USER: 'julie' },
    stdio: 'ignore',
  });
  const app = http.createServer((req, res) => {
    if (req.url === '/libraries.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(libraryBundle);
      return;
    }
    if (req.url === '/libraries') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px system-ui}.modal-overlay{position:fixed;inset:0;background:#0005}.modal-content{position:fixed;top:18%;left:20%;min-width:400px;padding:24px;background:white;z-index:30}#custom-headless-panel{transition:opacity 1s}#custom-headless-panel[data-closed]{opacity:0}.overlay-backdrop{position:fixed;inset:0;background:#0006;z-index:1000;display:flex;align-items:center;justify-content:center}.overlay-box{background:#fff;padding:24px;border-radius:8px}.menu-anchor{position:relative;display:inline-block}.menu{position:absolute;top:100%;left:0;z-index:50;display:flex;flex-direction:column;background:#fff;border:1px solid #ccc;padding:4px;min-width:160px}#page-chart-card{margin:16px 0}</style><div id="host-app"></div><script src="/libraries.js"></script>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(APP_HTML);
  });
  await new Promise((resolve) => app.listen(appPort, '127.0.0.1', resolve));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await waitForServer(tdocPort);
    await page.goto(`${appBase}/dashboard`);

    await test('the bookmarklet page offers a javascript: bookmark and the one-line install', async () => {
      const bm = await context.newPage();
      await bm.goto(`${tdocBase}/feedback`);
      const href = await bm.locator('#bookmarklet').getAttribute('href');
      // The whole address, not a prefix: it is code, and this is what it must be.
      const expected = `javascript:(function(){if(window.tdocFeedback){window.tdocFeedback.toggle();return}var s=document.createElement('script');s.src='${tdocBase}/feedback.js?b='+Date.now();s.async=true;s.setAttribute('data-tdoc-open','1');document.documentElement.appendChild(s)})()`;
      assert(href === expected, `bookmark address differs:\n${href}`);
      assert((await bm.content()).includes(`&lt;script src="${tdocBase}/feedback.js"`), 'one-line install is not shown');
      await bm.close();
    });

    await test('clicking the bookmark loads the client; the connect popup hands a token back to the app', async () => {
      // Reproduce a browser-blocked first attempt. The next user click must be
      // a genuinely new attempt, not the rejected Promise from the first one.
      await page.evaluate(() => { window.__tdocRealOpen = window.open; window.open = () => null; });
      // What the bookmark does, minus the bookmarks bar.
      await page.evaluate((src) => {
        const s = document.createElement('script');
        s.src = `${src}?b=${Date.now()}`;
        s.async = true;
        s.setAttribute('data-tdoc-open', '1');
        document.documentElement.appendChild(s);
      }, `${tdocBase}/feedback.js`);
      await page.waitForFunction(() => window.tdocFeedback && window.tdocFeedback.base);
      assert((await page.evaluate(() => window.tdocFeedback.base)) === tdocBase, 'client did not learn its origin from the script URL');
      const connectButton = page.locator('#tdoc-feedback-root .tdoc-feedback-notice button.submit');
      await connectButton.waitFor({ timeout: 5000 });
      assert((await connectButton.innerText()).includes('Connect'), 'notice does not offer to connect');
      await page.evaluate(() => { window.open = window.__tdocRealOpen; });
      const [popup] = await Promise.all([context.waitForEvent('page'), connectButton.click()]);
      await popup.waitForLoadState().catch(() => {});
      assert(popup.url().startsWith(`${tdocBase}/feedback/connect?origin=${encodeURIComponent(appBase)}`), `popup went to ${popup.url()}`);
      await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), `tdoc-feedback:${tdocBase}`);
      const session = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `tdoc-feedback:${tdocBase}`);
      assert(session.token && session.slug && session.version === 1, 'stored session is incomplete');
      assert(session.slug === 'feedback-127-0-0-1-' + appPort, `space slug ${session.slug}`);
      assert(fs.existsSync(path.join(root, session.slug, 'meta.json')), 'feedback space doc was not created');
      const meta = JSON.parse(fs.readFileSync(path.join(root, session.slug, 'meta.json'), 'utf8'));
      assert(meta.created_from === 'feedback' && meta.feedback.origin === appBase, 'space meta does not name the app');
      await popup.waitForEvent('close', { timeout: 3000 }).catch(() => {});
    });

    await test('clicking an element opens the real tdoc composer; posting leaves a pin', async () => {
      await page.locator('#invite').click({ force: true });
      const composer = page.locator('#tdoc-feedback-root .tdoc-popup textarea, #tdoc-feedback-root .tdoc-popup [contenteditable]');
      await composer.first().waitFor({ timeout: 5000 });
      await composer.first().fill('This button does nothing when clicked');
      await page.locator('#tdoc-feedback-root .tdoc-popup button.submit').click();
      await page.locator('#tdoc-feedback-root .tdoc-pin').first().waitFor({ timeout: 5000 });
      const slug = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).slug, `tdoc-feedback:${tdocBase}`);
      const comments = JSON.parse(fs.readFileSync(path.join(root, slug, 'comments.json'), 'utf8'));
      assert(comments.length === 1, `expected 1 comment, got ${comments.length}`);
      assert(comments[0].anchor.kind === 'product', 'anchor is not a product anchor');
      assert(comments[0].anchor.url === `${appBase}/dashboard`, `anchor url ${comments[0].anchor.url}`);
      assert(comments[0].anchor.selector === '#invite', `anchor selector ${comments[0].anchor.selector}`);
      assert(comments[0].author.login === 'julie', 'comment is not attributed to the signed-in person');
    });

    await test('the pin opens the native comment card', async () => {
      await page.locator('#tdoc-feedback-root .tdoc-pin').first().click();
      await page.locator('#tdoc-feedback-root .tdoc-margin-comment').waitFor({ timeout: 5000 });
      const text = await page.locator('#tdoc-feedback-root .tdoc-margin-comment').innerText();
      assert(text.includes('This button does nothing'), 'card does not show the comment');
    });

    await test('the comment shows on the feedback space doc', async () => {
      const slug = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).slug, `tdoc-feedback:${tdocBase}`);
      const doc = await context.newPage();
      await doc.goto(`${tdocBase}/d/${slug}/v/1`);
      await doc.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 8000 });
      const body = await doc.evaluate(() => document.body.innerText);
      assert(body.includes('Feedback ·'), 'doc title is not the feedback space');
      const cards = await doc.locator('[data-comment-id]').count();
      const pins = await doc.locator('.tdoc-pin').count();
      assert(cards + pins >= 1, 'comment is not visible on the doc');
      await doc.close();
    });

    await test('a reload keeps the session: pins and the dock come back, no popup needed', async () => {
      await page.reload();
      await page.addScriptTag({ url: `${tdocBase}/feedback.js` });
      await page.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor({ timeout: 5000 });
      await page.locator('#tdoc-feedback-root .tdoc-pin').first().waitFor({ timeout: 5000 });
      assert((await context.pages()).length === 1, 'a second popup opened');
    });

    // This local twin cannot notify (its session has no `notify`), which used
    // to hide the dock's Send to agent from the owner with no word why.
    await test('the owner keeps Send to agent with no notify: it opens the panel that says why and how to connect', async () => {
      const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `tdoc-feedback:${tdocBase}`);
      assert(!stored.notify, 'fixture: the local session is expected to lack notify');
      const send = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.tdoc-fb-send');
      await send.waitFor({ timeout: 5000 });
      assert((await send.getAttribute('aria-label')) === 'Send to agent', 'dock Send button is not named');
      await send.click();
      const dialog = page.getByRole('dialog', { name: 'Send to agent' });
      try {
        await dialog.getByText('Notify is not available on this host yet.').waitFor({ timeout: 5000 })
          .catch(async () => { throw new Error(`no explanation: ${await dialog.innerText().catch(() => '(no dialog)')}`); });
        await dialog.getByRole('button', { name: 'Close' }).click();
        await dialog.waitFor({ state: 'detached', timeout: 5000 });
      } finally {
        if (await dialog.count()) await page.keyboard.press('Escape');
      }

      // A host that can notify but has no agent: the connect path, with
      // links to tdoc (not to a path on the app).
      const host = await context.newPage();
      try {
        const cors = { 'access-control-allow-origin': appBase, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, OPTIONS' };
        await host.goto(`${appBase}/dashboard`);
        await host.evaluate((key) => {
          const session = JSON.parse(localStorage.getItem(key));
          localStorage.setItem(key, JSON.stringify({ ...session, notify: true }));
        }, `tdoc-feedback:${tdocBase}`);
        await host.route('**/api/feedback/session', async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify({ ...(await response.json()), notify: true }) });
        });
        await host.route('**/api/notify/**', (route) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
          body: JSON.stringify(route.request().url().includes('/targets') ? { default: null, candidates: [], fallback: null, reason: null } : { handoffs: [] }) }));
        await host.addScriptTag({ url: `${tdocBase}/feedback.js` });
        await host.waitForFunction(() => Boolean(window.tdocFeedback));
        await host.evaluate(() => window.tdocFeedback.open());
        await host.locator('#tdoc-feedback-root .tdoc-feedback-dock button.tdoc-fb-send').click();
        const connectView = host.getByRole('dialog', { name: 'Connect an agent' });
        await connectView.getByText('bin/tdoc-connect-agent').first().waitFor({ timeout: 5000 })
          .catch(async () => { throw new Error(`no connect view: ${await host.getByRole('dialog').first().innerText().catch(() => '(no dialog)')}`); });
        const settings = await connectView.getByRole('link', { name: 'workspace settings' }).getAttribute('href');
        assert(settings === `${tdocBase}/me?view=settings#agents`, `settings link points at ${settings}`);
      } finally {
        // The stored session is shared with the main page: put it back.
        await host.evaluate((key) => {
          const { notify, ...session } = JSON.parse(localStorage.getItem(key));
          localStorage.setItem(key, JSON.stringify(session));
        }, `tdoc-feedback:${tdocBase}`).catch(() => {});
        await host.close();
      }
    });

    // Share is in the dock for everyone, on a phone too: it opens the
    // space's page on tdoc with the doc Share dialog open (?share=1), where
    // people are invited and the owner moves the space into a team.
    await test('the dock has Share: it opens the space page with Share open, and fits at 390, 430 and 1440', async () => {
      for (const width of [390, 430, 1440]) {
        const host = await context.newPage();
        try {
          await host.setViewportSize({ width, height: 800 });
          await host.route('**/api/feedback/session', async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify({ ...body, share_url: `${tdocBase}/d/${body.slug}?share=1` }) });
          });
          await host.goto(`${appBase}/dashboard`);
          await host.addScriptTag({ url: `${tdocBase}/feedback.js` });
          await host.waitForFunction(() => Boolean(window.tdocFeedback));
          await host.evaluate(() => window.tdocFeedback.open());
          // The list opens first when there are comments; on a phone it
          // covers the dock until it is closed.
          const closeList = host.locator('#tdoc-feedback-root .tdoc-fb-panel button[aria-label="Close list"]');
          await closeList.waitFor({ timeout: 3000 }).catch(() => {});
          if (await closeList.count()) await closeList.click();
          await host.locator('#tdoc-feedback-root .tdoc-fb-panel').waitFor({ state: 'detached', timeout: 5000 });
          const share = host.locator('#tdoc-feedback-root .tdoc-feedback-dock a.tdoc-fb-share');
          await share.waitFor({ timeout: 5000 });
          assert((await share.getAttribute('aria-label')) === 'Share', 'Share is not named');
          // The word shows on a desktop; a phone has the icon, as Send to agent.
          assert((await share.innerText()).trim() === (width > 700 ? 'Share' : ''), `label at ${width}: ${await share.innerText()}`);
          assert(/^Invite people/.test(await share.getAttribute('title')), 'Share does not say it invites');
          const slug = await host.evaluate((key) => JSON.parse(localStorage.getItem(key)).slug, `tdoc-feedback:${tdocBase}`);
          assert((await share.getAttribute('href')) === `${tdocBase}/d/${slug}?share=1`, `href ${await share.getAttribute('href')}`);
          assert((await share.getAttribute('target')) === '_blank', 'Share navigates the app away');
          const dock = await share.evaluate((el) => { const r = el.closest('.tdoc-feedback-dock').getBoundingClientRect(); return { x: r.x, width: r.width }; });
          assert(dock && dock.x >= 0 && dock.x + dock.width <= width, `dock off screen at ${width}: ${JSON.stringify(dock)}`);
          const box = await share.boundingBox();
          assert(box && box.x >= 0 && box.x + box.width <= width, `Share off screen at ${width}: ${JSON.stringify(box)}`);
          if (process.env.TDOC_UI_SHOTS) await host.screenshot({ path: path.join(process.env.TDOC_UI_SHOTS, `widget-dock-${width}.png`) });
        } finally {
          await host.close();
        }
      }
    });

    await test('browsing leaves the app clickable; only + Comment takes over clicks', async () => {
      await page.evaluate(() => { window.__clicked = 0; document.getElementById('invite').addEventListener('click', () => { window.__clicked += 1; }); });
      await page.locator('#invite').click();
      assert((await page.evaluate(() => window.__clicked)) === 1, 'a click on the app was swallowed while browsing');
      assert((await page.locator('#tdoc-feedback-root .tdoc-popup textarea, #tdoc-feedback-root .tdoc-popup [contenteditable]').count()) === 0, 'browsing opened a composer');
      await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary').click();
      const banner = page.locator('#tdoc-feedback-root .tdoc-fb-banner');
      await banner.waitFor({ timeout: 3000 });
      const feedbackWins = await page.evaluate(() => {
        const banner = window.__fb('.tdoc-fb-banner');
        const r = banner.getBoundingClientRect();
        const nav = document.querySelector('nav');
        return {
          overlaps: r.top < nav.getBoundingClientRect().bottom,
          rootZ: Number(getComputedStyle(document.getElementById('tdoc-feedback-root')).zIndex),
          navZ: Number(getComputedStyle(nav).zIndex),
        };
      });
      assert(feedbackWins.overlaps && feedbackWins.rootZ > feedbackWins.navZ,
        `feedback chrome is not above the host top bar: ${JSON.stringify(feedbackWins)}`);
      await page.locator('#invite').click({ force: true });
      assert((await page.evaluate(() => window.__clicked)) === 1, 'picking let the click through to the app');
      await page.locator('#tdoc-feedback-root .tdoc-popup textarea, #tdoc-feedback-root .tdoc-popup [contenteditable]').first().waitFor({ timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });

    await test('the list shows every comment on the app and opens its card', async () => {
      const before = await page.evaluate(() => ({
        marginRight: document.documentElement.style.marginRight,
        main: document.querySelector('main').getBoundingClientRect().toJSON(),
      }));
      await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
      const panel = page.locator('#tdoc-feedback-root .tdoc-fb-panel');
      await panel.waitFor({ timeout: 3000 });
      await page.waitForTimeout(200);
      const overlay = await page.evaluate(() => {
        const panel = window.__fb('.tdoc-fb-panel');
        const p = panel.getBoundingClientRect();
        const m = document.querySelector('main').getBoundingClientRect();
        return {
          marginRight: document.documentElement.style.marginRight,
          main: m.toJSON(), panel: p.toJSON(),
          topRightIsPanel: Boolean(document.getElementById('tdoc-feedback-root').shadowRoot.elementFromPoint(innerWidth - 8, 8)?.closest('.tdoc-fb-panel')),
        };
      });
      assert(overlay.marginRight === before.marginRight && overlay.main.left === before.main.left && overlay.main.width === before.main.width,
        `feedback list shifted the host app: ${JSON.stringify({ before, overlay })}`);
      assert(overlay.panel.top === 0 && overlay.panel.right === 1200 && overlay.topRightIsPanel,
        `feedback list is not a top-layer right overlay: ${JSON.stringify(overlay)}`);
      // The header wraps instead of overflowing: the close button is inside
      // the viewport and is what a click there hits.
      const close = await page.evaluate(() => {
        const x = window.__fb('.tdoc-fb-panel .x');
        const r = x.getBoundingClientRect();
        return { r: r.toJSON(), vw: document.documentElement.clientWidth, hit: document.getElementById('tdoc-feedback-root').shadowRoot.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === x };
      });
      assert(close.r.right <= close.vw && close.r.left >= 0 && close.hit, `panel close button is cut off or covered: ${JSON.stringify(close)}`);
      // The composer stacks above the panel.
      const order = await page.evaluate(() => {
        const z = (sel) => Number(getComputedStyle(window.__fb(sel) || document.body).zIndex) || 0;
        const probe = document.createElement('div'); probe.className = 'tdoc-popup'; window.__fbRoot().appendChild(probe);
        const out = { popup: Number(getComputedStyle(probe).zIndex), panel: z('.tdoc-fb-panel') };
        probe.remove(); return out;
      });
      assert(order.popup > order.panel, `composer is under the comments panel: ${JSON.stringify(order)}`);
      const items = page.locator('#tdoc-feedback-root .tdoc-fb-item');
      assert((await items.count()) >= 1, 'list is empty');
      assert((await items.first().innerText()).includes('This button does nothing'), 'list item lacks the comment');
      await items.first().click();
      await page.locator('#tdoc-feedback-root .tdoc-margin-comment').waitFor({ timeout: 3000 });
    });

    await test('Refresh fetches a new comment without reloading the app', async () => {
      const session = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `tdoc-feedback:${tdocBase}`);
      const response = await context.request.post(`${tdocBase}/api/comments`, {
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        data: {
          slug: session.slug,
          version: session.version,
          text: 'Appeared without a page reload',
          anchor: { kind: 'product', url: `${appBase}/dashboard`, selector: '#invite', text: 'Send invite' },
        },
      });
      assert(response.ok(), `external comment failed: ${response.status()}`);
      const panel = page.locator('#tdoc-feedback-root .tdoc-fb-panel');
      if (!(await panel.isVisible())) await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
      await page.getByRole('button', { name: 'Refresh feedback' }).click();
      await page.getByText('Appeared without a page reload').waitFor({ timeout: 3000 });
    });

    await test('a comment on a modal remembers the dialog and comes back when it reopens', async () => {
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Team settings');
        d.style.cssText = 'position:fixed;top:120px;left:200px;padding:24px;background:#fff;border:1px solid #ccc;z-index:10';
        d.innerHTML = '<button id="save">Save</button>';
        document.body.appendChild(d);
      });
      await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary').click();
      await page.locator('#save').click({ force: true });
      const c = page.locator('#tdoc-feedback-root .tdoc-popup textarea, #tdoc-feedback-root .tdoc-popup [contenteditable]');
      await c.first().fill('Save is disabled');
      const countBeforeSave = await page.locator('#tdoc-feedback-root .tdoc-pin').count();
      await page.locator('#tdoc-feedback-root .tdoc-popup button.submit').last().click();
      await page.waitForFunction((n) => window.__fbAll('.tdoc-pin').length > n, countBeforeSave);
      const slug = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).slug, `tdoc-feedback:${tdocBase}`);
      const comments = JSON.parse(fs.readFileSync(path.join(root, slug, 'comments.json'), 'utf8'));
      const onModal = comments.find((x) => x.text === 'Save is disabled');
      assert(onModal && onModal.anchor.state && onModal.anchor.state.dialog === 'Team settings', `state not recorded: ${JSON.stringify(onModal && onModal.anchor.state)}`);
      const before = await page.locator('#tdoc-feedback-root .tdoc-pin').count();
      const saved = await page.evaluate(() => {
        const m = document.getElementById('modal');
        const copy = m.cloneNode(true);
        // The feedback host lives inside an open modal so capture-phase
        // outside-press handlers see its controls as part of the modal. It is
        // a live app root, not part of the modal's saved HTML.
        copy.querySelector('#tdoc-feedback-root')?.remove();
        const html = copy.outerHTML;
        m.remove();
        return html;
      });
      await page.waitForFunction((n) => window.__fbAll('.tdoc-pin').length === n - 1, before);
      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), saved);
      await page.waitForFunction((n) => window.__fbAll('.tdoc-pin').length === n, before);
      await page.evaluate(() => document.getElementById('modal').remove());
      await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
    });

    await test('a native modal <dialog> can be commented on; the layer goes back when it closes', async () => {
      await page.evaluate(() => {
        const d = document.createElement('dialog'); d.id = 'nd';
        d.innerHTML = '<h2>Share this doc</h2><button id="nd-done">Done</button>';
        document.body.appendChild(d); d.showModal();
      });
      await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'nd');
      const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
      if (!(await pick.evaluate((b) => b.classList.contains('on')))) await pick.click();
      await page.locator('#nd h2').click({ force: true });
      const c = page.locator('#tdoc-feedback-root .tdoc-popup textarea, #tdoc-feedback-root .tdoc-popup [contenteditable]').first();
      await c.click();
      await page.keyboard.type('Share title is vague');
      assert((await c.inputValue().catch(() => c.innerText())).includes('Share title is vague'), 'typing in the composer over a modal failed');
      await page.keyboard.press('Escape');
      await page.evaluate(() => { const d = document.getElementById('nd'); if (d.open) d.close(); d.remove(); });
      await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
      // Leave the dock as the next case expects it: not picking.
      if (await pick.evaluate((b) => b.classList.contains('on'))) await pick.click();
    });

    await test('a transformed, clipped modal <dialog> does not shrink the layer; removing it without close brings the layer back', async () => {
      const dockAt = () => page.evaluate(() => { const b = window.__fb('.tdoc-feedback-dock').getBoundingClientRect(); return [b.x, b.y, b.width, b.height].join(); });
      const dockBefore = await dockAt();
      await page.evaluate(() => {
        const d = document.createElement('dialog'); d.id = 'td';
        d.style.cssText = 'position:fixed;left:50%;top:50%;margin:0;transform:translate(-50%,-50%);overflow:hidden;width:420px;padding:24px';
        d.innerHTML = '<h2>Transformed share</h2><button>Done</button>';
        document.body.appendChild(d); d.showModal();
      });
      await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'td');
      const layout = await page.evaluate(() => {
        const r = document.getElementById('tdoc-feedback-root').getBoundingClientRect();
        const dock = window.__fb('.tdoc-feedback-dock').getBoundingClientRect();
        const hit = document.getElementById('tdoc-feedback-root').shadowRoot.elementFromPoint(dock.x + dock.width / 2, dock.y + dock.height / 2);
        return { r: [r.x, r.y, r.width, r.height], vw: innerWidth, vh: innerHeight, dockHit: Boolean(hit && hit.closest('#tdoc-feedback-root')) };
      });
      assert(layout.r[0] === 0 && layout.r[1] === 0 && layout.r[2] === layout.vw && layout.r[3] === layout.vh, `layer shrank to the dialog: ${layout.r}`);
      assert(layout.dockHit && (await dockAt()) === dockBefore, `dock moved or is covered inside the dialog: ${JSON.stringify(layout)} vs ${dockBefore}`);
      const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
      if (!(await pick.evaluate((b) => b.classList.contains('on')))) await pick.click();
      await page.locator('#td h2').click({ force: true });
      const c = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
      await c.click();
      await page.keyboard.type('Heading is vague');
      assert((await c.inputValue()) === 'Heading is vague', 'typing in the composer over a transformed modal failed');
      // A React unmount: gone from the DOM, no close event.
      await page.evaluate(() => document.getElementById('td').remove());
      await page.waitForFunction(() => {
        const host = document.getElementById('tdoc-feedback-root');
        return host && host.parentElement === document.documentElement && !host.hasAttribute('popover');
      });
      assert(await page.locator('#tdoc-feedback-root .tdoc-feedback-dock').isVisible(), 'the dock did not come back');
      await page.keyboard.press('Escape');
      if (await pick.evaluate((b) => b.classList.contains('on'))) await pick.click();
    });

    await test('a transformed, clipped script modal keeps the feedback layer at viewport size', async () => {
      await page.evaluate(() => {
        const modal = document.createElement('div');
        modal.id = 'transformed-script-modal';
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'position:fixed;left:50%;top:50%;width:440px;height:142px;transform:translate(-50%,-50%);filter:blur(0);overflow:hidden;background:white;z-index:100';
        modal.innerHTML = '<h2 id="transformed-target">Comment on this panel</h2><button id="transformed-action">Host action</button>';
        document.body.appendChild(modal);
        window.__transformedAction = 0;
        modal.querySelector('button').onclick = () => window.__transformedAction++;
      });
      try {
        await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'transformed-script-modal');
        const bounds = await page.evaluate(() => {
          const host = document.getElementById('tdoc-feedback-root');
          const r = host.getBoundingClientRect();
          const dock = window.__fb('.tdoc-feedback-dock').getBoundingClientRect();
          return { host: [r.x, r.y, r.width, r.height], viewport: [innerWidth, innerHeight], dock: dock.toJSON(), popover: host.matches(':popover-open') };
        });
        assert(bounds.popover && bounds.host.join() === [0, 0, ...bounds.viewport].join(), `script modal clipped feedback: ${JSON.stringify(bounds)}`);
        assert(bounds.dock.right <= bounds.viewport[0] && bounds.dock.bottom <= bounds.viewport[1], `dock left viewport: ${JSON.stringify(bounds)}`);
        await page.locator('#transformed-action').click();
        assert(await page.evaluate(() => window.__transformedAction === 1), 'feedback layer blocked a host modal button');
        const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
        if (!(await pick.evaluate((button) => button.classList.contains('on')))) await pick.click();
        await page.locator('#transformed-target').click({ force: true });
        const composer = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await composer.fill('The modal heading needs context');
        assert(await composer.inputValue() === 'The modal heading needs context', 'composer clipped by transformed script modal');
      } finally {
        await page.evaluate(() => document.getElementById('transformed-script-modal')?.remove());
        await page.keyboard.press('Escape');
        const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
        if (await pick.evaluate((button) => button.classList.contains('on'))) await pick.click();
      }
      await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
    });

    await test('a script modal with a focus trap and Escape/outside-press dismissal stays open while you comment on it', async () => {
      // How Radix and Headless UI behave: focus leaving the dialog is pulled
      // back, Escape and a press outside close it.
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'sm'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
        d.style.cssText = 'position:fixed;top:120px;left:200px;padding:24px;background:#fff;border:1px solid #ccc;z-index:10';
        d.innerHTML = '<h2>Share with team</h2><input id="sm-email" value="a@b.c">';
        document.body.appendChild(d);
        const close = () => { window.__smClosed = true; d.remove(); };
        document.addEventListener('focusout', (e) => { if (d.isConnected && e.relatedTarget && !d.contains(e.relatedTarget)) d.querySelector('input').focus(); });
        document.addEventListener('focusin', (e) => { if (d.isConnected && !d.contains(e.target)) d.querySelector('input').focus(); });
        document.addEventListener('keydown', (e) => { if (d.isConnected && e.key === 'Escape') close(); }, true);
        document.addEventListener('pointerdown', (e) => { if (d.isConnected && !d.contains(e.target)) close(); });
        d.querySelector('input').focus();
      });
      await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary').click();
      await page.locator('#sm h2').click({ force: true });
      const c = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
      await c.click();
      await page.keyboard.type('Say who gets access');
      assert((await c.inputValue()) === 'Say who gets access', `typing was pulled back into the dialog (active: ${await page.evaluate(() => document.activeElement.id || document.activeElement.nodeName)})`);
      await page.keyboard.press('Escape');
      await page.locator('#tdoc-feedback-root .tdoc-popup').waitFor({ state: 'detached' });
      assert(await page.evaluate(() => !window.__smClosed && Boolean(document.getElementById('sm'))), 'the dialog closed while commenting on it');
      await page.evaluate(() => document.getElementById('sm').remove());
      const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
      if (await pick.evaluate((b) => b.classList.contains('on'))) await pick.click();
    });

    await test('a modal whose outside-press boundary is its nested panel stays open through commenting', async () => {
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'capture-modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
        d.style.cssText = 'position:fixed;top:120px;left:200px;padding:24px;background:#fff;border:1px solid #ccc;z-index:100';
        d.innerHTML = '<div id="custom-billing-panel" data-headlessui-state="open"><h2>Billing settings</h2><input value="Example"></div>';
        document.body.appendChild(d);
        window.__captureModalClosed = false;
        window.__captureModalOutside = (e) => {
          // Headless UI checks the panel, not its role=dialog wrapper.
          if (!d.isConnected || d.querySelector('#custom-billing-panel').contains(e.target)) return;
          window.__captureModalClosed = true;
          d.remove();
        };
        // Modal libraries can decide that a press is outside during capture,
        // before the feedback host's bubble listeners get a chance to stop it.
        document.addEventListener('pointerdown', window.__captureModalOutside, true);
        document.addEventListener('focusin', window.__captureModalOutside, true);
      });
      try {
        const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
        if (!(await pick.evaluate((b) => b.classList.contains('on')))) await pick.click();
        assert(await page.locator('#capture-modal').isVisible(), 'opening feedback closed the modal');
        await page.locator('#capture-modal h2').click({ force: true });
        const c = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await c.fill('Show the billing period');
        assert(await page.locator('#capture-modal').isVisible(), 'typing in feedback closed the modal');
        await page.locator('#tdoc-feedback-root .tdoc-popup button.submit').click();
        assert(await page.locator('#capture-modal').isVisible(), 'posting feedback closed the modal');
        assert(!await page.evaluate(() => window.__captureModalClosed), 'the outside handler ran on feedback UI');
      } finally {
        await page.evaluate(() => {
          document.removeEventListener('pointerdown', window.__captureModalOutside, true);
          document.removeEventListener('focusin', window.__captureModalOutside, true);
          document.getElementById('capture-modal')?.remove();
        });
      }
    });

    await test('hidden mounted dialogs and non-modal popovers never capture feedback; hidden ancestors release it', async () => {
      await page.evaluate(() => {
        const popover = document.createElement('div');
        popover.id = 'nonmodal-popover'; popover.setAttribute('role', 'dialog');
        popover.innerHTML = '<input id="popover-input">';
        document.body.appendChild(popover);
        const wrapper = document.createElement('div');
        wrapper.id = 'modal-wrapper';
        wrapper.innerHTML = '<div id="active-modal" role="dialog" aria-modal="true"><input id="modal-input"></div>';
        document.body.appendChild(wrapper);
        const hidden = document.createElement('div');
        hidden.id = 'mounted-modal'; hidden.setAttribute('role', 'dialog'); hidden.setAttribute('aria-modal', 'true');
        hidden.style.visibility = 'hidden';
        document.body.appendChild(hidden);
        const faded = document.createElement('div');
        faded.id = 'faded-modal'; faded.setAttribute('role', 'dialog'); faded.setAttribute('aria-modal', 'true');
        faded.style.cssText = 'position:fixed;left:20px;top:20px;opacity:0;pointer-events:none';
        document.body.appendChild(faded);
      });
      try {
        await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'active-modal');
        await page.locator('#popover-input').focus();
        assert(await page.evaluate(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'active-modal'), 'non-modal dialog stole feedback');
        await page.evaluate(() => { document.getElementById('modal-wrapper').hidden = true; });
        await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
        assert(await page.locator('#tdoc-feedback-root .tdoc-feedback-dock').isVisible(), 'feedback disappeared with hidden wrapper');
        await page.evaluate(() => { document.getElementById('faded-modal').style.cssText = 'position:fixed;left:20px;top:20px;opacity:1;pointer-events:auto'; });
        await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'faded-modal');
        await page.evaluate(() => { document.getElementById('faded-modal').style.opacity = '0'; });
        await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
        await page.evaluate(() => { document.getElementById('modal-wrapper').hidden = false; });
        await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'active-modal');
      } finally {
        await page.evaluate(() => {
          document.getElementById('modal-wrapper')?.remove();
          document.getElementById('mounted-modal')?.remove();
          document.getElementById('faded-modal')?.remove();
          document.getElementById('nonmodal-popover')?.remove();
        });
      }
      await page.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
    });

    await test('feedback clicks and typing do not trigger host modal handlers', async () => {
      await page.evaluate(() => {
        const modal = document.createElement('div');
        modal.id = 'event-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
        modal.innerHTML = '<h2 id="event-target">Comment here</h2>';
        document.body.appendChild(modal);
        window.__feedbackLeaked = { click: 0, keydown: 0, input: 0 };
        for (const kind of Object.keys(window.__feedbackLeaked)) modal.addEventListener(kind, () => window.__feedbackLeaked[kind]++);
      });
      try {
        const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
        await pick.click(); // also clears any composer left by the previous case
        if (!(await pick.evaluate((b) => b.classList.contains('on')))) await pick.click();
        await page.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
        await page.locator('#event-target').click({ force: true });
        const textarea = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        const debugState = await page.evaluate(() => ({ parent: document.getElementById('tdoc-feedback-root').parentElement.id, picking: window.__fb('.tdoc-feedback-dock button.primary')?.className, banner: !!window.__fb('.tdoc-fb-banner'), selected: !!window.__fb('.tdoc-popup') }));
        assert(debugState.selected, `click did not open composer: ${JSON.stringify(debugState)}`);
        await textarea.fill('Keep modal events local');
        await textarea.press('Enter');
        await page.locator('#tdoc-feedback-root .tdoc-popup button.submit').click();
        const leaked = await page.evaluate(() => window.__feedbackLeaked);
        assert(Object.values(leaked).every((count) => count === 0), `host modal received feedback events: ${JSON.stringify(leaked)}`);
      } finally {
        await page.evaluate(() => document.getElementById('event-modal')?.remove());
      }
    });

    await test('host modal CSS cannot restyle feedback controls', async () => {
      const foreign = await context.newPage();
      try {
        await foreign.goto(appBase);
        await foreign.addScriptTag({ url: `${tdocBase}/feedback.js` });
        await foreign.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor();
        await foreign.evaluate(() => {
          const style = document.createElement('style');
          style.textContent = '[role="dialog"] * { font-family: fantasy !important; color: rgb(244, 0, 0) !important; text-transform: uppercase !important; direction: rtl !important; line-height: 7 !important; letter-spacing: 12px !important; word-spacing: 14px !important; white-space: nowrap !important; }';
          document.head.appendChild(style);
          const modal = document.createElement('div');
          modal.id = 'css-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
          modal.innerHTML = '<h2>Appearance</h2>';
          document.body.appendChild(modal);
        });
        await foreign.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'css-modal');
        const styles = await foreign.evaluate(() => {
          const host = document.getElementById('tdoc-feedback-root');
          const root = window.__fbRoot();
          const button = window.__fb('.tdoc-feedback-dock button');
          const css = getComputedStyle(button);
          const hostStyle = getComputedStyle(host);
          return { accent: getComputedStyle(root).getPropertyValue('--td-accent').trim(), hostFont: hostStyle.fontFamily,
            hostLineHeight: hostStyle.lineHeight, letterSpacing: hostStyle.letterSpacing, wordSpacing: hostStyle.wordSpacing,
            whiteSpace: hostStyle.whiteSpace, font: css.fontFamily, color: css.color, transform: css.textTransform, direction: css.direction, lineHeight: css.lineHeight };
        });
        assert(styles.accent === '#1652f0' && !styles.hostFont.includes('fantasy') && !styles.font.includes('fantasy')
          && styles.color !== 'rgb(244, 0, 0)' && styles.transform !== 'uppercase' && styles.direction === 'ltr'
          && styles.lineHeight !== '7' && styles.hostLineHeight !== '7' && styles.letterSpacing === 'normal'
          && (styles.wordSpacing === 'normal' || styles.wordSpacing === '0px') && styles.whiteSpace === 'normal',
          `host CSS or missing tokens changed feedback: ${JSON.stringify(styles)}`);
        const pick = foreign.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
        if (!(await pick.evaluate((button) => button.classList.contains('on')))) await pick.click();
        await foreign.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
        await foreign.locator('#css-modal h2').click({ force: true });
        const accent = await foreign.evaluate(() => ({
          button: getComputedStyle(window.__fb('.tdoc-popup button.submit')).backgroundColor,
          textarea: getComputedStyle(window.__fb('.tdoc-popup textarea')).borderTopColor,
        }));
        assert(accent.button === 'rgb(22, 82, 240)' && accent.textarea === 'rgb(22, 82, 240)',
          `comment controls lost their accent on a foreign page: ${JSON.stringify(accent)}`);
      } finally {
        await foreign.close();
      }
    });

    await test("tdoc's own Base UI dialog on My docs can be commented on: it stays open, the composer keeps the typing", async () => {
      const slug = 'quarterly-plan';
      fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
      fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), '<!doctype html><title>Quarterly plan</title><h1>Quarterly plan</h1>');
      fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: 'Quarterly plan', versions: [{ n: 1, created: new Date().toISOString() }] }));
      fs.writeFileSync(path.join(root, slug, 'comments.json'), '[]');
      const me = await context.newPage();
      const errors = [];
      me.on('pageerror', (error) => errors.push(error.message));
      try {
        await me.goto(`${tdocBase}/me`);
        await me.getByText('Quarterly plan').first().hover();
        await me.locator('button[aria-label="More actions"]').last().click({ force: true });
        await me.getByRole('menuitem', { name: /rename/i }).click();
        const dialog = me.locator('.ui-dialog-popup');
        await dialog.waitFor();
        await me.evaluate((src) => {
          const s = document.createElement('script');
          s.src = src; s.setAttribute('data-tdoc-open', '1');
          document.documentElement.appendChild(s);
        }, `${tdocBase}/feedback.js`);
        await me.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor();
        const pick = me.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
        if (!(await pick.evaluate((b) => b.classList.contains('on')))) await pick.click();
        // The dialog uses the same classes as the layer's own dialogs; it is
        // still the page, so a click on it starts a comment.
        await dialog.locator('h3').click({ force: true });
        const c = me.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await c.waitFor({ timeout: 4000 });
        await c.click();
        await me.keyboard.type('Rename title is vague');
        assert((await c.inputValue()) === 'Rename title is vague', 'typing in the composer over the Rename dialog failed');
        assert(await dialog.isVisible(), 'the Rename dialog closed when the composer took focus');
        await me.keyboard.press('Escape');
        await me.locator('#tdoc-feedback-root .tdoc-popup').waitFor({ state: 'detached' });
        assert(await dialog.isVisible(), 'Escape in the composer also closed the Rename dialog');
        await dialog.locator('h3').click({ force: true });
        await c.waitFor();
        await c.fill('Rename title is vague');
        await me.locator('#tdoc-feedback-root .tdoc-popup button.submit').click();
        await me.locator('#tdoc-feedback-root .tdoc-pin').first().waitFor({ timeout: 5000 });
        assert(await dialog.isVisible(), 'posting the comment closed the Rename dialog');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
        assert(await me.locator('#tdoc-feedback-root .tdoc-feedback-dock').isVisible(), 'the dock went away with the dialog');
        for (const width of [1512, 650, 390]) {
          await me.setViewportSize({ width, height: 823 });
          await me.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
          const panel = me.locator('#tdoc-feedback-root .tdoc-fb-panel');
          await panel.waitFor();
          await me.waitForTimeout(200); // let the slide-in clip-path finish
          const layout = await me.evaluate(() => {
            const panel = document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-fb-panel');
            const close = panel.querySelector('button.x');
            const r = panel.getBoundingClientRect();
            const x = close.getBoundingClientRect();
            return {
              panel: r.toJSON(), close: x.toJSON(), vw: innerWidth,
              closeHit: document.getElementById('tdoc-feedback-root').shadowRoot.elementFromPoint(x.x + x.width / 2, x.y + x.height / 2) === close,
            };
          });
          assert(layout.panel.right === width && layout.panel.left === (width <= 700 ? 0 : width - 340)
            && layout.close.right <= width && layout.closeHit,
          `feedback panel is clipped or under the top bar at ${width}px: ${JSON.stringify(layout)}`);
          await me.screenshot({ path: path.join(os.tmpdir(), `tdoc-feedback-panel-${width}.png`) });
          await panel.locator('.tdoc-fb-add').click();
          await panel.waitFor({ state: 'detached' });
          await me.locator('h1').first().click({ force: true });
          const composer = me.locator('#tdoc-feedback-root .tdoc-popup');
          await composer.waitFor();
          const box = await composer.boundingBox();
          const heading = await me.locator('h1').first().boundingBox();
          assert(box.x >= 0 && box.x + box.width <= width && box.y >= 48 && box.y + box.height <= 823,
            `feedback composer is offscreen or behind the top bar at ${width}px: ${JSON.stringify(box)}`);
          assert(Math.abs(box.y - (heading.y + heading.height + 8)) < 2,
            `feedback composer retained the document shell's 48px offset at ${width}px: ${JSON.stringify({ box, heading })}`);
          await me.screenshot({ path: path.join(os.tmpdir(), `tdoc-feedback-composer-${width}.png`) });
          await me.keyboard.press('Escape');
          await composer.waitFor({ state: 'detached' });
          const pick = me.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
          if (await pick.evaluate((b) => b.classList.contains('on'))) await pick.click();
        }
        assert(errors.length === 0, errors.join('\n'));
      } finally {
        await me.close();
      }
    });

    await test('a comment follows its element when the page is rebuilt with a card above it', async () => {
      await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary').click();
      const heading = page.locator('main > section.card h2', { hasText: 'Weekly active users' });
      await heading.click({ force: true });
      const c = page.locator('#tdoc-feedback-root .tdoc-popup textarea, #tdoc-feedback-root .tdoc-popup [contenteditable]');
      await c.first().fill('Rename this metric');
      await page.locator('#tdoc-feedback-root .tdoc-popup button.submit').last().click();
      await page.waitForTimeout(600);
      // The app re-renders with a new card first: the positional selector
      // now names a different heading.
      await page.evaluate(() => {
        const s = document.createElement('section'); s.className = 'card'; s.innerHTML = '<h2>Announcements</h2><p>new</p>';
        document.querySelector('main section.card').before(s);
      });
      await page.waitForTimeout(500);
      const target = await page.locator('main h2', { hasText: 'Weekly active users' }).boundingBox();
      const pins = await page.locator('#tdoc-feedback-root .tdoc-pin').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
      assert(pins.some((top) => Math.abs(top + 14 - target.y) < 6), `no pin next to the moved heading (heading y=${target.y}, pins ${pins})`);
    });

    await test('opening the comment list keeps a half-written comment', async () => {
      const pick = page.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
      if (!(await pick.evaluate((button) => button.classList.contains('on')))) await pick.click();
      await page.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
      await page.locator('main h2').first().click({ force: true });
      const draft = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
      await draft.fill('Please keep this draft');
      await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
      await page.locator('#tdoc-feedback-root .tdoc-fb-panel').waitFor();
      assert((await draft.inputValue()) === 'Please keep this draft', 'opening the list discarded the comment draft');
      await page.locator('#tdoc-feedback-root .tdoc-fb-panel button.x').click();
      await page.keyboard.press('Escape');
      if (await pick.evaluate((button) => button.classList.contains('on'))) await pick.click();
    });

    await test('real MUI, Radix, and Headless UI dialogs keep feedback usable and isolated', async () => {
      const libs = await context.newPage();
      const libraryErrors = [];
      libs.on('pageerror', (error) => libraryErrors.push(error.message));
      try {
        await libs.goto(`${appBase}/libraries`);
        await libs.addScriptTag({ url: `${tdocBase}/feedback.js` });
        const dock = libs.locator('#tdoc-feedback-root .tdoc-feedback-dock');
        await dock.waitFor({ timeout: 5000 });
        assert(await libs.evaluate(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement), 'closed MUI keepMounted dialog captured feedback');

        await libs.evaluate(() => {
          const banner = document.createElement('div');
          banner.id = 'cookie-banner'; banner.setAttribute('role', 'dialog'); banner.setAttribute('data-state', 'open');
          banner.setAttribute('aria-labelledby', 'cookie-title'); banner.setAttribute('aria-describedby', 'cookie-description');
          banner.innerHTML = '<h2 id="cookie-title">Cookie choices</h2><p id="cookie-description">Choose whether to allow cookies.</p>';
          document.body.appendChild(banner);
        });
        await libs.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert(await libs.evaluate(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement),
          'a nonmodal cookie banner captured feedback');
        await libs.evaluate(() => document.getElementById('cookie-banner').remove());

        await libs.locator('#popover-open').click();
        await libs.locator('#radix-popover').waitFor();
        assert(await libs.evaluate(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement), 'non-modal Radix Popover captured feedback');
        await libs.locator('#popover-open').click();

        await libs.locator('#mui-open').click();
        await libs.locator('#mui-target').waitFor();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.closest('[role="dialog"]'));
        const muiRoot = await libs.evaluate(() => document.getElementById('tdoc-feedback-root').parentElement.closest('.MuiDialog-root')?.className || '');
        assert(muiRoot, 'feedback did not follow the open MUI Dialog');
        await libs.evaluate(() => { document.querySelector('.MuiDialog-root').hidden = true; });
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
        await libs.evaluate(() => { document.querySelector('.MuiDialog-root').hidden = false; });
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.closest('.MuiDialog-root'));
        await libs.getByRole('button', { name: 'Close MUI' }).click();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);

        await libs.locator('#radix-open').click();
        await libs.locator('#radix-target').waitFor();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'radix-content', null, { timeout: 3000 });
        const pick = dock.locator('button.primary');
        await pick.click();
        await libs.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
        await libs.locator('#radix-target').click({ force: true });
        const radixDraft = libs.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await radixDraft.fill('Radix modal feedback');
        await radixDraft.press('Enter');
        await radixDraft.press('Meta+Enter');
        assert(await libs.evaluate(() => window.__libraryEvents.radixKeys === 0), 'feedback keys reached Radix dialog handler');
        assert(await libs.locator('#radix-content').isVisible(), 'feedback closed Radix dialog');
        await libs.getByRole('button', { name: 'Close Radix' }).click();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);

        await libs.locator('#radix-no-overlay-open').click();
        await libs.locator('#radix-no-overlay-target').waitFor();
        assert(await libs.evaluate(() => !document.body.hasAttribute('data-scroll-locked')),
          'Radix no-Overlay fixture unexpectedly locked body scrolling');
        assert(await libs.evaluate(() => document.body.style.pointerEvents === 'none'),
          'Radix no-Overlay fixture did not exercise modal pointer isolation');
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'radix-no-overlay-content');
        if (!(await pick.evaluate((button) => button.classList.contains('on')))) await pick.click();
        await libs.locator('#radix-no-overlay-target').click({ force: true });
        await libs.locator('#tdoc-feedback-root .tdoc-popup textarea').first().fill('Feedback on a dialog without an overlay');
        assert(await libs.locator('#radix-no-overlay-content').isVisible(), 'feedback closed a Radix Dialog without Overlay');
        await libs.locator('#tdoc-feedback-root .tdoc-popup button.submit').click();
        assert(await libs.locator('#radix-no-overlay-content').isVisible(), 'posting feedback closed a Radix Dialog without Overlay');
        await libs.getByRole('button', { name: 'Close Radix without Overlay' }).click();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);
        if (await pick.evaluate((button) => button.classList.contains('on'))) await pick.click();

        await libs.locator('#headless-open').click();
        await libs.locator('#custom-headless-panel[data-closed]').waitFor({ state: 'attached', timeout: 3000 });
        const entering = await libs.locator('#custom-headless-panel').evaluate((panel) => ({
          opacity: Number(getComputedStyle(panel).opacity), parent: document.getElementById('tdoc-feedback-root').parentElement.id,
        }));
        assert(entering.opacity === 0,
          `Headless UI fixture did not exercise transparent entry: ${JSON.stringify(entering)}`);
        await libs.locator('#headless-target').waitFor();
        await libs.waitForFunction(() => {
          const panel = document.getElementById('custom-headless-panel');
          return panel && panel.getAnimations().some((animation) => animation.playState === 'running')
            && Number(getComputedStyle(panel).opacity) < 0.8
            && document.getElementById('tdoc-feedback-root').parentElement === panel;
        }, null, { timeout: 3000 });
        await libs.evaluate(() => {
          window.__headlessEntryClick = null;
          document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-feedback-dock button.primary').addEventListener('pointerdown', () => {
            const panel = document.getElementById('custom-headless-panel');
            window.__headlessEntryClick = {
              opacity: Number(getComputedStyle(panel).opacity),
              inside: document.getElementById('tdoc-feedback-root').parentElement === panel,
            };
          }, { once: true });
        });
        await pick.click({ force: true });
        const entryClick = await libs.evaluate(() => window.__headlessEntryClick);
        assert(entryClick && entryClick.opacity < 1 && entryClick.inside,
          `feedback was not inside the Headless UI panel during entry: ${JSON.stringify(entryClick)}`);
        assert(await libs.locator('#custom-headless-panel').isVisible(), 'clicking feedback during Headless UI entry closed the dialog');
        await libs.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
        await libs.locator('#headless-target').click({ force: true });
        const headlessDraft = libs.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await headlessDraft.fill('Headless modal feedback');
        await headlessDraft.press('Enter');
        const events = await libs.evaluate(() => window.__libraryEvents);
        assert(events.headlessKeys === 0 && events.headlessSubmits === 0, `feedback events reached Headless UI form: ${JSON.stringify(events)}`);
        assert(await libs.locator('#custom-headless-panel').isVisible(), 'feedback closed Headless UI dialog');
        await libs.keyboard.press('Escape');
        await libs.keyboard.press('Escape');
        await libs.getByRole('button', { name: 'Close Headless UI' }).click();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root')?.parentElement === document.documentElement, null, { timeout: 3000 });
        assert(libraryErrors.length === 0, libraryErrors.join('\n'));
      } finally {
        await libs.close();
      }
    });

    // ---- Comment on an area (feedbackAreaSelect) and picking inside modals.
    // The libraries page has a canvas chart on the page and one in every kind
    // of modal; the flag is pinned on for these pages.
    const areaPage = async (width = 1200, height = 800) => {
      const p = await context.newPage();
      await p.setViewportSize({ width, height });
      await p.addInitScript(() => { window.__TDOC_FLAGS__ = { feedbackAreaSelect: true }; });
      p.on('pageerror', (error) => consoleErrors.push(error.message));
      await p.goto(`${appBase}/libraries`);
      await p.addScriptTag({ url: `${tdocBase}/feedback.js` });
      await p.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor({ timeout: 5000 });
      return p;
    };
    const boxOf = async (p, selector) => p.locator(selector).first().boundingBox();
    const mouseDrag = async (p, from, to, { alt = false, beforeUp = null } = {}) => {
      if (alt) await p.keyboard.down('Alt');
      await p.mouse.move(from[0], from[1]);
      await p.mouse.down();
      await p.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
      await p.mouse.move(to[0], to[1], { steps: 4 });
      if (beforeUp) await beforeUp();
      await p.mouse.up();
      if (alt) await p.keyboard.up('Alt');
    };
    const startPicking = async (p) => {
      const pick = p.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
      if (!(await pick.evaluate((b) => b.classList.contains('on')))) await pick.click();
      await p.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor({ timeout: 3000 });
    };
    const composerLabel = async (p) => {
      const head = p.locator('#tdoc-feedback-root .tdoc-popup .head .h').first();
      await head.waitFor({ timeout: 3000 });
      return head.innerText();
    };
    const postDraft = async (p, text) => {
      const draft = p.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
      await draft.fill(text);
      await p.locator('#tdoc-feedback-root .tdoc-popup button.submit').first().click();
      await p.locator('#tdoc-feedback-root .tdoc-popup').waitFor({ state: 'detached', timeout: 5000 });
    };
    const storedComments = async () => {
      const slug = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).slug, `tdoc-feedback:${tdocBase}`);
      return JSON.parse(fs.readFileSync(path.join(root, slug, 'comments.json'), 'utf8'));
    };
    const shot = async (p, name) => { if (process.env.TDOC_UI_SHOTS) await p.screenshot({ path: path.join(process.env.TDOC_UI_SHOTS, `area-${name}.png`) }); };

    // The cases below add a dozen comments; the later cases expect the
    // space as it was, so it is put back after them.
    const commentsFile = path.join(root, await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).slug, `tdoc-feedback:${tdocBase}`), 'comments.json');
    const commentsBeforeAreas = fs.readFileSync(commentsFile, 'utf8');

    await test('without the flag there is no Area tool and a drag still picks the element it started on', async () => {
      assert((await page.locator('#tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-area').count()) === 0, 'Area tool shown with the flag off');
    });

    let areaId = null;
    let areaExpected = null;
    await test('a drag across a chart comments on that area: a live box, then the box, its container and what is under it are stored', async () => {
      const p = await areaPage();
      try {
        await startPicking(p);
        const chart = await boxOf(p, '#page-chart');
        const from = [chart.x + 30, chart.y + 15];
        const to = [chart.x + 150, chart.y + 75];
        let live = null;
        await mouseDrag(p, from, to, { beforeUp: async () => {
          live = await p.evaluate(() => {
            const box = document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-drag-marquee');
            return box ? { rect: box.getBoundingClientRect().toJSON(), tag: box.innerText } : null;
          });
          await shot(p, 'drag-live');
        } });
        assert(live && live.tag === 'Comment on this area', `no live box while dragging: ${JSON.stringify(live)}`);
        assert(Math.abs(live.rect.width - 120) <= 2 && Math.abs(live.rect.height - 60) <= 2, `live box size ${JSON.stringify(live.rect)}`);
        assert((await composerLabel(p)).startsWith('Area 120×60'), `composer is not for an area: ${await composerLabel(p)}`);
        await shot(p, 'composer');
        await postDraft(p, 'The third bar looks too short');
        const made = (await storedComments()).find((c) => c.text === 'The third bar looks too short');
        assert(made, 'area comment not stored');
        const a = made.anchor;
        assert(a.kind === 'product' && a.region, `not an area anchor: ${JSON.stringify(a)}`);
        // The smallest element holding the whole box: the chart itself.
        assert(a.selector === '#page-chart' && a.tag === 'canvas', `container selector ${a.selector}`);
        const container = await p.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().toJSON(), a.selector);
        assert(a.region.rel.width === 120 && a.region.rel.height === 60
          && Math.abs(a.region.rel.x - Math.round(from[0] - container.x)) <= 1 && Math.abs(a.region.rel.y - Math.round(from[1] - container.y)) <= 1,
        `stored box ${JSON.stringify(a.region.rel)} vs container ${JSON.stringify(container)}`);
        assert(a.region.frac && a.region.frac.width > 0 && a.region.frac.width <= 1, `no fractions: ${JSON.stringify(a.region)}`);
        assert(a.rect.width === 120 && a.viewport.width === 1200 && a.region.scroll, `page box / viewport / scroll missing: ${JSON.stringify(a)}`);
        assert(a.label.startsWith('Area 120×60'), `label ${a.label}`);
        areaId = made.id;
        areaExpected = { left: from[0] - chart.x, top: from[1] - chart.y };
        assert(!(await p.locator('#tdoc-feedback-root .tdoc-fb-banner').count()), 'pick mode did not end with the comment');
      } finally { await p.close(); }
    });

    await test('the area is drawn again in the same place after a reload', async () => {
      assert(areaId, 'no area comment from the previous case');
      const p = await areaPage();
      try {
        const pin = p.locator(`#tdoc-feedback-root .tdoc-pin[data-id="${areaId}"]`);
        await pin.waitFor({ timeout: 5000 });
        await pin.click();
        await p.locator('#tdoc-feedback-root .tdoc-margin-comment').waitFor({ timeout: 3000 });
        const drawn = await p.evaluate(() => document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-drag-marquee')?.getBoundingClientRect().toJSON());
        const chart = await boxOf(p, '#page-chart');
        assert(drawn && Math.abs(drawn.x - (chart.x + areaExpected.left)) <= 2 && Math.abs(drawn.y - (chart.y + areaExpected.top)) <= 2
          && Math.abs(drawn.width - 120) <= 2 && Math.abs(drawn.height - 60) <= 2, `area drawn at ${JSON.stringify(drawn)}, chart ${JSON.stringify(chart)}`);
        const pinBox = await pin.boundingBox();
        assert(Math.abs(pinBox.x + 14 - (drawn.x + drawn.width)) <= 4, `pin is not on the area's corner: ${JSON.stringify(pinBox)} / ${JSON.stringify(drawn)}`);
        assert((await p.locator('#tdoc-feedback-root .tdoc-margin-comment').innerText()).includes('Area 120×60'), 'card does not say it is on an area');
        await shot(p, 'reload');
      } finally { await p.close(); }
    });

    await test('a click still picks an element; a drag that starts on text picks the element holding it', async () => {
      const p = await areaPage();
      try {
        await p.evaluate(() => { window.__hostClicks = 0; document.addEventListener('click', () => window.__hostClicks++, true); });
        await startPicking(p);
        const h3 = await boxOf(p, '#page-chart-card h3');
        await p.mouse.click(h3.x + 10, h3.y + h3.height / 2);
        assert((await composerLabel(p)) === 'h3 · “Signups”', `click did not pick the heading: ${await composerLabel(p)}`);
        await p.keyboard.press('Escape');
        // 5px is under the threshold: still a click.
        await mouseDrag(p, [h3.x + 10, h3.y + h3.height / 2], [h3.x + 14, h3.y + h3.height / 2 + 3]);
        assert((await composerLabel(p)) === 'h3 · “Signups”', `a 5px wobble was not a click: ${await composerLabel(p)}`);
        await p.keyboard.press('Escape');
        const h1 = await boxOf(p, 'h1');
        await mouseDrag(p, [h1.x + 5, h1.y + h1.height / 2], [h1.x + 140, h1.y + h1.height / 2 + 2]);
        assert((await composerLabel(p)) === 'h1 · “Real modal libraries”', `a drag on text did not pick its element: ${await composerLabel(p)}`);
        await p.keyboard.press('Escape');
        assert(await p.evaluate(() => window.__hostClicks === 0), 'the app got a click while picking');
      } finally { await p.close(); }
    });

    await test('Option-drag and the dock Area tool draw a box even over text', async () => {
      const p = await areaPage();
      try {
        await startPicking(p);
        const h1 = await boxOf(p, 'h1');
        await mouseDrag(p, [h1.x + 5, h1.y + 4], [h1.x + 140, h1.y + h1.height - 4], { alt: true });
        assert((await composerLabel(p)).startsWith('Area 135×'), `Option-drag did not draw a box: ${await composerLabel(p)}`);
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
        const tool = p.locator('#tdoc-feedback-root .tdoc-feedback-dock button.tdoc-fb-area');
        await tool.click();
        assert((await tool.getAttribute('aria-pressed')) === 'true', 'Area tool did not turn on');
        assert((await p.locator('#tdoc-feedback-root .tdoc-fb-banner').innerText()).startsWith('Drag a box around the area'), 'banner does not say Area mode');
        await shot(p, 'tool');
        await mouseDrag(p, [h1.x + 5, h1.y + 4], [h1.x + 100, h1.y + h1.height - 4]);
        const label = await composerLabel(p);
        assert(label.startsWith('Area 95×') && label.includes('Real modal'), `Area tool drag: ${label}`);
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
        assert((await tool.getAttribute('aria-pressed')) === 'false', 'Area tool stayed on after pick mode ended');
      } finally { await p.close(); }
    });

    await test('Escape cancels a drag in progress, then pick mode', async () => {
      const p = await areaPage();
      try {
        await startPicking(p);
        const chart = await boxOf(p, '#page-chart');
        await p.mouse.move(chart.x + 10, chart.y + 10);
        await p.mouse.down();
        await p.mouse.move(chart.x + 120, chart.y + 60, { steps: 5 });
        assert(await p.locator('#tdoc-feedback-root .tdoc-drag-marquee').count() === 1, 'no box while dragging');
        await p.keyboard.press('Escape');
        assert(await p.locator('#tdoc-feedback-root .tdoc-drag-marquee').count() === 0, 'Escape left the box');
        await p.mouse.move(chart.x + 150, chart.y + 70, { steps: 2 });
        await p.mouse.up();
        await p.waitForTimeout(200);
        assert(await p.locator('#tdoc-feedback-root .tdoc-popup').count() === 0, 'a cancelled drag opened the composer');
        assert(await p.locator('#tdoc-feedback-root .tdoc-fb-banner').isVisible(), 'Escape on a drag also left pick mode');
        await p.keyboard.press('Escape');
        await p.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor({ state: 'detached', timeout: 2000 });
      } finally { await p.close(); }
    });

    await test('C starts and stops picking, but never while typing in the app', async () => {
      const p = await areaPage();
      try {
        await p.evaluate(() => { const i = document.createElement('input'); i.id = 'host-input'; document.querySelector('main').prepend(i); window.__hostKeys = 0; document.addEventListener('keydown', () => window.__hostKeys++); });
        await p.locator('h1').click();
        await p.keyboard.press('c');
        await p.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor({ timeout: 2000 });
        await p.keyboard.press('c');
        await p.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor({ state: 'detached', timeout: 2000 });
        assert(await p.evaluate(() => window.__hostKeys === 0), 'the app also got the C');
        await p.locator('#host-input').click();
        await p.keyboard.type('cc');
        assert((await p.locator('#host-input').inputValue()) === 'cc', 'C was taken from a text field');
        assert(await p.locator('#tdoc-feedback-root .tdoc-fb-banner').count() === 0, 'typing c in the app started picking');
      } finally { await p.close(); }
    });

    await test('inside every kind of modal a click and a drag both comment, and the modal stays open', async () => {
      const p = await areaPage();
      const cases = [
        ['native <dialog>.showModal()', '#native-open', '#native-target', '#native-dialog', '#native-chart'],
        ['Radix Dialog', '#radix-open', '#radix-target', '#radix-content', '#radix-chart'],
        ['Radix Dialog without Overlay', '#radix-no-overlay-open', '#radix-no-overlay-target', '#radix-no-overlay-content', '#radix-no-overlay-chart'],
        ['MUI Dialog (focus trap)', '#mui-open', '#mui-target', '.MuiDialog-paper', '#mui-chart'],
        ['fixed overlay with a backdrop', '#overlay-open', '#overlay-target', '#overlay-modal', '#overlay-chart'],
        ['dropdown menu', '#menu-open', '#menu-rename', '#menu', '#menu'],
        ['Radix Popover', '#popover-open', '#radix-popover', '#radix-popover', '#radix-popover'],
      ];
      try {
        for (const [name, open, target, box, chart] of cases) {
          await p.goto(`${appBase}/libraries`);
          await p.addScriptTag({ url: `${tdocBase}/feedback.js` });
          await p.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor({ timeout: 5000 });
          await p.locator(open).click();
          await p.locator(target).waitFor({ timeout: 3000 });
          await p.waitForTimeout(250);
          await startPicking(p);
          assert(await p.locator(box).isVisible(), `${name}: pressing Comment closed it`);
          const t = await boxOf(p, target);
          await p.mouse.click(t.x + Math.min(20, t.width / 2), t.y + t.height / 2);
          const clicked = await composerLabel(p);
          assert(!clicked.startsWith('Area'), `${name}: click made ${clicked}`);
          assert(await p.locator(box).isVisible(), `${name}: picking closed it`);
          await p.keyboard.press('Escape');
          assert(await p.locator(box).isVisible(), `${name}: Escape on the composer closed it`);
          const c = await boxOf(p, chart);
          await mouseDrag(p, [c.x + 4, c.y + 4], [c.x + Math.min(c.width - 4, 100), c.y + Math.min(c.height - 4, 50)], { alt: true });
          assert((await composerLabel(p)).startsWith('Area'), `${name}: drag did not make an area`);
          if (name === 'fixed overlay with a backdrop') await shot(p, 'modal-overlay');
          if (name === 'Radix Dialog') await shot(p, 'modal-radix');
          await postDraft(p, `Area in ${name}`);
          assert(await p.locator(box).isVisible(), `${name}: posting closed it`);
          const events = await p.evaluate(() => window.__libraryEvents);
          assert(!events.overlayCloses && !events.menuCloses && !events.nativeCloses && !events.menuChosen,
            `${name}: the app reacted to feedback: ${JSON.stringify(events)}`);
          const stored = (await storedComments()).find((x) => x.text === `Area in ${name}`);
          assert(stored && stored.anchor.region && stored.anchor.region.rel.width > 0, `${name}: area not stored`);
        }
        const stored = await storedComments();
        const native = stored.find((x) => x.text === 'Area in native <dialog>.showModal()');
        assert(native.anchor.selector === '#native-chart', `native dialog area is not on its chart: ${native.anchor.selector}`);
        assert(native.anchor.state && native.anchor.state.dialog, `native dialog state not recorded: ${JSON.stringify(native.anchor.state)}`);
      } finally { await p.close(); }
    });

    await test('a disabled button and an iframe can be picked; the app never sees the press', async () => {
      const p = await areaPage();
      try {
        await p.locator('#overlay-open').click();
        await p.evaluate(() => {
          const frame = document.createElement('iframe');
          frame.id = 'embed'; frame.style.cssText = 'width:200px;height:60px;border:1px solid #ccc;display:block';
          frame.srcdoc = '<p>Embedded widget</p>';
          document.getElementById('overlay-modal').append(frame);
        });
        await startPicking(p);
        const d = await boxOf(p, '#overlay-disabled');
        await p.mouse.click(d.x + d.width / 2, d.y + d.height / 2);
        assert((await composerLabel(p)) === 'button · “Disabled save”', `disabled button not picked: ${await composerLabel(p)}`);
        await p.keyboard.press('Escape');
        const f = await boxOf(p, '#embed');
        await p.mouse.click(f.x + 40, f.y + 20);
        assert((await composerLabel(p)) === '#embed', `iframe not picked: ${await composerLabel(p)}`);
        await p.keyboard.press('Escape');
        // A box over both: the area lists them for whoever fixes it.
        await mouseDrag(p, [d.x - 3, d.y - 3], [f.x + f.width + 3, f.y + f.height + 3], { alt: true });
        assert((await composerLabel(p)).startsWith('Area'), 'no area over the disabled button and the iframe');
        await postDraft(p, 'Save stays disabled next to the embed');
        const stored = (await storedComments()).find((x) => x.text === 'Save stays disabled next to the embed');
        const listed = stored.anchor.region.elements.map((e) => e.selector);
        assert(listed.includes('#overlay-disabled') && listed.includes('#embed'), `elements under the box: ${JSON.stringify(stored.anchor.region.elements)}`);
        assert(stored.anchor.text.includes('Disabled save'), `text under the box: ${stored.anchor.text}`);
        await startPicking(p);
        assert(await p.locator('#overlay-modal').isVisible() && !(await p.evaluate(() => window.__libraryEvents.overlayCloses)), 'the overlay closed');
      } finally { await p.close(); }
    });

    // Phones: a tap picks, a long press then drag draws a box, a swipe
    // scrolls. Chromium gets real touch input (CDP); WebKit gets the same
    // pointer and touch events dispatched on the page.
    for (const [engineName, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
      await test(`phone 390 (${engineName}): tap picks an element, long-press then drag comments on an area`, async () => {
        const session = await page.evaluate((key) => localStorage.getItem(key), `tdoc-feedback:${tdocBase}`);
        const b = engine === chromium ? browser : await webkit.launch();
        const phone = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: engine === chromium, deviceScaleFactor: 2 });
        try {
          await phone.addInitScript(([key, value]) => { localStorage.setItem(key, value); window.__TDOC_FLAGS__ = { feedbackAreaSelect: true }; }, [`tdoc-feedback:${tdocBase}`, session]);
          const p = await phone.newPage();
          await p.goto(`${appBase}/libraries`);
          await p.addScriptTag({ url: `${tdocBase}/feedback.js` });
          await p.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor({ timeout: 5000 });
          const tool = p.locator('#tdoc-feedback-root .tdoc-feedback-dock button.tdoc-fb-area');
          assert(await tool.isVisible() && !(await tool.locator('.tdoc-fb-area-label').isVisible()), 'phone Area tool should be icon only');
          const dock = await p.locator('#tdoc-feedback-root .tdoc-feedback-dock').boundingBox();
          assert(dock.x >= 0 && dock.x + dock.width <= 390, `dock with the Area tool runs off a 390 screen: ${JSON.stringify(dock)}`);
          await p.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary').tap();
          const banner = p.locator('#tdoc-feedback-root .tdoc-fb-banner');
          await banner.waitFor({ timeout: 3000 });
          assert((await banner.innerText()).startsWith('Tap an element, or hold and drag a box'), `phone banner: ${await banner.innerText()}`);
          const h3 = await p.locator('#page-chart-card h3').boundingBox();
          await p.touchscreen.tap(h3.x + 10, h3.y + h3.height / 2);
          const head = p.locator('#tdoc-feedback-root .tdoc-popup .head .h').first();
          await head.waitFor({ timeout: 3000 });
          assert((await head.innerText()) === 'h3 · “Signups”', `tap picked ${await head.innerText()}`);
          await p.locator('#tdoc-feedback-root .tdoc-popup button.x').first().tap();
          await p.locator('#tdoc-feedback-root .tdoc-popup').waitFor({ state: 'detached', timeout: 2000 });
          const chart = await p.locator('#page-chart').boundingBox();
          const from = [chart.x + 20, chart.y + 10];
          const to = [chart.x + 140, chart.y + 70];
          if (engine === chromium) {
            const cdp = await phone.newCDPSession(p);
            const touch = (type, [x, y]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
            await touch('touchStart', from);
            await p.waitForTimeout(650);
            for (let i = 1; i <= 6; i++) await touch('touchMove', [from[0] + (to[0] - from[0]) * i / 6, from[1] + (to[1] - from[1]) * i / 6]);
            assert(await p.locator('#tdoc-feedback-root .tdoc-drag-marquee').count() === 1, 'no box while the finger drags');
            await touch('touchEnd', to);
          } else {
            await p.evaluate(async ([from, to]) => {
              const shield = document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-fb-shield');
              const fire = (type, [x, y]) => shield.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
              fire('pointerdown', from);
              await new Promise((r) => setTimeout(r, 650));
              for (let i = 1; i <= 6; i++) fire('pointermove', [from[0] + (to[0] - from[0]) * i / 6, from[1] + (to[1] - from[1]) * i / 6]);
              fire('pointerup', to);
            }, [from, to]);
          }
          await head.waitFor({ timeout: 3000 });
          const label = await head.innerText();
          assert(label.startsWith('Area 120×60'), `long-press drag made ${label}`);
          if (process.env.TDOC_UI_SHOTS) await p.screenshot({ path: path.join(process.env.TDOC_UI_SHOTS, `area-phone-${engineName.toLowerCase()}.png`) });
          await p.locator('#tdoc-feedback-root .tdoc-popup button.x').first().tap();
          if (engine === chromium) {
            // A quick swipe is a scroll, not a box.
            const cdp = await phone.newCDPSession(p);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
            for (let i = 1; i <= 4; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + 30 * i, y: from[1] }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await p.waitForTimeout(700);
            assert(await p.locator('#tdoc-feedback-root .tdoc-popup').count() === 0, 'a swipe opened the composer');
          }
        } finally {
          await phone.close();
          if (b !== browser) await b.close();
        }
      });
    }

    fs.writeFileSync(commentsFile, commentsBeforeAreas);

    await test('the same agent thread renders alike in the document and the real host app at 390/1440', async () => {
      const session = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `tdoc-feedback:${tdocBase}`);
      const file = path.join(root, session.slug, 'comments.json');
      const original = fs.readFileSync(file, 'utf8');
      const source = JSON.parse(original).find((c) => c.anchor?.kind === 'product' && c.anchor.url === `${appBase}/dashboard`);
      assert(source, 'no product comment to seed parity fixture');
      const at = new Date(Date.now() - 60000).toISOString();
      const replyAt = new Date(Date.now() - 30000).toISOString();
      const fixture = {
        ...source, id: 'c_feedback_parity', text: 'Clarify the invite button', created: at,
        anchor: { kind: 'product', url: `${appBase}/dashboard`, selector: '#invite', tag: 'button', text: 'Send invite' },
        status: 'open', handoff_at: at, handoff_to: { handle: 'agent' },
        handoff_status: 'sent', handoff_delivery: { status: 'delivered', at },
        replies: [{ id: 'r_feedback_parity', parent_id: 'c_feedback_parity',
          text: 'Which team should receive the invite?', created: replyAt,
          author: { kind: 'agent', login: 'agent', name: 'Helper' },
          agent_status: 'question', reactions: {} }], reactions: {},
      };
      fs.writeFileSync(file, JSON.stringify([...JSON.parse(original), fixture]));
      const host = await context.newPage();
      const doc = await context.newPage();
      let handoffPayload = null;
      try {
        await host.setViewportSize({ width: 1440, height: 800 });
        await host.goto(`${appBase}/dashboard`);
        await host.evaluate((key) => {
          const session = JSON.parse(localStorage.getItem(key));
          session.notify = true;
          localStorage.setItem(key, JSON.stringify(session));
        }, `tdoc-feedback:${tdocBase}`);
        await host.route('**/api/feedback/session', async (route) => {
          const response = await route.fetch();
          const session = await response.json();
          await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify({ ...session, notify: true }) });
        });
        await host.route('**/api/notify/targets?**', (route) => route.fulfill({
          status: 200,
          headers: { 'access-control-allow-origin': appBase, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, OPTIONS' },
          contentType: 'application/json',
          body: JSON.stringify({ default: { provider: 'raft', agent_name: 'Helper', agent_sub: 'helper', server_slug: 'team' }, candidates: [], fallback: null, reason: null }),
        }));
        await host.route('**/api/notify/handoff', (route) => {
          if (route.request().method() === 'POST') handoffPayload = JSON.parse(route.request().postData());
          return route.fulfill({ status: 200,
            headers: { 'access-control-allow-origin': appBase, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' },
            contentType: 'application/json', body: JSON.stringify({ ok: true, delivery: { status: 'delivered' } }),
          });
        });
        await host.addScriptTag({ url: `${tdocBase}/feedback.js` });
        await host.waitForFunction(() => Boolean(window.tdocFeedback));
        await host.evaluate(() => window.tdocFeedback.open());
        await host.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor();
        const panel = host.locator('#tdoc-feedback-root .tdoc-fb-panel');
        // open() shows the list once the comments are loaded; open it by hand
        // only if that does not happen (a toggle would close it again).
        await panel.waitFor({ state: 'visible', timeout: 4000 })
          .catch(() => host.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click());
        await panel.waitFor({ state: 'visible' });
        await panel.getByRole('button', { name: 'All', exact: true }).click();
        const fbCard = host.locator('#tdoc-feedback-root .tdoc-fb-item article[data-comment-id="c_feedback_parity"]');
        await fbCard.waitFor();
        const pin = host.locator('#tdoc-feedback-root .tdoc-pin[data-id="c_feedback_parity"]');
        assert((await pin.count()) === 1, `fixture pin missing: ${JSON.stringify(await host.evaluate(() => ({
          pins: [...window.__fbAll('.tdoc-pin')].map((p) => p.dataset.id),
          invite: document.getElementById('invite')?.getBoundingClientRect().toJSON(),
          title: document.title,
        })))}`);
        assert((await pin.locator('.tdoc-pin-handoff-badge.is-question').count()) === 1,
          `feedback pin lost the agent question badge: ${await pin.evaluate((el) => el.outerHTML)} / ${await fbCard.innerText()}`);
        assert((await pin.locator('.tdoc-pin-unread-dot').count()) === 1, 'feedback pin lost the unread agent reply');
        await fbCard.locator('.tdoc-replies-toggle').click();
        assert(await fbCard.locator('.tdoc-reply[data-comment-id="r_feedback_parity"]').isVisible(), 'feedback list cannot show the agent reply');
        const shots = process.env.TDOC_UI_SHOTS;
        await fbCard.scrollIntoViewIfNeeded();
        await host.waitForTimeout(250); // let the panel's entrance clip animation finish
        const withinPanel = async () => host.evaluate(() => {
          const panel = window.__fb('.tdoc-fb-panel').getBoundingClientRect();
          const card = window.__fb('.tdoc-fb-item article[data-comment-id="c_feedback_parity"]').getBoundingClientRect();
          return panel.left >= 0 && panel.right <= innerWidth && card.left >= panel.left && card.right <= panel.right;
        });
        assert(await withinPanel(), 'feedback comment card overflows the panel at 1440');
        if (shots) { fs.mkdirSync(shots, { recursive: true }); await host.screenshot({ path: path.join(shots, 'shared-comment-host-1440.png') }); }
        await host.setViewportSize({ width: 390, height: 800 });
        await fbCard.scrollIntoViewIfNeeded();
        await host.waitForTimeout(100);
        assert(await withinPanel(), 'feedback comment card overflows the panel at 390');
        assert(await host.evaluate(() => {
          const pinRect = window.__fb('.tdoc-pin[data-id="c_feedback_parity"]').getBoundingClientRect();
          const hit = document.getElementById('tdoc-feedback-root').shadowRoot.elementFromPoint(pinRect.x + pinRect.width / 2, pinRect.y + pinRect.height / 2);
          return Boolean(hit?.closest('.tdoc-fb-panel'));
        }), 'a page pin is covering the mobile comment panel');
        if (shots) await host.screenshot({ path: path.join(shots, 'shared-comment-host-390.png') });

        await doc.setViewportSize({ width: 390, height: 800 });
        await doc.goto(`${tdocBase}/d/${session.slug}/v/${session.version}`);
        await doc.waitForFunction(() => document.body.dataset.tdocReady === '1');
        await doc.locator('.tdoc-fab').click();
        const docCard = doc.locator('.tdoc-drawer-list article[data-comment-id="c_feedback_parity"]');
        await docCard.waitFor();
        assert((await fbCard.locator('.tdoc-thread-unread-dot').count()) === 1
          && (await docCard.locator('.tdoc-thread-unread-dot').count()) === 1,
        'the same unread thread must be marked in both comment lists');
        await docCard.locator('.tdoc-replies-toggle').click();
        const read = (card) => card.evaluate((element) => {
          const text = (selector) => element.querySelector(selector)?.innerText.replace(/\s+/g, ' ').trim();
          return { status: text('.tdoc-status-row'), author: text('.tdoc-cc-head .author'),
            text: text('.text'), replies: [...element.querySelectorAll('.tdoc-replies .tdoc-reply[data-comment-id]')]
              .map((reply) => ({ author: reply.querySelector('.author')?.textContent.trim(),
                text: reply.querySelector('.text')?.textContent.trim() })) };
        });
        const feedback = await read(fbCard);
        const document = await read(docCard);
        assert(JSON.stringify(feedback) === JSON.stringify(document), `document/feedback thread differs: ${JSON.stringify({ feedback, document })}`);
        assert(feedback.status.includes('Asked you') && feedback.replies[0]?.text.includes('Which team'), 'agent status or reply was omitted');
        await fbCard.locator('.tdoc-reply-toggle').first().click();
        await docCard.locator('.tdoc-reply-toggle').first().click();
        assert(await fbCard.locator('.tdoc-reply-form').isVisible() && await docCard.locator('.tdoc-reply-form').isVisible(),
          'one surface cannot open the shared reply box');
        assert(await fbCard.locator('.tdoc-reply-form .tdoc-reply-agent').isVisible(),
          'feedback reply box is missing the shared agent tag control');
        await panel.locator('button.x').click();
        await host.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary').click();
        await host.locator('#invite').click({ force: true });
        const composer = host.locator('#tdoc-feedback-root .tdoc-popup');
        await composer.locator('button.tdoc-composer-agent').click();
        assert((await composer.locator('textarea').inputValue()).includes('Helper'), 'the feedback composer did not insert the shared agent tag');
        assert(await composer.locator('.tdoc-agent-pill').isVisible(), 'the agent tag did not render as a pill');
        await composer.getByRole('button', { name: 'Comment', exact: true }).click();
        for (let i = 0; i < 20 && !handoffPayload; i++) await host.waitForTimeout(100);
        assert(handoffPayload?.recipient?.agent_name === 'Helper' && handoffPayload.comment_ids.length === 1,
          `selected agent was not sent with the comment: ${JSON.stringify(handoffPayload)}`);
      } finally {
        await host.close();
        await doc.close();
        fs.writeFileSync(file, original);
        // The fixture's notify lives in the shared localStorage; the app page
        // that stays open would otherwise ask this local host for agents.
        await page.evaluate((key) => {
          const stored = JSON.parse(localStorage.getItem(key));
          delete stored.notify;
          localStorage.setItem(key, JSON.stringify(stored));
        }, `tdoc-feedback:${tdocBase}`);
      }
    });

    await test('stored unsafe product links cannot navigate the host; feedback read controls match pin state', async () => {
      const session = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `tdoc-feedback:${tdocBase}`);
      const file = path.join(root, session.slug, 'comments.json');
      const original = fs.readFileSync(file, 'utf8');
      const source = JSON.parse(original).find((c) => c.anchor?.kind === 'product');
      assert(source, 'no product comment for link-safety fixture');
      const at = (offset) => new Date(Date.now() + offset).toISOString();
      const clone = (id, url, replies = []) => ({ ...source, id, text: `Fixture ${id}`, created: at(-120000),
        anchor: { kind: 'product', url, selector: '#invite', text: 'Send invite' },
        status: 'open', handoff_at: at(-90000), handoff_status: 'sent',
        handoff_delivery: { status: 'delivered', at: at(-90000) }, replies, reactions: {} });
      const agentReply = (id) => ({ id, text: 'I have a question', created: at(-60000),
        author: { kind: 'agent', login: 'helper', name: 'Helper' }, agent_status: 'question', reactions: {} });
      const unsafe = clone('c_fb_unsafe', 'javascript:window.__feedbackInjected=1');
      const external = clone('c_fb_external', 'https://elsewhere.example/steal');
      const unreadA = clone('c_fb_unread_a', `${appBase}/dashboard`, [agentReply('r_fb_unread_a')]);
      const unreadB = clone('c_fb_unread_b', `${appBase}/pricing`, [agentReply('r_fb_unread_b')]);
      const waiting = clone('c_fb_waiting', `${appBase}/dashboard`, [agentReply('r_fb_waiting'), {
        id: 'r_fb_waiting_human', text: 'Please also check this', created: at(-30000),
        author: { kind: 'human', login: 'teammate', name: 'Teammate' }, reactions: {},
      }]);
      waiting.handoff_at = at(-10000);
      waiting.handoff_delivery = { status: 'delivered', at: waiting.handoff_at };
      fs.writeFileSync(file, JSON.stringify([...JSON.parse(original), unsafe, external, unreadA, unreadB, waiting]));
      const host = await context.newPage();
      try {
        await host.setViewportSize({ width: 390, height: 800 });
        await host.goto(`${appBase}/dashboard`);
        await host.evaluate(() => { window.__feedbackInjected = 0; });
        await host.addScriptTag({ url: `${tdocBase}/feedback.js` });
        await host.waitForFunction(() => Boolean(window.tdocFeedback));
        await host.evaluate(() => window.tdocFeedback.open());
        const panel = host.locator('#tdoc-feedback-root .tdoc-fb-panel');
        // open() loads first and opens the list itself when there are
        // comments; only click the dock if it did not.
        await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (!(await panel.isVisible())) await host.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
        await host.waitForTimeout(1500); await host.screenshot({ path: `/tmp/fb-drag-work/parity-debug-${Date.now()}.png` }); console.log('DEBUG', await host.evaluate(() => ({ panel: !!document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-fb-panel'), w: innerWidth, notice: document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-feedback-notice')?.innerText })));
        await panel.waitFor({ state: 'visible' });
        await panel.getByRole('button', { name: 'All', exact: true }).click();
        const card = (id) => panel.locator(`article[data-comment-id="${id}"]`);
        await card('c_fb_unread_a').waitFor();
        assert((await card('c_fb_waiting').locator('.tdoc-thread-unread-dot').count()) === 0,
          'waiting thread has an unread list dot while its pin has none');
        assert((await card('c_fb_unread_a').locator('.tdoc-thread-unread-dot').count()) === 1,
          'unread thread lost its read control');
        const readbar = panel.locator('.tdoc-fb-readbar');
        assert(await readbar.getByRole('button', { name: 'Mark all as read' }).isVisible(), 'bulk read control is missing');
        const shots = process.env.TDOC_UI_SHOTS;
        await card('c_fb_unread_a').scrollIntoViewIfNeeded();
        await host.waitForTimeout(250); // finish the panel's clip entrance before screenshots
        if (shots) { fs.mkdirSync(shots, { recursive: true }); await host.screenshot({ path: path.join(shots, 'feedback-link-read-controls-390.png') }); }
        await host.setViewportSize({ width: 1440, height: 800 });
        await card('c_fb_unread_a').scrollIntoViewIfNeeded();
        if (shots) await host.screenshot({ path: path.join(shots, 'feedback-link-read-controls-1440.png') });
        await card('c_fb_unread_a').getByRole('button', { name: 'Mark as read' }).click();
        assert((await card('c_fb_unread_a').locator('.tdoc-thread-unread-dot').count()) === 0,
          'single read control did not clear its thread');
        assert((await card('c_fb_unread_b').locator('.tdoc-thread-unread-dot').count()) === 1,
          'single read control cleared another thread');
        await readbar.getByRole('button', { name: 'Mark all as read' }).click();
        assert((await card('c_fb_unread_b').locator('.tdoc-thread-unread-dot').count()) === 0,
          'bulk read control did not clear remaining threads');
        assert((await card('c_fb_unsafe').locator('a.tdoc-product-where').count()) === 0,
          'legacy script URL was rendered as a clickable link');
        assert((await card('c_fb_external').locator('a.tdoc-product-where').count()) === 0,
          'an off-site product link was rendered as a clickable link in feedback');
        for (const id of ['c_fb_unsafe', 'c_fb_external']) {
          const target = card(id);
          await target.scrollIntoViewIfNeeded();
          await panel.locator(`.tdoc-fb-item:has(article[data-comment-id="${id}"]) .tdoc-fb-context`).click();
          assert(host.url() === `${appBase}/dashboard`, `${id} navigated off the current page`);
        }
        assert(await host.evaluate(() => window.__feedbackInjected === 0), 'script URL executed in the host page');
        await panel.locator('.tdoc-fb-item:has(article[data-comment-id="c_fb_unread_b"]) .tdoc-fb-context').click();
        await host.waitForURL(`${appBase}/pricing`);
      } finally {
        await host.close();
        fs.writeFileSync(file, original);
      }
    });

    await test('no console errors on the app page', async () => {
      assert(consoleErrors.length === 0, consoleErrors.join('\n'));
    });
    await test('a site embed (data-tdoc-space) exposes window.tdoc with its space and events', async () => {
      const site = await context.newPage();
      await site.goto(`${appBase}/pricing`);
      await site.evaluate((src) => {
        const s = document.createElement('script');
        s.src = src;
        s.setAttribute('data-tdoc-space', 'acme-site-space');
        document.documentElement.appendChild(s);
      }, `${tdocBase}/feedback.js`);
      await site.waitForFunction(() => window.tdoc && window.tdoc.space === 'acme-site-space');
      const api = await site.evaluate(() => ['open', 'close', 'toggle', 'comment', 'on'].every((k) => typeof window.tdoc[k] === 'function'));
      assert(api, 'window.tdoc API incomplete');
      const opened = await site.evaluate(() => new Promise((resolve) => {
        const off = window.tdoc.on('open', () => { off(); resolve(true); });
        window.tdoc.open();
        setTimeout(() => resolve(false), 3000);
      }));
      assert(opened, "tdoc.on('open') did not fire");
      // The local twin signs everyone in as the e2e user, so the connect
      // popup (and its &space=) is covered by the worker suite site-space.
      await site.close();
    });

  } finally {
    await browser.close();
    server.kill();
    app.close();
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
