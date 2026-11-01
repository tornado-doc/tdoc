// Trash in the browser: Delete says it moves to Trash for 30 days, the toast
// offers Undo, the doc link is gone while it waits, the Trash tab shows the
// days left with Restore and Delete forever -- desktop and phone. Real worker
// routes (in-process harness) behind a local HTTP server, real built shell
// runtime, real Chromium.
//
// TDOC_DEMO_DIR=<dir> also records a video of each run (and slows it down so
// it can be watched) -- the demo attached to the PR that added Trash.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('trash-ui.test.js');

const SID = 'b2'.repeat(16);
const DEMO = process.env.TDOC_DEMO_DIR || '';

async function seed(env) {
  await env.META.put('hosted-account:alice', JSON.stringify({
    account_id: 'acct-alice', github_login: 'alice', created: '2026-01-01T00:00:00.000Z',
  }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'alice', account_id: 'acct-alice', name: 'alice', avatar_url: '', created: new Date().toISOString(),
  }));
  for (const [slug, title, body] of [
    ['q4-roadmap', 'Q4 roadmap', 'Ship Trash, then the mobile editor.'],
    ['meeting-notes', 'Meeting notes', 'Decisions from Monday.'],
  ]) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created: '2026-10-01T00:00:00.000Z', versions: [{ n: 1, created: '2026-10-01T00:00:00.000Z' }],
      hosted: { account_id: 'acct-alice', github_login: 'alice', owner_key: 'alice' },
      access: { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, `<!doctype html><html><body><h1>${title}</h1><p>${body}</p></body></html>`);
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
  console.log('Trash UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true, ...(DEMO ? { slowMo: 140 } : {}) });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const pause = (ms) => (DEMO ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  const run = async (label, viewport) => {
    const env = makeEnv(mod.CommentsStore);
    await seed(env);
    const { server, base } = await startServer(worker, env);
    if (DEMO) fs.mkdirSync(path.join(DEMO, label), { recursive: true });
    const context = await browser.newContext({
      viewport,
      ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      ...(DEMO ? { recordVideo: { dir: path.join(DEMO, label), size: viewport } } : {}),
    });
    await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const row = (slug) => page.locator(`.doc-row[data-slug="${slug}"]`);
    const shot = async (name) => { if (DEMO) await page.screenshot({ path: path.join(DEMO, `${label}-${name}.png`) }); };
    const deleteFromList = async (slug) => {
      await row(slug).getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('Trash for 30 days').waitFor();
      await shot('confirm');
      await pause(600);
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    };
    try {
      await page.goto(`${base}/me`);
      await row('q4-roadmap').waitFor();
      await pause(500);

      await deleteFromList('q4-roadmap');
      const toast = page.locator('.tdoc-toast');
      await toast.getByText('Moved 1 doc to Trash').waitFor();
      await shot('toast');
      assert.equal(await row('q4-roadmap').count(), 0, 'row still listed after delete');
      assert.ok(JSON.parse(await env.META.get('meta:q4-roadmap')).trashed_at, 'not trashed on the server');
      await pause(700);
      await toast.getByRole('button', { name: 'Undo' }).click();
      await row('q4-roadmap').waitFor();
      await toast.getByText('Restored 1 doc').waitFor();
      assert.ok(!JSON.parse(await env.META.get('meta:q4-roadmap')).trashed_at, 'Undo did not restore on the server');
      await pause(900);

      await deleteFromList('q4-roadmap');
      await toast.getByText('Moved 1 doc to Trash').waitFor();
      await pause(700);

      // The link: gone, exactly like a doc that never existed.
      await page.goto(`${base}/d/q4-roadmap`);
      await page.waitForURL((url) => url.searchParams.get('notice') === 'notfound');
      await page.waitForLoadState('networkidle');
      await shot('link-gone');
      await pause(1200);

      await page.goto(`${base}/me`);
      await page.getByRole('tab', { name: 'Trash' }).click();
      const trashed = page.locator('.trash-row[data-slug="q4-roadmap"]');
      await trashed.waitFor();
      assert.match(await trashed.textContent(), /Q4 roadmap/);
      assert.match(await trashed.locator('.trash-days').textContent(), /30 days left/);
      await shot('trash');
      const box = await trashed.getByRole('button', { name: 'Restore' }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, `Restore is off screen: ${JSON.stringify(box)}`);
      await pause(900);
      await trashed.getByRole('button', { name: 'Restore' }).click();
      await toast.getByText('Restored “Q4 roadmap”').waitFor();
      await page.locator('#pane-trash .empty').getByText('Trash is empty.').waitFor();
      await pause(700);

      await page.goto(`${base}/d/q4-roadmap`);
      const frame = page.frameLocator('iframe').first();
      await frame.getByText('Ship Trash, then the mobile editor.').waitFor();
      await shot('restored');
      await pause(1200);

      await page.goto(`${base}/me`);
      await deleteFromList('q4-roadmap');
      await toast.getByText('Moved 1 doc to Trash').waitFor();
      await page.getByRole('tab', { name: 'Trash' }).click();
      await trashed.waitFor();
      await pause(600);
      await trashed.getByRole('button', { name: 'More actions for Q4 roadmap' }).click();
      await page.getByRole('menuitem', { name: 'Delete forever' }).click();
      const confirm = page.getByRole('dialog');
      await confirm.getByText('This cannot be undone.').waitFor();
      await shot('forever');
      await pause(800);
      await confirm.getByRole('button', { name: 'Delete forever' }).click();
      await toast.getByText('Deleted “Q4 roadmap” for good').waitFor();
      await page.locator('#pane-trash .empty').getByText('Trash is empty.').waitFor();
      assert.equal(await env.META.get('meta:q4-roadmap'), null, 'Delete forever left the record');
      assert.equal(await env.DOCS.head('docs/q4-roadmap/v1/index.html'), null, 'Delete forever left the bytes');
      await pause(1200);

      // From the doc page: the same copy, then My docs says where it went,
      // and Undo comes straight back to the doc.
      if (viewport.width >= 600) {
        await page.goto(`${base}/d/meeting-notes`);
        await page.frameLocator('iframe').first().getByText('Decisions from Monday.').waitFor();
        await page.locator('#tdoc-more-btn').click();
        await page.locator('[data-action="delete"]').click();
        const docDialog = page.getByRole('dialog');
        await docDialog.getByText(/move to Trash for 30 days/).waitFor();
        await docDialog.getByRole('button', { name: 'Delete' }).click();
        await page.waitForURL((url) => url.pathname === '/me');
        await toast.getByText('Moved to Trash').waitFor();
        assert.equal(await row('meeting-notes').count(), 0, 'trashed doc listed after the doc-page delete');
        await shot('doc-page-toast');
        await pause(700);
        await toast.getByRole('button', { name: 'Undo' }).click();
        await page.waitForURL((url) => url.pathname === '/d/meeting-notes');
        await page.frameLocator('iframe').first().getByText('Decisions from Monday.').waitFor();
        await pause(900);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      server.close();
    }
  };

  try {
    await t('desktop: delete → Undo → delete → link gone → Trash → Restore → readable → Delete forever', () => run('desktop', { width: 1180, height: 820 }));
    await t('phone: the same, with Restore and the days left in reach', () => run('phone', { width: 390, height: 844 }));
    await t('a folder goes to Trash with its docs and Undo brings both back; a team has its own Trash', async () => {
      const env = makeEnv(mod.CommentsStore);
      await seed(env);
      const now = Date.now();
      const fid = `f_${now}_abcdef12`;
      await env.META.put('folders:alice', JSON.stringify({ folders: [{ id: fid, name: 'Planning', created: new Date(now).toISOString(), visibility: 'private' }], docs: { 'q4-roadmap': fid } }));
      const made = await worker.fetch(new Request('https://tdoc.dev/api/teams', {
        method: 'POST',
        headers: { Cookie: `tdoc_sid=${SID}`, Origin: 'https://tdoc.dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme' }),
      }), env, {});
      const teamId = (await made.json()).team.id;
      const { server, base } = await startServer(worker, env);
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(`${base}/me`);
        const folderRow = page.locator(`.folder-row[data-folder-id="${fid}"]`);
        await folderRow.waitFor();
        await folderRow.getByRole('button', { name: 'Folder actions' }).click();
        await page.getByRole('menuitem', { name: 'Delete folder' }).click();
        await page.getByRole('dialog').getByText(/move to Trash for 30 days/).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: 'Delete folder' }).click();
        const toast = page.locator('.tdoc-toast');
        await toast.getByText('Moved “Planning” and 1 doc to Trash').waitFor();
        assert.equal(await folderRow.count(), 0, 'folder still listed');
        await page.getByRole('tab', { name: 'Trash' }).click();
        const entry = page.locator(`.trash-row[data-folder-id="${fid}"]`);
        await entry.waitFor();
        assert.match(await entry.textContent(), /Folder · 1 doc/);
        await page.getByRole('tab', { name: 'Docs' }).click();
        await toast.getByRole('button', { name: 'Undo' }).click();
        await folderRow.waitFor();
        assert.ok(!JSON.parse(await env.META.get('meta:q4-roadmap')).trashed_at, 'Undo left the doc in Trash');
        await page.goto(`${base}/me?team=${teamId}&view=trash`);
        await page.locator('#pane-trash').getByText('Trash is empty.').waitFor();
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
        server.close();
      }
    });
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
