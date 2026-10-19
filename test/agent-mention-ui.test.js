// @-mentioning the doc's agent by name: offered first after @, tagging it hands
// the comment to the agent, the button carries its name, and the posted text
// cannot be read by the server as a person to invite.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('agent-mention-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-agent-mention-ui-'));
  const config = path.join(ROOT, `.vite-agent-mention-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/agent-mention.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}

(async () => {
  console.log('Agent @-mention UI');
  const out = build();
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((request, response) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/h.js' || pathname === '/h.css') {
      response.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return response.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    }
    response.setHeader('content-type', 'text/html');
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  try {
    for (const width of [1050, 390]) {
      await t(`@ offers the agent by name and tagging it hands the comment over (${width}px)`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 820 } });
        const page = await context.newPage();
        await page.goto(base);
        const button = page.locator('button.submit.agent');
        assert.equal((await button.textContent()).trim(), '@Claude');
        const box = page.locator('textarea');
        await box.click();
        await box.type('please fix @cl');
        const first = page.locator('.tdoc-mention-option').first();
        await first.waitFor();
        assert.match(await first.textContent(), /@Claude.*Agent · gets this comment/);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `agent-mention-${width}.png`) }); }
        await page.keyboard.press('Enter');
        assert.equal(await box.inputValue(), 'please fix @Claude ');
        await page.getByRole('button', { name: 'Comment', exact: true }).click();
        await page.waitForFunction(() => window.__posts.length === 1);
        const post = await page.evaluate(() => window.__posts[0]);
        assert.equal(post.opts.sendToAgent, true, 'a tagged comment was not handed to the agent');
        assert.equal(post.text, 'please fix @\u2060Claude ', 'the tag would reach the server as a person');
        assert.ok(!/(^|[^A-Za-z0-9_@\/-])@([A-Za-z0-9])/.test(post.text), 'server mention pattern still matches');
        await context.close();
      });
    }
    await t('a plain comment that does not tag the agent is not handed over', async () => {
      const context = await browser.newContext({ viewport: { width: 1050, height: 820 } });
      const page = await context.newPage();
      await page.goto(base);
      await page.locator('textarea').fill('looks good @dana');
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await page.waitForFunction(() => window.__posts.length === 1);
      const post = await page.evaluate(() => window.__posts[0]);
      assert.equal(post.opts.sendToAgent, false);
      assert.equal(post.text, 'looks good @dana');
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
  else console.log('\nall passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
