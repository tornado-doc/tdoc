// My docs, layout A (wide screens): the left sidebar (Everything, types with
// counts, folders, Comments / Trash), Needs you from the bell's unread rows
// and unread agent replies, cards by default with a remembered list view,
// a doc dragged onto a folder moves there, and Settings as its own page with
// its sections. On a phone (390, 430): one column of rows, Needs you as a
// strip to swipe, the views and the type / folder filters as chip rows, ⋯
// with Star, Select for batch actions, Settings as a list of sections. Layout
// A is behind the myDocsA flag (on in dev mode): with it off, My docs keeps
// the one-column layout at every width. Real worker routes (in-process
// harness) behind a local HTTP server, real built shell runtime, real Chromium.
//
// TDOC_SHOTS_DIR=<dir> also writes screenshots (1440, 1280, dark, 390, 430).
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('my-docs-a-ui.test.js');

const JULIE = 'c3'.repeat(16);
const SHOTS = process.env.TDOC_SHOTS_DIR || '';
const H = 3600e3;
const D = 24 * H;
const FOLDER = 'f_1762900000000_abcdef12';
const FOLDER2 = 'f_1762900000001_abcdef13';

async function seed(env) {
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  for (const [login, sid] of [['julie', JULIE]]) {
    await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, created: '2026-01-01T00:00:00.000Z' }));
    await env.META.put(`session:${sid}`, JSON.stringify({ login, account_id: `acct-${login}`, name: 'Julie Shi', avatar_url: '', created: new Date().toISOString() }));
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
      preview: { excerpt: `About ${title.toLowerCase()}.`, kind, kind_v: 2 },
    }));
    await env.DOCS.put(`docs/${slug}/v2/index.html`, `<!doctype html><html><body>${body}</body></html>`);
  };
  await doc('julie', 'julie-first', 'What standups cost', 'doc', { visibility: 'unlisted' }, 9 * D);
  await doc('julie', 'q4-plan', 'Q4 plan', 'doc', { visibility: 'unlisted' }, 2 * H);
  await doc('julie', 'budget-2027', 'Budget 2027', 'sheet', { visibility: 'private', allowed_users: ['bob'] }, D + 2 * H);
  await doc('julie', 'launch-deck', 'Launch deck', 'slides', { visibility: 'public' }, 3 * D);
  await doc('julie', 'ideas', 'Ideas', 'doc', { visibility: 'private' }, 40 * D);
  await doc('julie', 'hiring-plan', 'Hiring plan 2027', 'sheet', { visibility: 'private' }, 6 * D);
  await doc('bob', 'bobs-doc', 'Bob research', 'doc', { visibility: 'unlisted' }, 5 * D);
  await env.META.put('folders:julie', JSON.stringify({
    folders: [
      { id: FOLDER, name: 'Planning', created: ago(20 * D), visibility: 'private' },
      { id: FOLDER2, name: 'Fundraising', created: ago(20 * D), visibility: 'private' },
    ],
    docs: { ideas: FOLDER, 'hiring-plan': FOLDER2 },
  }));
  await env.META.put('recents:julie', JSON.stringify({ items: [{ slug: 'bobs-doc', at: ago(5 * H) }, { slug: 'q4-plan', at: ago(D + H) }] }));
  await env.META.put('stars:julie', JSON.stringify({ items: [{ slug: 'launch-deck', at: ago(2 * D) }] }));
  await env.META.put('inbox:julie', JSON.stringify({ items: [
    { id: 'n1', kind: 'comment', group_key: 'comment:q4-plan', slug: 'q4-plan', version: 2, comment_id: 'c_1', thread_id: 'c_1', actor: { login: 'bob', name: 'Bob Lee' }, preview: 'Is this final? The Q3 numbers moved.', title: 'Q4 plan', at: ago(H), read: false, count: 2 },
    { id: 'n2', kind: 'mention', group_key: 'mention:budget-2027', slug: 'budget-2027', version: 2, comment_id: 'c_2', thread_id: 'c_2', actor: { login: 'serena', name: 'Serena Park' }, preview: '@julie can we drop the annual line?', title: 'Budget 2027', at: ago(3 * H), read: false, count: 1 },
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
  console.log('My docs layout A UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const env = makeEnv(mod.CommentsStore);
  await seed(env);
  const { server, base } = await startServer(worker, env);
  const open = async (viewport, { flags = { myDocsA: true }, dark = false } = {}) => {
    const context = await browser.newContext({
      viewport,
      ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    await context.addCookies([{ name: 'tdoc_sid', value: JULIE, url: base }]);
    await context.addInitScript(({ flags: pinned, dark: wantDark }) => {
      try { localStorage.setItem('tdoc.agentTip.dismissals', '2'); } catch {}
      if (wantDark) try { localStorage.setItem('tdoc-theme', 'dark'); } catch {}
      if (pinned) window.__TDOC_FLAGS__ = { ...(window.__TDOC_FLAGS__ || {}), ...pinned };
    }, { flags, dark });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, errors };
  };
  const shot = async (page, name, full = false) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
  };
  const card = (page, slug) => page.locator(`.mda .doc-row[data-slug="${slug}"]`);
  const shownSlugs = (page) => page.locator('.mda .doc-list .doc-row').evaluateAll((rows) => rows.map((row) => row.dataset.slug).sort());

  try {
    const { context, page, errors } = await open({ width: 1440, height: 900 });
    try {
      await t('1440: sidebar, title, grid of cards by default', async () => {
        await page.goto(`${base}/me`);
        await card(page, 'q4-plan').waitFor();
        const side = await page.locator('.mda-side').boundingBox();
        assert.ok(side && Math.abs(side.width - 232) <= 1, `sidebar is ${side && side.width}px`);
        assert.equal(await page.locator('.mda h1').textContent(), 'My docs');
        assert.equal(await page.locator('.mda-grid .mda-card').count(), 6);
        assert.equal(await page.locator('.tabs').count(), 0, 'the old tab row is gone on a wide screen');
        assert.equal(await card(page, 'budget-2027').locator('.mda-th-sheet').count(), 1, 'a sheet is drawn as a grid');
        assert.equal(await card(page, 'launch-deck').locator('.mda-th-slides').count(), 1, 'a deck is drawn as a slide');
        assert.equal(await card(page, 'budget-2027').getByRole('img', { name: 'Sheet' }).count(), 1);
        assert.match(await card(page, 'q4-plan').locator('.doc-meta').textContent(), /^updated 2h ago · Link$/);
        assert.equal(await page.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed'), 'true');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
        await shot(page, 'a-1440-grid');
      });

      await t('1440: Needs you shows the bell\'s unread rows and the unread agent reply, newest first', async () => {
        const needs = page.locator('.mda-needs').first();
        await needs.locator('.mda-need').first().waitFor();
        const slugs = await needs.locator('.mda-need').evaluateAll((cards) => cards.map((c) => c.dataset.slug));
        assert.deepEqual(slugs, ['q4-plan', 'budget-2027', 'launch-deck']);
        const q4 = needs.locator('.mda-need[data-slug="q4-plan"]');
        assert.match(await q4.locator('.mda-need-reason').textContent(), /^Bob Lee commented/);
        assert.equal(await q4.locator('.mda-need-quote').textContent(), 'Is this final? The Q3 numbers moved.');
        assert.equal(await q4.locator('.mda-who').textContent(), 'BL');
        assert.match(await q4.locator('.mda-need-link').getAttribute('href'), /^\/d\/q4-plan\/v\/2\?comment=c_1$/);
        const agent = needs.locator('.mda-need[data-slug="launch-deck"]');
        assert.equal(await agent.getAttribute('data-kind'), 'agent');
        assert.equal(await agent.locator('.mda-need-reason').textContent(), 'An agent replied');
        assert.equal(await agent.getByRole('button', { name: /Mark done/ }).count(), 0, 'no done for an agent reply (read it in the doc)');
        assert.equal(await page.getByRole('tab', { name: /Needs you/ }).locator('.mda-chip-n').textContent(), '3');
        // The card's unread: one blue circle with one number on the drawing's corner.
        const unread = card(page, 'launch-deck').locator('.doc-activity');
        assert.equal((await unread.textContent()).trim(), '1');
        assert.equal(await unread.getAttribute('aria-label'), '1 agent reply');
        assert.equal(await unread.locator('svg').count(), 0, 'no robot glyph');
        assert.equal((await unread.boundingBox()).height, 20);
      });

      await t('1440: Mark done reads the bell rows on the server, and the card stays gone after a reload', async () => {
        const read = page.waitForRequest((req) => req.url().includes('/api/notifications/read') && req.method() === 'POST');
        await page.locator('.mda-need[data-slug="budget-2027"]').getByRole('button', { name: 'Mark done: Budget 2027' }).click();
        assert.deepEqual(JSON.parse((await read).postData()).ids, ['n2']);
        await page.locator('.mda-need[data-slug="budget-2027"]').waitFor({ state: 'detached' });
        await page.waitForTimeout(200);
        await page.reload();
        await page.locator('.mda-need[data-slug="q4-plan"]').waitFor();
        assert.equal(await page.locator('.mda-need[data-slug="budget-2027"]').count(), 0);
      });

      await t('1440: Needs you view lists every card; the chip is a tab', async () => {
        await page.getByRole('tab', { name: /Needs you/ }).click();
        await page.locator('.mda-need').first().waitFor();
        assert.equal(await page.getByRole('tab', { name: /Needs you/ }).getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('.mda .doc-list').count(), 0);
        assert.match(page.url(), /view=needs/);
        await shot(page, 'a-1440-needs');
        await page.getByRole('tab', { name: /All docs/ }).click();
        await card(page, 'q4-plan').waitFor();
      });

      await t('1440: sidebar type filter narrows the list and says how many of each', async () => {
        const sheets = page.locator('.mda-side').getByRole('button', { name: /^Sheets/ });
        assert.equal(await sheets.getAttribute('aria-label'), 'Sheets (2)');
        assert.equal(await page.locator('.mda-side').getByRole('button', { name: /^Docs/ }).getAttribute('aria-label'), 'Docs (3)');
        assert.equal(await page.locator('.mda-side').getByRole('button', { name: /^Slides/ }).getAttribute('aria-label'), 'Slides (1)');
        await sheets.click();
        assert.equal(await sheets.getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await shownSlugs(page), ['budget-2027', 'hiring-plan']);
        assert.match(page.url(), /type=sheet/);
        await shot(page, 'a-1440-type-sheets');
        await sheets.click();
        assert.equal(await sheets.getAttribute('aria-pressed'), 'false');
        assert.equal((await shownSlugs(page)).length, 6);
      });

      await t('1440: a folder in the sidebar filters to its docs; Everything shows them all', async () => {
        const planning = page.locator(`.mda-folder[data-folder-id="${FOLDER}"]`);
        assert.equal(await planning.locator('.mda-side-count').textContent(), '1');
        await planning.getByRole('button', { name: /Planning/ }).click();
        assert.deepEqual(await shownSlugs(page), ['ideas']);
        assert.match(page.url(), new RegExp(`folder=${FOLDER}`));
        await page.locator('.mda-everything').getByRole('button').click();
        assert.equal((await shownSlugs(page)).length, 6);
      });

      await t('1440: dragging a card onto a folder moves the doc there, on the server too', async () => {
        const planning = page.locator(`.mda-folder[data-folder-id="${FOLDER}"]`);
        const move = page.waitForResponse((res) => res.url().includes('/api/folders/move') && res.request().method() === 'POST');
        await card(page, 'q4-plan').dragTo(planning);
        const response = await move;
        assert.equal(response.status(), 200, `move answered ${response.status()}`);
        assert.deepEqual(JSON.parse(response.request().postData()).slugs, ['q4-plan']);
        await page.locator('.tdoc-toast').getByText('Moved 1 doc').waitFor();
        await page.waitForFunction((id) => document.querySelector(`.mda-folder[data-folder-id="${id}"] .mda-side-count`)?.textContent === '2', FOLDER);
        await shot(page, 'a-1440-dragged');
        await page.reload();
        await page.locator(`.mda-folder[data-folder-id="${FOLDER}"]`).getByRole('button', { name: /Planning/ }).click();
        assert.deepEqual(await shownSlugs(page), ['ideas', 'q4-plan']);
        await shot(page, 'a-1440-folder');
        await page.locator('.mda-everything').getByRole('button').click();
      });

      await t('1440: New folder from the sidebar, then rename it from its ⋯', async () => {
        await page.locator('.mda-side').getByRole('button', { name: 'New folder' }).click();
        const dialog = page.getByRole('dialog', { name: 'New folder' });
        await dialog.locator('input').fill('Writing');
        await dialog.getByRole('button', { name: 'Create' }).click();
        const writing = page.locator('.mda-folder', { hasText: 'Writing' });
        await writing.waitFor();
        assert.equal(await writing.getAttribute('data-depth'), '0', 'a sidebar folder is made at the top');
        await writing.hover();
        await writing.getByRole('button', { name: 'Folder actions' }).click();
        await page.getByRole('menuitem', { name: 'Rename' }).click();
        const rename = page.getByRole('dialog', { name: 'Rename folder' });
        await rename.locator('input').fill('Essays');
        await rename.getByRole('button', { name: 'Save' }).click();
        await page.locator('.mda-folder', { hasText: 'Essays' }).waitFor();
      });

      await t('1440: the list view is a table and is remembered across visits', async () => {
        await page.getByRole('button', { name: 'List view' }).click();
        await page.locator('.mda-table .mda-row').first().waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('tdoc.myDocsLayout')), 'list');
        await page.reload();
        await page.locator('.mda-table .mda-row').first().waitFor();
        assert.equal(await page.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await page.locator('.mda-table-hd span').allTextContents(), ['', '', 'Name', 'Folder', 'Sharing', 'Last activity', '']);
        const row = page.locator('.mda-row[data-slug="ideas"]');
        assert.match(await row.locator('.mda-cell-folder').textContent(), /Planning/);
        assert.equal((await row.locator('.doc-sharing').textContent()).trim(), 'Only you');
        await row.getByRole('link', { name: 'Ideas' }).waitFor();
        await shot(page, 'a-1440-list');
        // Selecting works in the list: the batch bar offers Move and Delete.
        await row.hover();
        await row.getByRole('checkbox').check();
        await page.locator('.batch-bar').getByText('1 selected').waitFor();
        await page.locator('.batch-bar .batch-delete').waitFor();
        await row.getByRole('checkbox').uncheck();
        await page.getByRole('button', { name: 'Grid view' }).click();
      });

      await t('1440: Recent and Starred are views over the same sidebar filters', async () => {
        await page.getByRole('tab', { name: /Recent/ }).click();
        await card(page, 'bobs-doc').waitFor();
        assert.match(await card(page, 'bobs-doc').locator('.doc-meta').textContent(), /^bob · visited 5h ago$/);
        await page.getByRole('tab', { name: /Starred/ }).click();
        await card(page, 'launch-deck').waitFor();
        assert.match(await card(page, 'launch-deck').locator('.doc-meta').textContent(), /starred 2d ago/);
        await page.getByRole('tab', { name: /All docs/ }).click();
      });

      await t('1440: ⋯ on a card has Share, Rename, Move to folder, Delete; star toggles', async () => {
        await card(page, 'ideas').hover();
        await card(page, 'ideas').getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menuitem').first().waitFor();
        const items = await page.getByRole('menuitem').allTextContents();
        for (const want of ['Share', 'Rename', 'Move to folder', 'Delete']) assert.ok(items.includes(want), `menu: ${items.join(', ')}`);
        await shot(page, 'a-1440-row-menu');
        await page.keyboard.press('Escape');
        const star = card(page, 'ideas').getByRole('button', { name: 'Star Ideas' });
        await card(page, 'ideas').hover();
        await star.click();
        await card(page, 'ideas').getByRole('button', { name: 'Unstar Ideas' }).waitFor();
      });

      await t('1440: the New menu opens with the type tiles', async () => {
        await page.locator('.mda-new').click();
        await page.locator('.mk-tile[data-kind="doc"]').waitFor();
        await shot(page, 'a-1440-new');
        await page.keyboard.press('Escape');
      });

      await t('1440: Comments and Trash from the sidebar', async () => {
        await page.getByRole('tab', { name: 'Trash' }).click();
        await page.locator('#pane-trash').waitFor();
        assert.match(page.url(), /view=trash/);
        await page.getByRole('tab', { name: 'Comments' }).click();
        await page.locator('#pane-feedback').waitFor();
        await page.locator('.mda-everything').getByRole('button').click();
        await card(page, 'q4-plan').waitFor();
      });

      await t('1440: Settings is its own page from the account menu, with its sections', async () => {
        await page.locator('.tdoc-account-trigger').click();
        await page.getByRole('menuitem', { name: 'Settings' }).click();
        await page.waitForURL(/\/me\?view=settings/);
        const nav = page.getByRole('navigation', { name: 'Settings sections' });
        await nav.waitFor();
        assert.equal(await page.locator('.mda-side').count(), 0, 'no sidebar on Settings');
        const names = (await nav.locator('.mds-nav-item').allTextContents()).map((s) => s.trim());
        assert.deepEqual(names, ['Profile', 'Sign-in methods', 'Agents & computers', 'Teams', 'Notifications', 'Danger zone']);
        for (const id of ['profile', 'sign-in-methods', 'agents', 'agent-access', 'teams', 'notifications', 'delete-account']) {
          assert.equal(await page.locator(`.mds-body #${id}`).count(), 1, `#${id} missing`);
        }
        await shot(page, 'a-1440-settings');
        await nav.getByRole('link', { name: 'Teams' }).click();
        await page.waitForFunction(() => { const r = document.getElementById('teams').getBoundingClientRect(); return r.top >= 0 && r.top < 200; });
        await page.waitForTimeout(300);
        assert.equal(await nav.getByRole('link', { name: 'Teams' }).getAttribute('aria-current'), 'true');
        assert.match(page.url(), /#teams$/);
        await nav.getByRole('link', { name: 'Danger zone' }).click();
        await page.waitForFunction(() => { const r = document.getElementById('delete-account').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
        await page.waitForTimeout(300);
        assert.equal(await nav.getByRole('link', { name: 'Danger zone' }).getAttribute('aria-current'), 'true');
        await nav.getByRole('button', { name: 'My docs', exact: true }).click();
        await card(page, 'q4-plan').waitFor();
        assert.ok(!page.url().includes('view=settings'));
      });

      await t('1440: the account menu\'s Agents lands on the Agents section', async () => {
        await page.goto(`${base}/me?view=settings#agents`);
        await page.locator('.mds-body #agents').waitFor();
        await page.waitForFunction(() => document.getElementById('agents').getBoundingClientRect().top < 200);
      });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }

    await t('1280: same layout, nothing overflows; dark mode', async () => {
      const { context: ctx, page: p, errors: errs } = await open({ width: 1280, height: 800 });
      try {
        await p.goto(`${base}/me`);
        await card(p, 'q4-plan').waitFor();
        await p.locator('.mda-need').first().waitFor();
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
        const tools = await p.locator('.mda-filters').boundingBox();
        const main = await p.locator('.mda-main-in').boundingBox();
        assert.ok(tools.x + tools.width <= main.x + main.width + 1, 'filters overflow the column');
        await shot(p, 'a-1280-grid');
        await p.goto(`${base}/me?view=settings`);
        await p.locator('.mds-nav').waitFor();
        await shot(p, 'a-1280-settings');
        assert.deepEqual(errs, []);
      } finally { await ctx.close(); }
      const dark = await open({ width: 1440, height: 900 }, { dark: true });
      try {
        await dark.page.goto(`${base}/me`);
        await card(dark.page, 'q4-plan').waitFor();
        await dark.page.locator('.mda-need').first().waitFor();
        assert.equal(await dark.page.evaluate(() => document.documentElement.getAttribute('data-tdoc-theme')), 'dark');
        await shot(dark.page, 'a-1440-dark');
      } finally { await dark.context.close(); }
    });

    // ---- Layout A on a phone (390 = iPhone 14/15, 430 = the Pro Max) ----
    // State from the wide tests above: budget-2027's bell row is done,
    // q4-plan is in Planning, Essays exists, Ideas is starred.
    for (const width of [390, 430]) {
      await t(`phone ${width}, flag on: one column of rows, readable sizes, nothing sideways`, async () => {
        const { context: ctx, page: p, errors: errs } = await open({ width, height: 844 });
        try {
          await p.goto(`${base}/me`);
          await card(p, 'q4-plan').waitFor();
          await p.locator('.mda-need').first().waitFor();
          assert.equal(await p.locator('.mda-phone').count(), 1);
          assert.equal(await p.locator('.mda-side, .tabs, .mda-grid, .mda-table').count(), 0, 'no sidebar, old tabs, cards or table on a phone');
          assert.equal(await p.locator('.mda-plist .mda-prow').count(), 6);
          assert.equal(await p.locator('.mda h1').textContent(), 'My docs');
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
          const sizes = await card(p, 'budget-2027').evaluate((row) => ({
            height: row.getBoundingClientRect().height,
            title: parseFloat(getComputedStyle(row.querySelector('.doc-title')).fontSize),
            meta: parseFloat(getComputedStyle(row.querySelector('.doc-meta')).fontSize),
            metaLines: Math.round(row.querySelector('.doc-meta').getBoundingClientRect().height / parseFloat(getComputedStyle(row.querySelector('.doc-meta')).lineHeight)),
            menu: row.querySelector('.row-menu-btn').getBoundingClientRect().height,
          }));
          assert.ok(sizes.height >= 64, `row is ${sizes.height}px tall`);
          assert.ok(sizes.title >= 16, `title is ${sizes.title}px`);
          assert.ok(sizes.meta >= 14, `meta is ${sizes.meta}px`);
          assert.equal(sizes.metaLines, 1, 'one meta line');
          assert.ok(sizes.menu >= 44, `⋯ is ${sizes.menu}px`);
          assert.match(await card(p, 'budget-2027').locator('.doc-meta').textContent(), /^updated 1d ago · 1 person$/);
          assert.equal(await card(p, 'budget-2027').getByRole('img', { name: 'Sheet' }).count(), 1);
          // Unread: one blue circle with one number at the row's end, the
          // breakdown in its label; no robot or bubble glyphs.
          const badge = card(p, 'q4-plan').locator('.doc-activity');
          assert.equal((await badge.textContent()).trim(), '2');
          assert.equal(await badge.getAttribute('aria-label'), '2 new comments');
          assert.equal((await card(p, 'launch-deck').locator('.doc-activity').textContent()).trim(), '1');
          assert.equal(await card(p, 'launch-deck').locator('.doc-activity').getAttribute('aria-label'), '1 agent reply');
          assert.equal(await p.locator('.doc-activity svg').count(), 0);
          const [badgeBox, titleBox] = [await badge.boundingBox(), await card(p, 'q4-plan').locator('.doc-title').boundingBox()];
          assert.ok(badgeBox.height === 20 && badgeBox.x > titleBox.x + titleBox.width, 'badge is a 20px circle after the title');
          // A long title wraps to two lines before it is cut.
          const wrap = await card(p, 'q4-plan').locator('.doc-title').evaluate((el) => {
            const before = el.textContent;
            el.textContent = 'A much longer title that goes on and on about the quarterly plan and its numbers, 第一轮原始记录';
            const lh = parseFloat(getComputedStyle(el).lineHeight);
            const lines = Math.round(el.getBoundingClientRect().height / lh);
            el.textContent = before;
            return { lines, clamp: getComputedStyle(el).webkitLineClamp };
          });
          assert.deepEqual(wrap, { lines: 2, clamp: '2' }, 'a long title wraps to two lines, then is cut');
          // A starred doc keeps its star by the title.
          assert.equal(await card(p, 'launch-deck').getByRole('img', { name: 'Starred' }).count(), 1);
          // The row opens the doc from anywhere on it.
          await card(p, 'ideas').scrollIntoViewIfNeeded();
          const box = await card(p, 'ideas').boundingBox();
          const hit = await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'), [box.x + box.width * 0.6, box.y + box.height - 8]);
          assert.equal(hit, '/d/ideas');
          const body = await p.locator('.mda-psearch input').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          assert.ok(body >= 16, `search is ${body}px (iOS zooms under 16)`);
          const newBtn = await p.locator('.mda-new').boundingBox();
          assert.ok(newBtn.height >= 44, `New is ${newBtn.height}px tall`);
          await shot(p, `a-phone-${width}`);
          await shot(p, `a-phone-${width}-full`, true);
          assert.deepEqual(errs, []);
        } finally { await ctx.close(); }
      });

      await t(`phone ${width}, flag on: Needs you is a strip of cards to swipe, See all opens the view`, async () => {
        const { context: ctx, page: p, errors: errs } = await open({ width, height: 844 });
        try {
          await p.goto(`${base}/me`);
          const strip = p.locator('.mda-needs-grid.is-strip');
          await strip.locator('.mda-need').first().waitFor();
          assert.deepEqual(await strip.locator('.mda-need').evaluateAll((cards) => cards.map((c) => c.dataset.slug)), ['q4-plan', 'launch-deck']);
          const layout = await strip.evaluate((el) => {
            const tops = [...el.querySelectorAll('.mda-need')].map((c) => Math.round(c.getBoundingClientRect().top));
            return { oneRow: new Set(tops).size === 1, scrolls: el.scrollWidth > el.clientWidth, overflowX: getComputedStyle(el).overflowX, snap: getComputedStyle(el).scrollSnapType };
          });
          assert.ok(layout.oneRow, 'cards sit in one row');
          assert.ok(layout.scrolls && layout.overflowX === 'auto', 'the strip scrolls sideways');
          assert.match(layout.snap, /x/);
          const reason = await strip.locator('.mda-need-reason').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          assert.ok(reason >= 15, `card text is ${reason}px`);
          await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
          await shot(p, `a-phone-${width}-needs-swiped`);
          await p.getByRole('button', { name: 'See all 2' }).click();
          assert.equal(await p.getByRole('tab', { name: /Needs you/ }).getAttribute('aria-selected'), 'true');
          await p.locator('.mda-needs .mda-need').first().waitFor();
          assert.equal(await p.locator('.mda-needs-grid.is-strip').count(), 0, 'the view lists them, one per line');
          assert.match(p.url(), /view=needs/);
          await shot(p, `a-phone-${width}-needs`);
          assert.deepEqual(errs, []);
        } finally { await ctx.close(); }
      });

      await t(`phone ${width}, flag on: type chips and folder chips filter the list`, async () => {
        const { context: ctx, page: p, errors: errs } = await open({ width, height: 844 });
        try {
          await p.goto(`${base}/me`);
          await card(p, 'q4-plan').waitFor();
          const filters = p.getByRole('group', { name: 'Filter by type and folder' });
          const scrolls = await filters.evaluate((el) => getComputedStyle(el).overflowX === 'auto' && getComputedStyle(el).flexWrap === 'nowrap');
          assert.ok(scrolls, 'the chip row scrolls sideways');
          const sheets = filters.getByRole('button', { name: 'Sheets (2)' });
          await sheets.click();
          assert.equal(await sheets.getAttribute('aria-pressed'), 'true');
          assert.deepEqual(await shownSlugs(p), ['budget-2027', 'hiring-plan']);
          assert.match(p.url(), /type=sheet/);
          await shot(p, `a-phone-${width}-type-sheets`);
          await sheets.click();
          assert.equal((await shownSlugs(p)).length, 6);
          const planning = filters.locator(`.mda-folder[data-folder-id="${FOLDER}"]`);
          assert.equal(await planning.locator('.mda-chip-n').textContent(), '2');
          await planning.click();
          assert.equal(await planning.getAttribute('aria-pressed'), 'true');
          assert.deepEqual(await shownSlugs(p), ['ideas', 'q4-plan']);
          assert.match(p.url(), new RegExp(`folder=${FOLDER}`));
          await p.reload();
          await card(p, 'ideas').waitFor();
          const inSight = await filters.locator(`.mda-folder[data-folder-id="${FOLDER}"]`).evaluate((chip) => {
            const r = chip.getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth;
          });
          assert.ok(inSight, 'the chosen folder chip is scrolled into sight');
          // The open folder's path, with its ⋯ (Share, Rename, Delete).
          const crumbs = p.getByRole('navigation', { name: 'Folder path' });
          await crumbs.getByRole('button', { name: 'Planning' }).waitFor();
          await crumbs.getByRole('button', { name: 'Folder actions' }).click();
          await p.getByRole('menuitem').first().waitFor();
          const folderItems = await p.getByRole('menuitem').allTextContents();
          for (const want of ['Share', 'Rename', 'Delete folder']) assert.ok(folderItems.includes(want), `folder menu: ${folderItems.join(', ')}`);
          await p.keyboard.press('Escape');
          // Type and folder together.
          await filters.getByRole('button', { name: /^Docs/ }).click();
          assert.deepEqual(await shownSlugs(p), ['ideas', 'q4-plan']);
          await filters.getByRole('button', { name: /^Slides/ }).click();
          assert.deepEqual(await shownSlugs(p), []);
          await p.locator('.mda-phone .empty').getByText('No slides in Planning yet.').waitFor();
          await shot(p, `a-phone-${width}-folder`);
          await filters.getByRole('button', { name: /^Slides/ }).click();
          await filters.getByRole('button', { name: 'All folders' }).click();
          assert.equal((await shownSlugs(p)).length, 6);
          assert.equal(await filters.getByRole('button', { name: 'New folder' }).count(), 1);
          assert.deepEqual(errs, []);
        } finally { await ctx.close(); }
      });

      await t(`phone ${width}, flag on: ⋯ on a row (Star first), Select for batch actions, New by type, the other views`, async () => {
        const { context: ctx, page: p, errors: errs } = await open({ width, height: 844 });
        try {
          await p.goto(`${base}/me`);
          await card(p, 'budget-2027').waitFor();
          await card(p, 'budget-2027').getByRole('button', { name: 'More actions' }).click();
          await p.getByRole('menuitem').first().waitFor();
          const items = await p.getByRole('menuitem').allTextContents();
          assert.equal(items[0], 'Star');
          for (const want of ['Share', 'Rename', 'Move to folder', 'Delete']) assert.ok(items.includes(want), `menu: ${items.join(', ')}`);
          await shot(p, `a-phone-${width}-row-menu`);
          const star = p.waitForRequest((req) => req.url().includes('/api/star') && req.method() === 'POST');
          await p.getByRole('menuitem', { name: 'Star' }).click();
          await star;
          await card(p, 'budget-2027').getByRole('img', { name: 'Starred' }).waitFor();
          await card(p, 'budget-2027').getByRole('button', { name: 'More actions' }).click();
          await p.getByRole('menuitem', { name: 'Unstar' }).click();
          await card(p, 'budget-2027').getByRole('img', { name: 'Starred' }).waitFor({ state: 'detached' });
          // Select: checkboxes on the rows, the batch bar once one is ticked.
          assert.equal(await p.locator('.mda-prow .row-check').count(), 0);
          await p.getByRole('button', { name: 'Select' }).click();
          await card(p, 'ideas').getByRole('checkbox', { name: 'Select Ideas' }).check();
          await p.locator('.batch-bar').getByText('1 selected').waitFor();
          await p.locator('.batch-bar .batch-delete').waitFor();
          await shot(p, `a-phone-${width}-select`);
          await p.getByRole('button', { name: 'Done', exact: true }).click();
          assert.equal(await p.locator('.mda-prow .row-check, .batch-bar').count(), 0);
          // New: the type tiles.
          await p.locator('.mda-new').click();
          await p.locator('.mk-tile[data-kind="doc"]').waitFor();
          await shot(p, `a-phone-${width}-new`);
          await p.keyboard.press('Escape');
          // Recent, Comments, Trash: chips in the same scrolling row.
          const views = p.getByRole('tablist', { name: 'My docs views' });
          await views.getByRole('tab', { name: /Recent/ }).click();
          await card(p, 'bobs-doc').waitFor();
          assert.match(await card(p, 'bobs-doc').locator('.doc-meta').textContent(), /^bob · visited 5h ago/);
          await views.getByRole('tab', { name: 'Trash' }).click();
          await p.locator('#pane-trash').waitFor();
          assert.match(p.url(), /view=trash/);
          await views.getByRole('tab', { name: 'Comments' }).click();
          await p.locator('#pane-feedback').waitFor();
          await views.getByRole('tab', { name: /All docs/ }).click();
          await card(p, 'q4-plan').waitFor();
          // Search: the same filter as on a wide screen, the folder in the meta line.
          await p.locator('.mda-psearch input').fill('ideas');
          assert.deepEqual(await shownSlugs(p), ['ideas']);
          assert.match(await card(p, 'ideas').locator('.doc-meta').textContent(), /^in Planning · /);
          assert.equal(await p.locator('.mda-needs-grid').count(), 0, 'Needs you steps aside while searching');
          assert.deepEqual(errs, []);
        } finally { await ctx.close(); }
      });

      await t(`phone ${width}, flag on: Settings from the account menu is a full-screen list of sections`, async () => {
        const { context: ctx, page: p, errors: errs } = await open({ width, height: 844 });
        try {
          await p.goto(`${base}/me`);
          await card(p, 'q4-plan').waitFor();
          await p.getByRole('button', { name: 'More actions' }).first().click();
          await p.getByRole('menuitem', { name: 'My account' }).click();
          await p.getByRole('menuitem', { name: 'Settings' }).click();
          await p.waitForURL(/\/me\?view=settings/);
          const nav = p.getByRole('navigation', { name: 'Settings sections' });
          await nav.waitFor();
          assert.equal(await p.locator('.mda-phone, .mds-nav').count(), 0, 'no My docs chrome, no side list');
          const names = (await nav.locator('.mds-list-item').allTextContents()).map((s) => s.trim());
          assert.deepEqual(names, ['Profile', 'Sign-in methods', 'Agents & computers', 'Teams', 'Notifications', 'Danger zone']);
          const row = await nav.locator('.mds-list-item').first().evaluate((el) => ({ h: el.getBoundingClientRect().height, f: parseFloat(getComputedStyle(el).fontSize) }));
          assert.ok(row.h >= 56 && row.f >= 16, `section row ${row.h}px, ${row.f}px text`);
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 0, `settings scroll sideways by ${overflow}px`);
          await shot(p, `a-phone-${width}-settings`);
          await nav.getByRole('link', { name: 'Teams' }).click();
          await p.locator('.mds-body #teams').waitFor();
          assert.equal(await p.locator('.mds-body #profile, .mds-body #notifications').count(), 0, 'one section at a time');
          assert.match(p.url(), /#teams$/);
          await shot(p, `a-phone-${width}-settings-teams`);
          await p.getByRole('button', { name: 'Settings', exact: true }).click();
          await nav.waitFor();
          await nav.getByRole('link', { name: 'Profile' }).click();
          await p.locator('.mds-body #profile').waitFor();
          await shot(p, `a-phone-${width}-settings-profile`);
          await p.getByRole('button', { name: 'Settings', exact: true }).click();
          await p.getByRole('button', { name: 'My docs', exact: true }).click();
          await card(p, 'q4-plan').waitFor();
          assert.ok(!p.url().includes('view=settings'));
          // The account menu's Agents opens that section directly.
          await p.goto(`${base}/me?view=settings#agents`);
          await p.locator('.mds-body #agents').waitFor();
          assert.equal(await p.locator('.mds-list').count(), 0);
          assert.deepEqual(errs, []);
        } finally { await ctx.close(); }
      });

      await t(`phone ${width}, flag on: dark mode`, async () => {
        const dark = await open({ width, height: 844 }, { dark: true });
        try {
          await dark.page.goto(`${base}/me`);
          await card(dark.page, 'q4-plan').waitFor();
          await dark.page.locator('.mda-need').first().waitFor();
          assert.equal(await dark.page.evaluate(() => document.documentElement.getAttribute('data-tdoc-theme')), 'dark');
          await shot(dark.page, `a-phone-${width}-dark`);
          await dark.page.goto(`${base}/me?view=settings`);
          await dark.page.locator('.mds-list').waitFor();
          await shot(dark.page, `a-phone-${width}-settings-dark`);
          assert.deepEqual(dark.errors, []);
        } finally { await dark.context.close(); }
      });
    }

    await t('team space: the same layout, its own folders, drag into a team folder, Team settings in the sidebar', async () => {
      const api = async (url, body) => {
        const response = await worker.fetch(new Request(`https://tdoc.dev${url}`, {
          method: 'POST',
          headers: { Cookie: `tdoc_sid=${JULIE}`, Origin: 'https://tdoc.dev', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }), env, { waitUntil() {} });
        const json = await response.json();
        assert.ok(response.ok, `${url}: ${response.status} ${JSON.stringify(json)}`);
        return json;
      };
      const teamId = (await api('/api/teams', { name: 'Acme' })).team.id;
      await api('/api/team/move', { slugs: ['julie-first', 'launch-deck'], team: teamId });
      const folderId = (await api('/api/folders', { name: 'Launches', team: teamId })).folder.id;
      const { context: ctx, page: p, errors: errs } = await open({ width: 1440, height: 900 });
      try {
        await p.goto(`${base}/me?team=${teamId}`);
        await card(p, 'launch-deck').waitFor();
        assert.equal(await p.locator('.mda h1').textContent(), 'Acme');
        assert.deepEqual(await shownSlugs(p), ['julie-first', 'launch-deck']);
        const launches = p.locator(`.mda-folder[data-folder-id="${folderId}"]`);
        await card(p, 'launch-deck').dragTo(launches);
        await p.locator('.tdoc-toast').getByText('Moved 1 doc').waitFor();
        await launches.getByRole('button', { name: /Launches/ }).click();
        assert.deepEqual(await shownSlugs(p), ['launch-deck']);
        await p.locator('.mda-everything').getByRole('button').click();
        await shot(p, 'a-1440-team');
        await p.getByRole('tab', { name: 'Team settings' }).click();
        await p.locator('.mda .tm-settings').first().waitFor();
        assert.match(p.url(), /view=settings/);
        assert.equal(await p.locator('.mda-side').count(), 1, 'team settings keep the sidebar');
        // Back in My docs, the moved docs are gone from the personal list.
        await p.goto(`${base}/me`);
        await card(p, 'q4-plan').waitFor();
        assert.equal(await card(p, 'launch-deck').count(), 0);
        assert.deepEqual(errs, []);
      } finally { await ctx.close(); }
    });

    await t('myDocsA off (everybody outside dev mode): the one-column layout with its tabs, on a wide screen', async () => {
      const { context: ctx, page: p, errors: errs } = await open({ width: 1440, height: 900 }, { flags: null });
      try {
        await p.goto(`${base}/me`);
        await p.locator('.tabs').waitFor();
        assert.equal(await p.locator('.mda').count(), 0);
        assert.deepEqual((await p.getByRole('tab').allTextContents()).map((s) => s.trim()), ['Docs', 'Recent', 'Starred', 'Comments', 'Trash', 'Settings']);
        await shot(p, 'old-1440-flag');
        assert.deepEqual(errs, []);
      } finally { await ctx.close(); }
    });

    // Flag off (everybody outside dev mode): a phone keeps today's layout.
    for (const width of [390, 430]) {
      await t(`phone ${width}, flag off: the one-column layout as before (tabs, folders as rows, select all)`, async () => {
        const { context: ctx, page: p, errors: errs } = await open({ width, height: 844 }, { flags: null });
        try {
          await p.goto(`${base}/me`);
          await p.locator('.tabs').waitFor();
          await p.locator('.doc-row[data-slug="budget-2027"]').waitFor();
          assert.equal(await p.locator('.mda, .mda-side, .mda-phone, .mda-prow, .mda-needs').count(), 0);
          assert.equal(await p.locator('.docs-hub.is-phone-a, .docs-hub.is-wide-a').count(), 0, 'no layout A class on the page');
          assert.deepEqual((await p.getByRole('tab').allTextContents()).map((s) => s.trim()), ['Docs', 'Recent', 'Starred', 'Comments', 'Trash', 'Settings']);
          await p.locator('main.wrap .page-hd .mk-btn').getByText('New').waitFor();
          await p.getByRole('button', { name: 'Grid view' }).waitFor();
          await p.locator('.batch-bar .select-all').getByText('Select all').waitFor();
          assert.ok(await p.locator('#folder-rows .folder-row').count() >= 2, 'folders are rows at the top of Docs');
          assert.equal(await p.locator('.doc-list .doc-row .star-btn').count() > 0, true, 'rows keep their star button');
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 0, `phone page scrolls sideways by ${overflow}px`);
          await shot(p, `old-phone-${width}-docs`);
          await p.goto(`${base}/me?view=needs`);
          await p.locator('.tabs').waitFor();
          await p.waitForFunction(() => !location.search.includes('view=needs'));
          assert.equal(await p.getByRole('tab', { name: 'Docs' }).getAttribute('aria-selected'), 'true', 'Needs you falls back to Docs');
          await p.goto(`${base}/me?view=settings`);
          await p.locator('.tm-settings').waitFor();
          assert.equal(await p.locator('.mds, .mds-list').count(), 0, 'the old Settings tab, not the Settings page');
          await shot(p, `old-phone-${width}-settings`);
          assert.deepEqual(errs, []);
        } finally { await ctx.close(); }
      });
    }
  } finally {
    server.close();
    await browser.close();
  }
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });
