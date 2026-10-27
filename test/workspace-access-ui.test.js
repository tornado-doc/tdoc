// Workspace-level agent access in a real browser: the Allow page a person
// meets when an agent connects (/activate), and Settings > Agents, where each
// connection shows the workspaces it reaches and can be changed or removed.
// Real worker routes (in-process harness) behind a local HTTP server, real
// built shell runtime, desktop and phone widths. Each step is also checked
// against the server: what the page shows is what the token can do.
//
// TDOC_DEMO_DIR=<dir> records a paced walkthrough video per width (webm) and
// screenshots there, for a person to watch rather than a test to assert.
//
// Run with: node test/workspace-access-ui.test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium } = requirePlaywrightOrSkip('workspace-access-ui.test.js');
const DEMO = process.env.TDOC_DEMO_DIR || '';

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (inReq, res) => {
    const pathname = inReq.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    for await (const c of inReq) chunks.push(c);
    const headers = { ...inReq.headers, host: 'tdoc.dev' };
    // The worker believes it is https://tdoc.dev; the page's own origin is
    // this local server, so same-origin posts are told so.
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    const response = await worker.fetch(new Request(`https://tdoc.dev${inReq.url}`, {
      method: inReq.method,
      headers,
      body: chunks.length && !['GET', 'HEAD'].includes(inReq.method) ? Buffer.concat(chunks) : undefined,
    }), env, { waitUntil() {}, passThroughOnException() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy', 'set-cookie'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// A stand-in terminal for the video: what the agent prints while it waits.
function terminalHtml(lines) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#1e1e1e;min-height:100vh">
  <div style="font:13px/1.6 ui-monospace,Menlo,monospace;color:#d4d4d4;padding:22px;white-space:pre-wrap;word-break:break-word">${lines.map(esc).join('\n')}</div></body>`;
}

(async () => {
  console.log('Workspace access UI (Allow page, Settings > Agents)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, opts) => {
    const r = await worker.fetch(req(p, opts), env, { waitUntil() {}, passThroughOnException() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const cookie = await putSession(env, 'julie');
  const origin = { Origin: 'https://tdoc.dev' };
  const team = async (name) => (await call('/api/teams', { method: 'POST', cookie, headers: origin, body: { name } })).body.team;
  const abby = await team('abby');
  const befreed = await team('BeFreed');
  // An account token, so the person has one older connection in the list.
  const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'weekly-notes', device: 'office-imac', client: 'Codex' } });
  const account = minted.body.token;
  const publish = (token, slug, extra = {}) => call('/api/upload', { method: 'POST', token, body: { slug, version: 1, html: `<h1>${slug}</h1>`, meta: { title: slug, access: { visibility: 'private' } }, ...extra } });
  await publish(account, 'abby-plan');
  await call('/api/team/move', { method: 'POST', token: account, body: { team: abby.id, slugs: ['abby-plan'] } });

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const pause = (page, ms) => (DEMO ? page.waitForTimeout(ms) : Promise.resolve());
  if (DEMO) fs.mkdirSync(DEMO, { recursive: true });

  try {
    for (const [label, width, height] of [['desktop', 1280, 820], ['phone', 390, 844]]) {
      const context = await browser.newContext({
        viewport: { width, height },
        ...(DEMO ? { recordVideo: { dir: path.join(DEMO, `raw-${label}`), size: { width, height } } } : {}),
        ...(label === 'phone' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      });
      await context.addCookies([{ name: 'tdoc_sid', value: cookie.split('=')[1], url: base }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const shot = async (name) => { if (DEMO) await page.screenshot({ path: path.join(DEMO, `${label}-${name}.png`), fullPage: false }); };
      const device = `${label === 'phone' ? 'julies-phone-test' : 'julies-mac'}`;
      let start = null;
      let token = null;

      await t(`${label}: an agent connects and the Allow page lists every workspace, all ticked`, async () => {
        start = (await call('/api/cli/pair/start', { method: 'POST', body: { label: 'q3-report', device, client: 'Claude Code' } })).body;
        if (DEMO) {
          await page.setContent(terminalHtml([
            '$ bin/tdoc-publish --signin-only',
            `[tdoc] Sign in to publish on ${base}`,
            '[tdoc] A tdoc page just opened in your browser — the code is filled in; sign in and approve.',
            `[tdoc] (If nothing opened: ${base}/activate?code=${start.user_code} )`,
            "[tdoc] Once it's approved, I'll continue here on my own.",
          ]));
          await pause(page, 2200);
        }
        await page.goto(`${base}/activate?code=${start.user_code}`);
        await page.locator('.tdoc-ws-option').first().waitFor();
        const names = await page.locator('.tdoc-ws-name').allInnerTexts();
        if (JSON.stringify(names) !== JSON.stringify(['My docs', 'abby', 'BeFreed'])) throw new Error(`workspaces: ${names}`);
        const boxes = page.locator('.tdoc-ws-option input');
        for (let i = 0; i < 3; i++) if (!(await boxes.nth(i).isChecked())) throw new Error(`box ${i} not ticked by default`);
        const grant = await page.locator('.tdoc-activate-grant').first().innerText();
        if (!grant.includes(`Claude Code on ${device}`)) throw new Error(`the asker is not named: ${grant}`);
        await pause(page, 1800);
        await shot('allow-all-ticked');
      });

      await t(`${label}: unticking a workspace and Allow mints a token that reaches only the rest`, async () => {
        await page.locator('.tdoc-ws-option', { hasText: 'abby' }).click();
        if (await page.locator('.tdoc-ws-option input').nth(1).isChecked()) throw new Error('abby still ticked');
        await pause(page, 1200);
        await shot('allow-abby-unticked');
        await page.getByRole('button', { name: 'Allow', exact: true }).click();
        await page.getByRole('heading', { name: 'Access allowed' }).waitFor();
        const hint = await page.locator('.tdoc-activate-hint').first().innerText();
        if (!hint.includes('My docs and BeFreed')) throw new Error(`no summary: ${hint}`);
        await pause(page, 1500);
        await shot('allowed');
        const polled = (await call('/api/cli/pair/poll', { method: 'POST', body: { user_code: start.user_code, pair_secret: start.pair_secret } })).body;
        token = polled.token;
        if (JSON.stringify(polled.workspaces) !== JSON.stringify(['me', befreed.id])) throw new Error(`token reaches ${JSON.stringify(polled.workspaces)}`);
        const out = await publish(token, `try-abby-${label}`, { team: 'abby' });
        if (out.status !== 403) throw new Error(`published into abby: ${out.status}`);
        if (DEMO) {
          await page.setContent(terminalHtml([
            '$ bin/tdoc-publish --signin-only',
            '[tdoc] Signed in as julie',
            `[tdoc] This connection reaches only the workspaces you ticked. Change them in Settings → Agents: ${base}/me?view=settings#agent-access`,
            '',
            `$ bin/tdoc-publish --team abby q3-report`,
            `[tdoc] Not published: ${out.body.message}`,
          ]));
          await pause(page, 3500);
        }
      });

      await t(`${label}: Settings > Agents shows the connection and the workspaces it reaches`, async () => {
        await page.goto(`${base}/me?view=settings#agent-access`);
        const row = page.locator('.tdoc-dev-row', { hasText: device });
        await row.waitFor();
        await row.scrollIntoViewIfNeeded();
        const reach = await row.locator('.tdoc-dev-reach').innerText();
        if (!reach.includes('My docs and BeFreed')) throw new Error(`row says: ${reach}`);
        const older = await page.locator('.tdoc-dev-row', { hasText: 'office-imac' }).locator('.tdoc-dev-reach').innerText();
        if (!older.includes('All workspaces')) throw new Error(`account-level row says: ${older}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) throw new Error(`page overflows by ${overflow}px`);
        await pause(page, 1800);
        await shot('settings-agents');
      });

      await t(`${label}: changing the workspaces takes effect on the next request`, async () => {
        const row = page.locator('.tdoc-dev-row', { hasText: device });
        await row.getByRole('button', { name: 'Change' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await pause(page, 900);
        await dialog.locator('.tdoc-ws-option', { hasText: 'abby' }).click();
        await dialog.locator('.tdoc-ws-option', { hasText: 'My docs' }).click();
        await pause(page, 900);
        await shot('change-dialog');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await dialog.waitFor({ state: 'detached' });
        await page.locator('[role="status"]', { hasText: 'Saved.' }).waitFor();
        const reach = await row.locator('.tdoc-dev-reach').innerText();
        if (!reach.includes('abby and BeFreed')) throw new Error(`row says: ${reach}`);
        const who = (await call('/api/hosted/whoami', { token })).body;
        if (JSON.stringify(who.workspaces) !== JSON.stringify([abby.id, befreed.id])) throw new Error(`server says ${JSON.stringify(who.workspaces)}`);
        const read = await call('/d/abby-plan/raw', { token });
        if (read.status !== 200) throw new Error(`abby still unreachable: ${read.status}`);
        await pause(page, 1600);
        await shot('changed');
      });

      await t(`${label}: removing the connection stops it at once`, async () => {
        const row = page.locator('.tdoc-dev-row', { hasText: device });
        await row.getByRole('button', { name: 'Remove' }).click();
        const dialog = page.getByRole('dialog');
        await pause(page, 1000);
        await dialog.getByRole('button', { name: 'Remove' }).click();
        await row.waitFor({ state: 'detached' });
        const who = await call('/api/hosted/whoami', { token });
        if (who.status !== 401) throw new Error(`removed token still works: ${who.status}`);
        await pause(page, 1600);
        await shot('removed');
      });

      await t(`${label}: no page errors`, async () => {
        if (errors.length) throw new Error(errors.join('\n'));
      });
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
