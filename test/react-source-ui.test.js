// The feedback widget on a site built with React (reactSourceCapture): the
// picker's hover outline names the component under the pointer and its
// source file:line as a quiet text tag, a comment's anchor stores the chain
// (`anchor.react`), hostile names and paths are shown as text and never run,
// and a page without React (or with the flag off) shows no tag and stores
// nothing. Desktop and phone width.
// Run with: node test/react-source-ui.test.js  (TDOC_UI_SHOTS=<dir> for screenshots)

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const esbuild = require('esbuild');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('react-source-ui.test.js');

let pass = 0, fail = 0;
async function test(name, operation) {
  try { await operation(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message || error}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function waitForServer(port, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const request = http.get({ host: '127.0.0.1', port, path: '/api/ping' }, (response) => { response.resume(); resolve(); });
      request.on('error', () => { if (Date.now() >= deadline) reject(new Error('local server did not start')); else setTimeout(poll, 80); });
    })();
  });
}

const STYLE = '<style>body{font:16px system-ui;margin:0}main{max-width:720px;margin:60px auto;padding:0 24px}.pricing{display:flex;gap:16px;flex-wrap:wrap}.plan{border:1px solid #ddd;border-radius:8px;padding:16px;min-width:180px}button{background:#111;color:#fff;border:0;padding:8px 14px;border-radius:6px}</style>';
const PLAIN_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${STYLE}<main><h1>Plain page</h1><div class="plan" id="plain"><h3>No React here</h3><button type="button" id="plain-buy">Buy</button></div></main>`;

(async () => {
  console.log('Feedback widget: React component and source (reactSourceCapture)');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-react-src-'));
  const tdocPort = await reservePort();
  const appPort = await reservePort();
  const tdocBase = `http://localhost:${tdocPort}`;
  const appBase = `http://127.0.0.1:${appPort}`;
  const bundle = (await esbuild.build({
    entryPoints: [path.join(__dirname, 'fixtures', 'react-source-app.jsx')],
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', jsxDev: true,
    define: { 'process.env.NODE_ENV': '"development"' },
  })).outputFiles[0].contents;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(tdocPort), TDOC_E2E_USER: 'julie' }, stdio: 'ignore',
  });
  const app = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/plain') { res.end(PLAIN_HTML); return; }
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme pricing</title>${STYLE}<div id="root"></div><script src="/app.js"></script>`);
  });
  await new Promise((resolve) => app.listen(appPort, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  const shots = process.env.TDOC_UI_SHOTS;
  const shot = async (p, name) => { if (shots) await p.screenshot({ path: path.join(shots, `react-source-${name}.png`) }); };
  const hint = (p) => p.evaluate(() => {
    const el = document.getElementById('tdoc-feedback-root')?.shadowRoot?.querySelector('.tdoc-fb-react-hint');
    return el ? { text: el.textContent, html: el.innerHTML, rect: el.getBoundingClientRect().toJSON() } : null;
  });
  const stored = () => fs.readdirSync(root).flatMap((dir) => {
    const file = path.join(root, dir, 'comments.json');
    if (!fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
  });

  // One browser context per viewport, connected once.
  async function open(ctx, pathname, flag = true) {
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((on) => { window.__TDOC_FLAGS__ = { reactSourceCapture: on }; }, flag);
    await p.goto(`${appBase}${pathname}`);
    await p.evaluate((src) => { const s = document.createElement('script'); s.src = src; s.setAttribute('data-tdoc-open', '1'); document.documentElement.appendChild(s); }, `${tdocBase}/feedback.js`);
    await p.waitForFunction(() => document.getElementById('tdoc-feedback-root')?.shadowRoot?.querySelector('.tdoc-feedback-dock, .tdoc-feedback-notice'));
    const connect = p.locator('#tdoc-feedback-root .tdoc-feedback-notice button.submit');
    if (await connect.count()) {
      const [popup] = await Promise.all([ctx.waitForEvent('page'), connect.click()]);
      await popup.waitForEvent('close', { timeout: 5000 }).catch(() => {});
    }
    await p.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor({ state: 'attached', timeout: 5000 });
    await p.waitForTimeout(150);
    const pick = p.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
    if (!(await pick.isVisible()) || !(await pick.evaluate((b) => b.classList.contains('on')))) await p.evaluate(() => window.tdocFeedback.comment());
    await p.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
    return { p, errors };
  }
  const hoverOn = async (p, selector) => {
    const b = await p.locator(selector).boundingBox();
    assert(b, `${selector} has no box`);
    await p.mouse.move(b.x + 6, b.y + 6);
    await p.mouse.move(b.x + 8, b.y + 8);
    await p.waitForTimeout(120);
  };

  try {
    await waitForServer(tdocPort);
    const desk = await browser.newContext({ viewport: { width: 1200, height: 800 } });

    await test('desktop: hovering a plan card shows the component chain and file:line as a text tag; the comment stores anchor.react', async () => {
      const { p, errors } = await open(desk, '/');
      await hoverOn(p, '#plan-pro');
      const h = await hint(p);
      assert(h, 'no hint on a React element');
      assert(h.text === 'Pricing › PlanCard · PlanCard.jsx:9', `hint: ${h.text}`);
      assert(h.html === h.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), `hint is not plain text: ${h.html}`);
      await shot(p, 'desktop-hover');
      const b = await p.locator('#plan-pro').boundingBox();
      await p.mouse.click(b.x + 8, b.y + 8);
      const draft = p.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
      await draft.waitFor({ timeout: 3000 });
      await draft.fill('Pro card is too tall');
      await p.locator('#tdoc-feedback-root .tdoc-popup button.submit').first().click();
      await p.locator('#tdoc-feedback-root .tdoc-popup').waitFor({ state: 'detached', timeout: 5000 });
      const c = stored().find((x) => x.text === 'Pro card is too tall');
      assert(c && c.anchor && c.anchor.react, `no anchor.react: ${JSON.stringify(c && c.anchor)}`);
      assert(JSON.stringify(c.anchor.react.components) === JSON.stringify(['App', 'Pricing', 'PlanCard']), `chain: ${JSON.stringify(c.anchor.react)}`);
      assert(c.anchor.react.file === 'src/pricing/PlanCard.jsx' && c.anchor.react.line === 9 && c.anchor.react.column === 5, `source: ${JSON.stringify(c.anchor.react)}`);
      assert(errors.length === 0, errors.join('\n'));
      await p.close();
    });

    await test('hostile component names and source paths: dropped, never run; only the real App is named', async () => {
      const { p, errors } = await open(desk, '/');
      await hoverOn(p, '#evil');
      const h = await hint(p);
      // App is still a component around it, the hostile name and path are not.
      assert(h && h.text === 'App', `hint on the hostile element: ${h && h.html}`);
      assert(await p.evaluate(() => !window.__pwned && !document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-fb-react-hint img')), 'hostile markup ran');
      assert(errors.length === 0, errors.join('\n'));
      await p.close();
    });

    await test('a page without React shows no tag and stores no react part', async () => {
      const { p, errors } = await open(desk, '/plain');
      await hoverOn(p, '#plain');
      assert((await hint(p)) === null, 'a tag on a page without React');
      const b = await p.locator('#plain').boundingBox();
      await p.mouse.click(b.x + 8, b.y + 8);
      const draft = p.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
      await draft.waitFor({ timeout: 3000 });
      await draft.fill('Plain page comment');
      await p.locator('#tdoc-feedback-root .tdoc-popup button.submit').first().click();
      await p.locator('#tdoc-feedback-root .tdoc-popup').waitFor({ state: 'detached', timeout: 5000 });
      const c = stored().find((x) => x.text === 'Plain page comment');
      assert(c && !('react' in c.anchor), `react part on a plain page: ${JSON.stringify(c && c.anchor)}`);
      assert(errors.length === 0, errors.join('\n'));
      await p.close();
    });

    await test('the tag stays inside the viewport at the right edge, the top, and over a full-height element', async () => {
      const { p, errors } = await open(desk, '/');
      for (const style of ['position:fixed;top:0;right:0;width:150px', 'position:fixed;top:0;left:0;right:0;height:100vh']) {
        await p.evaluate((css) => { document.getElementById('plan-pro').style.cssText = css; }, style);
        await p.mouse.move(1, 1);
        await hoverOn(p, '#plan-pro');
        const h = await hint(p);
        assert(h, `no hint (${style})`);
        assert(h.rect.left >= 0 && h.rect.right <= 1200 && h.rect.top >= 0 && h.rect.bottom <= 800, `tag outside the viewport (${style}): ${JSON.stringify(h.rect)}`);
      }
      await shot(p, 'desktop-edge');
      assert(errors.length === 0, errors.join('\n'));
      await p.close();
    });

    await test('the flag can come from the session (dev mode), with nothing pinned on the page', async () => {
      for (const [devFlags, want] of [[['reactSourceCapture'], true], [[], false]]) {
        const p = await desk.newPage();
        await p.route(`${tdocBase}/api/feedback/session`, async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          await route.fulfill({ response: res, json: { ...body, dev_flags: devFlags } });
        });
        const answered = p.waitForResponse(`${tdocBase}/api/feedback/session`, { timeout: 5000 });
        await p.goto(`${appBase}/`);
        assert(await p.evaluate(() => window.__TDOC_FLAGS__ === undefined), 'a flag is pinned');
        await p.evaluate((src) => { const s = document.createElement('script'); s.src = src; document.documentElement.appendChild(s); }, `${tdocBase}/feedback.js`);
        await answered;
        await p.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor({ state: 'attached', timeout: 5000 });
        await p.waitForTimeout(150);
        await p.evaluate(() => window.tdocFeedback.comment());
        await p.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
        await hoverOn(p, '#plan-starter');
        const h = await hint(p);
        assert(Boolean(h) === want, `dev_flags ${JSON.stringify(devFlags)}: hint ${JSON.stringify(h)}`);
        await p.close();
      }
    });

    await test('flag off: no tag on a React page', async () => {
      const { p } = await open(desk, '/', false);
      await hoverOn(p, '#plan-pro');
      assert((await hint(p)) === null, 'a tag with the flag off');
      await p.close();
    });
    await desk.close();

    await test('phone width: the tag stays on one line inside the screen', async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const { p, errors } = await open(phone, '/');
      await hoverOn(p, '#buy-starter');
      const h = await hint(p);
      assert(h, 'no hint at phone width');
      assert(h.rect.left >= 0 && h.rect.right <= 390 && h.rect.height < 24, `tag off screen or wrapped: ${JSON.stringify(h.rect)}`);
      await shot(p, 'phone-hover');
      assert(errors.length === 0, errors.join('\n'));
      await phone.close();
    });
  } finally {
    await browser.close();
    server.kill();
    app.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
