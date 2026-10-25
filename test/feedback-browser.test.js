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
</main></body></html>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-feedback-'));
  const tdocPort = await reservePort();
  const appPort = await reservePort();
  const tdocBase = `http://localhost:${tdocPort}`;
  const appBase = `http://127.0.0.1:${appPort}`;

  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(tdocPort), TDOC_E2E_USER: 'julie' },
    stdio: 'ignore',
  });
  const app = http.createServer((req, res) => {
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
        const banner = document.querySelector('#tdoc-feedback-root .tdoc-fb-banner');
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
        const panel = document.querySelector('#tdoc-feedback-root .tdoc-fb-panel');
        const p = panel.getBoundingClientRect();
        const m = document.querySelector('main').getBoundingClientRect();
        return {
          marginRight: document.documentElement.style.marginRight,
          main: m.toJSON(), panel: p.toJSON(),
          topRightIsPanel: Boolean(document.elementFromPoint(innerWidth - 8, 8)?.closest('.tdoc-fb-panel')),
        };
      });
      assert(overlay.marginRight === before.marginRight && overlay.main.left === before.main.left && overlay.main.width === before.main.width,
        `feedback list shifted the host app: ${JSON.stringify({ before, overlay })}`);
      assert(overlay.panel.top === 0 && overlay.panel.right === 1200 && overlay.topRightIsPanel,
        `feedback list is not a top-layer right overlay: ${JSON.stringify(overlay)}`);
      // The header wraps instead of overflowing: the close button is inside
      // the viewport and is what a click there hits.
      const close = await page.evaluate(() => {
        const x = document.querySelector('#tdoc-feedback-root .tdoc-fb-panel .x');
        const r = x.getBoundingClientRect();
        return { r: r.toJSON(), vw: document.documentElement.clientWidth, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === x };
      });
      assert(close.r.right <= close.vw && close.r.left >= 0 && close.hit, `panel close button is cut off or covered: ${JSON.stringify(close)}`);
      // The composer stacks above the panel.
      const order = await page.evaluate(() => {
        const z = (sel) => Number(getComputedStyle(document.querySelector(sel) || document.body).zIndex) || 0;
        const probe = document.createElement('div'); probe.className = 'tdoc-popup'; document.getElementById('tdoc-feedback-root').appendChild(probe);
        const out = { popup: Number(getComputedStyle(probe).zIndex), panel: z('#tdoc-feedback-root .tdoc-fb-panel') };
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
      await page.waitForFunction((n) => document.querySelectorAll('#tdoc-feedback-root .tdoc-pin').length > n, countBeforeSave);
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
      await page.waitForFunction((n) => document.querySelectorAll('#tdoc-feedback-root .tdoc-pin').length === n - 1, before);
      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), saved);
      await page.waitForFunction((n) => document.querySelectorAll('#tdoc-feedback-root .tdoc-pin').length === n, before);
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
      const dockAt = () => page.evaluate(() => { const b = document.querySelector('#tdoc-feedback-root .tdoc-feedback-dock').getBoundingClientRect(); return [b.x, b.y, b.width, b.height].join(); });
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
        const dock = document.querySelector('#tdoc-feedback-root .tdoc-feedback-dock').getBoundingClientRect();
        const hit = document.elementFromPoint(dock.x + dock.width / 2, dock.y + dock.height / 2);
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
        d.innerHTML = '<div id="headlessui-dialog-panel-example"><h2>Billing settings</h2><input value="Example"></div>';
        document.body.appendChild(d);
        window.__captureModalClosed = false;
        window.__captureModalOutside = (e) => {
          // Headless UI checks the panel, not its role=dialog wrapper.
          if (!d.isConnected || d.querySelector('[id^="headlessui-dialog-panel-"]').contains(e.target)) return;
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
        for (const width of [1512, 390]) {
          await me.setViewportSize({ width, height: 823 });
          await me.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
          const panel = me.locator('#tdoc-feedback-root .tdoc-fb-panel');
          await panel.waitFor();
          await me.waitForTimeout(200); // let the slide-in clip-path finish
          const layout = await me.evaluate(() => {
            const panel = document.querySelector('#tdoc-feedback-root .tdoc-fb-panel');
            const close = panel.querySelector('button.x');
            const r = panel.getBoundingClientRect();
            const x = close.getBoundingClientRect();
            return {
              panel: r.toJSON(), close: x.toJSON(), vw: innerWidth,
              closeHit: document.elementFromPoint(x.x + x.width / 2, x.y + x.height / 2) === close,
            };
          });
          assert(layout.panel.right === width && layout.panel.left === (width <= 600 ? 0 : width - 340)
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
