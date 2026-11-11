// Version history in the real shell against the real worker (flag
// versionHistory; Julie's approved mock, tdoc-version-history-mock):
//   - "Edited …" in the bar opens a panel at the right (resizable) with one
//     row per run of saves: who, what changed ("Edited Goal · 1 place"), when.
//   - a row of several saves opens to each save.
//   - Show changes (on by default, remembered): a row shows its red/green in
//     one column; off, the document as it was.
//   - Share this version copies the fixed /v/N link; the Share dialog no
//     longer offers "Copy a link to vN instead".
//   - Restore saves the old version as a new one and opens it.
//   - a phone gets the same rows in a bottom drawer from ⋯ → Version history.
//   - dev mode adds version numbers; normal mode shows none.
//   - a viewer who may not list the history: "Edited …" is plain text, no
//     menu, no View changes or Versions in ⋯; a shared /v/N link still says
//     which version it is and links to the latest.
//   - a comment whose words are gone and which was written on an older
//     version says "Commented on an earlier version".
// Run with: node test/version-history-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('version-history-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const page = (sections) => `<!doctype html><html><head><title>Pricing page launch brief</title></head><body><h1>Pricing page launch brief</h1>${
  Object.entries(sections).map(([h, ps]) => `<h2>${h}</h2>${ps.map((p) => `<p>${p}</p>`).join('')}`).join('')}</body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    let body = ''; req.on('data', (d) => { body += d; }); await new Promise((r) => req.on('end', r));
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let out = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) out = Buffer.from(out.toString('utf8').replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path).replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    response.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'content-security-policy'].includes(k)) res.setHeader(k, v); });
    res.statusCode = response.status; res.end(out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('version history in the document page');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test' });
  const sid = 'b'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const minted = await (await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'julie' }) }), env, {})).json();
  const token = minted.token;
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const v1 = { Goal: ['Launch the new pricing page before the December campaign.'], Timeline: ['Design review ends on November 12.'], Risks: ['Customers on old plans may think their price is changing.'] };
  const v2 = { ...v1, Timeline: ['Design review ends on November 12.', 'The page ships on December 3.'] };
  const v3 = { ...v2, Risks: ['Existing customers keep their current price for 12 months.'] };
  const v4 = { ...v3, Timeline: ['Design review ends on November 14.', 'The page ships on December 3.'] };
  const v5 = { ...v4, Goal: ['Launch the new pricing page before the campaign.'] };
  let docN = 0;
  const at = (minutes) => new Date(Date.now() - (300 - minutes) * 60000).toISOString();
  const newDoc = async () => {
    const slug = `history-ui-${++docN}`;
    const up = (n, s) => api('/api/upload', { method: 'POST', token, body: { slug, version: n, html: page(s), meta: { title: 'Pricing page launch brief' } } });
    assert.equal((await up(1, v1)).status, 200);
    assert.equal((await up(2, v2)).status, 200);
    for (const [base, s] of [[2, v3], [3, v4], [4, v5]]) {
      const r = await api('/api/doc/versions', { method: 'POST', cookie, body: { slug, baseVersion: base, html: page(s) } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
    const times = { 1: at(0), 2: at(10), 3: at(100), 4: at(115), 5: at(290) };
    for (const v of meta.versions) v.created = times[v.n];
    await env.META.put(`meta:${slug}`, JSON.stringify(meta));
    return slug;
  };

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/${name}` }); } };

  const strangerSid = 'c'.repeat(32);
  await env.META.put(`session:${strangerSid}`, JSON.stringify({ login: 'reader', name: 'reader', email: 'reader@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const open = async (slug, { phone = false, flags = null, path = '', as = sid } = {}) => {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    if (as) await ctx.addCookies([{ name: 'tdoc_sid', value: as, domain: '127.0.0.1', path: '/' }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    await ctx.addInitScript((pinned) => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied.push(text); } } });
      if (pinned) window.__TDOC_FLAGS__ = pinned;
    }, flags);
    const p = await ctx.newPage();
    await p.goto(`${base}/d/${slug}${path}`);
    await p.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 15000 });
    return { ctx, page: p };
  };
  const panel = (p) => p.locator('.tdoc-history-panel');
  const rows = (root) => root.locator('.tdoc-history-list > .tdoc-history-row:not(.is-pending-suggestions)');

  // Julie is on the dev-mode list: normal mode first, as everybody sees it.
  assert.equal((await api('/api/me/dev-mode', { method: 'POST', cookie, body: { on: false } })).status, 200);
  try {
    await t('desktop: Edited opens the panel; rows group saves by writer within 30 minutes; what changed fills in', async () => {
      const slug = await newDoc();
      const v = await open(slug);
      const toggle = v.page.locator('#tdoc-version-toggle');
      assert.match(await toggle.innerText(), /^Edited /);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click();
      await panel(v.page).waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.match(v.page.url(), /history=1/);
      await v.page.waitForFunction(() => document.querySelectorAll('.tdoc-history-list > .tdoc-history-row').length === 3);
      const r = rows(panel(v.page));
      assert.match(await r.nth(0).innerText(), /julie[\s\S]*Latest · (Today|Yesterday), /);
      await v.page.waitForFunction(() => !document.querySelector('.tdoc-history-what.is-pending'), null, { timeout: 10000 });
      assert.match(await r.nth(0).locator('.tdoc-history-what').innerText(), /^Edited Goal · 1 place$/);
      assert.match(await r.nth(1).locator('.tdoc-history-what').innerText(), /^Edited Timeline, Risks · 2 places$/);
      assert.match(await r.nth(1).innerText(), /2 saves/);
      assert.match(await r.nth(2).innerText(), /Agent · julie[\s\S]*Created the document/);
      // Normal mode: no version numbers anywhere in the panel.
      assert.ok(!/\bv\d/.test(await panel(v.page).innerText()), await panel(v.page).innerText());
      // Show changes is on by default.
      assert.equal(await v.page.getByRole('switch', { name: 'Show changes' }).getAttribute('aria-checked'), 'true');
      // The open row: its saves, one by one.
      await r.nth(1).locator('.tdoc-history-expand').click();
      assert.equal(await r.nth(1).locator('.tdoc-history-save').count(), 2);
      await shot(v.page, 'history-desktop-panel.png');
      await v.ctx.close();
    });

    await t('desktop: a row shows its red/green against the save before it; off shows the version clean, and stays off', async () => {
      const slug = await newDoc();
      const v = await open(slug, { path: '?history=1' });
      await panel(v.page).waitFor();
      await rows(panel(v.page)).nth(1).locator('.tdoc-history-rowmain').click();
      // v2 -> v4 in one column: Risks rewritten, the review date changed.
      const frame = v.page.frameLocator('.tdoc-history-doc .is-after iframe');
      await frame.locator('[data-tdoc-change], .tdoc-diff-ins').first().waitFor({ timeout: 15000 });
      const marked = await frame.locator('.tdoc-diff-ins, .tdoc-diff-del, [data-tdoc-change]').allInnerTexts();
      assert.ok(marked.join(' ').includes('14'), marked.join(' | '));
      assert.ok(await v.page.locator('.tdoc-history-doc .tdoc-diff-pane-label').count() === 0, 'no "vN · After" label');
      await rows(panel(v.page)).nth(1).locator('.tdoc-history-actions').waitFor();
      await shot(v.page, 'history-desktop-changes.png');
      await v.page.getByRole('switch', { name: 'Show changes' }).click();
      const clean = v.page.locator('iframe.tdoc-history-frame');
      await clean.waitFor();
      assert.match(await clean.getAttribute('src'), new RegExp(`/d/${slug}/v/4/frame`));
      await shot(v.page, 'history-desktop-clean.png');
      await v.page.reload();
      await panel(v.page).waitFor();
      assert.equal(await v.page.getByRole('switch', { name: 'Show changes' }).getAttribute('aria-checked'), 'false');
      await v.ctx.close();
    });

    await t('Share this version copies the fixed /v/N link; Share no longer offers a version link', async () => {
      const slug = await newDoc();
      const v = await open(slug, { path: '?history=1' });
      await panel(v.page).waitFor();
      const second = rows(panel(v.page)).nth(1);
      await second.locator('.tdoc-history-rowmain').click();
      await second.getByRole('button', { name: 'Share this version' }).click();
      await v.page.waitForFunction(() => window.__copied.length === 1);
      assert.match(await v.page.evaluate(() => window.__copied[0]), new RegExp(`/d/${slug}/v/4$`));
      await v.page.getByText('Link to this version copied').waitFor();
      // A save inside the row: its own number.
      await second.locator('.tdoc-history-expand').click();
      await second.locator('.tdoc-history-save').nth(1).click();
      await second.locator('.tdoc-history-saves .tdoc-history-actions').getByRole('button', { name: 'Share this version' }).click();
      await v.page.waitForFunction(() => window.__copied.length === 2);
      assert.match(await v.page.evaluate(() => window.__copied[1]), new RegExp(`/d/${slug}/v/3$`));
      // The latest row has no Restore.
      await rows(panel(v.page)).nth(0).locator('.tdoc-history-rowmain').click();
      assert.equal(await rows(panel(v.page)).nth(0).getByRole('button', { name: 'Restore' }).count(), 0);
      await v.page.locator('.tdoc-history-panel').getByRole('button', { name: 'Close version history' }).click();
      await panel(v.page).waitFor({ state: 'detached' });
      await v.page.locator('#tdoc-share-btn').click();
      await v.page.locator('.ui-dialog-popup').waitFor();
      assert.equal(await v.page.getByText(/Copy a link to v\d+ instead/).count(), 0);
      await v.ctx.close();
    });

    await t('Restore saves the old version as a new one and opens it', async () => {
      const slug = await newDoc();
      const v = await open(slug, { path: '?history=1' });
      await panel(v.page).waitFor();
      const oldest = rows(panel(v.page)).nth(2);
      await oldest.locator('.tdoc-history-rowmain').click();
      await oldest.getByRole('button', { name: 'Restore' }).click();
      await v.page.getByRole('dialog').getByText('Restore this version?').waitFor();
      await v.page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
      await v.page.waitForURL(new RegExp(`/d/${slug}$`), { timeout: 10000 });
      const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
      const last = meta.versions[meta.versions.length - 1];
      assert.equal(last.n, 6);
      assert.equal(last.restored_from, 2);
      await v.page.frameLocator('iframe.tdoc-doc-frame').getByText('Customers on old plans may think').waitFor({ timeout: 15000 });
      await v.page.locator('#tdoc-version-toggle').click();
      await rows(panel(v.page)).first().getByText('Restored an earlier version').waitFor();
      await v.ctx.close();
    });

    await t('phone: ⋯ → Version history opens the same rows in a bottom drawer; picking one leaves the document in view', async () => {
      const slug = await newDoc();
      const v = await open(slug, { phone: true });
      assert.equal(await v.page.locator('#tdoc-version-toggle').isVisible(), false);
      await v.page.locator('.tdoc-bar [aria-label="More actions"], .tdoc-bar [aria-label="More"], .tdoc-bar .tdoc-more-trigger').first().click();
      await v.page.locator('[data-action="history"]').click();
      const drawer = v.page.locator('.tdoc-history-drawer');
      await drawer.waitFor();
      await v.page.waitForFunction(() => document.querySelectorAll('.tdoc-history-drawer .tdoc-history-list > .tdoc-history-row').length === 3);
      await v.page.waitForFunction(() => !document.querySelector('.tdoc-history-what.is-pending'), null, { timeout: 10000 });
      assert.equal(await v.page.locator('.tdoc-history-panel').count(), 0);
      await shot(v.page, 'history-phone-drawer.png');
      const box = await drawer.boundingBox();
      await rows(drawer).nth(1).locator('.tdoc-history-rowmain').click();
      await v.page.frameLocator('.tdoc-history-doc .is-after iframe').locator('[data-tdoc-change], .tdoc-diff-ins').first().waitFor({ timeout: 15000 });
      await v.page.waitForTimeout(400);
      const low = await drawer.boundingBox();
      assert.ok(low.y > box.y + 100, `the drawer dropped (${box.y} -> ${low.y})`);
      const width = await v.page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(width <= 390, `no sideways scroll (${width})`);
      await shot(v.page, 'history-phone-selected.png');
      await v.ctx.close();
    });

    await t('dev mode: version numbers in the rows, and pending suggestions as one row on top that opens them', async () => {
      const slug = await newDoc();
      await api('/api/me/dev-mode', { method: 'POST', cookie, body: { on: true } });
      const proposed = await api(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'Existing customers keep their current price for 12 months.', replace: 'Existing customers keep their price for a year.' }], agent_login: 'claude', agent_name: 'Claude' } });
      assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
      const v = await open(slug);
      await v.page.locator('.tdoc-suggest-bar').waitFor({ timeout: 10000 });
      await v.page.locator('#tdoc-version-toggle').click();
      await panel(v.page).waitFor();
      assert.equal(await v.page.locator('.tdoc-suggest-bar').count(), 0, 'the review bar waits while history is open');
      const text = await rows(panel(v.page)).nth(1).innerText();
      assert.match(text, /v3–v4/, text);
      const waiting = panel(v.page).locator('.tdoc-history-row.is-pending-suggestions');
      await waiting.waitFor({ timeout: 10000 });
      assert.match(await waiting.innerText(), /1 suggestion waiting/);
      await shot(v.page, 'history-desktop-devmode.png');
      await waiting.locator('.tdoc-history-rowmain').click();
      await panel(v.page).waitFor({ state: 'detached' });
      await v.page.locator('.tdoc-suggest-bar').waitFor({ timeout: 10000 });
      // The same from a page that opened on the history.
      await v.page.goto(`${base}/d/${slug}?history=1`);
      await panel(v.page).locator('.tdoc-history-row.is-pending-suggestions .tdoc-history-rowmain').click();
      await v.page.locator('.tdoc-suggest-bar').waitFor({ timeout: 10000 });
      await api('/api/me/dev-mode', { method: 'POST', cookie, body: { on: false } });
      await v.ctx.close();
    });

    // The doc's history is its owner's (history_visibility default): a
    // signed-in reader and a signed-out one may read the doc, not its history.
    for (const [who, as] of [['a signed-in reader', strangerSid], ['a signed-out reader', null]]) {
      await t(`${who} without history rights: "Edited …" is plain text; no version menu anywhere`, async () => {
        const slug = await newDoc();
        const v = await open(slug, { as });
        const edited = v.page.locator('.tdoc-bar .tdoc-edited');
        await edited.waitFor();
        assert.match(await edited.innerText(), /^Edited /);
        assert.equal(await edited.evaluate((el) => el.tagName), 'SPAN', 'not a button');
        assert.equal(await edited.getAttribute('aria-expanded'), null);
        assert.equal(await v.page.locator('.tdoc-bar button.tdoc-edited').count(), 0);
        await edited.click();
        await v.page.waitForTimeout(300);
        assert.equal(await v.page.locator('[role="menu"]').count(), 0, 'no menu opens');
        assert.equal(await v.page.locator('.tdoc-history-panel').count(), 0, 'no panel opens');
        assert.doesNotMatch(v.page.url(), /history=1|compare=1/);
        await shot(v.page, `history-reader-plain-${as ? 'signed-in' : 'signed-out'}.png`);
        // ⋯ has no View changes, Versions or Version history either.
        await v.page.locator('.tdoc-bar [aria-label="More actions"], .tdoc-bar [aria-label="More"], .tdoc-bar .tdoc-more-trigger').first().click();
        await v.page.locator('[role="menu"]').first().waitFor();
        for (const name of ['View changes', 'Versions', 'Version history']) {
          assert.equal(await v.page.getByRole('menuitem', { name, exact: true }).count(), 0, `no ${name} in ⋯`);
        }
        assert.equal(await v.page.locator('[data-action="compare"], [data-action="history"], .tdoc-version-submenu-trigger').count(), 0);
        await shot(v.page, `history-reader-overflow-${as ? 'signed-in' : 'signed-out'}.png`);
        await v.ctx.close();
        // A phone: "Edited …" is not in the bar, and ⋯ has no version rows.
        const m = await open(slug, { as, phone: true });
        await m.page.locator('.tdoc-bar [aria-label="More actions"], .tdoc-bar [aria-label="More"], .tdoc-bar .tdoc-more-trigger').first().click();
        await m.page.locator('[role="menu"]').first().waitFor();
        for (const name of ['View changes', 'Versions', 'Version history']) {
          assert.equal(await m.page.getByRole('menuitem', { name, exact: true }).count(), 0, `no ${name} in phone ⋯`);
        }
        await shot(m.page, `history-reader-phone-overflow-${as ? 'signed-in' : 'signed-out'}.png`);
        await m.ctx.close();
      });
    }

    await t('a reader without history rights on a shared /v/N link: the strip names the version and links to the latest', async () => {
      const slug = await newDoc();
      for (const [phone, name] of [[false, 'desktop'], [true, 'phone']]) {
        const v = await open(slug, { as: strangerSid, path: '/v/2', phone });
        const strip = v.page.locator('.tdoc-oldver-strip');
        await strip.waitFor();
        assert.match(await strip.innerText(), /You're viewing v2 - the latest is v5/);
        assert.equal(await strip.locator('a').getAttribute('href'), `/d/${slug}`, 'the live doc, not a pinned version');
        if (!phone) {
          assert.equal(await v.page.locator('.tdoc-bar .tdoc-edited').evaluate((el) => el.tagName), 'SPAN');
          assert.equal(await v.page.locator('[role="menu"]').count(), 0);
        }
        await shot(v.page, `history-reader-old-version-${name}.png`);
        await strip.locator('a').click();
        await v.page.waitForURL(new RegExp(`/d/${slug}$`));
        await v.page.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 15000 });
        assert.equal(await v.page.locator('.tdoc-oldver-strip').count(), 0, 'no strip on the latest');
        await v.ctx.close();
      }
    });

    await t('the owner on a shared /v/N link: the same strip, and Edited still opens the panel', async () => {
      const slug = await newDoc();
      const v = await open(slug, { path: '/v/2' });
      await v.page.locator('.tdoc-oldver-strip').getByText("You're viewing v2").waitFor();
      await v.page.locator('#tdoc-version-toggle').click();
      await panel(v.page).waitFor();
      await shot(v.page, 'history-owner-old-version-panel.png');
      await v.ctx.close();
    });

    await t('a comment whose words are gone, written on an older version, says so', async () => {
      const slug = await newDoc();
      const c = await api('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: 'Is this right?', anchor: { kind: 'text', text: 'Customers on old plans may think their price is changing.' } } });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const v = await open(slug, { path: `?comment=${c.body.id}` });
      const card = v.page.locator('.tdoc-margin-comment', { hasText: 'Is this right?' }).first();
      await card.waitFor({ timeout: 15000 });
      await card.getByText('Commented on an earlier version').waitFor({ timeout: 10000 });
      await shot(v.page, 'history-earlier-comment.png');
      await v.ctx.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
