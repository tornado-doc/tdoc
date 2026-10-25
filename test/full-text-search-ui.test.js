// Full-text search in the browser: My docs keeps its instant title filter and
// adds "Results in document text" from /api/search -- English and Chinese,
// the matching passage marked, a doc's own markup shown as text, a click
// opening the doc -- at desktop and phone width. Real worker routes
// (in-process harness, node:sqlite as the store's SQLite) behind a local HTTP
// server, real built shell runtime, real Chromium.
//
// TDOC_SEARCH_SHOTS=<dir> saves screenshots of each state.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('full-text-search-ui.test.js');

const SID = 'c3'.repeat(16);
const SHOTS = process.env.TDOC_SEARCH_SHOTS || '';

const DOCS = [
  ['q4-planning', 'Q4 planning', '2026-10-20', '<h1>Q4 planning</h1><p>Three bets for the quarter. The hiring budget stays flat while we finish the editor; marketing spend moves to the creator program.</p><p>Owner: Julie. Review every Friday.</p>'],
  ['launch-retro', 'Launch retro', '2026-10-12', '<h1>Launch retro</h1><p>What went well: the waitlist converted at 31%. What hurt: the budget for paid ads ran out on day two, so the second wave was organic only.</p>'],
  ['interview-notes', 'Interview notes — design partners', '2026-09-28', '<h1>Interview notes</h1><p>Five design partners. All of them lose docs in Slack threads; two asked for full-text search across every doc and comment.</p>'],
  ['zh-weekly', '周报 第 42 周', '2026-10-18', '<h1>周报 第 42 周</h1><p>本周收入增长稳定，新用户留存率提升到 46%。下周重点：完善全文搜索，并整理设计伙伴的反馈。</p>'],
  ['zh-pricing', '定价方案讨论', '2026-10-05', '<h1>定价方案讨论</h1><p>团队版按席位收费。目标是在不影响收入增长的前提下，降低小团队的试用门槛。</p>'],
  ['onboarding-copy', 'Onboarding copy', '2026-08-30', '<h1>Onboarding copy</h1><p>Shorter first screen. Never show &lt;img src=x onerror="window.__xss=1"&gt; payloadword markup to readers.</p>'],
];

async function seed(env) {
  await env.META.put('hosted-account:alice', JSON.stringify({
    account_id: 'acct-alice', github_login: 'alice', created: '2026-01-01T00:00:00.000Z',
  }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'alice', email: 'alice@example.com', account_id: 'acct-alice', name: 'alice', avatar_url: '', created: new Date().toISOString(),
  }));
  for (const [slug, title, date, body] of DOCS) {
    const created = `${date}T09:00:00.000Z`;
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created, versions: [{ n: 1, created }],
      hosted: { account_id: 'acct-alice', github_login: 'alice', owner_key: 'alice' },
      access: { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, `<!doctype html><html><body>${body}</body></html>`);
  }
}

