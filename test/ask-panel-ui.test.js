// Ask this doc, in a real browser: the bar entry (desktop) and the ⋯ entry
// (phone) open the side panel / bottom sheet; a slow answer shows a thinking
// state; the answer renders as text; Post as comment labels it as AI; the
// last free question turns into the connect-your-agent line. The same panel
// as Send to my agent (private answer, posted anchored) and Copy for my agent.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('ask-panel-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-ask-panel-ui-'));
  const config = path.join(ROOT, `.vite-ask-panel-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/ask-panel.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

(async () => {
  console.log('Ask this doc UI');
  const out = build();
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/h.js' || pathname === '/h.css') {
      res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    }
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name) });
  };
  const ask = async (page, question) => {
    const dialog = page.getByRole('dialog', { name: 'Ask this doc' });
    await dialog.getByRole('textbox', { name: 'Your question' }).fill(question);
    await dialog.getByRole('button', { name: 'Ask', exact: true }).click();
    return dialog;
  };

  try {
    await t('desktop 1280: bar entry opens a side panel; thinking, answer, post as comment', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${base}/?selection=Billing%20ships%20first`);
      await page.getByRole('button', { name: 'Ask AI about this doc' }).click();
      const dialog = page.getByRole('dialog', { name: 'Ask this doc' });
      await dialog.waitFor();
      await dialog.getByText('2 free questions left').waitFor();
      assert.match(await dialog.locator('.tdoc-ask-focus').textContent(), /Billing ships first/);
      // A side panel: docked right, no backdrop, the page beside it still usable.
      const box = await dialog.boundingBox();
      assert.ok(box.x > 1280 - 400 && box.x + box.width <= 1280 && box.y >= 48, JSON.stringify(box));
      assert.equal(await page.locator('.ui-dialog-backdrop').count(), 0, 'side panel has a backdrop');
      await ask(page, 'What ships first?');
      await dialog.getByText(/Thinking… \d+s/).waitFor();
      await shot(page, 'ask-desktop-thinking.png');
      await dialog.locator('.tdoc-ask-answer-text').waitFor({ timeout: 10000 });
      assert.equal(await dialog.locator('.tdoc-ask-answer-text strong').textContent(), 'first');
      assert.equal(await dialog.locator('.tdoc-ask-answer-text li').count(), 2);
      assert.deepEqual(await page.evaluate(() => window.__askCalls), [{ question: 'What ships first?', version: 2, selection: 'Billing ships first' }]);
      await dialog.getByText('1 free question left').waitFor();
      const connect = dialog.getByRole('link', { name: /Connect your own agent for unlimited use and edits/ });
      assert.equal(await connect.getAttribute('href'), '/start');
      // The document can still be scrolled / clicked with the panel open.
      await page.locator('main h1').click();
      assert.ok(await dialog.isVisible(), 'clicking the page closed the side panel');
      await dialog.getByRole('button', { name: 'Post as comment' }).click();
      await dialog.getByRole('button', { name: 'Posted as comment' }).waitFor();
      const posted = await page.locator('#posted').textContent();
      assert.match(posted, /^Q: What ships first\?\n\nAI answer \(Ask this doc\): Billing ships/);
      await shot(page, 'ask-desktop-answer.png');
      await page.close();
    });

    await t('phone 390: ⋯ menu entry opens a bottom sheet that fits; the last question ends at the connect line', async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
      await page.goto(`${base}/?remaining=1&delay=600`);
      assert.equal(await page.getByRole('button', { name: 'Ask AI about this doc' }).isVisible(), false, 'bar entry shows on a phone');
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Ask AI' }).click();
      const dialog = page.getByRole('dialog', { name: 'Ask this doc' });
      await dialog.waitFor();
      await dialog.getByText('1 free question left').waitFor();
      const box = await dialog.boundingBox();
      assert.ok(Math.abs(box.x) < 1 && Math.abs(box.width - 390) < 1 && Math.abs(box.y + box.height - 780) < 2, JSON.stringify(box));
      await ask(page, '这份文档先发布什么？');
      await dialog.locator('.tdoc-ask-answer-text').waitFor({ timeout: 10000 });
      const limit = dialog.getByRole('link', { name: /You’ve used your free questions — connect your own agent for unlimited use and edits/ });
      await limit.waitFor();
      assert.equal(await limit.getAttribute('href'), '/start');
      assert.equal(await dialog.getByRole('textbox', { name: 'Your question' }).count(), 0, 'question box still offered at the limit');
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      const post = dialog.getByRole('button', { name: 'Post as comment' });
      assert.ok((await post.boundingBox()).height >= 28);
      await shot(page, 'ask-phone-limit.png');
      await page.close();
    });

    await t('Send to my agent (desktop): the popover question goes at once, waits, then the private answer posts anchored', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${base}/?mode=agent&selection=Billing%20ships%20first&question=${encodeURIComponent('Why billing first?')}`);
      await page.getByRole('button', { name: 'Ask AI about this doc' }).click();
      const dialog = page.getByRole('dialog', { name: 'Send to my agent' });
      await dialog.getByText(/Goes to Claude Code on sams-mac, your own agent/).waitFor();
      await dialog.getByText(/Sent to Claude Code on sams-mac · waiting for the answer…/).waitFor({ timeout: 5000 });
      assert.deepEqual(await page.evaluate(() => window.__agentCalls.map((c) => [c.question, c.passage && c.passage.text, c.passage && c.passage.context_after])), [['Why billing first?', 'Billing ships first', '. Then']]);
      assert.match(await dialog.locator('.tdoc-ask-result .tdoc-ask-focus').first().textContent(), /Billing ships first/);
      await shot(page, 'agent-desktop-waiting.png');
      // Picked up on the next read, answered on the one after (5 s polls).
      await dialog.getByText(/is working on it/).waitFor({ timeout: 8000 });
      await dialog.locator('.tdoc-ask-answer-text').waitFor({ timeout: 8000 });
      await dialog.getByText(/Answer from Claude Code on sams-mac · only you can see this/).waitFor();
      assert.equal(await dialog.locator('.tdoc-ask-answer-text strong').textContent(), 'first');
      await shot(page, 'agent-desktop-answer.png');
      await dialog.getByRole('button', { name: 'Post as comment' }).click();
      await dialog.getByRole('button', { name: 'Posted as comment' }).waitFor();
      assert.match(await page.locator('#posted').textContent(), /^Q: Why billing first\?\n\nAnswer from my agent \(Claude Code on sams-mac\): Billing ships/);
      const anchor = await page.evaluate(() => window.__postedAnchor);
      assert.equal(anchor && anchor.text, 'Billing ships first', 'the posted answer is anchored to the passage');
      // The panel and the comment composer share the question box's look.
      const border = await dialog.locator('textarea.tdoc-ask-input').evaluate((n) => getComputedStyle(n).borderTopColor);
      assert.equal(border, 'rgb(22, 82, 240)');
      await page.close();
    });

    await t('Copy for my agent (phone): one click copies the line with the link and the passage, and offers the helper', async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
      await page.goto(`${base}/?mode=copy&selection=Billing%20ships%20first`);
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Ask AI' }).click();
      const dialog = page.getByRole('dialog', { name: 'Copy for my agent' });
      await dialog.getByRole('textbox', { name: 'Your question' }).fill('Who owns billing?');
      await dialog.getByRole('button', { name: 'Copy for my agent' }).click();
      await dialog.getByText('Copied. Paste it into your agent.').waitFor();
      assert.deepEqual(await page.evaluate(() => window.__copied), ['Read https://tdoc.dev/d/launch-plan and answer: Who owns billing?\n\nAbout this passage: "Billing ships first"']);
      const helper = dialog.getByRole('link', { name: /Turn on the background helper/ });
      assert.equal(await helper.getAttribute('href'), '/me?view=settings#agents');
      const box = await dialog.boundingBox();
      assert.ok(Math.abs(box.width - 390) < 1, JSON.stringify(box));
      const lines = await dialog.getByRole('button', { name: 'Copy for my agent' }).evaluate((n) => { const r = document.createRange(); r.selectNodeContents(n); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; });
      assert.equal(lines, 1, 'the button label wrapped');
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      await shot(page, 'copy-phone.png');
      await page.close();
    });

    await t('a 429 from the server shows the connect line instead of an error', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${base}/?remaining=0&delay=10`);
      await page.getByRole('button', { name: 'Ask AI about this doc' }).click();
      const dialog = page.getByRole('dialog', { name: 'Ask this doc' });
      await dialog.getByRole('link', { name: /You’ve used your free questions/ }).waitFor();
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
