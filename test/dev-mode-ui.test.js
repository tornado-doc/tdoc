// Dev mode in the browser, desktop and phone. Real worker routes (in-process
// harness) behind a local HTTP server, the real built shell, real Chromium.
//
//   - the account menu's "Dev mode" switch: allow-listed only, flips the
//     server-side setting; onboarding controls live in a submenu, not a bar
//   - exiting through the Dev mode row needs two presses, like replay
//   - flagged features (shell/src/feature-flags.js) show only in dev mode:
//     doc thumbnails in the My docs grid and on /@handle cards; off, the
//     cards are text (title, excerpt, date) and the menu says what dev mode adds
//   - an account not on the list has no switch and the API refuses it
//   - Sign out -> Sign in on the landing page brings a connected account back
//     to My docs, not to "Connect your agent"
//
// TDOC_SHOTS_DIR=<dir> saves desktop and phone menu screenshots.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('dev-mode-ui.test.js');

const JULIE = 'c3'.repeat(16);
const BOB = 'd4'.repeat(16);
const SHOTS = process.env.TDOC_SHOTS_DIR || '';
// A stand-in preview card (400x210 PNG).
const THUMB = makeThumb();
const ENV = {
  TDOC_DEBUG_ACCOUNTS: 'julie@example.com',
  OIDC_ISSUER: 'https://idp.example', OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'csec', OIDC_LABEL: 'Email',
};

