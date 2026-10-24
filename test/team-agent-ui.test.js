// Team agents in a real browser, desktop and phone: a team admin adds one in
// team settings -> Agents and gets one command; the dedicated machine runs it
// (the real bin/tdoc-daemon against this worker, over HTTP); a member sends a
// comment on a team doc to it; the reply shows up as "<name> · <team> team
// agent"; the admin removes it and its token stops.
//
// Real worker routes (in-process harness) behind a local HTTP server, real
// built shell runtime, the real daemon and tdoc-agent-reply. Only the model
// is a stand-in: a `claude` on PATH that answers the comment it was handed.
// The terminal frames in the video are the daemon's real output, shown on a
// page styled as a terminal.
//
// TDOC_DEMO_DIR=<dir> records a paced walkthrough video per width (webm) and
// screenshots there.
//
// Run with: node test/team-agent-ui.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium } = requirePlaywrightOrSkip('team-agent-ui.test.js');
const DEMO = process.env.TDOC_DEMO_DIR || '';
const ROOT = path.join(__dirname, '..');

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

function terminalHtml(title, lines) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#1e1e1e;min-height:100vh">
  <div style="font:12px/1.4 -apple-system,sans-serif;color:#999;padding:10px 22px;border-bottom:1px solid #333">${esc(title)}</div>
  <div style="font:13px/1.6 ui-monospace,Menlo,monospace;color:#d4d4d4;padding:22px;white-space:pre-wrap;word-break:break-word">${lines.map(esc).join('\n')}</div></body>`;
}

(async () => {
  console.log('Team agents UI (team settings, Send to team agent, reply, remove)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const call = async (p, opts) => {
    const r = await worker.fetch(req(p, opts), env, { waitUntil() {}, passThroughOnException() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const origin = { Origin: 'https://tdoc.dev' };
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name: 'BeFreed' } })).body.team;
  await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  const docHtml = '<h1>Weekly report</h1><p>Signups grew 12% this week, led by the referral campaign.</p><p>Retention held at 41% for the October cohort.</p>';

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const pause = (page, ms) => (DEMO ? page.waitForTimeout(ms) : Promise.resolve());
  if (DEMO) fs.mkdirSync(DEMO, { recursive: true });

  // The dedicated machine: a temp HOME with nothing personal in it.
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-team-agent-ui-'));
  const FAKEBIN = path.join(world, 'bin');
  fs.mkdirSync(FAKEBIN, { recursive: true });
  fs.writeFileSync(path.join(FAKEBIN, 'claude'), `#!/usr/bin/env bash
