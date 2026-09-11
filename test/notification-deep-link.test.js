// A notification click lands on the comment it is about — from anywhere.
//
// The same-document case always worked: the frame had already laid the pins
// out, so the deep-link effect found the target's cluster and scrolled to it.
// Arriving from another page did not. The comments came back before the
// frame's first `tdoc:pins`, the effect saw no cluster, read that as "anchor
// lost", opened a floating card at the top and cleared the target — so the
// document never scrolled, and the click looked like it went nowhere (JUL-38).
//
// The document here is made long on purpose: the target sits far below the
// fold, which is the only place the difference between "scrolled to it" and
// "opened a card somewhere" is visible.
//
// The third case is the one the old fallback existed for (#328): the anchor's
// words are gone, so the frame gives the comment a seat at the end of the
// document instead of a pin on a sentence. The link has to land there too.
//
// Gated: playwright. Boots server.js against a copy of the fixtures with the
// e2e inbox on, seeds one notification, and clicks it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('notification-deep-link.test.js');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, error) { console.log(`  ✗ ${name}\n    ${error.message || error}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (error) { bad(name, error); } }

const USER = 'tester';
const SLUG = 'sample-doc';
const COMMENT = 'c_fixture_1';

function reservePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
async function waitForServer(url, ms = 15000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not come up');
}

(async () => {
  // A private copy of the fixtures: the doc is lengthened and an inbox is
  // written, and neither belongs in the committed tree.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-deeplink-'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'tdocs'), root, { recursive: true });
  const docPath = path.join(root, SLUG, 'v2', 'index.html');
  const original = fs.readFileSync(docPath, 'utf8');
  const filler = Array.from({ length: 120 }, (_, i) => `<p>Filler ${i}: pushes the commented section far below the fold.</p>`).join('\n');
  const ANCHOR_WORDS = 'A second section with its own heading';
  if (!original.includes(ANCHOR_WORDS)) throw new Error('fixture no longer carries the anchored sentence');
  const writeDoc = ({ orphan = false } = {}) => {
    let html = original.replace('<h2>Section Two', `${filler}\n<h2>Section Two`);
    if (orphan) html = html.replace(ANCHOR_WORDS, 'Rewritten words the anchor can no longer find');
    fs.writeFileSync(docPath, html);
  };
  writeDoc();
  const inboxFile = path.join(root, `.inbox-${USER}.json`);
  const seedInbox = () => fs.writeFileSync(inboxFile, JSON.stringify({ items: [{
    id: 'n1', kind: 'comment', group_key: 'g1', slug: SLUG, version: 2,
    comment_id: COMMENT, thread_id: COMMENT,
    actor: { login: 'alice', name: 'alice', avatar_url: '' },
    preview: 'Fixture comment', title: SLUG, at: new Date().toISOString(), read: false, count: 1,
  }] }));

  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: USER },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  try {
    await waitForServer(`${base}/d/${SLUG}/v/2`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    // Open the account menu, then Notifications, then click the one row.
    async function clickNotification(startUrl) {
      seedInbox();
      await page.goto(startUrl, { waitUntil: 'networkidle' });
      await page.click('.tdoc-account-trigger');
      await page.waitForSelector('.ui-menu-popup', { timeout: 3000 });
      await page.locator('.ui-menu-popup').getByText(/^Notifications/).click();
      await page.waitForSelector('.tdoc-notification-list .tdoc-cluster-row', { timeout: 5000 });
      await page.locator('.tdoc-notification-list .tdoc-cluster-row').first().click();
    }
    // Landed on the comment: its card is open AND its pin is on screen — a
    // floating card with the pin still below the fold is the failure.
    async function landed({ unanchored = false } = {}) {
      await page.waitForSelector('.tdoc-margin-comment.active', { timeout: 5000 });
      const isUnanchored = await page.$eval('.tdoc-margin-comment.active', (el) => el.classList.contains('tdoc-unanchored'));
      if (isUnanchored !== unanchored) throw new Error(`card ${isUnanchored ? 'is' : 'is not'} unanchored, expected ${unanchored ? 'unanchored' : 'anchored'}`);
      await page.waitForSelector('.tdoc-pin', { timeout: 5000 });
      const pin = await page.$eval('.tdoc-pin', (el) => el.getBoundingClientRect().top);
      const height = await page.evaluate(() => window.innerHeight);
      if (!(pin > 0 && pin < height)) throw new Error(`pin is not on screen (top=${Math.round(pin)}, viewport=${height})`);
      const url = new URL(page.url());
      if (url.pathname !== `/d/${SLUG}/v/2` || url.searchParams.get('comment') !== COMMENT) {
        throw new Error(`unexpected url ${url.pathname}${url.search}`);
      }
    }

    await t('a notification clicked on the same document scrolls to its comment', async () => {
      await clickNotification(`${base}/d/${SLUG}/v/2`);
      await landed();
    });

    await t('a notification clicked from another page arrives on its comment, scrolled into view', async () => {
      await clickNotification(`${base}/d/${SLUG}/v/1`);
      await landed();
    });

    await t('a notification for a comment whose anchor is gone still lands on its seat', async () => {
      writeDoc({ orphan: true });
      await clickNotification(`${base}/d/${SLUG}/v/1`);
      await landed({ unanchored: true });
    });
  } finally {
    if (browser) await browser.close();
    try { child.kill('SIGTERM'); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
