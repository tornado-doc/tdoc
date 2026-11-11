// "Posting…" ends when the comment is saved (Julie, 2026-11-11: the
// bookmarklet's composer stayed on "Posting…" although a refresh showed the
// comment was already there). The POST's answer shows the comment and frees
// the composer; the re-read of the comments, the @ list and an agent hand-off
// follow behind it. Here every request after the POST hangs, and on each
// surface the comment must still show and the button come back:
//
//   - the feedback widget (bookmarklet): a new comment on an element, and a reply
//   - the feedback space page: a reply
//   - the doc page (slides and sheets share its comment hook): a reply
//
// Real worker routes (in-process harness) behind a local HTTP server, the
// built runtimes, a browser. TDOC_UI_ENGINES=chromium,webkit runs both.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const playwright = requirePlaywrightOrSkip('comment-post-no-hang-ui.test.js');

const ENGINES = (process.env.TDOC_UI_ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const TDOC = 'https://tdoc.dev';
const HOME = { Origin: TDOC };
// Well past one round trip here, well short of "never".
const PROMPT_MS = 3000;

const TDOC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tdoc page</title>
<style>body{font:16px system-ui;margin:0}main{max-width:640px;margin:80px auto;padding:0 24px}</style></head>
<body><main><h1>My docs</h1><p id="x">Something to comment on.</p><p id="y">Another thing.</p></main>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/__page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(TDOC_PAGE);
    }
    if (pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'server/runtime/feedback.js')));
    }
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    try { for await (const chunk of request) chunks.push(chunk); } catch { return; }
    const headers = { ...request.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = TDOC;
    delete headers.referer;
    const response = await worker.fetch(new Request(`${TDOC}${request.url}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
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
      res.setHeader(key, key === 'location' ? value.replace(TDOC, '') : value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// From the first POST /api/comments on, every other API request on this page
// hangs: the re-read, the @ list, read state, a hand-off. Only the POST itself
// goes through.
async function hangAfterPost(page) {
  const state = { posted: 0, hung: [] };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/comments' && request.method() === 'POST') {
      state.posted++;
      return route.continue();
    }
    if (state.posted) { state.hung.push(`${request.method()} ${url.pathname}`); return; }
    return route.continue();
  });
  return state;
}

(async () => {
  console.log('Comment posting ends at the POST, on every surface');
  const mod = await loadWorker();
  const worker = mod.default;
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const call = async (env, p, opts) => {
    const r = await worker.fetch(req(p, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  // Serena's feedback space for tdoc.dev itself, with one comment on #y;
  // and a doc of hers with one document comment.
  const world = async () => {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const serena = await issue(worker, env, 'serena');
    await env.META.put(`account-notify:${serena.account_id}`, JSON.stringify([{ provider: 'raft', server_id: 'srv-stan', agent_sub: 's1', server_slug: 'stan', agent_name: 'serena-codex', last_touched: new Date().toISOString() }]));
    const space = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: serena.cookie, headers: HOME, body: { origin: TDOC } })).body;
    const anchor = { kind: 'product', url: `${TDOC}/__page`, selector: '#y', tag: 'p', text: 'Another thing.' };
    const comment = (await call(env, '/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'Why is this here?', anchor } })).body;
    const docSlug = 'posting-doc';
    await env.META.put(`meta:${docSlug}`, JSON.stringify({
      slug: docSlug, title: 'Posting doc', github_login: 'serena', hosted: { github_login: 'serena', account_id: serena.account_id },
      versions: [{ n: 1, created: '2026-11-10T00:00:00Z' }], access: { mode: 'private', allowed_users: [] },
    }));
    await env.DOCS.put(`docs/${docSlug}/v1/index.html`, '<!doctype html><html><head><meta charset="utf-8"><title>Posting doc</title></head><body><main><h1>Posting doc</h1><p>Body text.</p></main></body></html>');
    const docComment = (await call(env, '/api/comments', { method: 'POST', cookie: serena.cookie, body: { slug: docSlug, version: 1, text: 'A document thought.', anchor: null } })).body;
    const { server, base } = await startServer(worker, env);
    return { env, serena, space, comment, docSlug, docComment, server, base };
  };
  const sid = (cookie) => cookie.split('=')[1];
  const storedComments = async (w, slug) => {
    const r = await call(w.env, `/api/comments?slug=${slug}&version=1`, { cookie: w.serena.cookie });
    return r.body || [];
  };
  const widgetPage = async (browser, w, width) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${w.base}`, JSON.stringify(w.space)]);
    return { context, page };
  };

  for (const engine of ENGINES) {
    const browser = await playwright[engine].launch({ headless: true });
    try {
      for (const width of [1440, 390]) {
        const tag = `${engine}-${width}`;

        await t(`${tag}: widget: a new comment shows and its composer closes while every read after the POST hangs`, async () => {
          const w = await world();
          const { context, page } = await widgetPage(browser, w, width);
          try {
            const root = page.locator('#tdoc-feedback-root');
            await page.goto(`${w.base}/__page`);
            await root.locator(`[data-comment-id="${w.comment.id}"]`).first().waitFor();
            // Pick an element: the list's + Comment, then the paragraph.
            await page.evaluate(() => {
              const shadow = document.getElementById('tdoc-feedback-root').shadowRoot;
              const pick = [...shadow.querySelectorAll('button')].find((b) => /comment/i.test(b.getAttribute('aria-label') || b.textContent || '') && /\+|add|new/i.test(b.textContent + (b.getAttribute('aria-label') || '')));
              pick && pick.click();
            });
            await page.locator('#x').click({ force: true });
            const composer = root.locator('.tdoc-popup textarea').first();
            await composer.waitFor({ timeout: 5000 });
            await composer.fill('The empty list needs a hint.');
            const pinsBefore = await root.locator('.tdoc-pin').count();
            const hung = await hangAfterPost(page);
            await root.locator('.tdoc-popup button.submit.ui-btn-primary').first().click();
            await composer.waitFor({ state: 'detached', timeout: PROMPT_MS }).catch(async () => {
              const label = await root.locator('.tdoc-popup button.submit.ui-btn-primary').first().innerText().catch(() => '?');
              throw new Error(`the composer is still open ("${label}") after the POST; waiting on: ${hung.hung.join(', ') || 'nothing'}`);
            });
            assert.equal(hung.posted, 1, 'expected exactly one POST');
            const stored = await storedComments(w, w.space.slug);
            const made = stored.find((c) => c.text === 'The empty list needs a hint.');
            assert(made, 'the comment was not saved');
            // Its pin is on the paragraph, from the POST's answer alone.
            await page.waitForFunction((n) => {
              const shadow = document.getElementById('tdoc-feedback-root').shadowRoot;
              return shadow.querySelectorAll('.tdoc-pin').length > n;
            }, pinsBefore, { timeout: PROMPT_MS }).catch(() => {
              throw new Error(`no pin for the new comment; waiting on: ${hung.hung.join(', ') || 'nothing'}`);
            });
          } finally { await context.close(); w.server.close(); }
        });

        await t(`${tag}: widget: a reply shows and its box frees while every read after the POST hangs`, async () => {
          const w = await world();
          const { context, page } = await widgetPage(browser, w, width);
          try {
            const root = page.locator('#tdoc-feedback-root');
            await page.goto(`${w.base}/__page`);
            const card = root.locator(`[data-comment-id="${w.comment.id}"]`).first();
            await card.waitFor();
            await card.getByRole('button', { name: 'Reply' }).first().click();
            const box = root.locator('.tdoc-reply-form textarea').first();
            await box.waitFor();
            await box.fill('Because the empty state is missing.');
            const hung = await hangAfterPost(page);
            await root.locator('.tdoc-reply-form .tdoc-reply-submit.ui-btn-primary').first().click();
            await root.getByText('Because the empty state is missing.').first().waitFor({ timeout: PROMPT_MS }).catch(() => {
              throw new Error(`the reply does not show after the POST; waiting on: ${hung.hung.join(', ') || 'nothing'}`);
            });
            await root.getByText('Posting…').first().waitFor({ state: 'detached', timeout: PROMPT_MS }).catch(() => {
              throw new Error(`"Posting…" is still shown; waiting on: ${hung.hung.join(', ')}`);
            });
          } finally { await context.close(); w.server.close(); }
        });

        // The dock's Send is a menu item on a phone; the dialog is the same.
        if (width > 600) await t(`${tag}: widget: Send to agent opens ready on the list the widget already has, while a fresh read hangs`, async () => {
          const w = await world();
          const { context, page } = await widgetPage(browser, w, width);
          try {
            const root = page.locator('#tdoc-feedback-root');
            let targetReads = 0;
            let hangTargets = false;
            await page.route('**/api/notify/targets**', async (route) => {
              targetReads++;
              if (hangTargets) return;
              return route.continue();
            });
            await page.goto(`${w.base}/__page`);
            await root.locator(`[data-comment-id="${w.comment.id}"]`).first().waitFor();
            const send = root.locator('.tdoc-feedback-dock button.tdoc-fb-send');
            await send.waitFor();
            await page.waitForTimeout(300);
            assert(targetReads >= 1, 'the widget never read its agents');
            hangTargets = true;
            await send.click();
            const dialog = page.getByRole('dialog', { name: 'Send to agent' });
            await dialog.waitFor({ timeout: PROMPT_MS });
            const primary = dialog.locator('button.primary', { hasText: 'Send' });
            await primary.waitFor({ timeout: 1500 }).catch(async () => {
              throw new Error(`no Send button while the targets read hangs: ${await dialog.innerText().catch(() => '')}`);
            });
            assert.equal(await primary.isDisabled(), false, 'Send is disabled while the targets read hangs');
            await page.keyboard.press('Escape');
          } finally { await context.close(); w.server.close(); }
        });

        await t(`${tag}: feedback space page: a reply shows and its box frees while every read after the POST hangs`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.serena.cookie), url: w.base }]);
            const page = await context.newPage();
            await page.goto(`${w.base}/d/${w.space.slug}`);
            const card = page.locator(`[data-comment-id="${w.comment.id}"]`).first();
            await card.waitFor();
            await card.getByRole('button', { name: 'Reply' }).first().click();
            const box = page.locator('.tdoc-reply-form textarea').first();
            await box.waitFor();
            await box.fill('Seen it on the space page.');
            const hung = await hangAfterPost(page);
            await page.locator('.tdoc-reply-form .tdoc-reply-submit.ui-btn-primary').first().click();
            await page.getByText('Seen it on the space page.').first().waitFor({ timeout: PROMPT_MS }).catch(() => {
              throw new Error(`the reply does not show after the POST; waiting on: ${hung.hung.join(', ') || 'nothing'}`);
            });
            await page.getByText('Posting…').first().waitFor({ state: 'detached', timeout: PROMPT_MS }).catch(() => {
              throw new Error(`"Posting…" is still shown; waiting on: ${hung.hung.join(', ')}`);
            });
          } finally { await context.close(); w.server.close(); }
        });

        await t(`${tag}: doc page: a reply shows and its box frees while every read after the POST hangs`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.serena.cookie), url: w.base }]);
            const page = await context.newPage();
            await page.goto(`${w.base}/d/${w.docSlug}`);
            const card = page.locator(`[data-comment-id="${w.docComment.id}"]`).first();
            if (!(await card.isVisible().catch(() => false))) {
              // On a phone the comments live in the drawer.
              const open = page.locator('[aria-label*="omment" i]').first();
              await card.waitFor({ timeout: 4000 }).catch(async () => { await open.click().catch(() => {}); });
            }
            await card.waitFor();
            await card.getByRole('button', { name: 'Reply' }).first().click();
            const box = page.locator('.tdoc-reply-form textarea').first();
            await box.waitFor();
            await box.fill('Agreed on the doc page.');
            const hung = await hangAfterPost(page);
            await page.locator('.tdoc-reply-form .tdoc-reply-submit.ui-btn-primary').first().click();
            await page.getByText('Agreed on the doc page.').first().waitFor({ timeout: PROMPT_MS }).catch(() => {
              throw new Error(`the reply does not show after the POST; waiting on: ${hung.hung.join(', ') || 'nothing'}`);
            });
            await page.getByText('Posting…').first().waitFor({ state: 'detached', timeout: PROMPT_MS }).catch(() => {
              throw new Error(`"Posting…" is still shown; waiting on: ${hung.hung.join(', ')}`);
            });
          } finally { await context.close(); w.server.close(); }
        });
      }
    } finally { await browser.close(); }
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
