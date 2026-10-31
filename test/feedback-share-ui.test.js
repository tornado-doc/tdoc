// A feedback space shares like a doc (Julie, 2026-10-30: "feedback spaces
// are just like docs. Keep it simple"). Real worker routes (in-process
// harness) behind a local HTTP server, the built shell runtime, a browser.
//
//   - The space page's Share opens the doc Share dialog: the owner gets the
//     access settings and, under Workspace, the doc move picker; a person
//     who only joined gets the copy-link Share. ?share=1 (the widget's
//     Share) arrives with it open.
//   - Moving into a team is the doc move: afterwards the dialog says the
//     team manages it.
//   - Turning on site mode for a personal space, as the admin of a team,
//     asks to move it into the team first; "Keep it personal" goes straight
//     on to the site settings.
//   - Desktop and phone: nothing runs off the side.
//
// TDOC_UI_ENGINES=chromium,webkit runs both engines; TDOC_UI_SHOTS=<dir>
// saves a screenshot of each step.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const playwright = requirePlaywrightOrSkip('feedback-share-ui.test.js');

const SHOTS = process.env.TDOC_UI_SHOTS || '';
const ENGINES = (process.env.TDOC_UI_ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const HOME = { Origin: 'https://tdoc.dev' };

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = { ...request.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${request.url}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (['content-length', 'content-encoding', 'content-security-policy'].includes(key)) return;
      res.setHeader(key, key === 'location' ? value.replace('https://tdoc.dev', '') : value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('Feedback space Share UI');
  const mod = await loadWorker();
  const worker = mod.default;
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const call = async (env, p, opts) => {
    const r = await worker.fetch(req(p, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  // A fresh world per run: julie owns a personal space for her app and is
  // the admin of Acme; can joined the space to comment.
  const world = async () => {
    const env = makeEnv(mod.CommentsStore);
    const julie = await issue(worker, env, 'julie');
    const can = await issue(worker, env, 'can');
    const space = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { origin: 'http://localhost:3000' } })).body;
    const team = (await call(env, '/api/teams', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { name: 'Acme' } })).body.team;
    await call(env, '/api/feedback/join', { method: 'POST', cookie: can.cookie, headers: HOME, body: { slug: space.slug } });
    const { server, base } = await startServer(worker, env);
    return { env, julie, can, slug: space.slug, team, server, base };
  };
  const sid = (cookie) => cookie.split('=')[1];
  const noSideways = async (page) => assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the page scrolls sideways',
  );
  // Every part of an open dialog stays inside the viewport.
  const dialogFits = async (page, dialog, width) => {
    const box = await dialog.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 0.5, `dialog off screen at ${width}px: ${JSON.stringify(box)}`);
    const clipped = await dialog.evaluate((el) => [...el.querySelectorAll('button, a, input, .tdoc-share-link-field')]
      .filter((node) => node.offsetParent && node.scrollWidth > node.clientWidth + 1 && !node.classList.contains('tdoc-share-link-field'))
      .map((node) => node.textContent.trim().slice(0, 40)));
    assert.deepEqual(clipped, [], `clipped controls at ${width}px`);
  };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  for (const engine of ENGINES) {
    const browser = await playwright[engine].launch({ headless: true });
    try {
      for (const width of [1440, 430, 390]) {
        const tag = `${engine}-${width}`;
        await t(`${tag}: the owner's Share is the doc Share; Move to a team… moves the space with the doc picker`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.julie.cookie), url: w.base }]);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(`${w.base}/d/${w.slug}`);
            const share = page.locator('#tdoc-fbspace-share');
            await share.waitFor();
            assert.equal((await share.innerText()).trim(), 'Share');
            const sbox = await share.boundingBox();
            assert(sbox && sbox.x + sbox.width <= width, `Share is off screen: ${JSON.stringify(sbox)}`);
            await noSideways(page);
            await shot(page, `${tag}-space-page`);
            await share.click();
            const dialog = page.getByRole('dialog', { name: 'Share' });
            await dialog.waitFor();
            assert.equal(await dialog.locator('#tdoc-share-url').innerText(), `https://tdoc.dev/d/${w.slug}`);
            await dialog.getByText('Who has access').waitFor();
            await dialog.locator('#tdoc-share-workspace').getByText('In My docs: only you manage it.').waitFor();
            await dialogFits(page, dialog, width);
            await shot(page, `${tag}-share-owner`);
            await dialog.getByRole('button', { name: 'Move to a team…' }).click();
            const picker = page.getByRole('dialog', { name: 'Move this feedback space' });
            await picker.waitFor();
            await picker.locator('.move-list button').first().waitFor();
            const choices = await picker.locator('.move-list button').allInnerTexts();
            assert.deepEqual(choices.map((c) => c.replace(/^\s*\S\s*/, '').trim()), ['Acme'], `choices ${JSON.stringify(choices)}`);
            await dialogFits(page, picker, width);
            await shot(page, `${tag}-move-picker`);
            await picker.locator('.move-list button', { hasText: 'Acme' }).click();
            // Back on the space with Share open, now the team's.
            await page.waitForURL((url) => url.pathname === `/d/${w.slug}` && !url.search.includes('share=1'));
            const after = page.getByRole('dialog', { name: 'Share' });
            await after.locator('#tdoc-share-workspace').getByText('In Acme: its admins manage it.').waitFor();
            await after.locator('#tdoc-access-team').waitFor({ state: 'attached' }).catch(() => {});
            await shot(page, `${tag}-share-after-move`);
            const meta = JSON.parse(await w.env.META.get(`meta:${w.slug}`));
            assert.equal(meta.workspace_id, w.team.id);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
            w.server.close();
          }
        });

        await t(`${tag}: someone who joined gets the copy-link Share, no access settings or move`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.can.cookie), url: w.base }]);
            const page = await context.newPage();
            // The widget's Share link: ?share=1 opens it on arrival.
            await page.goto(`${w.base}/d/${w.slug}?share=1`);
            const dialog = page.getByRole('dialog', { name: 'Share' });
            await dialog.waitFor();
            assert.equal(await dialog.locator('#tdoc-share-url').innerText(), `https://tdoc.dev/d/${w.slug}`);
            assert.equal(await dialog.getByText('Who has access').count(), 0, 'a non-owner sees access settings');
            assert.equal(await dialog.locator('#tdoc-share-workspace').count(), 0, 'a non-owner is offered the move');
            assert.equal(new URL(page.url()).search, '', '?share=1 stays in the address bar');
            await dialogFits(page, dialog, width);
            await shot(page, `${tag}-share-member`);
          } finally {
            await context.close();
            w.server.close();
          }
        });

        await t(`${tag}: site mode on a personal space asks to move it into a team first; Keep it personal goes on`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.julie.cookie), url: w.base }]);
            const page = await context.newPage();
            await page.goto(`${w.base}/me?view=comments`);
            await page.locator('.tdoc-fb-embed-btn').first().click();
            const prompt = page.getByRole('dialog', { name: 'Move it to a team first?' });
            await prompt.waitFor();
            await prompt.getByText('Comments from your site').waitFor();
            await prompt.locator('.move-list button', { hasText: 'Acme' }).waitFor();
            assert.equal(await prompt.locator('.move-list button', { hasText: 'My docs' }).count(), 0);
            await dialogFits(page, prompt, width);
            await shot(page, `${tag}-site-team-first`);
            await prompt.getByRole('button', { name: 'Keep it personal' }).click();
            await page.getByRole('dialog', { name: 'Comments on your site' }).waitFor();
            const meta = JSON.parse(await w.env.META.get(`meta:${w.slug}`));
            assert(!meta.workspace_id, 'Keep it personal moved the space');
            await page.keyboard.press('Escape');
            // Moving instead: the space goes to Acme, then the site settings.
            await page.locator('.tdoc-fb-embed-btn').first().click();
            const again = page.getByRole('dialog', { name: 'Move it to a team first?' });
            await again.locator('.move-list button', { hasText: 'Acme' }).click();
            await page.getByRole('dialog', { name: 'Comments on your site' }).waitFor();
            const moved = JSON.parse(await w.env.META.get(`meta:${w.slug}`));
            assert.equal(moved.workspace_id, w.team.id);
            await page.getByRole('dialog', { name: 'Comments on your site' }).getByRole('button', { name: 'Save' }).click();
            await page.locator('.tdoc-site-snippet').waitFor();
            await shot(page, `${tag}-site-settings`);
            await page.keyboard.press('Escape');
            // A team space goes straight to its settings next time.
            await page.locator('.tdoc-fb-embed-btn').first().click();
            await page.getByRole('dialog', { name: 'Comments on your site' }).waitFor();
            assert.equal(await page.getByRole('dialog', { name: 'Move it to a team first?' }).count(), 0);
          } finally {
            await context.close();
            w.server.close();
          }
        });
      }
    } finally {
      await browser.close();
    }
  }
  if (failed) {
    console.log(`\nFAIL — ${failed} failed`);
    process.exit(1);
  }
  console.log('\nPASS');
})();
