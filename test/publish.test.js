// tdoc local-publish flow test.
// Spawns server.js with TDOC_DRY_PUBLISH=1, drives a Playwright session
// against http://localhost:<port>/d/<slug>/v/<n>, clicks Publish, and
// verifies the modal walks through dry-run mode and surfaces a URL.
//
// Run: NODE_PATH=/private/tmp/node_modules node test/publish.test.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const HOST = '127.0.0.1';
let PORT = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-pub-'));
const SLUG = 'publish-test';
const DOC_DIR = path.join(TMP, SLUG, 'v1');
fs.mkdirSync(DOC_DIR, { recursive: true });
fs.writeFileSync(path.join(DOC_DIR, 'index.html'),
  '<!doctype html><html><body><h1>publish test</h1><p>A doc to publish.</p></body></html>');
fs.writeFileSync(path.join(TMP, SLUG, 'meta.json'),
  JSON.stringify({ title: 'Publish test', versions: [{ n: 1 }] }, null, 2));

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e.stack || e.message || e}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, HOST, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

(async () => {
  PORT = await freePort();
  const serverBin = path.join(__dirname, '..', 'server', 'server.js');
  const proc = spawn('node', [serverBin], {
    env: { ...process.env, TDOC_PORT: String(PORT), TDOC_HOST: HOST, TDOC_DIR: TMP, TDOC_DRY_PUBLISH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for "tdoc server:" line
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout')), 5000);
    proc.stdout.on('data', d => { if (d.toString().includes('tdoc server')) { clearTimeout(to); res(); } });
    proc.stderr.on('data', d => process.stderr.write(d));
  });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1400, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(`http://${HOST}:${PORT}/d/${SLUG}/v/1`, { waitUntil: 'networkidle' });

  await t('Publish button visible on local doc', async () => {
    const btn = await page.$('#tdoc-publish-btn');
    if (!btn) throw new Error('no #tdoc-publish-btn');
    const txt = await btn.textContent();
    if (!txt.includes('Publish')) throw new Error(`label "${txt}"`);
  });

  await t('Share button NOT visible on local doc', async () => {
    const s = await page.$('#tdoc-share-btn');
    if (s) throw new Error('Share button should not appear in local mode');
  });

  await t('Click Publish opens modal with slug + Publish action', async () => {
    await page.click('#tdoc-publish-btn');
    // The React shell renders dialogs through the shared AppDialog facade
    // (Base UI portal) — the contract is an accessible dialog, not a fixed id.
    await page.waitForSelector('[role="dialog"] .ui-dialog-popup, .ui-dialog-popup[role="dialog"]', { timeout: 2000 });
    const slugTxt = await page.$eval('#tdoc-pub-slug', el => el.textContent);
    if (slugTxt !== SLUG) throw new Error(`slug "${slugTxt}"`);
    const go = await page.$('#tdoc-pub-go');
    if (!go) throw new Error('no Publish button in modal');
  });

  await t('Clicking Publish (dry-run) → result URL surfaces', async () => {
    await page.click('#tdoc-pub-go');
    await page.waitForSelector('#tdoc-pub-url', { timeout: 5000 });
    const url = await page.$eval('#tdoc-pub-url', el => el.textContent.trim());
    if (!url.startsWith('https://')) throw new Error(`dry url: "${url}"`);
    if (!url.includes(SLUG)) throw new Error(`url missing slug: "${url}"`);
  });

  await t('GET /api/publish-style smoke (POST dry-run returns ok)', async () => {
    const r = await fetch(`http://${HOST}:${PORT}/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG }),
    });
    const data = await r.json();
    if (!data.ok || !data.dry) throw new Error('dry POST did not return ok+dry: ' + JSON.stringify(data));
    if (!data.url.includes(SLUG)) throw new Error('dry url missing slug: ' + data.url);
  });

  await t('Invalid slug rejected by /api/publish', async () => {
    const r = await fetch(`http://${HOST}:${PORT}/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'bad slug!' }),
    });
    if (r.status !== 400) throw new Error('expected 400, got ' + r.status);
  });

  await browser.close();
  proc.kill();
  // tmp cleanup
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