function makeThumb() {
  const zlib = require('zlib');
  const w = 400, h = 210;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const band = y < 60 ? [25, 128, 82] : (x > 30 && x < 370 && y % 30 < 12 ? [200, 220, 205] : [243, 248, 244]);
      raw[o] = band[0]; raw[o + 1] = band[1]; raw[o + 2] = band[2];
    }
  }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function seed(env) {
  const session = (email, account_id) => JSON.stringify({
    email, account_id, name: email.split('@')[0], avatar_url: '', created: new Date().toISOString(),
    idp: { provider: 'oidc', sub: email },
  });
  await env.META.put(`account-email:julie@example.com`, JSON.stringify({ account_id: 'acct-julie' }));
  await env.META.put(`account-email:bob@example.com`, JSON.stringify({ account_id: 'acct-bob' }));
  await env.META.put(`session:${JULIE}`, session('julie@example.com', 'acct-julie'));
  await env.META.put(`session:${BOB}`, session('bob@example.com', 'acct-bob'));
  // Julie is a long-time user: her agent connected months ago and she has
  // docs, from before the journey existed, so her record says only that.
  // Nothing about her should look like onboarding -- until a visit to /setup
  // stamps `started`, which is what put the checklist back on My docs.
  await env.META.put('account-terminal:acct-julie', JSON.stringify({ first: '2026-03-01T00:00:00Z', last: '2026-10-01T00:00:00Z' }));
  await env.META.put('account-onboarding:acct-julie', JSON.stringify({ agent_connected: '2026-03-01T00:00:00Z' }));
  for (const [slug, title, account_id] of [['julie-notes', 'Julie notes', 'acct-julie'], ['tornado-doc', 'tdoc', 'acct-julie']]) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created: '2026-03-01T00:00:00Z', versions: [{ n: 1, created: '2026-03-01T00:00:00Z' }],
      hosted: { account_id, owner_key: 'email:julie@example.com' },
      access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
      preview: { excerpt: `${title}: prompt-native documents, for people and their agents.`, image: `/thumbs/${slug}.png` },
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, `<!doctype html><html><body><h1>${title}</h1><p>Prompt-native documents, for people and their agents.</p></body></html>`);
  }
}

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('Dev mode UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };

  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const phone = viewport.width < 600;
    const env = makeEnv(mod.CommentsStore, ENV);
    await seed(env);
    const { server, base } = await startServer(worker, env);
    const newContext = async (sid) => {
      const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      if (sid) await context.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
      return context;
    };
    const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) }); };
    // The account menu: the avatar chip on a desktop, ⋯ -> My account on a phone.
    const openAccountMenu = async (page) => {
      if (!phone) await page.locator('.tdoc-account-trigger').click();
      else {
        await page.locator('#tdoc-more-btn').click();
        await page.getByRole('menuitem', { name: 'My account' }).click();
      }
    };
    const devItem = (page) => page.getByRole('menuitemcheckbox', { name: /Dev mode/ });
    const onboarding = (page) => page.getByRole('menuitem', { name: /Onboarding test/ });

    try {
      await t(`${label}: onboarding controls stay in the account submenu, and dev mode still turns off and on`, async () => {
        const context = await newContext(JULIE);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/me`);
        assert.equal(await page.locator('.sg-debug').count(), 0, 'no floating testing strip');
        await openAccountMenu(page);
        await devItem(page).waitFor();
        assert.equal(await devItem(page).getAttribute('aria-checked'), 'true');
        assert.match(await devItem(page).innerText(), /Dev mode: on/);
        await shot(page, 'menu-on');
        await onboarding(page).click();
        await page.getByRole('menuitem', { name: 'replay' }).waitFor();
        assert.match(await page.locator('.tdoc-onboarding-test-status').innerText(), /Current: connected/);
        await shot(page, 'onboarding-test');
        await page.keyboard.press('Escape');
        await devItem(page).click();
        assert.match(await devItem(page).innerText(), /Dev mode: exit\?/);
        assert.equal(await env.META.get('dev-mode:julie@example.com'), null, 'first press only arms exit');
        await Promise.all([page.waitForEvent('load'), devItem(page).click()]);
        assert.equal(await env.META.get('dev-mode:julie@example.com'), 'off', 'kept on the server');
        await page.locator(phone ? '#tdoc-more-btn' : '.tdoc-account-trigger').waitFor();
        assert.equal(await page.locator('.sg-debug').count(), 0, 'no testing strip while off');
        await openAccountMenu(page);
        await devItem(page).waitFor();
        assert.equal(await devItem(page).getAttribute('aria-checked'), 'false');
        assert.match(await devItem(page).innerText(), /Dev mode: off/);
        assert.equal(await onboarding(page).count(), 0, 'testing submenu hidden while off');
        await shot(page, 'menu-off');
        await Promise.all([page.waitForEvent('load'), devItem(page).click()]);
        await openAccountMenu(page);
        await onboarding(page).waitFor();
        assert.equal(await env.META.get('dev-mode:julie@example.com'), null, 'on again');
        assert.deepEqual(errors, []);
        await context.close();
      });

      await t(`${label}: doc thumbnails show only in dev mode; off, grid and profile cards are text`, async () => {
        const context = await newContext(JULIE);
        await context.route('**/thumbs/*.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: THUMB }));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const call = (p, body) => page.evaluate(async ([p, body]) => (await fetch(p, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })).status, [p, body]);
        await page.goto(`${base}/me`);
        await page.locator('.doc-row[data-slug="julie-notes"]').waitFor();
        assert.equal(await call('/api/me/handle', { handle: 'julie' }), 200);
        assert.equal(await call('/api/me/profile/pin', { slug: 'julie-notes', pinned: true }), 200);
        // Give every doc a card again: pinning and the My docs backfill
        // rewrite the preview, and the harness has no card renderer.
        const thumbs = async () => {
          for (const slug of ['julie-notes', 'tornado-doc']) {
            const meta = JSON.parse(await env.META.get(`meta:${slug}`));
            meta.preview = { ...(meta.preview || {}), image: `/thumbs/${slug}.png` };
            await env.META.put(`meta:${slug}`, JSON.stringify(meta));
          }
        };
        const grid = async () => {
          await thumbs();
          await page.goto(`${base}/me`);
          await page.getByRole('button', { name: 'Grid view' }).click();
          await page.locator('.doc-list.is-grid .doc-row[data-slug="julie-notes"]').waitFor();
        };
        const card = (slug) => page.locator(`.doc-list.is-grid .doc-row[data-slug="${slug}"]`);
        const gridShot = async (name) => {
          if (!SHOTS) return;
          await page.waitForFunction(() => [...document.images].every((img) => img.complete));
          await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`), fullPage: true });
        };

        // Off: no picture box, the excerpt is back, the menu says nothing extra.
        await env.META.put('dev-mode:julie@example.com', 'off');
        await grid();
        assert.equal(await page.locator('.doc-list.is-grid img, .doc-list.is-grid .doc-card-preview').count(), 0, 'no thumbnail while off');
        assert.ok(await card('julie-notes').evaluate((el) => el.classList.contains('is-text-card')));
        const excerpt = card('julie-notes').locator('.doc-preview-excerpt');
        assert.equal(await excerpt.isVisible(), true, 'the excerpt shows on a text card');
        assert.match(await excerpt.innerText(), /prompt-native documents/i);
        assert.equal(await card('julie-notes').locator('.doc-meta').isVisible(), true, 'and the date');
        await gridShot('grid-devmode-off');
        await openAccountMenu(page);
        await devItem(page).waitFor();
        assert.match(await page.locator('.tdoc-dev-mode-flags').innerText(), /Dev mode shows: Doc thumbnails/);
        await shot(page, 'menu-flags');
        await page.keyboard.press('Escape');
        await thumbs();
        await page.goto(`${base}/@julie`);
        await page.locator('.profile-pick-card').first().waitFor();
        assert.equal(await page.locator('.profile-pick-card.has-image, .profile-pick-media').count(), 0, 'no profile thumbnail while off');
        assert.equal(await page.locator('.profile-pick-excerpt').first().isVisible(), true, 'profile card keeps its excerpt');

        // On: the picture is there, in the grid and on the profile.
        await env.META.delete('dev-mode:julie@example.com');
        await grid();
        await card('julie-notes').locator('.doc-card-preview img').waitFor();
        assert.equal(await page.locator('.doc-list.is-grid .is-text-card').count(), 0);
        assert.equal(await card('julie-notes').locator('.doc-card-preview img').getAttribute('src'), '/thumbs/julie-notes.png');
        await gridShot('grid-devmode-on');
        await thumbs();
        await page.goto(`${base}/@julie`);
        await page.locator('.profile-pick-card').first().waitFor();
        await page.locator('.profile-pick-card.has-image .profile-pick-media img').first().waitFor();
        assert.deepEqual(errors, []);
        await context.close();
      });

      await t(`${label}: Exit dev mode in the account menu needs a second press`, async () => {
        const context = await newContext(JULIE);
        const page = await context.newPage();
        await page.goto(`${base}/me`);
        await openAccountMenu(page);
        await devItem(page).click();
        assert.match(await devItem(page).innerText(), /Dev mode: exit\?/i, 'first press arms it and says so');
        if (SHOTS) await page.waitForTimeout(400); // let the colour change settle for the picture
        await shot(page, 'menu-exit-armed');
        assert.equal(await env.META.get('dev-mode:julie@example.com'), null, 'one press changes nothing');
        await Promise.all([page.waitForEvent('load'), devItem(page).click()]);
        assert.equal(await env.META.get('dev-mode:julie@example.com'), 'off', 'the second press turns it off');
        await page.locator(phone ? '#tdoc-more-btn' : '.tdoc-account-trigger').waitFor();
        assert.equal(await page.locator('.sg-debug').count(), 0, 'and there is no bar');
        // It disarms itself: a lone press, then a pause, is not half of an exit.
        await env.META.delete('dev-mode:julie@example.com');
        await page.reload();
        await openAccountMenu(page);
        await devItem(page).click();
        await page.waitForTimeout(4300);
        assert.match(await devItem(page).innerText(), /^Dev mode: on$/, 'disarmed after a few seconds');
        await context.close();
      });

      await t(`${label}: an account not on the list has no switch, and the API refuses it`, async () => {
        const context = await newContext(BOB);
        const page = await context.newPage();
        await page.goto(`${base}/me`);
        await page.locator(phone ? '#tdoc-more-btn' : '.tdoc-account-trigger').waitFor();
        assert.equal(await page.locator('.sg-debug').count(), 0, 'no Internal bar');
        await openAccountMenu(page);
        await page.getByRole('menuitem', { name: /Sign out/ }).waitFor();
        assert.equal(await devItem(page).count(), 0, 'no Dev mode item');
        assert.equal(await onboarding(page).count(), 0, 'no onboarding test submenu');
        const status = await page.evaluate(async () => (await fetch('/api/me/dev-mode', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }),
        })).status);
        assert.equal(status, 403);
        const state = await page.evaluate(async () => (await fetch('/api/onboarding/state', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'new' }),
        })).status);
        assert.equal(state, 403);
        await context.close();
      });

      await t(`${label}: Sign out, then Sign in on the landing page, lands a connected account on My docs`, async () => {
        await env.META.put('dev-mode:julie@example.com', 'off');
        const context = await newContext(JULIE);
        const page = await context.newPage();
        // The provider round trip: sign the person in and go where `return` says.
        let returned = '';
        await page.route('**/api/auth/oidc/login**', async (route) => {
          const url = new URL(route.request().url());
          returned = url.searchParams.get('return') || '';
          const sid = 'e5'.repeat(16);
          await env.META.put(`session:${sid}`, JSON.stringify({
            email: 'julie@example.com', account_id: 'acct-julie', name: 'julie', created: new Date().toISOString(),
          }));
          await context.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
          await route.fulfill({ status: 302, headers: { Location: `${base}${returned}` } });
        });
        await page.goto(`${base}/me`);
        await openAccountMenu(page);
        await Promise.all([page.waitForURL(`${base}/`), page.getByRole('menuitem', { name: /Sign out/ }).click()]);
        const signIn = phone
          ? async () => { await page.locator('#tdoc-more-btn').click(); await page.getByRole('menuitem', { name: 'Sign in' }).click(); }
          : async () => page.locator('.tdoc-account-trigger.signin').click();
        await Promise.all([page.waitForURL(/\/me$/), signIn()]);
        assert.equal(returned, '/setup?via=signin', 'the landing page returns into the gate, marked as a sign-in');
        assert.equal(await page.getByRole('heading', { name: 'Connect your agent' }).count(), 0, 'not shown the gate');
        const rec = JSON.parse(await env.META.get('account-onboarding:acct-julie'));
        assert.ok(!rec.started, 'signing in again did not start an onboarding journey');
        await page.locator('.doc-row[data-slug="julie-notes"]').waitFor();
        assert.equal(await page.locator('.onb-card, .onb-chip').count(), 0, 'no onboarding checklist on My docs');
        await context.close();
      });

      await t(`${label}: document states stay scoped; dismissing setup returns to hub states`, async () => {
        await seed(env);
        await env.META.delete('dev-mode:julie@example.com');
        const context = await newContext(JULIE);
        const page = await context.newPage();
        await page.goto(`${base}/d/julie-notes`);
        await openAccountMenu(page);
        await onboarding(page).click();
        await page.getByRole('menuitem', { name: 'published' }).waitFor();
        assert.equal(await page.getByRole('menuitem', { name: 'new', exact: true }).count(), 0, 'document has only its own states');
        await shot(page, 'document-onboarding-test');
        await page.goto(`${base}/setup`);
        await page.getByRole('heading', { name: 'Connect your AI', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.waitForURL(`${base}/me`);
        await openAccountMenu(page);
        await onboarding(page).click();
        await page.getByRole('menuitem', { name: 'connected' }).waitFor();
        for (const state of ['new', 'started', 'connected', 'published', 'commented', 'revised']) {
          assert.equal(await page.getByRole('menuitem', { name: state, exact: true }).count(), 1, `My docs exposes ${state}`);
        }
        await shot(page, 'setup-onboarding-test');
        await context.close();
      });

      await t(`${label}: replay in the submenu still needs two presses`, async () => {
        await seed(env);
        await env.META.delete('dev-mode:julie@example.com');
        const context = await newContext(JULIE);
        const page = await context.newPage();
        await page.goto(`${base}/me`);
        await openAccountMenu(page);
        await onboarding(page).click();
        await page.getByRole('menuitem', { name: 'replay' }).click();
        assert.equal(await page.getByRole('menuitem', { name: 'replay?' }).count(), 1, 'first press arms replay without closing the submenu');
        assert.ok(JSON.parse(await env.META.get('account-onboarding:acct-julie')).agent_connected, 'first press changes nothing');
        await Promise.all([page.waitForEvent('load'), page.getByRole('menuitem', { name: 'replay?' }).click()]);
        assert.equal(Boolean(JSON.parse(await env.META.get('account-onboarding:acct-julie') || '{}').agent_connected), false, 'second press resets the journey');
        await context.close();
      });
    } finally {
      server.close();
    }
  }

  await browser.close();
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