async function startServer(worker, env, waits) {
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
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    }), env, { waitUntil(p) { waits.push(Promise.resolve(p).catch(() => {})); } });
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
  try { require('node:sqlite'); } catch {
    console.log('full-text search UI: SKIP (node:sqlite needs Node 22+)');
    return;
  }
  console.log('full-text search UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };

  const run = async (label, viewport) => {
    // The text results ship behind the fullTextSearch flag: dev mode only.
    const env = makeEnv(mod.CommentsStore, { TDOC_SEARCH_CACHE_MS: '0', TDOC_DEBUG_ACCOUNTS: 'alice@example.com' });
    await seed(env);
    const waits = [];
    // A folder, so results show where a doc lives. (Folder records are cached
    // per isolate, so each run names its own.)
    const folder = await worker.fetch(req('/api/folders', { method: 'POST', cookie: SID, headers: { Origin: 'https://tdoc.dev' }, body: { name: label === 'desktop' ? 'Planning' : 'Planning Q4' } }), env, {});
    const folderBody = await folder.json();
    assert.ok(folderBody.folder, `folder: ${JSON.stringify(folderBody)}`);
    const folderId = folderBody.folder.id;
    await worker.fetch(req('/api/folders/move', { method: 'POST', cookie: SID, headers: { Origin: 'https://tdoc.dev' }, body: { folder: folderId, slugs: ['q4-planning', 'zh-pricing'] } }), env, {});
    const comment = await worker.fetch(req('/api/comments', { method: 'POST', cookie: SID, body: { slug: 'launch-retro', version: 1, text: 'Can we get the budget numbers per channel before Friday?', anchor: null } }), env, {});
    assert.equal(comment.status, 200, 'seed comment');
    const { server, base } = await startServer(worker, env, waits);
    const context = await browser.newContext({
      viewport,
      ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${viewport.width}.png`), fullPage: false }); };
    const input = page.getByRole('searchbox', { name: 'Search docs' });
    const results = page.locator('.text-search-row');
    try {
      await env.META.put('dev-mode:alice@example.com', 'off');
      await page.goto(`${base}/me`);
      await page.locator('.doc-row[data-slug="launch-retro"]').waitFor();
      // Opening My docs queued every unindexed doc; the store's alarm reads them.
      while (waits.length) await Promise.all(waits.splice(0));
      await env.COMMENTS.runAlarms();

      await t(`${label}: with the flag off (dev mode off) there are no text results`, async () => {
        let asked = 0;
        page.on('request', (r) => { if (r.url().includes('/api/search')) asked++; });
        await input.fill('budget');
        await page.locator('#pane-mine > .empty').getByText('No matches.').waitFor();
        await page.waitForTimeout(500);
        assert.equal(await page.locator('.text-search').count(), 0, 'text results shown with the flag off');
        assert.equal(asked, 0, 'the hub asked /api/search with the flag off');
      });
      await env.META.delete('dev-mode:alice@example.com');
      await page.reload();
      await page.locator('.doc-row[data-slug="launch-retro"]').waitFor();

      await t(`${label}: English body and comment text, marked, title filter still instant`, async () => {
        await input.fill('budget');
        await page.locator('.text-search').getByText('Results in document text').waitFor();
        await results.first().waitFor();
        await page.locator('.text-search[aria-busy="false"]').waitFor();
        const slugs = await results.evaluateAll((rows) => rows.map((row) => row.dataset.slug));
        assert.deepEqual([...slugs].sort(), ['launch-retro', 'q4-planning'], `results ${slugs}`);
        const marks = await page.locator('.text-search mark').allTextContents();
        assert.ok(marks.length >= 2 && marks.every((m) => m.toLowerCase() === 'budget'), `marks ${marks}`);
        const planning = page.locator('.text-search-row[data-slug="q4-planning"]');
        assert.match(await planning.locator('.doc-meta').textContent(), /My docs › Planning( Q4)? · updated 2026-10-20/);
        // The instant list filters titles only; no title says "budget".
        assert.equal(await page.locator('#pane-mine > .doc-list .doc-row').count(), 0, 'title list should be empty');
        assert.equal(await page.locator('#pane-mine > .empty').count(), 0, 'an empty notice above text results');
        await shot('search-en');
        await input.fill('zzqqxx');
        await page.locator('#pane-mine > .empty').getByText('No matches.').waitFor();
        assert.equal(await page.locator('.text-search').count(), 0, 'an empty text section');
        await input.fill('retro');
        await page.locator('#pane-mine .doc-row[data-slug="launch-retro"]').waitFor();
      });

      await t(`${label}: Chinese, a phrase and a two-character word`, async () => {
        await input.fill('收入增长');
        await page.locator('.text-search-row[data-slug="zh-pricing"]').waitFor();
        await page.locator('.text-search[aria-busy="false"]').waitFor();
        const slugs = await results.evaluateAll((rows) => rows.map((row) => row.dataset.slug));
        assert.deepEqual([...slugs].sort(), ['zh-pricing', 'zh-weekly'], `results ${slugs}`);
        assert.ok((await page.locator('.text-search mark').allTextContents()).every((m) => m === '收入增长'));
        const passages = (await page.locator('.text-search-snippet').allTextContents()).join(' | ');
        assert.ok(!/doctype/i.test(passages), `markup in a passage: ${passages}`);
        assert.ok(!passages.includes('定价方案讨论 团队版'), `the title heading repeated in the passage: ${passages}`);
        await shot('search-zh');
        await input.fill('反馈');
        await page.locator('.text-search-row[data-slug="zh-weekly"]').waitFor();
      });

      await t(`${label}: a doc's markup is shown as text, never run`, async () => {
        await input.fill('payloadword');
        const row = page.locator('.text-search-row[data-slug="onboarding-copy"]');
        await row.waitFor();
        assert.match(await row.locator('.text-search-snippet').textContent(), /<img src=x onerror="window\.__xss=1">/);
        assert.equal(await page.locator('.text-search img').count(), 0, 'an element was created from doc text');
        assert.equal(await page.evaluate(() => window.__xss), undefined, 'doc text ran');
      });

      await t(`${label}: a capped search says some shared docs were not searched`, async () => {
        await page.route('**/api/search?*', (route) => route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, q: 'partialword', indexing: 0, partial: true, skipped: 3, results: [
            { slug: 'launch-retro', title: 'Launch retro', title_marks: [{ text: 'Launch retro', hit: false }], workspace_id: '', folder: '', owner: '', mine: true, updated: '2026-10-12T09:00:00.000Z', where: 'body', snippet: [{ text: 'a ', hit: false }, { text: 'partialword', hit: true }] },
          ] }),
        }));
        try {
          await input.fill('partialword');
          await page.locator('.text-search').getByText('Some shared docs weren’t searched.').waitFor();
          await input.fill('');
        } finally { await page.unroute('**/api/search?*'); }
      });

      await t(`${label}: nothing on the page overflows, and a result opens its doc`, async () => {
        await input.fill('Slack threads');
        const row = page.locator('.text-search-row[data-slug="interview-notes"]');
        await row.waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `page overflows by ${overflow}px`);
        await row.click();
        await page.waitForURL((url) => url.pathname === '/d/interview-notes');
      });
      assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
      server.close();
    }
  };

  await run('desktop', { width: 1440, height: 900 });
  await run('phone', { width: 390, height: 844 });
  await browser.close();
  if (failed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
