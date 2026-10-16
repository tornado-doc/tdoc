// Team comment overview: all-team browsing is a page, not a bell clone. Locks
// the four filters, deep links, progressive pagination and phone layout.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('team-comments-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-team-comments-ui-'));
  const config = path.join(ROOT, `.vite-team-comments-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/team-comments.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

const rows = [
  { id: 'c_sky', thread_id: 'c_sky', kind: 'comment', reply_count: 1, slug: 'daily-report', title: 'Daily report', version: 4, text: 'This table needs more context.', anchor: 'Paid conversion by country', created: '2026-10-15T23:30:00Z', resolved: false, author: { key: 'sky', name: 'Sky', avatar_url: '', kind: 'human' } },
  { id: 'r_claire', thread_id: 'c_sky', parent_id: 'c_sky', kind: 'reply', reply_count: 1, slug: 'daily-report', title: 'Daily report', version: 4, text: 'Added the missing comparison.', anchor: 'Paid conversion by country', created: '2026-10-15T23:40:00Z', resolved: false, author: { key: 'claire', name: 'Claire', avatar_url: '', kind: 'human' } },
  { id: 'c_waiting', thread_id: 'c_waiting', kind: 'comment', reply_count: 0, slug: 'daily-report', title: 'Daily report', version: 4, text: 'Can someone check the source?', anchor: 'Weekly revenue', created: '2026-10-15T22:30:00Z', resolved: false, author: { key: 'sky', name: 'Sky', avatar_url: '', kind: 'human' } },
  { id: 'c_ai', thread_id: 'c_ai', kind: 'comment', reply_count: 0, slug: 'daily-report', title: 'Daily report', version: 4, text: 'Automated review note.', anchor: 'Summary', created: '2026-10-15T21:30:00Z', resolved: false, author: { key: 'codex', name: 'Codex', avatar_url: '', kind: 'agent' } },
  { id: 'c_done', thread_id: 'c_done', kind: 'comment', reply_count: 0, slug: 'onboarding', title: 'Onboarding choices', version: 2, text: 'Fixed in the new copy.', anchor: 'Choose your goal', created: '2026-09-01T10:00:00Z', resolved: true, author: { key: 'julie', name: 'Julie', avatar_url: '', kind: 'human' } },
];

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}

(async () => {
  console.log('Team comment overview UI');
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

  async function open(width) {
    const context = await browser.newContext({ viewport: { width, height: 780 } });
    const page = await context.newPage();
    const calls = [];
    await page.route('**/api/team/comments?*', async (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset')) || 0;
      calls.push(offset);
      await route.fulfill({ json: offset === 0
        ? { ok: true, items: rows.slice(0, 3), next: 12, docs_scanned: 12, docs_total: 14 }
        : { ok: true, items: rows.slice(3), next: null, docs_scanned: 2, docs_total: 14 } });
    });
    await page.goto(base);
    await page.waitForSelector('.tm-comment-row');
    await page.waitForFunction(() => document.querySelectorAll('.tm-comment-row').length === 4);
    return { context, page, calls };
  }

  try {
    await t('loads every page, defaults to unresolved, and links to the exact comment', async () => {
      const { context, page, calls } = await open(1100);
      assert.deepEqual(calls, [0, 12]);
      assert.equal(await page.locator('.tm-comment-row').count(), 4);
      assert.match(await page.locator('.tm-comment-row').first().getAttribute('href'), /\/d\/daily-report\/v\/4\?comment=r_claire/);
      assert.match(await page.locator('.tm-comment-row').first().textContent(), /Claire.*replied in.*Daily report.*Unresolved/);
      assert.match(await page.locator('.tm-comment-anchor').first().textContent(), /Paid conversion by country/);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'team-comments-desktop.png'), fullPage: true }); }
      await context.close();
    });

    await t('status, person, doc and date filters narrow the overview', async () => {
      const { context, page } = await open(1100);
      await page.getByRole('combobox', { name: 'Comment status' }).click();
      await page.getByRole('option', { name: 'All status' }).click();
      assert.equal(await page.locator('.tm-comment-row').count(), 5);
      await page.getByRole('combobox', { name: 'Comment author' }).click();
      await page.getByRole('option', { name: 'Sky' }).click();
      assert.equal(await page.locator('.tm-comment-row').count(), 2);
      await page.getByRole('combobox', { name: 'Comment author' }).click();
      await page.getByRole('option', { name: 'All people' }).click();
      await page.getByRole('combobox', { name: 'Comment document' }).click();
      await page.getByRole('option', { name: 'Onboarding choices' }).click();
      assert.equal(await page.locator('.tm-comment-row').count(), 1);
      await page.getByRole('combobox', { name: 'Comment document' }).click();
      await page.getByRole('option', { name: 'All docs' }).click();
      await page.locator('input[type=date]').fill('2026-10-01');
      assert.equal(await page.locator('.tm-comment-row').count(), 4);
      await context.close();
    });

    await t('unreplied and author-type filters compose', async () => {
      const { context, page } = await open(1100);
      await page.getByRole('combobox', { name: 'Reply status' }).click();
      await page.getByRole('option', { name: 'Unreplied' }).click();
      assert.equal(await page.locator('.tm-comment-row').count(), 2);
      assert.match(await page.locator('.tm-comment-row').allTextContents().then((rows) => rows.join(' ')), /Sky.*Codex/);
      await page.getByRole('combobox', { name: 'Author type' }).click();
      await page.getByRole('option', { name: 'People only' }).click();
      assert.equal(await page.locator('.tm-comment-row').count(), 1);
      assert.match(await page.locator('.tm-comment-row').first().textContent(), /Sky/);
      await context.close();
    });

    await t('phone view has 44px filters and no sideways overflow', async () => {
      const { context, page } = await open(390);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('.tm-comment-filter, .tm-comment-since input')].map((el) => el.getBoundingClientRect().height),
      }));
      assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
      assert.ok(layout.controls.every((height) => height >= 44), JSON.stringify(layout.controls));
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'team-comments-phone.png'), fullPage: true }); }
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