set -eu
prompt="$(cat)"
slug="$(printf '%s' "$prompt" | sed -n 's/.*for the slug "\\([^"]*\\)".*/\\1/p' | head -1)"
ids="$(printf '%s' "$prompt" | sed -n 's/^This handoff covers comment ids: \\([^ .,]*\\).*/\\1/p' | head -1)"
bash "$TDOC_SKILL_DIR/bin/tdoc-agent-reply" --slug "$slug" --parent "$ids" --text "Added last week's numbers beside this week's: signups 10.7% then, 12% now." --status answered --login claude >/dev/null
`);
  fs.chmodSync(path.join(FAKEBIN, 'claude'), 0o755);

  try {
    for (const [label, width, height] of [['desktop', 1280, 820], ['phone', 390, 844]]) {
      const slug = `weekly-report-${label}`;
      await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html: docHtml, meta: { title: 'Weekly report', access: { visibility: 'private' } } } });
      await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: [slug] } });
      const HOME = path.join(world, `home-${label}`);
      fs.mkdirSync(path.join(HOME, '.tdoc'), { recursive: true });
      const daemon = (args) => new Promise((resolve) => {
        const child = spawn('bash', [path.join(ROOT, 'bin', 'tdoc-daemon'), ...args], {
          env: { ...process.env, HOME, PATH: `${FAKEBIN}${path.delimiter}${process.env.PATH}`, TDOC_DIR: path.join(HOME, 'tdocs'), TDOC_DAEMON_DIR: path.join(HOME, '.tdoc', 'daemon'), TDOC_DAEMON_OS: 'linux' },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('close', (code) => resolve({ code, out }));
      });
      const device = `befreed-${label}-box`;

      const context = await browser.newContext({
        viewport: { width, height },
        ...(DEMO ? { recordVideo: { dir: path.join(DEMO, `raw-${label}`), size: { width, height } } } : {}),
        ...(label === 'phone' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      });
      const as = async (person) => {
        await context.clearCookies();
        await context.addCookies([{ name: 'tdoc_sid', value: person.cookie.split('=')[1], url: base }]);
      };
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const shot = async (name) => { if (DEMO) await page.screenshot({ path: path.join(DEMO, `${label}-${name}.png`), fullPage: false }); };
      const caption = async (text) => {
        if (!DEMO) return;
        await page.evaluate((s) => {
          let el = document.getElementById('demo-caption');
          if (!el) {
            el = document.createElement('div');
            el.id = 'demo-caption';
            el.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;background:rgba(17,17,17,.88);color:#fff;font:600 13px/1.35 -apple-system,sans-serif;padding:8px 14px;border-radius:999px;max-width:92vw;text-align:center;pointer-events:none';
            document.body.appendChild(el);
          }
          el.textContent = s;
        }, text);
      };
      const agentName = `report-bot-${label}`;
      let setup = null;

      await t(`${label}: the admin adds a team agent and gets one command, with the dedicated-machine warning`, async () => {
        await as(julie);
        await page.goto(`${base}/me?team=${team.id}&view=settings#agents`);
        const section = page.locator('.tm-team-agents');
        await section.waitFor();
        await section.scrollIntoViewIfNeeded();
        await caption('Julie (admin): team settings → Agents');
        await pause(page, 1500);
        await section.getByRole('button', { name: 'Add team agent' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add team agent' });
        await dialog.waitFor();
        const warn = await dialog.locator('.tm-agent-warn').innerText();
        if (!/dedicated machine or container, with no personal data/.test(warn)) throw new Error(`warning: ${warn}`);
        await dialog.locator('input').fill(agentName);
        await pause(page, 1200);
        await shot('add-dialog');
        await dialog.getByRole('button', { name: 'Add', exact: true }).click();
        const connect = page.getByRole('dialog', { name: `Connect ${agentName}` });
        await connect.waitFor();
        const command = await connect.locator('.tm-agent-command code').innerText();
        const code = (command.match(/tdts_[a-f0-9]{48}/) || [])[0];
        if (!code || !command.includes('connect-team')) throw new Error(`command: ${command}`);
        setup = { command, code };
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) throw new Error(`page overflows by ${overflow}px`);
        await caption('One command for a dedicated machine');
        await pause(page, 2600);
        await shot('setup-command');
        await connect.getByRole('button', { name: 'Done' }).click();
        await section.locator('.tm-agent-row', { hasText: agentName }).waitFor();
      });

      await t(`${label}: the machine runs it: the real daemon connects as the team agent and checks in`, async () => {
        const run = await daemon(['connect-team', setup.code, '--base', base, '--no-start']);
        if (run.code !== 0) throw new Error(run.out);
        const first = await daemon(['once', '--cli', 'claude', '--device', device]);
        if (first.code !== 0) throw new Error(first.out);
        if (DEMO) {
          await page.setContent(terminalHtml(`${device} (dedicated machine)`, [
            `$ ${setup.command.replace(/https:\/\/tdoc\.dev/, base)}`.replace(/--base \S+/, `--base ${base}`),
            ...run.out.trim().split('\n'),
            `$ tdoc-daemon once --cli claude --device ${device}`,
            ...first.out.trim().split('\n').map((l) => l.replace(/^\[[^\]]+\] /, '')),
          ]));
          await pause(page, 3800);
          await shot('terminal-connected');
        }
        await page.goto(`${base}/me?team=${team.id}&view=settings&r=${Date.now()}#agents`);
        const row = page.locator('.tm-agent-row', { hasText: agentName });
        await row.waitFor();
        await row.scrollIntoViewIfNeeded();
        const text = await row.innerText();
        if (!text.includes(`${agentName} · BeFreed team agent`) || !text.includes(device)) throw new Error(`row: ${text}`);
        await caption('Connected: it belongs to the team, not to Julie');
        await pause(page, 2000);
        await shot('agent-connected');
      });

      let commentId = null;
      await t(`${label}: a member sends a comment on a team doc to the team agent`, async () => {
        await as(bob);
        const posted = await call('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug, version: 1, text: 'Can you add last week for comparison?', anchor: { kind: 'text', text: 'Signups grew 12% this week' } } });
        commentId = posted.body.id;
        await page.goto(`${base}/d/${slug}`);
        await caption('Bob (member) opens a BeFreed doc');
        const send = page.locator('#tdoc-send-agent-btn');
        await send.waitFor();
        await pause(page, 1500);
        await send.click();
        const dialog = page.getByRole('dialog', { name: 'Send to agent' });
        await dialog.waitFor();
        const recipient = await dialog.locator('.tdoc-notify-recipient').innerText();
        if (!recipient.includes('Send to team agent') || !recipient.includes(`${agentName} · BeFreed team agent`)) throw new Error(`recipient: ${recipient}`);
        await caption('Send to team agent');
        await pause(page, 1800);
        await shot('send-dialog');
        await dialog.locator('.primary').click();
        await dialog.locator('.tdoc-send-result.is-ok').waitFor();
        await pause(page, 1500);
        await shot('sent');
        const queue = (await call(`/api/notify/local/pending?device=${device}`, { token: JSON.parse(fs.readFileSync(path.join(HOME, '.tdoc', 'published.json'), 'utf8')).upload_token })).body;
        if (!queue.pending.some((h) => h.comment_ids.includes(commentId))) throw new Error(`not queued: ${JSON.stringify(queue)}`);
      });

      await t(`${label}: the team agent picks it up and its reply appears, named as the team agent`, async () => {
        const run = await daemon(['once', '--cli', 'claude', '--device', device]);
        if (run.code !== 0 || !/done h_/.test(run.out)) throw new Error(run.out);
        if (DEMO) {
          await page.setContent(terminalHtml(`${device} (dedicated machine)`, [`$ tdoc-daemon once --cli claude --device ${device}`, ...run.out.trim().split('\n').map((l) => l.replace(/^\[[^\]]+\] /, ''))]));
          await pause(page, 3000);
        }
        await page.goto(`${base}/d/${slug}?comment=${encodeURIComponent(commentId)}`);
        const more = page.getByRole('button', { name: /1 reply/ }).first();
        await more.waitFor({ timeout: 15000 });
        await pause(page, 1200);
        await more.click();
        const reply = page.getByText("Added last week's numbers", { exact: false }).first();
        await reply.waitFor({ timeout: 15000 });
        await reply.scrollIntoViewIfNeeded();
        const card = await page.locator(`[data-comment-id="${commentId}"]`).first().innerText().catch(() => '');
        if (card && !card.includes(agentName)) throw new Error(`reply not named as the team agent: ${card.slice(0, 400)}`);
        await caption(`The reply: ${agentName} · BeFreed team agent`);
        await pause(page, 3000);
        await shot('reply');
      });

      await t(`${label}: the admin removes it and its token stops at once`, async () => {
        await as(julie);
        await page.goto(`${base}/me?team=${team.id}&view=settings#agents`);
        const row = page.locator('.tm-agent-row', { hasText: agentName });
        await row.waitFor();
        await row.scrollIntoViewIfNeeded();
        await caption('Julie removes it');
        await pause(page, 1200);
        await row.getByRole('button', { name: 'Remove' }).click();
        const dialog = page.getByRole('dialog', { name: `Remove ${agentName}?` });
        await dialog.waitFor();
        await pause(page, 1200);
        await dialog.getByRole('button', { name: 'Remove' }).click();
        await row.waitFor({ state: 'detached' });
        const token = JSON.parse(fs.readFileSync(path.join(HOME, '.tdoc', 'published.json'), 'utf8')).upload_token;
        const who = await call('/api/hosted/whoami', { token });
        if (who.status !== 401) throw new Error(`removed agent's token still works: ${who.status}`);
        const after = await daemon(['once', '--cli', 'claude', '--device', device]);
        await caption('Removed: its token no longer works');
        await pause(page, 1800);
        await shot('removed');
        if (DEMO) {
          await page.setContent(terminalHtml(`${device} (dedicated machine)`, [`$ tdoc-daemon once --cli claude --device ${device}`, ...after.out.trim().split('\n')]));
          await pause(page, 2600);
        }
        if (after.code === 0) throw new Error(`daemon still polls: ${after.out}`);
      });

      await t(`${label}: no page errors`, async () => {
        if (errors.length) throw new Error(errors.join('\n'));
      });
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(world, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
