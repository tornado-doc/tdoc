// @ in the composer offers the agents Send to agent would, in its order:
// the first two with nothing typed, every match once a name is typed, in an
// "Agents" group above people. Picking one hands the comment to that agent,
// and the tag in the text is never a GitHub @login. A reader who cannot send
// to agents sees people only.
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
const JOINER = '⁠';

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
  const open = async (width, query = '') => {
    const context = await browser.newContext({ viewport: { width, height: 820 } });
    const page = await context.newPage();
    // The people half asks GitHub when nobody here matches; keep it offline.
    await page.route('https://api.github.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    await page.goto(`${base}/${query}`);
    return { context, page };
  };
  const rows = (page) => page.locator('.tdoc-mention-menu').evaluate((menu) => [...menu.children].map((el) => (
    el.classList.contains('tdoc-mention-group') ? `# ${el.textContent}` : el.textContent.replace(/\s+/g, ' ').trim()
  )));

  try {
    for (const width of [1050, 390]) {
      await t(`@ lists two agents above people; typing searches them all; picking hands over (${width}px)`, async () => {
        const { context, page } = await open(width);
        const box = page.locator('textarea');
        await box.click();
        await box.type('please fix @');
        await page.locator('.tdoc-mention-option').first().waitFor();
        const empty = await rows(page);
        assert.deepEqual(empty.slice(0, 3), ['# Agents', "xiaocc · julieMine · this doc's agent", 'Claude Code · julieMine'], JSON.stringify(empty));
        assert.equal(empty[3], '# People', JSON.stringify(empty));
        assert.ok(empty[4].startsWith('@dana'), JSON.stringify(empty));
        assert.ok(!empty.some((r) => /^@claude\b/i.test(r)), 'a fake @claude person is offered');
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `agent-mention-${width}.png`) }); }

        await box.type('cod');
        await page.waitForFunction(() => document.querySelectorAll('.tdoc-mention-agent').length === 2);
        const typed = await rows(page);
        assert.deepEqual(typed, ['# Agents', 'Codex · julieMine', 'Claude Code · julieMine'], JSON.stringify(typed));
        await page.keyboard.press('Enter');
        assert.equal(await box.inputValue(), `please fix @${JOINER}Codex · julie `);
        await page.getByRole('button', { name: 'Comment', exact: true }).click();
        await page.waitForFunction(() => window.__posts.length === 1);
        const post = await page.evaluate(() => window.__posts[0]);
        assert.equal(post.opts.sendToAgent, true, 'a tagged comment was not handed to the agent');
        assert.equal(post.opts.recipient.agent_sub, 'juliesmac_codex', 'handed to the wrong agent');
        assert.ok(!/(^|[^A-Za-z0-9_@/-])@([A-Za-z0-9])/.test(post.text), 'the server would read the tag as a GitHub login');
        await context.close();
      });
    }

    await t('the fallback agent, past the first two, is found by name', async () => {
      const { context, page } = await open(1050);
      const box = page.locator('textarea');
      await box.click();
      await box.type('@dev');
      await page.locator('.tdoc-mention-agent').first().waitFor();
      assert.deepEqual((await rows(page)).slice(0, 2), ['# Agents', 'devin · julieMine']);
      await context.close();
    });

    await t('a plain comment that tags no agent is not handed over', async () => {
      const { context, page } = await open(1050);
      await page.locator('textarea').fill('looks good @dana');
      // The @ list is open over the composer's only button: close it first.
      await page.locator('.tdoc-popup .h').click();
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await page.waitForFunction(() => window.__posts.length === 1);
      const post = await page.evaluate(() => window.__posts[0]);
      assert.equal(post.opts.sendToAgent, false);
      assert.equal(post.opts.recipient, null);
      await context.close();
    });

    await t('an agent reply reads "<name> · <owner>" and its hover card lists all five facts', async () => {
      const { context, page } = await open(1050, '?view=authors');
      const lines = await page.locator('.author .login').allTextContents();
      assert.deepEqual(lines, ['smarter-tdoc-claw · yayashuxue', 'Codex · julie', '@smarter-tdoc-claw · @julie'], JSON.stringify(lines));
      await page.locator('.tdoc-agent-name').first().hover();
      await page.locator('.tdoc-agent-card').waitFor();
      const card = (await page.locator('.tdoc-agent-card').textContent()).replace(/\s+/g, ' ');
      assert.equal(card, 'Namesmarter-tdoc-clawActs foryayashuxueProgramRaft (Claude)LocationjulieScopePersonal');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'agent-author-card.png') });
      // A local agent wears its program's mark, not a generic terminal.
      assert.equal(await page.locator('.tdoc-agent-provider-mark').nth(1).locator('svg[viewBox="0 0 180 180"]').count(), 1);
      await context.close();
    });

    await t('a reader who cannot send to agents sees people only', async () => {
      const { context, page } = await open(1050, '?agents=0');
      const box = page.locator('textarea');
      await box.click();
      await box.type('@');
      await page.locator('.tdoc-mention-option').first().waitFor();
      const list = await rows(page);
      assert.ok(!list.some((r) => r.startsWith('#')), JSON.stringify(list));
      assert.equal(await page.locator('.tdoc-mention-agent').count(), 0);
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
