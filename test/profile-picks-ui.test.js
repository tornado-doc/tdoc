// The owner of /@handle can take picks down, not only add them: a remove
// control on every card (with Undo), and every pinned doc in the Public picks
// dialog — including docs since moved to a team or deleted — can be unchecked.
// Real worker routes (in-process harness) behind a local HTTP server, real
// built shell runtime, real Chromium.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('profile-picks-ui.test.js');

const SID = 'a1'.repeat(16);

async function seed(worker, env) {
  await env.META.put('hosted-account:owner', JSON.stringify({
    account_id: 'acct-owner', github_login: 'owner', created: '2026-01-01T00:00:00.000Z',
  }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'owner', account_id: 'acct-owner', name: 'owner', avatar_url: '', created: new Date().toISOString(),
  }));
  for (const [slug, title] of [['kept', 'Kept doc'], ['team-moved', 'Team doc'], ['gone', 'Deleted doc']]) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created: '2026-01-01T00:00:00.000Z', versions: [{ n: 1, created: '2026-01-01T00:00:00.000Z' }],
      hosted: { account_id: 'acct-owner', github_login: 'owner' },
      access: { visibility: 'private' },
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${title}</h1><p>Opening paragraph of ${title}.</p>`);
  }
  const call = (path, body) => worker.fetch(new Request(`https://tdoc.dev${path}`, {
    method: 'POST',
    headers: { Cookie: `tdoc_sid=${SID}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, {});
  assert.equal((await call('/api/me/handle', { handle: 'owner' })).status, 200);
  for (const slug of ['gone', 'team-moved', 'kept']) {
    assert.equal((await call('/api/me/profile/pin', { slug, pinned: true })).status, 200, `pin ${slug}`);
  }
  // After pinning: one doc moves to a team, one is deleted.
  const moved = JSON.parse(await env.META.get('meta:team-moved'));
  await env.META.put('meta:team-moved', JSON.stringify({ ...moved, workspace_id: 'team-1' }));
  await env.META.delete('meta:gone');
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
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      // The in-process harness does not bundle; point the page at the built runtime.
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
  console.log('Profile picks UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const fresh = async (width = 1100, more = null) => {
    const env = makeEnv(mod.CommentsStore);
    await seed(worker, env);
    if (more) await more(env);
    const { server, base } = await startServer(worker, env);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/@owner`);
    await page.locator('.profile-picks').waitFor();
    const pins = async () => JSON.parse(await env.META.get('account-profile:acct-owner')).pins;
    const close = async () => { await context.close(); server.close(); };
    return { env, page, errors, pins, close };
  };
  const cardTitles = (page) => page.locator('.profile-pick-item .profile-pick-title').allTextContents();

  try {
    await t('every card has a remove control; removing restores access and Undo puts it back', async () => {
      const { env, page, errors, pins, close } = await fresh();
      try {
        assert.deepEqual(await cardTitles(page), ['Kept doc', 'Team doc']);
        await page.getByRole('button', { name: 'Remove Kept doc from profile' }).click();
        await page.getByRole('status').filter({ hasText: 'Removed “Kept doc” from your profile.' }).waitFor();
        assert.deepEqual(await cardTitles(page), ['Team doc']);
        assert.deepEqual(await pins(), ['team-moved', 'gone']);
        assert.equal(JSON.parse(await env.META.get('meta:kept')).access.visibility, 'private');
        await page.getByRole('button', { name: 'Undo' }).click();
        await page.getByRole('button', { name: 'Remove Kept doc from profile' }).waitFor();
        assert.deepEqual(await cardTitles(page), ['Kept doc', 'Team doc']);
        assert.deepEqual(await pins(), ['kept', 'team-moved', 'gone']);
        assert.equal(JSON.parse(await env.META.get('meta:kept')).access.visibility, 'public');
        assert.deepEqual(errors, []);
      } finally { await close(); }
    });

    await t('a pick moved to a team can be removed from its card', async () => {
      const { page, pins, close } = await fresh();
      try {
        await page.getByRole('button', { name: 'Remove Team doc from profile' }).click();
        await page.getByRole('status').filter({ hasText: 'Removed “Team doc”' }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Undo' }).count(), 0, 'no Undo for a doc that cannot be re-picked');
        assert.deepEqual(await pins(), ['kept', 'gone']);
        await page.reload();
        await page.locator('.profile-picks').waitFor();
        assert.deepEqual(await cardTitles(page), ['Kept doc']);
      } finally { await close(); }
    });

    await t('the Public picks dialog lists every pin, deleted and team-moved ones included, and unchecks them', async () => {
      const { page, pins, close } = await fresh();
      try {
        await page.getByRole('button', { name: 'Add a pick' }).click();
        const dialog = page.getByRole('dialog', { name: 'Public picks' });
        await dialog.waitFor();
        const rows = dialog.locator('.profile-pick-row');
        assert.deepEqual((await rows.locator('b').allTextContents()).sort(), ['Kept doc', 'Team doc', 'gone']);
        const row = (title) => rows.filter({ has: page.locator('b', { hasText: title }) });
        assert.match(await row('gone').textContent(), /Deleted · uncheck to remove/);
        for (let i = 0; i < 3; i++) assert.equal(await rows.nth(i).locator('input').isChecked(), true);
        await row('gone').locator('input').click();
        if (process.env.TDOC_UI_SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${process.env.TDOC_UI_SHOTS}/profile-picks-dialog.png` }); }
        await page.getByRole('status').filter({ hasText: 'Removed “gone”' }).waitFor();
        assert.equal(await row('gone').count(), 0, 'a deleted doc leaves the list once taken down');
        for (const title of ['Team doc', 'Kept doc']) {
          await row(title).locator('input').click();
          await page.getByRole('status').filter({ hasText: `Removed “${title}”` }).waitFor();
        }
        assert.deepEqual(await pins(), []);
        await dialog.getByRole('button', { name: 'Done' }).click();
        await page.reload();
        await page.getByText('No public picks yet. Add one from your docs.').waitFor();
      } finally { await close(); }
    });

    await t('pinning a doc that is not Public says it makes it Public (searchable) first; a Public doc pins at once', async () => {
      const extra = async (env) => {
        for (const [slug, title, visibility] of [['link-doc', 'Link doc', 'unlisted'], ['open-doc', 'Open doc', 'public']]) {
          await env.META.put(`meta:${slug}`, JSON.stringify({
            title, slug, created: '2026-01-02T00:00:00.000Z', versions: [{ n: 1, created: '2026-01-02T00:00:00.000Z' }],
            hosted: { account_id: 'acct-owner', github_login: 'owner' },
            access: { visibility, commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
          }));
          await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${title}</h1>`);
        }
      };
      const { env, page, pins, close } = await fresh(390, extra);
      try {
        await page.getByRole('button', { name: 'Add a pick' }).click();
        const picks = page.getByRole('dialog', { name: 'Public picks' });
        await picks.waitFor();
        const row = (title) => picks.locator('.profile-pick-row').filter({ has: page.locator('b', { hasText: title }) });
        await row('Link doc').locator('input').click();
        const confirm = page.getByRole('dialog', { name: 'Pinning makes this doc Public (searchable)' });
        await confirm.waitFor();
        assert.equal(JSON.parse(await env.META.get('meta:link-doc')).access.visibility, 'unlisted', 'changed before confirming');
        if (process.env.TDOC_UI_SHOTS) await page.screenshot({ path: `${process.env.TDOC_UI_SHOTS}/profile-pin-public-confirm-390.png` });
        await confirm.getByRole('button', { name: 'Make Public and pin' }).click();
        // A new pick reloads the page so its card has a server-side excerpt.
        await page.locator('.profile-pick-item .profile-pick-title', { hasText: 'Link doc' }).waitFor();
        assert.equal(JSON.parse(await env.META.get('meta:link-doc')).access.visibility, 'public');
        assert.ok((await pins()).includes('link-doc'));
        await page.getByRole('button', { name: 'Add a pick' }).click();
        await picks.waitFor();
        await row('Open doc').locator('input').click();
        await page.locator('.profile-pick-item .profile-pick-title', { hasText: 'Open doc' }).waitFor();
        assert.ok((await pins()).includes('open-doc'), 'a Public doc did not pin without the confirm');
      } finally { await close(); }
    });

    await t('a failed take-down says so and keeps the card', async () => {
      const { page, pins, close } = await fresh(390);
      try {
        await page.route('**/api/me/profile/pin', (route) => route.fulfill({
          status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal' }),
        }));
        await page.getByRole('button', { name: 'Remove Kept doc from profile' }).click();
        await page.getByRole('status').filter({ hasText: 'Could not remove this pick (internal).' }).waitFor();
        assert.deepEqual(await cardTitles(page), ['Kept doc', 'Team doc']);
        assert.deepEqual(await pins(), ['kept', 'team-moved', 'gone']);
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      } finally { await close(); }
    });
  } finally {
    await browser.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
