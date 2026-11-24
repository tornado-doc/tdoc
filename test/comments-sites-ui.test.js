// Comments and Sites tabs (commentsSitesTabs), in a real browser: real worker
// routes (in-process harness) behind a local HTTP server, the built shell
// runtime, Chromium.
//
// Flag on, in My docs and a team:
//   Comments lists doc and site comments in one list, a doc or globe mark on
//     each, a site row with its host, page and the element clicked; Filters
//     has From (All / Docs / Sites) and "Doc or site".
//   Sites has one row per site with its open count and one button (Settings
//     opens under the row; Add to your site for a bookmark-only one); local
//     and preview hosts fold under Test sites and are not counted; a site's
//     name opens Comments on that site alone.
//   No sites: the /feedback SDK block (demo, Ask your agent, the one line),
//     Add to your site and Try it on a page first.
//   Phone: no sideways scroll; rows stack.
// Flag off: Comments is the old list of sites; there is no Sites tab.
// TDOC_UI_SHOTS=<dir> saves screenshots at 1440 and 390.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('comments-sites-ui.test.js');

const SHOTS = process.env.TDOC_UI_SHOTS || '';
const JULIE = 'c5'.repeat(16);
const BOB = 'c6'.repeat(16);
const CAROL = 'c7'.repeat(16);

