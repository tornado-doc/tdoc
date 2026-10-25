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
const { chromium } = requirePlaywrightOrSkip('feedback-browser.test.js');

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
      res.end('<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui}.modal-overlay{position:fixed;inset:0;background:#0005}.modal-content{position:fixed;top:18%;left:20%;min-width:400px;padding:24px;background:white;z-index:30}</style><div id="host-app"></div><script src="/libraries.js"></script>');
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
      await page.locator('#invite').click();
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
      await page.locator('#invite').click();
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
      await page.locator('#save').click();
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
      await page.locator('#nd h2').click();
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
      await page.locator('#td h2').click();
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
        await page.locator('#transformed-target').click();
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
      await page.locator('#sm h2').click();
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
        await page.locator('#capture-modal h2').click();
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
        await page.locator('#event-target').click();
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
          style.textContent = '[role="dialog"] * { font-family: fantasy !important; color: rgb(244, 0, 0) !important; text-transform: uppercase !important; direction: rtl !important; line-height: 3 !important; }';
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
          return { accent: getComputedStyle(root).getPropertyValue('--td-accent').trim(), hostFont: getComputedStyle(host).fontFamily,
            font: css.fontFamily, color: css.color, transform: css.textTransform, direction: css.direction, lineHeight: css.lineHeight };
        });
        assert(styles.accent === '#1652f0' && !styles.hostFont.includes('fantasy') && !styles.font.includes('fantasy')
          && styles.color !== 'rgb(244, 0, 0)' && styles.transform !== 'uppercase' && styles.direction === 'ltr'
          && styles.lineHeight !== '3', `host CSS or missing tokens changed feedback: ${JSON.stringify(styles)}`);
        const pick = foreign.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
        if (!(await pick.evaluate((button) => button.classList.contains('on')))) await pick.click();
        await foreign.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
        await foreign.locator('#css-modal h2').click();
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
        await dialog.locator('h3').click();
        const c = me.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await c.waitFor({ timeout: 4000 });
        await c.click();
        await me.keyboard.type('Rename title is vague');
        assert((await c.inputValue()) === 'Rename title is vague', 'typing in the composer over the Rename dialog failed');
        assert(await dialog.isVisible(), 'the Rename dialog closed when the composer took focus');
        await me.keyboard.press('Escape');
        await me.locator('#tdoc-feedback-root .tdoc-popup').waitFor({ state: 'detached' });
        assert(await dialog.isVisible(), 'Escape in the composer also closed the Rename dialog');
        await dialog.locator('h3').click();
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
          await me.locator('h1').first().click();
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
      await heading.click();
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
      await page.locator('main h2').first().click();
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
        await libs.locator('#radix-target').click();
        const radixDraft = libs.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await radixDraft.fill('Radix modal feedback');
        await radixDraft.press('Enter');
        await radixDraft.press('Meta+Enter');
        assert(await libs.evaluate(() => window.__libraryEvents.radixKeys === 0), 'feedback keys reached Radix dialog handler');
        assert(await libs.locator('#radix-content').isVisible(), 'feedback closed Radix dialog');
        await libs.getByRole('button', { name: 'Close Radix' }).click();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement === document.documentElement);

        await libs.locator('#headless-open').click();
        await libs.locator('#headless-target').waitFor();
        await libs.waitForFunction(() => document.getElementById('tdoc-feedback-root').parentElement.id === 'custom-headless-panel', null, { timeout: 3000 });
        if (!(await pick.evaluate((button) => button.classList.contains('on')))) await pick.click();
        await libs.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
        await libs.locator('#headless-target').click();
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
