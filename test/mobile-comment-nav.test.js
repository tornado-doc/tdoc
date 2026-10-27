// Phone: a highlight opens its comment, every time; a comment in the list
// takes you to its highlight (Julie, 2026-10-13). Every other tap on a
// highlight used to be spent "closing" a card the shut drawer was hiding.
// Run with: node test/mobile-comment-nav.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium, devices } = requirePlaywrightOrSkip('mobile-comment-nav.test.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message || e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
function waitForServer(port, timeout = 5000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/ping' }, (res) => { res.resume(); resolve(); });
      r.on('error', () => (Date.now() >= deadline ? reject(new Error('local server did not start')) : setTimeout(poll, 80)));
    })();
  });
}

(async () => {
  console.log('mobile comment navigation');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-mobile-nav-'));
  const slug = 'phone-doc';
  fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
  const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Filler paragraph ${i} that pushes the next anchor further down the page so it has to be scrolled to.</p>`).join('\n');
  fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Phone</title></head><body><main>
<h1>Phone doc</h1>
<p>First target alpha sits near the top.</p>
${filler(30)}
<p>Second target bravo sits in the middle.</p>
${filler(30)}
<p>Third target charlie sits at the end.</p>
</main></body></html>`);
  const c = (id, word, before, after) => ({
    id, version: 1, anchor: { kind: 'text', text: word, context_before: before, context_after: after },
    text: `about ${word}`, author: { login: 'owner', name: 'owner', avatar_url: '' },
    status: 'open', created: '2026-10-01T00:00:00Z', replies: [], reactions: {},
  });
  fs.writeFileSync(path.join(root, slug, 'comments.json'), JSON.stringify([
    c('c_alpha', 'alpha', 'First target ', ' sits'),
    c('c_bravo', 'bravo', 'Second target ', ' sits'),
    c('c_charlie', 'charlie', 'Third target ', ' sits'),
  ]));
  fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: 'Phone doc', versions: [{ n: 1, created: new Date().toISOString() }] }));
  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitForServer(port);
    browser = await chromium.launch();
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/d/${slug}/v/1`);
    await page.waitForSelector('.tdoc-fab');
    const frame = page.frames().find((f) => /\/frame/.test(f.url()));
    await frame.waitForFunction(() => CSS.highlights.get('tdoc-anchor') && CSS.highlights.get('tdoc-anchor').size === 3);
    const iframeBox = await (await page.$('iframe')).boundingBox();
    const tapHighlight = async (word) => {
      const pt = await frame.evaluate((w) => {
        const r = [...CSS.highlights.get('tdoc-anchor')].find((x) => x.toString() === w);
        let rc = r.getBoundingClientRect();
        window.scrollTo(0, rc.top + scrollY - 200);
        rc = r.getClientRects()[0];
        return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
      }, word);
      await page.waitForTimeout(150);
      await page.touchscreen.tap(iframeBox.x + pt.x, iframeBox.y + pt.y);
    };
    const selectedVisible = (id) => page.evaluate((cid) => {
      const card = document.querySelector(`#tdoc-comment-layer [data-comment-id="${cid}"]`);
      if (!card) return false;
      const r = card.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight + 1;
    }, id);
    const closeDrawer = async () => {
      // The way people shut it: a tap on the dimmed page above the sheet.
      await page.touchscreen.tap(195, 70);
      await page.waitForFunction(() => !document.querySelector('#tdoc-comment-layer'));
    };

    await test('tapping highlights opens their comment every time, scrolled into view', async () => {
      for (const [word, id] of [['charlie', 'c_charlie'], ['bravo', 'c_bravo'], ['alpha', 'c_alpha'], ['charlie', 'c_charlie']]) {
        await tapHighlight(word);
        await page.waitForSelector('#tdoc-comment-layer', { timeout: 3000 }).catch(() => { throw new Error(`tap on "${word}" did not open the comments`); });
        await page.waitForFunction((cid) => {
          const card = document.querySelector(`#tdoc-comment-layer [data-comment-id="${cid}"]`);
          if (!card) return false;
          const r = card.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight + 1;
        }, id, { timeout: 3000 }).catch(() => { throw new Error(`"${word}" opened the list but not at its comment`); });
        await closeDrawer();
      }
    });

    await test('a bare tap with no click (iOS on plain text) still opens the comment', async () => {
      // iOS Safari fires touch events but no click for a tap on plain text;
      // send exactly that and nothing else.
      const pt = await frame.evaluate(() => {
        const r = [...CSS.highlights.get('tdoc-anchor')].find((x) => x.toString() === 'bravo');
        let rc = r.getBoundingClientRect();
        window.scrollTo(0, rc.top + scrollY - 200);
        rc = r.getClientRects()[0];
        return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
      });
      await page.waitForTimeout(150);
      await frame.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [touch] }));
      }, pt);
      await page.waitForSelector('#tdoc-comment-layer [data-comment-id="c_bravo"]', { timeout: 3000 });
      await page.touchscreen.tap(195, 70);
      await page.waitForFunction(() => !document.querySelector('#tdoc-comment-layer'));
    });

    await test('tapping a comment in the list closes it and brings its highlight into view', async () => {
      await frame.evaluate(() => window.scrollTo(0, 0));
      await page.locator('.tdoc-fab').tap();
      await page.waitForSelector('#tdoc-comment-layer');
      const card = page.locator('#tdoc-comment-layer [data-comment-id="c_charlie"]');
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      await page.touchscreen.tap(box.x + 30, box.y + 24);
      await page.waitForFunction(() => !document.querySelector('#tdoc-comment-layer'), null, { timeout: 3000 });
      await page.waitForTimeout(400);
      const where = await frame.evaluate(() => {
        const r = [...CSS.highlights.get('tdoc-anchor')].find((x) => x.toString() === 'charlie').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: innerHeight };
      });
      assert(where.top >= 0 && where.bottom <= where.h, `highlight not in view after the jump: ${JSON.stringify(where)}`);
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