async function seed(worker, env) {
  const people = [['julie', JULIE, 'Julie'], ['bob', BOB, 'Bob'], ['carol', CAROL, 'Carol']];
  for (const [login, sid, name] of people) {
    await env.META.put(`hosted-account:${login}`, JSON.stringify({ account_id: `acct-${login}`, github_login: login, created: '2026-01-01T00:00:00.000Z' }));
    await env.META.put(`session:${sid}`, JSON.stringify({ login, account_id: `acct-${login}`, name, avatar_url: '', created: new Date().toISOString() }));
  }
  const created = '2026-11-01T00:00:00.000Z';
  for (const [slug, title, owner] of [['q4-plan', 'Q4 launch plan', 'julie'], ['access-model', 'Agent access model', 'julie'], ['release-notes', 'Release notes Nov 12', 'julie']]) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created, versions: [{ n: 1, created }],
      hosted: { account_id: `acct-${owner}`, github_login: owner },
      access: { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${title}</h1><p>Ship on Dec 18</p><p>This release</p>`);
  }
  const call = async (pathname, body, { method = 'POST', sid = JULIE, token = '' } = {}) => (await worker.fetch(new Request(`https://tdoc.dev${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: `tdoc_sid=${sid}` }),
      'Content-Type': 'application/json',
      Origin: 'https://tdoc.dev',
    },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} })).json();
  await call('/api/comments', { slug: 'q4-plan', version: 1, text: 'This date clashes with the December freeze.', anchor: { text: 'Ship on Dec 18' } });
  await call('/api/comments', { slug: 'access-model', version: 1, text: 'Split into two token levels?', anchor: { text: 'Ship on Dec 18' } });
  const site = async (origin, comments, sid = JULIE) => {
    const space = await call('/api/feedback/connect', { origin }, { sid });
    for (const [text, anchor] of comments) {
      await call('/api/comments', { slug: space.slug, version: 1, text, anchor: { kind: 'product', ...anchor } }, { token: space.token });
    }
    return space.slug;
  };
  const hustle = await site('https://hustlefree.ai', [
    ['This button is hard to find on a phone.', { url: 'https://hustlefree.ai/pricing', selector: '#trial', tag: 'button', text: 'Start free trial' }],
    ['Logo looks blurry on a retina screen.', { url: 'https://hustlefree.ai/', selector: 'img.hero-logo', tag: 'img' }],
  ]);
  await call('/api/feedback/site', { slug: hustle, origins: ['https://hustlefree.ai', 'https://www.hustlefree.ai'] });
  const bookmark = await site('https://app.example.com', [['The table jumps on load.', { url: 'https://app.example.com/reports', selector: 'table.grid', tag: 'table' }]]);
  const local = await site('http://localhost:3000', [['Local only.', { url: 'http://localhost:3000/', selector: 'h1', tag: 'h1', text: 'Home' }]]);
  const preview = await site('https://pr-879-tdoc-preview.tornado.workers.dev', []);
  // A team with a doc and a site of its own.
  const team = (await call('/api/teams', { name: 'Tdoc' })).team;
  await call('/api/team/move', { slugs: ['release-notes'], team: team.id });
  await call('/api/comments', { slug: 'release-notes', version: 1, text: 'Lead with the sheets change.', anchor: { text: 'This release' } });
  const teamSite = await site('https://tdoc.dev', [['The SDK card wraps badly at 375px.', { url: 'https://tdoc.dev/feedback', selector: 'div.fb-card', tag: 'div', text: 'SDK' }]]);
  await call('/api/team/move', { slugs: [teamSite], team: team.id });
  await call('/api/feedback/site', { slug: teamSite, origins: ['https://tdoc.dev'] });
  // Carol is a member (not an admin) of both teams; the second has no sites.
  const emptyTeam = (await call('/api/teams', { name: 'Empty team' })).team;
  for (const item of [team, emptyTeam]) await call('/api/team/join', { token: item.invite_url.split('/').pop() }, { sid: CAROL });
  return { hustle, bookmark, local, preview, team, teamSite, emptyTeam };
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
    try { for await (const chunk of req) chunks.push(chunk); } catch { return; }
    const headers = { ...req.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method,
      headers,
      redirect: 'manual',
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
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
  console.log('Comments and Sites tabs UI (commentsSitesTabs)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'test-client' });
  const ids = await seed(worker, env);
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const open = async (pathname, { width = 1440, flag = true, sid = JULIE, flags = {} } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
    await context.addInitScript((all) => { window.__TDOC_FLAGS__ = all; }, { commentsSitesTabs: flag, ...flags });
    const page = await context.newPage();
    await page.goto(`${base}${pathname}`);
    return { context, page };
  };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  };
  const noSideScroll = async (page) => {
    const m = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }));
    assert.ok(m.s <= m.w + 1, `sideways scroll ${JSON.stringify(m)}`);
  };
  const teamQ = `team=${encodeURIComponent(ids.team.id)}`;

  try {
    for (const width of [1440, 390]) {
      const tag = width === 1440 ? 'desktop' : 'phone';
      await t(`${tag}: My docs Comments lists doc and site comments together, each with its source`, async () => {
        const { context, page } = await open('/me?view=comments', { width });
        await page.waitForFunction(() => document.querySelectorAll('#pane-my-comments .tm-comment-row').length >= 5);
        const rows = page.locator('#pane-my-comments .tm-comment-row');
        assert.equal(await page.locator('#pane-my-comments .tm-comment-row.is-site').count(), 4);
        assert.equal(await page.locator('#pane-my-comments .tm-comment-row.is-doc').count(), 2);
        const pricing = rows.filter({ hasText: 'hard to find on a phone' });
        assert.match(await pricing.locator('.tm-comment-src').textContent(), /hustlefree\.ai\/pricing/);
        assert.equal(await pricing.locator('.tm-comment-src svg[aria-label="Site"]').count(), 1);
        assert.equal(await pricing.locator('.tm-comment-anchor code').textContent(), 'button "Start free trial"');
        assert.match(await pricing.getAttribute('href'), new RegExp(`^/d/${ids.hustle}\\?comment=`));
        const doc = rows.filter({ hasText: 'December freeze' });
        assert.match(await doc.locator('.tm-comment-src').textContent(), /Q4 launch plan/);
        assert.equal(await doc.locator('.tm-comment-src svg[aria-label="Doc"]').count(), 1);
        assert.match(await doc.locator('.tm-comment-anchor').textContent(), /“Ship on Dec 18”/);
        // A team's comments stay with the team.
        assert.equal(await rows.filter({ hasText: 'sheets change' }).count(), 0);
        assert.equal(await rows.filter({ hasText: 'SDK card' }).count(), 0);
        await noSideScroll(page);
        await shot(page, `my-docs-comments-${width}`);
        await context.close();
      });

      await t(`${tag}: Filters has From (All / Docs / Sites) and Doc or site`, async () => {
        const { context, page } = await open('/me?view=comments', { width });
        await page.waitForFunction(() => document.querySelectorAll('#pane-my-comments .tm-comment-row').length >= 5);
        await page.getByRole('button', { name: 'Filters' }).click();
        const from = page.getByRole('radiogroup', { name: 'Comments from' });
        assert.deepEqual(await from.getByRole('radio').allTextContents(), ['All', 'Docs', 'Sites']);
        await page.getByRole('combobox', { name: 'Comment doc or site' }).click();
        await page.getByRole('option', { name: 'All docs and sites' }).waitFor();
        assert.deepEqual((await page.getByRole('option').allTextContents()).filter((x) => /hustlefree|Q4/.test(x)), ['hustlefree.ai', 'Q4 launch plan']);
        await page.getByRole('option', { name: 'All docs and sites' }).click();
        await shot(page, `my-docs-comments-filters-${width}`);
        await from.getByRole('radio', { name: 'Sites' }).click();
        assert.equal(await page.locator('#pane-my-comments .tm-comment-row.is-doc').count(), 0);
        assert.equal(await page.locator('#pane-my-comments .tm-comment-row.is-site').count(), 4);
        await from.getByRole('radio', { name: 'Docs' }).click();
        assert.equal(await page.locator('#pane-my-comments .tm-comment-row.is-site').count(), 0);
        assert.equal(await page.locator('#pane-my-comments .tm-comment-row.is-doc').count(), 2);
        await page.getByRole('button', { name: 'Done' }).click();
        assert.equal(await page.getByRole('button', { name: 'Filters · 1' }).count(), 1, 'Filters · 1');
        await context.close();
      });

      await t(`${tag}: My docs Sites: one row per site, test sites folded and not counted`, async () => {
        const { context, page } = await open('/me?view=sites', { width });
        await page.waitForSelector('#pane-sites .site-row');
        const main = page.locator('#pane-sites > .sites-list .site-row');
        const titles = await main.locator('.doc-title').allTextContents();
        assert.deepEqual([...titles].sort(), ['app.example.com', 'hustlefree.ai']);
        const hustle = main.filter({ hasText: 'hustlefree.ai' });
        // Counts arrive with /api/me/feedback.
        await page.waitForFunction(() => [...document.querySelectorAll('#pane-sites .site-row')].some((r) => /2 open/.test(r.textContent)));
        assert.match(await hustle.textContent(), /2 open.*on the site/);
        assert.equal(await hustle.getByRole('button').last().textContent(), 'Settings');
        const bookmark = main.filter({ hasText: 'app.example.com' });
        assert.match(await bookmark.textContent(), /bookmark only/);
        assert.equal(await bookmark.getByRole('button', { name: 'Add to your site' }).count(), 1);
        const tests = page.locator('details.sites-tests');
        assert.equal(await tests.getAttribute('open'), null, 'test sites start folded');
        assert.match(await tests.locator('summary').textContent(), /Test sites · 2/);
        if (width === 1440) assert.equal((await page.locator('.mda-view-sites .mda-side-count').textContent()).trim(), '2', 'test sites counted');
        await noSideScroll(page);
        await shot(page, `my-docs-sites-${width}`);
        // Settings opens under the row, the existing site settings, and the site page stays reachable.
        await hustle.getByRole('button', { name: 'Settings' }).click();
        const panel = page.locator(`#site-settings-${ids.hustle}`);
        await panel.waitFor();
        assert.match(await panel.locator('textarea').inputValue(), /https:\/\/hustlefree\.ai\nhttps:\/\/www\.hustlefree\.ai/);
        assert.match(await panel.locator('.tdoc-site-snippet').textContent(), new RegExp(`data-tdoc-space="${ids.hustle}"`));
        assert.equal(await panel.getByRole('link', { name: 'Open site page' }).getAttribute('href'), `/d/${ids.hustle}`);
        await tests.locator('summary').click();
        await noSideScroll(page);
        await shot(page, `my-docs-sites-settings-${width}`);
        await context.close();
      });

      await t(`${tag}: a site's name opens Comments on that site alone`, async () => {
        const { context, page } = await open('/me?view=sites', { width });
        await page.locator('#pane-sites .site-row-info', { hasText: 'hustlefree.ai' }).click();
        await page.waitForFunction(() => document.querySelectorAll('#pane-my-comments .tm-comment-row').length === 2);
        assert.match(page.url(), /view=comments/);
        const texts = await page.locator('#pane-my-comments .tm-comment-text').allTextContents();
        assert.deepEqual([...texts].sort(), ['Logo looks blurry on a retina screen.', 'This button is hard to find on a phone.']);
        assert.equal(await page.getByRole('button', { name: 'Filters · 1' }).count(), 1);
        await context.close();
      });

      await t(`${tag}: team Comments and Sites`, async () => {
        const { context, page } = await open(`/me?${teamQ}&view=comments`, { width });
        await page.waitForFunction(() => document.querySelectorAll('#pane-team-comments .tm-comment-row').length >= 2);
        // The sites are no longer listed over the team's comments.
        assert.equal(await page.locator('#pane-team-feedback').count(), 0);
        const siteRow = page.locator('#pane-team-comments .tm-comment-row.is-site');
        assert.match(await siteRow.locator('.tm-comment-src').textContent(), /tdoc\.dev\/feedback/);
        assert.equal(await siteRow.locator('.tm-comment-anchor code').textContent(), 'div "SDK"');
        assert.equal(await page.locator('#pane-team-comments .tm-comment-row.is-doc').filter({ hasText: 'Release notes Nov 12' }).count(), 1);
        await noSideScroll(page);
        await shot(page, `team-comments-${width}`);
        await page.goto(`${base}/me?${teamQ}&view=sites`);
        await page.waitForSelector('#pane-sites .site-row');
        const row = page.locator('#pane-sites .site-row', { hasText: 'tdoc.dev' });
        assert.match(await row.textContent(), /1 open.*on the site/);
        await row.getByRole('button', { name: 'Settings' }).click();
        assert.match(await page.locator(`#site-settings-${ids.teamSite}`).textContent(), /Every Tdoc member can comment/);
        await noSideScroll(page);
        await shot(page, `team-sites-${width}`);
        await context.close();
      });

      await t(`${tag}: no sites: Sites is the discovery block`, async () => {
        const { context, page } = await open('/me?view=sites', { width, sid: BOB });
        const intro = page.locator('#sites-intro');
        await intro.waitFor();
        assert.match(await intro.locator('h2').textContent(), /Comments on your own site/);
        assert.equal(await intro.locator('.site-demo.is-animated').count(), 1);
        assert.match(await intro.locator('.site-demo-steps').textContent(), /1 Select.*2 Comment.*3 Agent fixes/);
        assert.match(await intro.locator('#sdk-ask').textContent(), /Ask your agent.*Add tdoc feedback to my site/);
        assert.match(await intro.locator('#sdk-paste').textContent(), /data-tdoc-space=/);
        assert.equal(await intro.getByRole('button', { name: 'Add to your site' }).count(), 1);
        assert.equal(await intro.getByRole('link', { name: /Try it on a page first/ }).getAttribute('href'), '/feedback#try');
        await noSideScroll(page);
        await shot(page, `my-docs-sites-empty-${width}`);
        await page.goto(`${base}/me?view=comments`);
        await page.waitForSelector('#pane-my-comments .empty');
        await context.close();
      });

      await t(`${tag}: flag off: Comments lists the sites as before and there is no Sites tab`, async () => {
        const { context, page } = await open('/me?view=sites', { width, flag: false });
        // ?view=sites is not a view without the flag: Docs.
        assert.doesNotMatch(page.url(), /view=sites/);
        assert.equal(await page.locator('.mda-view-sites').count(), 0);
        await page.goto(`${base}/me?view=comments`);
        await page.waitForSelector('#pane-feedback .tdoc-fb-row');
        assert.equal(await page.locator('#pane-my-comments').count(), 0);
        assert.equal(await page.locator('#pane-feedback .tdoc-fb-row').filter({ hasText: 'hustlefree.ai' }).getByRole('button', { name: 'Site settings' }).count(), 1);
        await page.goto(`${base}/me?${teamQ}&view=comments`);
        await page.waitForSelector('#pane-team-comments .tm-comment-row');
        assert.equal(await page.locator('#pane-team-feedback .tdoc-fb-row').count(), 1);
        assert.equal(await page.locator('.tm-comment-src').count(), 0);
        await page.getByRole('button', { name: 'Filters' }).click();
        assert.equal(await page.getByRole('radiogroup', { name: 'Comments from' }).count(), 0);
        assert.equal(await page.getByRole('combobox', { name: 'Comment document' }).count(), 1);
        await context.close();
      });
    }

    for (const width of [1440, 390]) {
      const tag = width === 1440 ? 'desktop' : 'phone';
      await t(`${tag}: an empty team Sites tab: an admin may add a site, a member is told an admin can`, async () => {
        const q = `/me?team=${encodeURIComponent(ids.emptyTeam.id)}&view=sites`;
        const admin = await open(q, { width });
        await admin.page.locator('#sites-intro').getByRole('button', { name: 'Add to your site' }).waitFor();
        assert.equal(await admin.page.locator('#sites-ask-admin').count(), 0);
        assert.equal(await admin.page.locator('.sites-add').count(), 0, 'empty: the block has the button, not the header');
        await noSideScroll(admin.page);
        await shot(admin.page, `team-sites-empty-${width}`);
        await admin.context.close();
        const member = await open(q, { width, sid: CAROL });
        await member.page.waitForSelector('#sites-ask-admin');
        assert.equal(await member.page.locator('#sites-ask-admin').textContent(), 'A team admin can add a site.');
        assert.equal(await member.page.getByRole('button', { name: /Add to your site|Add a site/ }).count(), 0);
        assert.equal(await member.page.locator('#sdk-ask, #sdk-paste').count(), 0, 'steps a member cannot finish in this team');
        await noSideScroll(member.page);
        await shot(member.page, `team-sites-empty-member-${width}`);
        // What the page says is what the server enforces.
        const status = await member.page.evaluate(async (team) => (await fetch('/api/feedback/spaces', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origins: ['https://member.example'], team }),
        })).status, ids.emptyTeam.id);
        assert.equal(status, 403);
        await member.context.close();
      });

      await t(`${tag}: with sites, Add a site is in the header for who may add one`, async () => {
        for (const q of ['/me?view=sites', `/me?${teamQ}&view=sites`]) {
          const { context, page } = await open(q, { width });
          const add = page.getByRole('button', { name: 'Add a site' });
          await add.waitFor();
          assert.match(await add.getAttribute('class'), /ui-btn-quiet/);
          await noSideScroll(page);
          await add.click();
          await page.getByLabel('Your site’s address').waitFor();
          await page.getByRole('button', { name: 'Cancel' }).click();
          assert.equal(await page.getByLabel('Your site’s address').count(), 0);
          await context.close();
        }
        const member = await open(`/me?${teamQ}&view=sites`, { width, sid: CAROL });
        await member.page.waitForSelector('#pane-sites .site-row');
        assert.equal(await member.page.locator('.sites-add, #pane-sites .site-row-btn').count(), 0);
        await member.context.close();
        const off = await open('/me?view=comments', { width, flag: false });
        await off.page.waitForSelector('#pane-feedback .tdoc-fb-row');
        assert.equal(await off.page.locator('.sites-add').count(), 0);
        await off.context.close();
      });
    }

    await t('the demo bubble stays inside its frame and off the button and pin', async () => {
      for (const width of [1440, 390, 360, 320]) for (const q of ['/me?view=sites', '/feedback']) {
        const { context, page } = await open(q, { width, sid: BOB });
        await page.waitForSelector('.site-demo.is-animated');
        const m = await page.evaluate(() => {
          const box = (sel) => document.querySelector(sel).getBoundingClientRect();
          const [note, frame, pin] = ['.site-demo-note', '.site-demo-page', '.site-demo-pin'].map(box);
          return { top: note.top - frame.top, bottom: frame.bottom - note.bottom, right: frame.right - note.right, pin: note.left - pin.right };
        });
        assert.ok(Object.values(m).every((v) => v >= 0), `${width} ${q} ${JSON.stringify(m)}`);
        await context.close();
      }
    });

    await t('one-column layout on a phone: the tab that is on is scrolled into view, the page is not', async () => {
      for (const id of ['sites', 'settings']) {
        const { context, page } = await open(`/me?view=${id}`, { width: 320, flags: { myDocsA: false } });
        await page.waitForSelector('.tabs .tab.is-active');
        const m = await page.evaluate(() => {
          const bar = document.querySelector('.tabs').getBoundingClientRect();
          const tab = document.querySelector('.tabs .tab.is-active').getBoundingClientRect();
          return { left: tab.left - bar.left, right: bar.right - tab.right, y: scrollY };
        });
        assert.ok(m.left >= -1 && m.right >= -1 && m.y === 0, `${id} ${JSON.stringify(m)}`);
        await context.close();
      }
    });

    await t('a new test site opens its fold and settings', async () => {
      const { context, page } = await open(`/me?view=sites&site=${ids.local}`, { width: 1440 });
      await page.locator(`details.sites-tests[open] #site-settings-${ids.local}`).waitFor();
      await context.close();
    });

    await t('no sites: Add to your site makes the space and opens its settings with the line', async () => {
      const { context, page } = await open('/me?view=sites', { width: 1440, sid: BOB });
      await page.locator('#sites-intro').getByRole('button', { name: 'Add to your site' }).click();
      await page.getByLabel('Your site’s address').fill('https://bob-shop.example');
      await page.getByRole('button', { name: 'Get the line' }).click();
      await page.waitForSelector('#pane-sites .site-settings');
      assert.match(page.url(), /view=sites/);
      assert.match(await page.locator('#pane-sites .site-row').first().textContent(), /bob-shop\.example.*on the site/);
      assert.match(await page.locator('#pane-sites .site-settings .tdoc-site-snippet').textContent(), /data-tdoc-space="[^"]+"/);
      await context.close();
    });

    await t('/feedback: the same block, linking to My docs → Sites with the flag on', async () => {
      const on = await open('/feedback', { width: 1440 });
      await on.page.waitForSelector('#sdk');
      assert.equal(await on.page.locator('#sdk .site-demo.is-animated').count(), 1);
      assert.equal(await on.page.locator('#sdk a[href="/me?view=sites"]').textContent(), 'My docs → Sites');
      await on.context.close();
      const off = await open('/feedback', { width: 1440, flag: false });
      await off.page.waitForSelector('#sdk');
      assert.equal(await off.page.locator('#sdk .site-demo.is-animated').count(), 0);
      assert.equal(await off.page.locator('#sdk a[href="/me?view=comments"]').textContent(), 'My docs → Comments');
      await off.context.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) process.exitCode = 1;
  else console.log('\nall passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
