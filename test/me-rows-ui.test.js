// My docs rows in the browser: each row shows its type (icon with a label),
// who can open it, and an unread badge; Recent and Starred say when; ⋯ has
// Share, which opens the doc page's own Share dialog; "Finish setting up"
// shows on the Docs tab only and only below three docs -- desktop and phone.
// Real worker routes (in-process harness) behind a local HTTP server, real
// built shell runtime, real Chromium.
//
// TDOC_SHOTS_DIR=<dir> also writes a screenshot per view.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('me-rows-ui.test.js');

const JULIE = 'c3'.repeat(16);
const NEWBIE = 'd4'.repeat(16);
const SHOTS = process.env.TDOC_SHOTS_DIR || '';
const H = 3600e3;
const D = 24 * H;

async function seed(env) {
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  for (const [login, sid] of [['julie', JULIE], ['newbie', NEWBIE]]) {
    await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, created: '2026-01-01T00:00:00.000Z' }));
    await env.META.put(`session:${sid}`, JSON.stringify({ login, account_id: `acct-${login}`, name: login, avatar_url: '', created: new Date().toISOString() }));
    await env.META.put(`account-onboarding:acct-${login}`, JSON.stringify({ started: ago(10 * D), published_first: ago(10 * D), first_doc: `${login}-first`, agent_connected: ago(10 * D) }));
  }
  const doc = async (owner, slug, title, kind, access, age) => {
    const body = kind === 'sheet'
      ? `<h1>${title}</h1><table data-tdoc-sheet data-name="Costs"><thead><tr><th data-key="a">Item</th></tr></thead><tbody><tr data-row="1"><td>Rent</td></tr></tbody></table>`
      : kind === 'slides' ? `<section class="slide" data-tdoc-slide><h1>${title}</h1></section>` : `<h1>${title}</h1><p>Notes.</p>`;
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created: ago(age + 2 * D), versions: [{ n: 1, created: ago(age + 2 * D) }, { n: 2, created: ago(age) }],
      hosted: { account_id: `acct-${owner}`, github_login: owner, owner_key: owner },
      access: { commenting: 'signed_in', history_visibility: 'owner', allowed_users: [], ...access },
      preview: { excerpt: `About ${title.toLowerCase()}.`, kind },
    }));
    await env.DOCS.put(`docs/${slug}/v2/index.html`, `<!doctype html><html><body>${body}</body></html>`);
  };
  await doc('julie', 'julie-first', 'What standups cost', 'doc', { visibility: 'unlisted' }, 9 * D);
  await doc('julie', 'q4-plan', 'Q4 plan', 'doc', { visibility: 'unlisted' }, 2 * H);
  await doc('julie', 'budget-2027', 'Budget 2027', 'sheet', { visibility: 'private', allowed_users: ['bob'] }, D + 2 * H);
  await doc('julie', 'launch-deck', 'Launch deck', 'slides', { visibility: 'public' }, 3 * D);
  await doc('julie', 'ideas', 'Ideas', 'doc', { visibility: 'private' }, 40 * D);
  await doc('bob', 'bobs-doc', 'Bob research', 'doc', { visibility: 'unlisted' }, 5 * D);
  await doc('newbie', 'newbie-first', 'My first doc', 'doc', { visibility: 'unlisted' }, H);
  await env.META.put('recents:julie', JSON.stringify({ items: [{ slug: 'bobs-doc', at: ago(5 * H) }, { slug: 'q4-plan', at: ago(D + H) }] }));
  await env.META.put('stars:julie', JSON.stringify({ items: [{ slug: 'launch-deck', at: ago(2 * D) }] }));
  await env.META.put('inbox:julie', JSON.stringify({ items: [
    { id: 'n1', kind: 'comment', group_key: 'comment:q4-plan', slug: 'q4-plan', version: 2, comment_id: 'c_1', thread_id: 'c_1', actor: { login: 'bob', name: 'bob' }, preview: 'Is this final?', title: 'Q4 plan', at: ago(H), read: false, count: 2 },
  ] }));
  await env.META.put('agent-unread:julie', JSON.stringify({ items: [{ slug: 'launch-deck', thread: 'c_9', at: ago(30 * 60e3) }] }));
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
    // A browser closing mid-request aborts its body; unguarded, that rejection
    // ends the whole test process ("Error: aborted").
    try { for await (const chunk of req) chunks.push(chunk); } catch { return; }
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
  console.log('My docs rows UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };

  const run = async (label, viewport) => {
    const env = makeEnv(mod.CommentsStore);
    await seed(env);
    const { server, base } = await startServer(worker, env);
    const open = async (sid) => {
      const context = await browser.newContext({
        viewport,
        ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      });
      await context.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
      // The agent tip card would open over the row menu on a first visit.
      await context.addInitScript(() => { try { localStorage.setItem('tdoc.agentTip.dismissals', '2'); } catch {} });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      return { context, page, errors };
    };
    const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) }); } };
    const row = (page, slug) => page.locator(`.doc-row[data-slug="${slug}"]`);

    const julie = await open(JULIE);
    const { page } = julie;
    try {
      await t(`${label}: rows say doc / sheet / slides, with an accessible label`, async () => {
        await page.goto(`${base}/me`);
        await row(page, 'q4-plan').waitFor();
        await shot(page, 'docs');
        assert.equal(await row(page, 'budget-2027').getByRole('img', { name: 'Sheet' }).count(), 1);
        assert.equal(await row(page, 'launch-deck').getByRole('img', { name: 'Slides' }).count(), 1);
        assert.equal(await row(page, 'q4-plan').getByRole('img', { name: 'Doc' }).count(), 1);
        // The icon sits on the title line and stays inside the row.
        const icon = await row(page, 'budget-2027').locator('.doc-type').boundingBox();
        const title = await row(page, 'budget-2027').locator('.doc-title').boundingBox();
        assert.ok(icon && title && icon.x + icon.width <= title.x + 1, 'type icon is not before the title');
      });

      await t(`${label}: sharing state on your own rows`, async () => {
        const sharing = async (slug) => (await row(page, slug).locator('.doc-sharing').textContent()).trim();
        assert.equal(await sharing('q4-plan'), 'Link');
        assert.equal(await sharing('budget-2027'), '1 person');
        assert.equal(await sharing('launch-deck'), 'Public');
        assert.equal(await sharing('ideas'), 'Only you');
        assert.equal(await row(page, 'q4-plan').locator('.doc-sharing').getAttribute('aria-label'), 'Anyone with the link can read it');
      });

      await t(`${label}: unread comments and agent replies as a badge, nothing on a quiet row`, async () => {
        await row(page, 'q4-plan').getByRole('link', { name: '2 new comments' }).waitFor();
        await row(page, 'launch-deck').getByRole('link', { name: '1 agent reply' }).waitFor();
        assert.equal(await row(page, 'ideas').locator('.doc-activity').count(), 0);
        // Desktop and phone alike: the badge stays on the title line, inside the row.
        const rowBox = await row(page, 'q4-plan').boundingBox();
        const badge = await row(page, 'q4-plan').locator('.doc-activity').boundingBox();
        assert.ok(badge.x + badge.width <= rowBox.x + rowBox.width, 'badge overflows the row');
      });

      await t(`${label}: relative dates, and no setup card with three or more docs`, async () => {
        assert.match(await row(page, 'q4-plan').locator('.doc-meta').textContent(), /^updated 2h ago · Link$/);
        assert.equal(await page.locator('.onb-card, .onb-chip').count(), 0, 'the setup card shows with 5 docs');
      });

      await t(`${label}: Recent and Starred say when [the bug]`, async () => {
        await page.getByRole('tab', { name: 'Recent' }).click();
        await row(page, 'bobs-doc').waitFor();
        await shot(page, 'recent');
        assert.match(await row(page, 'bobs-doc').locator('.doc-meta').textContent(), /^bob · visited 5h ago$/);
        assert.match(await row(page, 'q4-plan').locator('.doc-meta').textContent(), /visited 1d ago/);
        assert.ok(await row(page, 'bobs-doc').locator('time').getAttribute('title'), 'no full date on hover');
        assert.equal(await row(page, 'bobs-doc').locator('.doc-sharing').count(), 0, 'somebody else\'s doc shows its sharing');
        await page.getByRole('tab', { name: 'Starred' }).click();
        await row(page, 'launch-deck').waitFor();
        assert.match(await row(page, 'launch-deck').locator('.doc-meta').textContent(), /starred 2d ago/);
      });

      await t(`${label}: ⋯ Share opens the doc page's Share dialog`, async () => {
        await page.getByRole('tab', { name: 'Docs' }).click();
        await row(page, 'q4-plan').getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menuitem').first().waitFor();
        await shot(page, 'row-menu');
        const items = await page.getByRole('menuitem').allTextContents();
        assert.equal(items[0], 'Share', `menu: ${items.join(', ')}`);
        await page.getByRole('menuitem', { name: 'Share' }).click();
        await page.waitForURL(/\/d\/q4-plan/);
        const dialog = page.getByRole('dialog', { name: 'Share' });
        await dialog.waitFor();
        await dialog.getByText('Who has access').waitFor();
        await shot(page, 'share-dialog');
        assert.ok(!page.url().includes('share=1'), 'share=1 stayed in the address');
      });

      await t(`${label}: Share is in a Recent row's ⋯ too`, async () => {
        await page.goto(`${base}/me?view=recent`);
        await row(page, 'bobs-doc').getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menuitem', { name: 'Share' }).waitFor();
        await page.keyboard.press('Escape');
      });
      assert.deepEqual(julie.errors, []);
    } finally {
      await julie.context.close();
    }

    const newbie = await open(NEWBIE);
    try {
      await t(`${label}: below three docs the setup card shows on Docs, and on no other tab`, async () => {
        const p = newbie.page;
        await p.goto(`${base}/me`);
        await row(p, 'newbie-first').waitFor();
        await p.locator('.onb-card').waitFor();
        await shot(p, 'newbie-docs');
        for (const tab of ['Recent', 'Starred', 'Comments', 'Trash', 'Settings']) {
          await p.getByRole('tab', { name: tab }).click();
          await p.waitForTimeout(100);
          assert.equal(await p.locator('.onb-card, .onb-chip').count(), 0, `setup card on ${tab}`);
        }
        await p.goto(`${base}/me?view=trash`);
        await p.locator('.tabs').waitFor();
        await p.waitForTimeout(200);
        assert.equal(await p.locator('.onb-card, .onb-chip').count(), 0, 'setup card on a direct Trash link');
        await shot(p, 'newbie-trash');
      });
      assert.deepEqual(newbie.errors, []);
    } finally {
      await newbie.context.close();
      server.close();
    }
  };

  try {
    await run('desktop', { width: 1440, height: 900 });
    await run('phone', { width: 390, height: 844 });
  } finally {
    await browser.close();
  }
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });
