// Comments a page of docs at a time (commentsSitesTabs), in a real browser:
// opening it asks for one page, not all of them; newest first as more loads,
// and what is shown never moves; Load more; filters say they look in what is
// loaded; dates of any zone; a failed page can be tried again; leaving stops
// loading, flag on and off. Flag off: a team's Comments loads as before. Real worker routes behind a local
// server. TDOC_UI_SHOTS=<dir> saves screenshots at 1440 and 390.
// Run with: node test/comments-paging-ui.test.js
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('comments-paging-ui.test.js');

const SHOTS = process.env.TDOC_UI_SHOTS || '';
const JULIE = 'd5'.repeat(16);
const DOCS = 60;
const at = (minutes) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + minutes * 60000).toISOString();

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
  console.log('Comments, a page at a time');
  const mod = await loadWorker();
  const worker = mod.default;
  // 60 docs with three comments each, one of the oldest doc's resolved; in My
  // docs and, the same again, in a team.
  const seeded = async () => {
    const env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'test-client', TDOC_EMAIL_ALIAS_SECRET: 'x' });
    await env.META.put('hosted-account:julie', JSON.stringify({ account_id: 'acct-julie', github_login: 'julie', created: at(0) }));
    await env.META.put(`session:${JULIE}`, JSON.stringify({ login: 'julie', account_id: 'acct-julie', name: 'Julie', avatar_url: '', created: new Date().toISOString() }));
    const team = (await (await worker.fetch(new Request('https://tdoc.dev/api/teams', { method: 'POST', headers: { Cookie: `tdoc_sid=${JULIE}`, 'Content-Type': 'application/json', Origin: 'https://tdoc.dev' }, body: JSON.stringify({ name: 'Tdoc' }) }), env, { waitUntil() {} })).json()).team;
    for (const [prefix, workspace] of [['p', ''], ['t', team.id]]) {
      for (let i = 0; i < DOCS; i++) {
        const slug = `${prefix}${String(i).padStart(2, '0')}`;
        await env.META.put(`meta:${slug}`, JSON.stringify({ title: `Plan ${slug}`, slug, created: at(0), versions: [{ n: 1, created: at(0) }], hosted: { account_id: 'acct-julie', github_login: 'julie' }, ...(workspace ? { workspace_id: workspace } : {}), access: { visibility: 'private', team: true, commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] } }));
        await env.META.put(`comments:${slug}`, JSON.stringify([0, 1, 2].map((k) => ({ id: `${slug}c${k}`, text: `${slug} comment ${k}`, created: at(((i * 37) % DOCS) * 100 + k), version: 1, ...(i === 0 && !k ? { status: 'applied', resolved: true } : {}), author: { login: `person${i % 4}`, name: `Person ${i % 4}` } }))));
      }
    }
    return { env, team };
  };
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const world = await seeded();
  const { server, base } = await startServer(worker, world.env);
  const open = async (pathname, { width = 1440, flag = true, to = base, before = null } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'tdoc_sid', value: JULIE, url: to }]);
    await context.addInitScript((on) => { window.__TDOC_FLAGS__ = { commentsSitesTabs: on }; }, flag);
    const page = await context.newPage();
    const asked = [];
    page.on('request', (r) => { if (/\/api\/(me|team)\/comments\?/.test(r.url())) asked.push(r.url().split('/api/')[1]); });
    if (before) await before(page);
    await page.goto(`${to}${pathname}`);
    return { context, page, asked };
  };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  };
  const texts = (page) => page.locator('.tm-comment-text').allTextContents();
  const want = Array.from({ length: DOCS }, (_, i) => i).sort((a, b) => ((b * 37) % DOCS) - ((a * 37) % DOCS)).flatMap((i) => [2, 1, 0].filter((k) => i || k).map((k) => `p${String(i).padStart(2, '0')} comment ${k}`));
  const status = (page) => page.locator('.tm-comment-more span').textContent();
  const more = (page) => page.getByRole('button', { name: 'Load more' });

  const asked0 = { n: 0 };
  const SAYS = 'Newest first. Load more for older comments. Filters look in what is loaded.';
  const SO_FAR = 'Comments loaded so far. Load more for others. Filters look in what is loaded.';

  await t('the first time and the next: comments at once, one request each', async () => {
    const w = await seeded();
    const s = await startServer(worker, w.env);
    for (let n = 0; n < 4; n++) {
      const { context, page, asked } = await open('/me?view=comments', { to: s.base });
      await more(page).waitFor();
      await page.waitForTimeout(300);
      assert.equal(asked.length, 1, asked.join());
      const says = await status(page);
      assert.ok(n ? (says === SAYS || n < 3) : says === SO_FAR, `${n}: ${says}`);
      if (!n) await shot(page, 'comments-first-time-1440');
      if (n === 3) assert.deepEqual(await texts(page), want.slice(0, 25));
      await context.close();
    }
    s.server.close();
  });

  await t('by offset (no secret to seal a cursor): every comment, and nothing is called newest', async () => {
    const asked = [];
    const { context, page } = await open('/me?view=comments', { before: (p) => p.route('**/api/me/comments?*', (route) => {
      const at = Number(new URL(route.request().url()).searchParams.get('offset')) || 0;
      asked.push(at);
      return route.fulfill({ json: { ok: true, items: Array.from({ length: 30 }, (_, i) => ({ id: `${at}-${i}`, slug: 'p00', thread_id: 'x', kind: 'comment', text: `${at}-${i}`, created: '2026-01-02T01:00:00.000Z', title: 'x', author: { key: 'q', name: 'q' }, source: 'doc' })), next: at < 60 ? at + 12 : null, docs_scanned: 12, docs_total: 72 } });
    }) });
    await more(page).waitFor();
    assert.deepEqual(asked, [0]);
    assert.equal(await status(page), SO_FAR);
    for (let n = 0; n < 20 && await more(page).count(); n++) { const had = (await texts(page)).length; await more(page).click(); await page.waitForFunction((x) => document.querySelectorAll('.tm-comment-text').length > x || !document.querySelector('.tm-comment-more'), had); }
    assert.equal(new Set(await texts(page)).size, 180);
    assert.deepEqual(asked, [0, 12, 24, 36, 48, 60]);
    await context.close();
  });

  await t('dates of other zones are in their place', async () => {
    const row = (id, created) => ({ id, slug: 'p00', thread_id: id, kind: 'comment', text: id, created, title: 'x', author: { key: 'q', name: 'q' }, source: 'doc' });
    const { context, page } = await open('/me?view=comments', { before: (p) => p.route('**/api/me/comments?*', (route) => route.fulfill({ json: { ok: true, items: [row('second', '2026-01-02T01:00:00.000Z'), row('waits', '2026-01-02T04:00:00+08:00'), row('first', '2026-01-01T20:00:00-08:00')], next: 'x.y', through: '2026-01-02T00:00:00.000Z' } })) });
    await more(page).waitFor();
    assert.deepEqual(await texts(page), ['first', 'second']);
    await context.close();
  });

  for (const q of ['/me?view=comments', `/me?team=${encodeURIComponent(world.team.id)}&view=comments`]) for (const flag of [true, false]) {
    if (!flag && !q.includes('team=')) continue; // My docs has no list of comments without it
    await t(`${flag ? 'flag on' : 'flag off'}, ${q.includes('team=') ? 'a team' : 'My docs'}: leaving stops loading`, async () => {
      const { context, page, asked } = await open(q, { flag, before: (p) => p.route(/\/api\/(me|team)\/comments\?/, async (route) => { await new Promise((done) => setTimeout(done, 250)); await (flag ? route.fulfill({ json: { ok: true, items: [], next: `p.${asked0.n += 1}` } }) : route.continue()); }) });
      await page.waitForFunction(() => /Loading comments/.test(document.body.textContent));
      while (!asked.length) await page.waitForTimeout(20);
      await page.locator('.mda-view-trash, .mda-view-sites, .mda-view-settings').first().click();
      const had = asked.length;
      await page.waitForTimeout(1200);
      assert.ok(asked.length <= had + 1, `${asked.length} after ${had}: ${asked.join()}`);
      assert.ok(had <= 3, `${had}`);
      await context.close();
    });
  }

  for (const width of [1440, 390]) {
    const tag = width === 1440 ? 'desktop' : 'phone';
    await t(`${tag}: newest first, more on Load more, what is shown stays where it is`, async () => {
      for (let n = 0; n < 4; n++) { const x = await open('/me?view=comments', { width }); await more(x.page).waitFor(); await x.context.close(); }
      const first = await open('/me?view=comments', { width });
      await more(first.page).waitFor();
      await shot(first.page, `comments-paged-${width}`);
      await first.context.close();
      const { context, page, asked } = await open('/me?view=comments', { width });
      await page.locator('.tm-comment-row').first().waitFor();
      await more(page).waitFor();
      let shown = await texts(page);
      assert.equal(asked.length, 1, asked.join());
      assert.deepEqual(shown, want.slice(0, 25));
      assert.equal(await status(page), SAYS);
      const m = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }));
      assert.ok(m.s <= m.w + 1, `sideways scroll ${JSON.stringify(m)}`);
      for (let n = 0; n < 20 && await more(page).count(); n++) {
        await more(page).click();
        await page.waitForFunction((had) => document.querySelectorAll('.tm-comment-text').length > had || !document.querySelector('.tm-comment-more'), shown.length);
        const now = await texts(page);
        assert.deepEqual(now.slice(0, shown.length), shown, 'what was shown moved');
        assert.deepEqual(now, want.slice(0, now.length));
        shown = now;
      }
      assert.equal(shown.length, want.length);
      assert.equal(asked.length, 5, asked.join());
      assert.equal(await page.locator('.tm-comment-more').count(), 0, 'all loaded: nothing more to say');
      await shot(page, `comments-all-${width}`);
      await context.close();
    });

    await t(`${tag}: a filter looks in what is loaded, says so, and Load more goes on`, async () => {
      const { context, page } = await open('/me?view=comments', { width });
      await more(page).waitFor();
      await page.getByRole('combobox', { name: 'Comment status' }).click();
      await page.getByRole('option', { name: 'Resolved', exact: true }).click();
      await page.getByText('Nothing matches in the comments loaded so far.').waitFor();
      assert.equal(await status(page), SAYS);
      for (let n = 0; n < 6 && !(await page.locator('.tm-comment-row').count()) && await more(page).count(); n++) { await more(page).click(); await page.waitForFunction(() => !/Loading/.test(document.querySelector('.tm-comment-more')?.textContent || '')); }
      assert.deepEqual(await texts(page), ['p00 comment 0']);
      const none = await open('/me?view=comments', { width });
      await more(none.page).waitFor();
      await none.page.getByRole('combobox', { name: 'Comment status' }).click();
      await none.page.getByRole('option', { name: 'Resolved', exact: true }).click();
      await none.page.getByText('Nothing matches').waitFor();
      await shot(none.page, `comments-filter-${width}`);
      await none.context.close();
      await context.close();
    });
  }

  await t('a page that fails says so, and Load more tries again', async () => {
    let fails = true;
    const { context, page } = await open('/me?view=comments', { before: (p) => p.route('**/api/me/comments?*cursor=*', (route) => (fails ? route.fulfill({ status: 500, json: { message: 'It did not load.' } }) : route.continue())) });
    await more(page).waitFor();
    await more(page).click(); // the rest of the first page
    const had = (await texts(page)).length;
    await more(page).click();
    await page.locator('.tm-comment-error').waitFor();
    assert.equal((await texts(page)).length >= had, true);
    fails = false;
    await more(page).click();
    await page.waitForFunction((n) => document.querySelectorAll('.tm-comment-text').length > n, had);
    assert.equal(await page.locator('.tm-comment-error').count(), 0);
    await context.close();
  });

  await t('comments that could not be read are said to be missing', async () => {
    const { context, page } = await open('/me?view=comments', { before: (p) => p.route('**/api/me/comments?*', async (route) => { const r = await route.fetch(); const body = await r.json(); await route.fulfill({ json: { ...body, missed: true, next: null, through: undefined } }); }) });
    await page.getByText('Some comments could not be loaded. Reload to try again.').waitFor();
    assert.equal(await more(page).count(), 1, 'the rest of what is loaded');
    await context.close();
  });

  await t('a team: the same; with the flag off it loads every page by offset, as before', async () => {
    const q = `/me?team=${encodeURIComponent(world.team.id)}&view=comments`;
    const warm = await open(q);
    await warm.page.locator('#pane-team-comments .tm-comment-row').first().waitFor();
    await warm.context.close();
    const on = await open(q);
    await more(on.page).waitFor();
    assert.equal(on.asked.length, 1, on.asked.join());
    assert.deepEqual((await texts(on.page)).slice(0, 5), want.slice(0, 5).map((x) => x.replace('p', 't')));
    await on.context.close();
    const off = await open(q, { flag: false });
    await off.page.locator('.tm-comment-pagination').waitFor();
    await off.page.waitForFunction(() => /of 179/.test(document.querySelector('.tm-comment-pagination')?.textContent || ''));
    assert.ok(off.asked.length === 5 && off.asked.every((x) => /offset=\d+$/.test(x) && !/paged/.test(x)), off.asked.join());
    assert.equal(await off.page.locator('.tm-comment-more').count(), 0);
    await off.context.close();
    const mine = await open('/me?view=comments', { flag: false });
    await mine.page.waitForTimeout(800);
    assert.equal(mine.asked.length, 0, mine.asked.join());
    await mine.context.close();
  });

  await browser.close();
  server.close();
  console.log(failed ? `\nFAIL — ${failed} failed` : '\nPASS');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
