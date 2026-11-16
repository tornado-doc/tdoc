// A comment face that cannot load shows the author's initial, not a broken
// image. The feedback overlay renders inside somebody else's app, whose CSP
// img-src blocks GitHub's and Clerk's avatar hosts (app.hustlefree.ai,
// 2026-11-02): every face in the cards and the margin pins was a broken
// icon. Served here with the same kind of CSP (img-src 'self' data:).
// Run with: node test/author-face-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('author-face-ui.test.js');

const ROOT = path.join(__dirname, '..');

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-author-face-ui-'));
  const config = path.join(ROOT, `.vite-author-face-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/author-face.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

(async () => {
  console.log('Comment faces under a host CSP');
  const out = build();
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((request, response) => {
    const pathname = request.url.split('?')[0];
    response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
    if (pathname === '/h.js' || pathname === '/h.css') {
      response.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return response.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    }
    response.setHeader('content-type', 'text/html');
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (const id of ['card-blocked', 'pin-blocked']) {
      try {
        await page.locator(`#${id} .tdoc-avatar-fallback`).waitFor({ state: 'attached', timeout: 5000 });
        assert.equal((await page.locator(`#${id} .tdoc-avatar-fallback`).textContent()).trim(), 'J');
        assert.equal(await page.locator(`#${id} img`).count(), 0, `${id} still has an <img>`);
        console.log(`  ✓ ${id}: a blocked picture falls back to the initial`);
      } catch (error) { failed++; console.log(`  ✗ ${id}\n    ${error.message}`); }
    }
    for (const id of ['card-shown', 'pin-shown']) {
      try {
        await page.locator(`#${id} img`).waitFor({ timeout: 5000 });
        assert.ok(await page.locator(`#${id} img`).evaluate((img) => img.complete && img.naturalWidth > 0), `${id} picture did not load`);
        assert.equal(await page.locator(`#${id} .tdoc-avatar-fallback`).count(), 0);
        console.log(`  ✓ ${id}: an allowed picture is still shown`);
      } catch (error) { failed++; console.log(`  ✗ ${id}\n    ${error.message}`); }
    }
    // tdoc AI wears one face everywhere: tdoc's strokes with the Ask AI star
    // on an accent badge, drawn inline (nothing for a host CSP to block).
    // An agent reply tdoc cannot name gets it too; a real provider keeps
    // its own mark.
    for (const id of ['card-tdoc-ai', 'card-ask-ai', 'card-unknown-agent', 'pin-tdoc-ai']) {
      try {
        const mark = page.locator(`#${id} .tdoc-agent-provider-mark.is-tdoc-ai svg.tdoc-ai-mark`);
        await mark.waitFor({ timeout: 5000 });
        assert.equal(await page.locator(`#${id} img`).count(), 0, `${id} draws a picture`);
        assert.equal(await mark.locator('path[stroke], g[stroke] path').count(), 5, 'the five tdoc strokes');
        const box = await mark.boundingBox();
        assert.ok(box.width >= 18 && box.width <= 28 && box.width === box.height, `${id}: ${JSON.stringify(box)}`);
        console.log(`  ✓ ${id}: tdoc AI's mark`);
      } catch (error) { failed++; console.log(`  ✗ ${id}\n    ${error.message}`); }
    }
    try {
      assert.equal(await page.locator('#card-claude .tdoc-agent-provider-mark svg[viewBox="0 0 248 248"]').count(), 1);
      assert.equal(await page.locator('#card-claude .tdoc-ai-mark').count(), 0);
      console.log('  ✓ card-claude: an agent with provider info keeps its own mark');
    } catch (error) { failed++; console.log(`  ✗ card-claude\n    ${error.message}`); }
    try {
      for (const size of [16, 32]) {
        const fit = await page.locator(`#face-${size} .tdoc-notif-avatar`).evaluate((el) => {
          const svg = el.querySelector('.tdoc-ai-mark');
          const badge = svg.querySelector(':scope > circle');
          const a = el.getBoundingClientRect(); const b = badge.getBoundingClientRect();
          const r = a.width / 2; const cx = a.left + r; const cy = a.top + r;
          // The badge's far edge stays inside the round face it is cropped to.
          const far = Math.hypot(b.left + b.width / 2 - cx, b.top + b.height / 2 - cy) + b.width / 2;
          return { face: a.width, mark: svg.getBoundingClientRect().width, far, r, right: b.left > cx, bottom: b.top > cy };
        });
        assert.equal(fit.mark, size, `${size}px: the mark fills the face`);
        assert.ok(fit.right && fit.bottom, `${size}px: the badge is in the bottom-right`);
        assert.ok(fit.far <= fit.r + 0.5, `${size}px: the badge is cropped by the circle ${JSON.stringify(fit)}`);
      }
      console.log('  ✓ 16px and 32px: the mark fills the face, badge bottom-right inside the circle');
    } catch (error) { failed++; console.log(`  ✗ sizes\n    ${error.message}`); }
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
})();
