// The Share panel offers three plain choices -- specific people / team,
// anyone with the link, public -- each with one line saying what it means.
// A new doc opens on "Anyone with the link", whose "Require sign-in to view"
// switch sits under it. Desktop (1280) and phone (390).
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('share-access-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-share-access-ui-'));
  const config = path.join(ROOT, `.vite-share-access-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/share-access.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

const OPTIONS = [
  ['Specific people / team', 'Only people you add.'],
  ['Anyone with the link', 'Not listed or searchable.'],
  ['Public', 'Listed on the web and searchable by search engines.'],
];

(async () => {
  console.log('Share panel access choices');
  const out = build();
  const patches = [];
  const teamInvites = [];
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/h.js' || pathname === '/h.css') {
      res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    }
    if (pathname === '/api/doc/access' && req.method === 'PATCH') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const { access } = JSON.parse(body);
        patches.push(access);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, access: { visibility: 'unlisted', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [], ...access } }));
      });
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const open = async (width, doc = '') => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    if (doc.includes('guests=1')) {
      await page.addInitScript(() => { window.__TDOC_APP_BOOT__ = { devMode: { on: true } }; });
      await page.route('**/api/team?*', (route) => route.fulfill({ json: { ok: true, team: {
        id: 'tm_1', name: 'BeFreed', role: 'admin', invites: [], members: [{ email: 'alice@befreed.ai', key: 'alice', role: 'admin' }],
      } } }));
      await page.route('**/api/team/guests?*', (route) => route.fulfill({ json: { ok: true, guests: [], limit: 5, invites: [] } }));
      await page.route('**/api/team', (route) => {
        teamInvites.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true, team: {
        id: 'tm_1', name: 'BeFreed', role: 'admin', invites: ['bob@befreed.ai'], members: [{ email: 'alice@befreed.ai', key: 'alice', role: 'admin' }],
      } } });
      });
    }
    await page.goto(`${base}/${doc ? `?doc=${doc}` : ''}`);
    await page.getByRole('dialog', { name: 'Share' }).waitFor();
    return page;
  };
  const choices = (page) => page.locator('.tdoc-access-option').evaluateAll((rows) => rows.map((row) => [
    row.querySelector('.tdoc-access-label').textContent, row.querySelector('.tdoc-access-hint').textContent, row.getAttribute('aria-checked'),
  ]));

  try {
    for (const width of [1280, 390]) {
      await t(`${width}px: three choices with one plain line each; a new doc is "Anyone with the link"`, async () => {
        const page = await open(width);
        const rows = await choices(page);
        assert.deepEqual(rows.map(([l, h]) => [l, h]), OPTIONS);
        assert.deepEqual(rows.map((r) => r[2]), ['false', 'true', 'false']);
        await page.getByRole('switch').waitFor();
        assert.match(await page.locator('.tdoc-access-sub').textContent(), /Require sign-in to view/);
        const layout = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          rows: [...document.querySelectorAll('.tdoc-access-option')].map((el) => {
            const r = el.getBoundingClientRect();
            return { h: r.height, right: r.right };
          }),
          hints: [...document.querySelectorAll('.tdoc-access-hint')].map((el) => el.scrollWidth <= el.clientWidth + 1),
        }));
        assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
        assert.ok(layout.rows.every((r) => r.h >= 44 && r.right <= layout.width), JSON.stringify(layout.rows));
        assert.ok(layout.hints.every(Boolean), 'a hint overflows its row');
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `share-access-${width}.png`), fullPage: true }); }
        await page.close();
      });
    }
    await t('the default choice creates a team invitation without sharing this document directly', async () => {
      patches.length = 0;
      teamInvites.length = 0;
      const page = await open(1280, 'team&guests=1');
      const input = page.getByPlaceholder('Add an email or GitHub username…');
      await input.fill('bob@befreed.ai');
      await input.press('Enter');
      await page.getByRole('button', { name: 'Invite to team (uses a seat)' }).click();
      await page.getByText('Team invitation saved.').waitFor();
      assert.equal(teamInvites.length, 1);
      assert.deepEqual(teamInvites[0].invites, ['bob@befreed.ai']);
      assert.equal(patches.length, 0, 'document access was not changed');
      await page.close();
    });

    await t('choosing Public saves visibility public and drops the sign-in switch', async () => {
      const page = await open(1280);
      patches.length = 0;
      await page.getByRole('radio', { name: /Public/ }).click();
      await page.getByText('Saved.').waitFor();
      assert.deepEqual(patches, [{ visibility: 'public' }]);
      assert.equal(await page.getByRole('switch').count(), 0);
      assert.equal(await page.getByRole('radio', { name: /Public/ }).getAttribute('aria-checked'), 'true');
      await page.close();
    });

    await t('Require sign-in to view saves signin_required', async () => {
      const page = await open(1280);
      patches.length = 0;
      await page.getByRole('switch').click();
      await page.getByText('Saved.').waitFor();
      assert.deepEqual(patches, [{ signin_required: true }]);
      assert.match(await page.locator('.manage-hint').first().textContent(), /signed in/);
      await page.close();
    });

    await t('an existing Public doc opens on Public; a team doc on Specific people / team with its team switch', async () => {
      const pub = await open(1280, 'public');
      assert.deepEqual((await choices(pub)).map((r) => r[2]), ['false', 'false', 'true']);
      await pub.close();
      const team = await open(390, 'team');
      assert.deepEqual((await choices(team)).map((r) => r[2]), ['true', 'false', 'false']);
      assert.match(await team.locator('.tdoc-access-sub').textContent(), /Everyone in BeFreed/);
      if (SHOTS) await team.screenshot({ path: path.join(SHOTS, 'share-access-team-390.png'), fullPage: true });
      await team.close();
    });
    for (const width of [1280, 390]) {
      await t(`${width}px: same-domain invite defaults to a team seat, with document-only guest choice`, async () => {
        patches.length = 0;
        const page = await open(width, 'team&guests=1');
        const input = page.getByPlaceholder('Add an email or GitHub username…');
        await input.fill('bob@befreed.ai');
        await input.press('Enter');
        await page.getByRole('button', { name: 'Invite to team (uses a seat)' }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Only this document (guest)' }).count(), 1);
        assert.equal(patches.some((patch) => patch.allowed_users?.includes('bob@befreed.ai')), false, 'no guest share before choice');
        await page.getByRole('button', { name: 'Only this document (guest)' }).click();
        await page.getByText('Saved.').waitFor();
        assert.equal(patches.at(-1).allowed_users[0], 'bob@befreed.ai');
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `share-guests-${width}.png`), fullPage: true });
        await page.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
