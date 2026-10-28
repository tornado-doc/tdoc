// Ask AI's two modes, in the real shell against the real worker, desktop and
// phone:
//   Ask ▾ / Send to agent ▾  a quiet mode picker in the input's bottom row,
//                 beside the agent pill, only for a viewer who can send (no
//                 picker otherwise). Send to agent hands the doc's ready comments
//                 to the agent picked in the same pill, through the Send to
//                 agent dialog's own send, and shows its delivery line; the
//                 count sits beside Send. With nothing ready it says so, the
//                 menu's Send to agent row is off and so is the button. The mode
//                 is remembered per doc. No paper-plane in the phone drawer.
//   one row       a team agent whose daemon registered claude and codex on
//                 one computer is one row in both pickers.
//   team agent    asking it in Ask shows, before Send, that its answer is a
//                 comment everyone sees; the question is posted and the
//                 question goes to the agent in that thread. No error.
// Run with: node test/ask-send-switch-ui.test.js

const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, devices } = requirePlaywrightOrSkip('ask-send-switch-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const MODEL = 'https://model.invalid/v1';
const SLUG = 'team-plan';
const DOC = '<!doctype html><html><body><h1>Team plan</h1><p>Billing ships first, on March 14, because invoices block two renewals. Search follows in April.</p><p>The mobile app waits for Q4.</p></body></html>';

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
  console.log('Ask AI: Ask / Send to agent, one row per agent, team agent in public (real shell)');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Invoices block two renewals.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  await env.META.delete(`account-terminal:${bob.account_id}`);
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  await api('/api/upload', { method: 'POST', token: julie.token, body: { slug: SLUG, version: 1, html: DOC, meta: { title: 'Team plan' } } });
  const team = (await api('/api/teams', { method: 'POST', cookie: julie.cookie, body: { name: 'BeFreed' } })).body.team;
  await api('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  await api('/api/team/move', { method: 'POST', cookie: julie.cookie, body: { slugs: [SLUG], team: team.id } });
  // Julie's last edit in the browser (what the editor stamps), so the team
  // agent may write the next version: authorship is checked at write time.
  const meta = JSON.parse(env.META.map.get(`meta:${SLUG}`));
  const last = meta.versions.reduce((a, b) => (Number(b.n) > Number(a.n) ? b : a));
  Object.assign(last, { source: 'browser', author: 'julie' });
  delete last.by;
  env.META.map.set(`meta:${SLUG}`, JSON.stringify(meta));
  // The team agent's daemon registers both CLIs on its one computer.
  const added = (await api('/api/team/agents', { method: 'POST', cookie: julie.cookie, body: { id: team.id, name: 'OpenTag' } })).body;
  const agentToken = (await api('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'mac' } })).body.token;
  const reg = await api('/api/notify/local/register', { method: 'POST', token: agentToken, body: { device: 'mac', clis: ['claude', 'codex'] } });
  if (reg.status !== 200) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  // The team agent wrote the latest version, so it is who gets the comments.
  const v2 = await api('/api/upload', { method: 'POST', token: agentToken, body: { slug: SLUG, version: 2, html: DOC, meta: { title: 'Team plan' } } });
  if (v2.status !== 200) throw new Error(`agent v2 ${v2.status} ${JSON.stringify(v2.body)}`);
  const post = (text) => api('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: SLUG, version: 2, text, anchor: { kind: 'text', text: 'Search follows in April' } } });
  const first = (await post('Can search move to March?')).body.id;
  const second = (await post('Add the April date to the summary')).body.id;
  const comments = async () => { const r = await api(`/api/comments?slug=${SLUG}&version=2`, { cookie: julie.cookie }); return Array.isArray(r.body) ? r.body : r.body.comments; };
  const pending = async () => (await api('/api/notify/local/pending?device=mac', { token: agentToken })).body.pending || [];

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const DESKTOP = { viewport: { width: 1280, height: 800 } };
  const PHONE = { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, defaultBrowserType: undefined };
  const open = async (who, opts, context = null) => {
    const ctx = context || await browser.newContext(opts);
    if (!context) await ctx.addCookies([{ name: 'tdoc_sid', value: who.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/d/${SLUG}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { context: ctx, page, errors };
  };
  // Ask AI: the bar's button on a desktop, the drawer's Ask AI tab on a phone.
  const askAi = async (page, phone) => {
    if (phone) {
      await page.locator('.tdoc-fab').click();
      await page.locator('#tdoc-comment-layer .tdoc-drawer-tabs').waitFor();
      if (await page.locator('#tdoc-send-plane-btn, .tdoc-send-plane-action').count()) throw new Error('the paper-plane is back in the drawer header');
      await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).getByRole('radio', { name: /Ask AI/ }).click();
      return page.locator('#tdoc-comment-layer .tdoc-ask-panel');
    }
    await page.locator('#tdoc-send-agent-btn').click();
    const panel = page.getByRole('dialog', { name: 'Ask AI' });
    await panel.waitFor();
    return panel;
  };
  // The mode picker: a quiet "Ask ▾" / "Send to agent ▾" in the input's row.
  const modePill = (panel) => panel.locator('.tdoc-ask-form-bottom').getByRole('button', { name: /^Mode:/ });
  const modeIs = async (panel, name) => (await modePill(panel).innerText()).trim() === name;
  const modeMenu = async (page, panel) => {
    await modePill(panel).click();
    const menu = page.locator('.tdoc-ask-mode-menu');
    await menu.waitFor();
    return menu;
  };
  const pickMode = async (page, panel, name) => {
    const menu = await modeMenu(page, panel);
    await menu.getByRole('menuitem', { name: new RegExp(`^${name} —`) }).click();
    await menu.waitFor({ state: 'detached' });
    if (!(await modeIs(panel, name))) throw new Error(`mode did not switch to ${name}`);
  };
  const menuRows = async (page, pill) => {
    await pill.click();
    const menu = page.locator('.tdoc-agent-menu');
    await menu.waitFor();
    const rows = (await menu.getByRole('menuitem').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
    return { menu, rows };
  };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

  try {
    let desktop = null;
    await t('desktop: Send to agent sends the 2 ready comments to the agent in the pill and shows the dialog\'s delivery line; the agent is one row', async () => {
      desktop = await open(bob, DESKTOP);
      const { page } = desktop;
      const panel = await askAi(page, false);
      if (!(await modeIs(panel, 'Ask'))) throw new Error('Ask is not the first mode');
      if (await panel.locator('.tdoc-seg, [role="radiogroup"]').count()) throw new Error('the segmented switch is back above the input');
      const modes = await modeMenu(page, panel);
      const items = (await modes.getByRole('menuitem').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
      if (JSON.stringify(items) !== JSON.stringify(['Ask — the agent answers', 'Send to agent — hand over 2 comments to fix'])) throw new Error(`mode menu: ${JSON.stringify(items)}`);
      await shot(page, 'mode-menu-1280.png');
      await modes.getByRole('menuitem', { name: /^Send to agent —/ }).click();
      await modes.waitFor({ state: 'detached' });
      if (!(await modeIs(panel, 'Send to agent'))) throw new Error('mode did not switch to Send to agent');
      if ((await panel.getByRole('textbox', { name: 'Note for the agent' }).getAttribute('placeholder')) !== 'Note for the agent (optional)…') throw new Error('Send mode placeholder');
      // The count is inline, beside Send, in the input's bottom row.
      await panel.locator('.tdoc-ask-form-bottom .tdoc-ask-ready-count').filter({ hasText: /^2 comments$/ }).waitFor();
      const pill = panel.getByRole('button', { name: 'Who should get these?' });
      if (!(await pill.innerText()).includes('OpenTag')) throw new Error(`recipient: ${await pill.innerText()}`);
      const { menu, rows } = await menuRows(page, pill);
      if (rows.filter((r) => r.includes('OpenTag')).length !== 1) throw new Error(`Send picker rows: ${JSON.stringify(rows)}`);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      await shot(page, 'send-mode-ready-1280.png');
      await panel.getByRole('button', { name: 'Send', exact: true }).click();
      await panel.locator('.tdoc-send-result.is-ok').getByText('Sent 2 comments to OpenTag ✓').waitFor({ timeout: 10000 });
      const queued = (await pending()).filter((h) => h.kind !== 'ask');
      const ids = queued.flatMap((h) => h.comment_ids || []);
      if (!ids.includes(first) || !ids.includes(second)) throw new Error(`not queued: ${JSON.stringify(queued)}`);
      // Sent: nothing is ready now, and the button says so by being off.
      await panel.locator('.tdoc-ask-form-bottom .tdoc-ask-ready-count[title="No comments ready to send"]').filter({ hasText: /^0 comments$/ }).waitFor({ timeout: 10000 });
      if (!(await panel.getByRole('button', { name: 'Send', exact: true }).isDisabled())) throw new Error('Send is on with nothing ready');
      await shot(page, 'send-mode-sent-1280.png');
      if (desktop.errors.length) throw new Error(desktop.errors.join('\n'));
    });

    await t('desktop: the mode is remembered per doc; 0 ready says so and Send is disabled', async () => {
      const { page, context } = desktop;
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      const panel = await askAi(page, false);
      if (!(await modeIs(panel, 'Send to agent'))) throw new Error('Send to agent was not remembered');
      await panel.locator('.tdoc-ask-form-bottom .tdoc-ask-ready-count[title="No comments ready to send"]').filter({ hasText: /^0 comments$/ }).waitFor();
      if (!(await panel.getByRole('button', { name: 'Send', exact: true }).isDisabled())) throw new Error('Send is on with 0 ready');
      const menu = await modeMenu(page, panel);
      const off = menu.getByRole('menuitem', { name: /^Send to agent —/ });
      if ((await off.innerText()).replace(/\s+/g, ' ').trim() !== 'Send to agent — No comments ready') throw new Error(`0-ready row: ${await off.innerText()}`);
      if ((await off.getAttribute('aria-disabled')) !== 'true') throw new Error('the Send to agent row is on with 0 ready');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      await shot(page, 'send-mode-none-1280.png');
      await pickMode(page, panel, 'Ask');
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      const again = await askAi(page, false);
      if (!(await modeIs(again, 'Ask'))) throw new Error('Ask was not remembered');
      const stored = await page.evaluate((slug) => localStorage.getItem(`tdoc-ask-mode:${slug}`), SLUG);
      if (stored !== 'ask') throw new Error(`stored mode: ${stored}`);
      await context.close();
    });

    await t('desktop: a team agent in Ask is one row, says before Send that its answer is public, and asks in a posted comment with no error', async () => {
      const { page, context, errors } = await open(bob, DESKTOP);
      const panel = await askAi(page, false);
      const pill = panel.getByRole('button', { name: 'Who should answer?' });
      if (!(await pill.innerText()).includes('tdoc AI')) throw new Error('a team agent was preselected for a private question');
      if (await panel.locator('.tdoc-ask-public-notice').count()) throw new Error('the public notice shows for tdoc AI');
      const { menu, rows } = await menuRows(page, pill);
      if (rows.filter((r) => r.includes('OpenTag')).length !== 1) throw new Error(`Ask picker rows: ${JSON.stringify(rows)}`);
      await menu.getByRole('menuitem', { name: /OpenTag/ }).click();
      const notice = panel.locator('.tdoc-ask-public-notice');
      await notice.waitFor();
      if ((await notice.innerText()).trim() !== 'OpenTag is a team agent: its answer is posted as a comment everyone can see') throw new Error(`notice: ${await notice.innerText()}`);
      await panel.getByRole('textbox', { name: 'Ask about this document' }).fill('Why does billing ship first?');
      await shot(page, 'ask-team-agent-notice-1280.png');
      await panel.getByRole('button', { name: 'Send question' }).click();
      await panel.getByText('Posted as a comment · Visible to everyone').waitFor({ timeout: 10000 });
      let ask = null;
      for (let i = 0; i < 40 && !ask; i++) {
        ask = (await pending()).find((h) => h.kind === 'ask');
        if (!ask) await page.waitForTimeout(250);
      }
      const posted = (await comments()).find((c) => c.text === 'Why does billing ship first?');
      if (!posted) throw new Error('the question was not posted');
      if (!ask || ask.comment_id !== posted.id) throw new Error(`not asked in the thread: ${JSON.stringify(ask)}`);
      if (await panel.locator('.tdoc-ask-answer.is-error').count()) throw new Error(`error shown: ${await panel.locator('.tdoc-ask-answer.is-error').innerText()}`);
      if (await panel.getByRole('button', { name: 'Retry' }).count()) throw new Error('Retry is shown');
      const reply = await api('/api/agent/ask-reply', { method: 'POST', token: agentToken, body: { slug: SLUG, ask_id: ask.ask_id, text: 'Invoices block two renewals.', agent_login: 'claude', agent_name: 'Claude' } });
      if (reply.status !== 200 || !reply.body.reply_id) throw new Error(`reply ${reply.status} ${JSON.stringify(reply.body)}`);
      await panel.locator('.tdoc-ask-answer').getByText('Invoices block two renewals.').waitFor({ timeout: 15000 });
      await shot(page, 'ask-team-agent-answered-1280.png');
      if (errors.length) throw new Error(errors.join('\n'));
      await context.close();
    });

    await t('desktop: a viewer who cannot send gets no mode picker, only Ask', async () => {
      const context = await browser.newContext(DESKTOP);
      const { page, errors } = await open(null, DESKTOP, context);
      const panel = await askAi(page, false);
      await panel.locator('.tdoc-ask-form-bottom').waitFor();
      if (await modePill(panel).count()) throw new Error('a viewer who cannot send sees the mode picker');
      if (await panel.getByRole('textbox', { name: 'Note for the agent' }).count()) throw new Error('Send mode shows without send');
      await shot(page, 'ask-no-send-1280.png');
      if (errors.length) throw new Error(errors.join('\n'));
      await context.close();
    });

    await t('phone: no paper-plane in the drawer header; the Ask AI tab carries the mode picker, 0 ready is disabled, and the team agent notice', async () => {
      await post('Phone: tighten the intro');
      const { page, context, errors } = await open(bob, PHONE);
      const panel = await askAi(page, true);
      await pickMode(page, panel, 'Send to agent');
      await panel.locator('.tdoc-ask-form-bottom .tdoc-ask-ready-count').filter({ hasText: /^1 comment$/ }).waitFor();
      await shot(page, 'send-mode-ready-390.png');
      await panel.getByRole('button', { name: 'Send', exact: true }).click();
      await panel.locator('.tdoc-send-result.is-ok').getByText('Sent 1 comment to OpenTag ✓').waitFor({ timeout: 10000 });
      await panel.locator('.tdoc-ask-form-bottom .tdoc-ask-ready-count[title="No comments ready to send"]').filter({ hasText: /^0 comments$/ }).waitFor({ timeout: 10000 });
      if (!(await panel.getByRole('button', { name: 'Send', exact: true }).isDisabled())) throw new Error('Send is on with nothing ready');
      await shot(page, 'send-mode-sent-390.png');
      // Readable on a phone: the delivery line is the dialog's green result,
      // and Agent activity's rows are styled links at reading size, not the
      // browser's default bordered buttons running off the drawer.
      const sentLine = await panel.locator('.tdoc-send-result.is-ok').evaluate((el) => ({ color: getComputedStyle(el).color, size: parseFloat(getComputedStyle(el).fontSize) }));
      if (sentLine.color !== 'rgb(26, 115, 64)' || sentLine.size < 13) throw new Error(`delivery line: ${JSON.stringify(sentLine)}`);
      await panel.locator('.tdoc-ask-activity-toggle').click();
      await panel.locator('.tdoc-handoff-details-row').first().waitFor();
      await panel.locator('.tdoc-handoff-details-expand').first().click();
      await panel.locator('.tdoc-handoff-details-history').first().waitFor();
      const activity = await panel.evaluate((root) => {
        const cs = (sel) => getComputedStyle(root.querySelector(sel));
        return {
          jump: [cs('.tdoc-handoff-details-jump').borderTopWidth, cs('.tdoc-handoff-details-jump').backgroundColor],
          expand: [cs('.tdoc-handoff-details-expand').borderTopWidth, parseFloat(cs('.tdoc-handoff-details-expand').fontSize)],
          preview: parseFloat(cs('.tdoc-handoff-details-preview').fontSize),
          history: parseFloat(cs('.tdoc-handoff-details-history').fontSize),
          overflow: [...root.querySelectorAll('.tdoc-handoff-details-row')].some((row) => row.scrollWidth > row.clientWidth + 1),
        };
      });
      if (activity.jump[0] !== '0px' || activity.jump[1] !== 'rgba(0, 0, 0, 0)' || activity.expand[0] !== '0px') throw new Error(`Agent activity rows are unstyled buttons: ${JSON.stringify(activity)}`);
      if (activity.preview < 15 || activity.expand[1] < 13 || activity.history < 13 || activity.overflow) throw new Error(`Agent activity is hard to read on a phone: ${JSON.stringify(activity)}`);
      await shot(page, 'send-agent-activity-390.png');
      await panel.locator('.tdoc-ask-activity-toggle').click();
      await pickMode(page, panel, 'Ask');
      const { menu, rows } = await menuRows(page, panel.getByRole('button', { name: 'Who should answer?' }));
      if (rows.filter((r) => r.includes('OpenTag')).length !== 1) throw new Error(`phone Ask picker rows: ${JSON.stringify(rows)}`);
      await menu.getByRole('menuitem', { name: /OpenTag/ }).click();
      await panel.locator('.tdoc-ask-public-notice').waitFor();
      await shot(page, 'ask-team-agent-notice-390.png');
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      if (layout.scrollWidth > layout.width + 1) throw new Error(JSON.stringify(layout));
      if (errors.length) throw new Error(errors.join('\n'));
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
    globalThis.fetch = realFetch;
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
