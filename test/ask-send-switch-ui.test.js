// Ask AI's two modes, in the real shell against the real worker, desktop and
// phone:
//   Ask ▾ / Edit ▾  a quiet mode picker in the input's bottom row, beside the
//                 agent pill, only for a viewer who can send (no picker
//                 otherwise). Edit asks the agent picked in the pill to change
//                 the doc: the input is the instruction (always shown, "What
//                 should the agent change?"); pending comments are optional
//                 attachments ("4 comments included · Choose", "2 of 4",
//                 "No comments included"; none pending: no line). The button
//                 is "Send to <agent>", off with no instruction and no checked
//                 comment. Sending: instruction + comments hands the comments
//                 off with the instruction as the note; comments only hands
//                 them off; instruction only posts it as the viewer's
//                 whole-document comment and hands that comment off. The mode
//                 is remembered per doc. No paper-plane in the phone drawer.
//   phone         at 390 and 320, with a long agent name, the input row stays
//                 one line: the name ends in an ellipsis and Send is the ↑.
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
  const third = (await post('Billing date: say "March 14"\nand link the invoice thread')).body.id;
  const fourth = (await post('Cut the mobile paragraph')).body.id;
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
    const sendBtn = (panel, name) => panel.locator('.tdoc-ask-send-form').getByRole('button', { name, exact: true });
    const handoffs = async () => (await pending()).filter((h) => h.kind !== 'ask');
    await t('desktop: Edit — labels, the instruction input, comments included / Choose, Send to OpenTag; instruction + checked comments sends the comments with the instruction as the note', async () => {
      desktop = await open(bob, DESKTOP);
      const { page } = desktop;
      const panel = await askAi(page, false);
      if (!(await modeIs(panel, 'Ask'))) throw new Error('Ask is not the first mode');
      if (await panel.locator('.tdoc-seg, [role="radiogroup"]').count()) throw new Error('the segmented switch is back above the input');
      const modes = await modeMenu(page, panel);
      const items = (await modes.getByRole('menuitem').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
      if (JSON.stringify(items) !== JSON.stringify(['Ask — the agent answers', 'Edit — the agent changes this doc'])) throw new Error(`mode menu: ${JSON.stringify(items)}`);
      await shot(page, 'mode-menu-1280.png');
      await modes.getByRole('menuitem', { name: /^Edit —/ }).click();
      await modes.waitFor({ state: 'detached' });
      if (!(await modeIs(panel, 'Edit'))) throw new Error('mode did not switch to Edit');
      // The instruction is the input: always there, focused, no "+ Add a note".
      const box = panel.getByRole('textbox', { name: 'What should the agent change?' });
      await box.waitFor();
      if ((await box.getAttribute('placeholder')) !== 'What should the agent change?') throw new Error('instruction placeholder');
      if (!(await box.evaluate((el) => el === document.activeElement))) throw new Error('the instruction is not focused');
      if (await panel.getByRole('button', { name: /Add a note/ }).count()) throw new Error('"+ Add a note" is back');
      const summary = panel.locator('.tdoc-ask-send-summary');
      const summaryIs = async (text) => { await summary.filter({ hasText: text }).waitFor({ timeout: 10000 }); };
      await summaryIs('4 comments included · Choose');
      const list = panel.getByRole('group', { name: 'Comments to include' });
      if (await list.count()) throw new Error('the comment list is open by default');
      const send = sendBtn(panel, 'Send to OpenTag');
      await send.waitFor();
      if (await send.isDisabled()) throw new Error('Send is off with 4 comments checked');
      if (await panel.locator('.tdoc-ask-send-icon').isVisible()) throw new Error('desktop shows the ↑ too');
      await shot(page, 'edit-mode-ready-1280.png');
      // Choose: every pending comment, author + first line, all checked.
      const choose = summary.getByRole('button', { name: 'Choose' });
      await choose.click();
      await list.waitFor();
      const listed = (await list.locator('.tdoc-ask-send-item').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
      const want = ['Can search move to March?', 'Add the April date to the summary', 'Billing date: say "March 14"', 'Cut the mobile paragraph'];
      if (listed.length !== 4 || listed.some((row, i) => !row.includes('bob') || !row.endsWith(want[i]))) throw new Error(`listed: ${JSON.stringify(listed)}`);
      if (await list.getByRole('checkbox', { checked: false }).count()) throw new Error('a listed comment starts unchecked');
      // All unchecked and no instruction: "No comments included", Send off.
      for (const box of await list.getByRole('checkbox').all()) await box.click();
      await summaryIs('No comments included · Done');
      if (!(await send.isDisabled())) throw new Error('Send is on with no instruction and no comment');
      await shot(page, 'edit-mode-none-checked-1280.png');
      for (const name of [/Can search move/, /Billing date/, /Cut the mobile/]) await list.getByRole('checkbox', { name }).click();
      await summaryIs('3 of 4 comments included · Done');
      await summary.getByRole('button', { name: 'Done' }).click();
      await list.waitFor({ state: 'detached' });
      await summaryIs('3 of 4 comments included · Choose');
      const pill = panel.getByRole('button', { name: 'Who should change it?' });
      if (!(await pill.innerText()).includes('OpenTag')) throw new Error(`recipient: ${await pill.innerText()}`);
      const { menu, rows } = await menuRows(page, pill);
      if (rows.filter((r) => r.includes('OpenTag')).length !== 1) throw new Error(`Edit picker rows: ${JSON.stringify(rows)}`);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      await box.fill('Keep the March date');
      await shot(page, 'edit-mode-instruction-comments-1280.png');
      await send.click();
      await panel.locator('.tdoc-send-result.is-ok').getByText('Sent 3 comments to OpenTag ✓').waitFor({ timeout: 10000 });
      const queued = await handoffs();
      const ids = queued.flatMap((h) => h.comment_ids || []);
      if (![first, third, fourth].every((id) => ids.includes(id)) || ids.includes(second)) throw new Error(`queued: ${JSON.stringify(queued)}`);
      if (!queued.some((h) => h.instruction === 'Keep the March date')) throw new Error(`instruction not the note: ${JSON.stringify(queued.map((h) => h.instruction))}`);
      if ((await comments()).some((c) => c.text === 'Keep the March date')) throw new Error('an instruction with comments became a comment');
      // The unchecked one stays pending, checked; the input clears.
      await summaryIs('1 comment included · Choose');
      if (await box.inputValue()) throw new Error('the instruction stays after sending');
      if (desktop.errors.length) throw new Error(desktop.errors.join('\n'));
    });

    await t('desktop: Edit with comments only hands them off as today', async () => {
      const { page } = desktop;
      const panel = page.getByRole('dialog', { name: 'Ask AI' });
      const send = sendBtn(panel, 'Send to OpenTag');
      await send.click();
      await panel.locator('.tdoc-send-result.is-ok').getByText('Sent 1 comment to OpenTag ✓').waitFor({ timeout: 10000 });
      const h = (await handoffs()).find((x) => (x.comment_ids || []).includes(second));
      if (!h || h.instruction !== 'address this comment') throw new Error(`comments-only handoff: ${JSON.stringify(h)}`);
      // Nothing pending: no line, the input stays, Send is off until typed.
      await panel.locator('.tdoc-ask-send-summary').waitFor({ state: 'detached', timeout: 10000 });
      await panel.getByRole('textbox', { name: 'What should the agent change?' }).waitFor();
      if (!(await send.isDisabled())) throw new Error('Send is on with nothing to send');
      await shot(page, 'edit-mode-empty-1280.png');
    });

    await t('desktop: Edit with only an instruction posts a whole-document comment by the viewer and hands that comment to the chosen agent', async () => {
      const { page } = desktop;
      const panel = page.getByRole('dialog', { name: 'Ask AI' });
      const box = panel.getByRole('textbox', { name: 'What should the agent change?' });
      const send = sendBtn(panel, 'Send to OpenTag');
      const before = new Set((await handoffs()).map((h) => h.id || h.handoff_id || JSON.stringify(h.comment_ids)));
      await box.fill('Tighten the summary to two lines');
      if (await send.isDisabled()) throw new Error('Send is off with an instruction');
      await shot(page, 'edit-mode-instruction-1280.png');
      await send.click();
      await panel.locator('.tdoc-send-result.is-ok').getByText('Sent to OpenTag ✓').waitFor({ timeout: 10000 });
      const posted = (await comments()).filter((c) => c.text === 'Tighten the summary to two lines');
      if (posted.length !== 1) throw new Error(`document comments: ${JSON.stringify(posted)}`);
      const doc = posted[0];
      if (doc.anchor && doc.anchor.kind !== 'document') throw new Error(`not a whole-document comment: ${JSON.stringify(doc.anchor)}`);
      if (!JSON.stringify(doc.author || {}).includes('bob')) throw new Error(`author: ${JSON.stringify(doc.author)}`);
      const h = (await handoffs()).find((x) => (x.comment_ids || []).includes(doc.id));
      if (!h) throw new Error('the document comment was not handed off');
      if (before.has(h.id || h.handoff_id || JSON.stringify(h.comment_ids))) throw new Error('reused an old handoff');
      if (JSON.stringify(h.comment_ids) !== JSON.stringify([doc.id])) throw new Error(`handoff carries more: ${JSON.stringify(h.comment_ids)}`);
      if (await box.inputValue()) throw new Error('the instruction stays after sending');
      await panel.locator('.tdoc-ask-send-summary').waitFor({ state: 'detached', timeout: 10000 });
      await shot(page, 'edit-mode-instruction-sent-1280.png');
      if (desktop.errors.length) throw new Error(desktop.errors.join('\n'));
    });

    await t('desktop: the mode is remembered per doc', async () => {
      const { page, context } = desktop;
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      const panel = await askAi(page, false);
      if (!(await modeIs(panel, 'Edit'))) throw new Error('Edit was not remembered');
      await panel.getByRole('textbox', { name: 'What should the agent change?' }).waitFor();
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
      if (await panel.getByRole('textbox', { name: 'What should the agent change?' }).count()) throw new Error('Edit shows without send');
      await shot(page, 'ask-no-send-1280.png');
      if (errors.length) throw new Error(errors.join('\n'));
      await context.close();
    });

    await t('phone 390: no paper-plane in the drawer header; Edit with the instruction, the comments line and the ↑ in one row; sends; Agent activity readable; Ask keeps the team agent notice', async () => {
      await post('Phone: tighten the intro');
      const { page, context, errors } = await open(bob, PHONE);
      const panel = await askAi(page, true);
      await pickMode(page, panel, 'Edit');
      await panel.locator('.tdoc-ask-send-summary').filter({ hasText: '1 comment included · Choose' }).waitFor();
      if (await panel.locator('.tdoc-ask-send-list').count()) throw new Error('phone: the list is open by default');
      await panel.getByRole('textbox', { name: 'What should the agent change?' }).waitFor();
      // A phone's Send is the ↑, named for the agent; no wide button.
      const phoneSend = panel.locator('.tdoc-ask-send-form').getByRole('button', { name: 'Send to OpenTag', exact: true });
      await phoneSend.waitFor();
      if ((await phoneSend.innerText()).trim() !== '↑') throw new Error(`phone send: ${await phoneSend.innerText()}`);
      if (await panel.locator('.tdoc-ask-send-btn').isVisible()) throw new Error('phone shows the wide Send button');
      const row = await panel.locator('.tdoc-ask-send-form .tdoc-ask-form-bottom').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { overflow: el.scrollWidth > el.clientWidth + 1, kids: [...el.querySelectorAll('button')].filter((b) => b.offsetParent).every((b) => { const k = b.getBoundingClientRect(); return k.right <= r.right + 1 && k.top >= r.top - 1 && k.bottom <= r.bottom + 1; }) };
      });
      if (row.overflow || !row.kids) throw new Error(`phone input row overflows: ${JSON.stringify(row)}`);
      await shot(page, 'edit-mode-ready-390.png');
      await panel.locator('.tdoc-ask-send-summary').getByRole('button', { name: 'Choose' }).click();
      if (!(await panel.getByRole('checkbox', { name: /Phone: tighten the intro/ }).isChecked())) throw new Error('phone: the comment starts unchecked');
      await shot(page, 'edit-mode-choose-390.png');
      await panel.locator('.tdoc-ask-send-summary').getByRole('button', { name: 'Done' }).click();
      await panel.getByRole('textbox', { name: 'What should the agent change?' }).fill('Keep it short');
      await shot(page, 'edit-mode-instruction-390.png');
      await phoneSend.click();
      await panel.locator('.tdoc-send-result.is-ok').getByText('Sent 1 comment to OpenTag ✓').waitFor({ timeout: 10000 });
      await panel.locator('.tdoc-ask-send-summary').waitFor({ state: 'detached', timeout: 10000 });
      if (!(await phoneSend.isDisabled())) throw new Error('phone: Send is on with nothing to send');
      await shot(page, 'edit-mode-sent-390.png');
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

    // A team agent with a long name: on a phone the Edit row must stay one
    // line -- mode, agent (ellipsized), ↑ -- with no sideways scroll.
    const LONG = 'Quarterly Planner · befreed team · mac'; // 38 of the 40 a team agent name may have
    const longAgent = (await api('/api/team/agents', { method: 'POST', cookie: julie.cookie, body: { id: team.id, name: LONG } })).body;
    const longToken = (await api('/api/team/agents/connect', { method: 'POST', body: { code: longAgent.setup_code, device: 'mac' } })).body.token;
    await api('/api/notify/local/register', { method: 'POST', token: longToken, body: { device: 'mac', clis: ['claude'] } });
    await post('Phone: one more for the long name');
    for (const width of [390, 320]) {
      await t(`phone ${width}: a long agent name ends in an ellipsis; the Edit row stays one line with the ↑, no horizontal overflow`, async () => {
        const { page, context, errors } = await open(bob, { ...PHONE, viewport: { width, height: 760 } });
        const panel = await askAi(page, true);
        if (!(await modeIs(panel, 'Edit'))) await pickMode(page, panel, 'Edit');
        const pill = panel.getByRole('button', { name: 'Who should change it?' });
        await pill.click();
        const menu = page.locator('.tdoc-agent-menu');
        await menu.waitFor();
        const longRow = menu.getByRole('menuitem', { name: /Quarterly Planner/ });
        if (!(await longRow.count())) throw new Error(`picker rows: ${JSON.stringify(await menu.innerText())} ${JSON.stringify(longAgent)} ${longToken}`);
        await longRow.click();
        await menu.waitFor({ state: 'detached' });
        await panel.getByRole('textbox', { name: 'What should the agent change?' }).fill('Shorten the intro');
        const label = (await pill.innerText()).trim();
        if (!label.startsWith('Quarterly Planner')) throw new Error(`pill: ${label}`);
        const icon = panel.locator('.tdoc-ask-send-form').getByRole('button', { name: `Send to ${label}`, exact: true });
        await icon.waitFor();
        if ((await icon.innerText()).trim() !== '↑') throw new Error('the phone send is not the ↑');
        const row = await panel.locator('.tdoc-ask-send-form .tdoc-ask-form-bottom').evaluate((el) => {
          const r = el.getBoundingClientRect();
          const shown = [...el.querySelectorAll('button')].filter((b) => b.offsetParent);
          const tops = shown.map((b) => Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2));
          const name = el.querySelector('.tdoc-agent-pill .tdoc-ask-pill-label');
          return {
            overflow: el.scrollWidth > el.clientWidth + 1,
            inside: shown.every((b) => { const k = b.getBoundingClientRect(); return k.left >= r.left - 7 && k.right <= r.right + 1; }), // the pills sit 6px out, aligned with the text
            oneLine: Math.max(...tops) - Math.min(...tops) <= 2 && r.height < 40,
            ellipsis: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis',
            count: shown.length,
          };
        });
        if (row.overflow || !row.inside || !row.oneLine || !row.ellipsis || row.count !== 3) throw new Error(`${width}: ${JSON.stringify(row)}`);
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        if (layout.scrollWidth > layout.width + 1) throw new Error(JSON.stringify(layout));
        await shot(page, `edit-mode-long-name-${width}.png`);
        if (errors.length) throw new Error(errors.join('\n'));
        await context.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
    globalThis.fetch = realFetch;
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
