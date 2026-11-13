// New › Doc › Write it with your agent, flag writeWithAgent on: with an
// agent tdoc can push to, the dialog offers it and Send; Send makes a private
// doc, hands the sentence to that agent and opens the doc on the request
// comment, whose line says it was sent. With none, the dialog says why
// (chat apps cannot be sent to) and links to Connect an agent; the copy line
// stays. Flag off: the copy line only. Real worker routes behind a local HTTP
// server, real built shell, Chromium; desktop and phone.
//
// TDOC_TEST_SCREENSHOTS=<dir> writes the dialog and the opened doc per viewport.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('write-with-agent-ui.test.js');

const SID = 'c3'.repeat(16);
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

async function seed(env) {
  await env.META.put('hosted-account:alice', JSON.stringify({
    account_id: 'acct-alice', github_login: 'alice', created: '2026-01-01T00:00:00.000Z',
  }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'alice', account_id: 'acct-alice', name: 'alice', avatar_url: '', created: new Date().toISOString(),
  }));
  for (const [slug, title] of [['q4-roadmap', 'Q4 roadmap'], ['meeting-notes', 'Meeting notes']]) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created: '2026-10-01T00:00:00.000Z', versions: [{ n: 1, created: '2026-10-01T00:00:00.000Z' }],
      hosted: { account_id: 'acct-alice', github_login: 'alice', owner_key: 'alice' },
      access: { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, `<!doctype html><html><body><h1>${title}</h1><p>Notes.</p></body></html>`);
  }
}

// The harness bucket models If-None-Match only. A browser's first save
// replaces the blank scaffold with `onlyIf: { etagMatches }` (worker
// _saveVersion), so give its objects an etag and honour that condition here.
function withEtags(bucket) {
  const tags = new Map();
  let n = 0;
  const get = bucket.get.bind(bucket);
  const put = bucket.put.bind(bucket);
  bucket.get = async (k, opts) => {
    const object = await get(k, opts);
    return object ? { ...object, etag: tags.get(k) } : object;
  };
  bucket.put = async (k, v, opts) => {
    const match = opts && opts.onlyIf && opts.onlyIf.etagMatches;
    if (match) {
      if (tags.get(k) !== match) return null;
      const { onlyIf, ...rest } = opts;
      opts = rest;
    }
    const result = await put(k, v, opts);
    if (result) tags.set(k, `e${++n}`);
    return result;
  };
  return bucket;
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
  console.log('New: write with your agent');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  let passed = 0;
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };

  const run = async (label, viewport, { agents, flag = true }) => {
    const env = makeEnv(mod.CommentsStore);
    withEtags(env.DOCS);
    await seed(env);
    if (agents) await env.META.put('account-notify:acct-alice', JSON.stringify([{ provider: 'local', device: 'mbp', cli: 'claude' }]));
    const { server, base } = await startServer(worker, env);
    const phone = viewport.width < 600;
    const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    await context.addInitScript((on) => {
      try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {}
      if (window === window.top) window.__TDOC_FLAGS__ = Object.assign({}, window.__TDOC_FLAGS__, { writeWithAgent: on, agentProgress: on });
    }, flag);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const tag = `${label}, ${flag ? (agents ? 'an agent' : 'no agent') : 'flag off'}`;
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) });
    };
    const press = (locator) => (phone ? locator.tap() : locator.click());
    const openDialog = async () => {
      await press(page.getByRole('button', { name: 'New', exact: true }));
      await press(page.getByRole('menuitem', { name: 'Doc', exact: true }));
      await press(page.locator('.ui-menu-popup.mk-pushed').getByRole('menuitem', { name: /Write it with your agent/ }));
      const dialog = page.getByRole('dialog');
      await dialog.locator('.mk-agent[data-kind="doc"]').waitFor();
      return dialog;
    };
    try {
      await page.goto(`${base}/me`);
      await page.locator('.doc-row[data-slug="q4-roadmap"]').waitFor();
      if (!flag) {
        await t(`${tag}: the copy line only`, async () => {
          const dialog = await openDialog();
          await dialog.locator('.mk-line').waitFor();
          assert.equal(await dialog.locator('.mk-send, .mk-send-loading').count(), 0);
        });
      } else if (!agents) {
        await t(`${tag}: says why nothing can be sent, links to Connect an agent, keeps the copy line`, async () => {
          const dialog = await openDialog();
          const note = dialog.locator('.mk-send-none');
          await note.waitFor();
          assert.match(await note.innerText(), /claude\.ai or ChatGPT/);
          assert.equal(await note.getByRole('link', { name: 'Connect an agent' }).getAttribute('href'), '/me?view=settings#agents');
          await dialog.locator('.mk-line').waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).count(), 0);
          await shot('no-agent');
        });
      } else {
        await t(`${tag}: Send makes the doc, hands it to the agent and opens it on the request`, async () => {
          const dialog = await openDialog();
          const send = dialog.getByRole('button', { name: 'Send', exact: true });
          await send.waitFor();
          assert.ok(await send.isDisabled(), 'Send before a sentence');
          assert.match(await dialog.locator('.mk-send-agent').innerText(), /claude/i);
          await dialog.locator('.mk-subject input').fill('a packing list for Iceland in March');
          await shot('dialog');
          await press(send);
          await page.waitForURL(/\/d\/[a-z0-9-]+/, { timeout: 20000 });
          const slug = new URL(page.url()).pathname.split('/')[2];
          const handoffs = JSON.parse(await env.META.get(`handoffs:${slug}`) || '[]');
          assert.equal(handoffs.length, 1);
          assert.equal(handoffs[0].recipient.agent_sub, 'mbp_claude');
          const chip = page.locator('.tdoc-handoff-chip:visible').first();
          await chip.waitFor({ timeout: 20000 });
          assert.match(await chip.innerText(), /Sent|Delivered/);
          await page.getByText('a packing list for Iceland in March').first().waitFor();
          await shot('doc');
        });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      server.close();
    }
  };

  for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 844 }]]) {
    await run(label, viewport, { agents: true });
    await run(label, viewport, { agents: false });
  }
  await run('desktop', { width: 1280, height: 860 }, { agents: true, flag: false });
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
