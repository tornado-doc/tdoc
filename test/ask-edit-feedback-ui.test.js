// Julie's feedback on Ask/Edit v2, in the real shell against the real worker:
//   - @agent in a comment or a reply asks for suggestions (the phone drawer,
//     a typed @ on a desktop, ⌘⇧Enter), for an owner in dev mode; the agent's
//     edits come back to the review bar, and an agent that only answers does
//     not leave the "working" status up.
//   - a local CLI other than claude keeps the plain handoff (the daemon would
//     refuse it), and so does everybody outside dev mode, to the byte. No
//     suggestion capability reaches anyone outside dev mode.
//   - a reply box is done once the reply is posted, whatever the delivery takes.
//   - a rewrite shows as one removed block then one added block; a small edit
//     stays word by word; clearing puts the original back exactly; edits are
//     text, never markup.
//   - answering an agent in dev mode, the reply box starts with its tag; deleted,
//     it stays deleted; nothing for a person's reply, for an agent the viewer
//     can't pick, or for one whose edits would skip review.
//   - outside dev mode no reply box starts with a tag, readers included: a tag on
//     an editing agent there leads to a plain handoff, which can publish without
//     review. Someone who wants an agent names it.
//   - the version compare marks a rewrite with the same blocks as a suggestion,
//     for everybody.
//   - a thread is flat: replies flush with the top comment at any depth.
// Run with: node test/ask-edit-feedback-ui.test.js

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('ask-edit-feedback-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const MODEL = 'https://model.invalid/v1';
const SLUG = 'plan';
const SMALL = 'Billing ships first, on March 14, because invoices block two renewals.';
const LONG = 'The mobile app waits for the fourth quarter because the team has no designer until then, and the current contractor leaves in May.';
const LONG_NEW = 'Hiring decides this: without a designer nothing on phones can start, so we revisit the whole plan once someone has joined in autumn.';
const DOC = `<!doctype html><html><body><h1>Plan</h1><p id="small">${SMALL}</p><p id="long">${LONG}</p><p id="split">Keep <b>this bold part</b> of the sentence as it stands for now, please.</p></body></html>`;

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
  console.log('Ask/Edit v2 feedback: @agent suggests, rewrites read as blocks, the box is not held');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL, TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test' });
  const sid = 'a'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const minted = await (await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'julie' }) }), env, {})).json();
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const token = minted.token;
  assert.equal((await api('/api/upload', { method: 'POST', token, body: { slug: SLUG, version: 1, html: DOC, meta: { title: 'Plan' } } })).status, 200);
  assert.equal((await api('/api/notify/local/register', { method: 'POST', token, body: { device: 'mac-mini', clis: ['claude', 'codex'] } })).status, 200);
  let commentN = 0;
  const comment = async () => (await api('/api/comments', { method: 'POST', cookie, body: { slug: SLUG, version: 1, text: `Thread ${++commentN}`, anchor: { kind: 'text', text: 'Billing ships first' } } })).body.id;
  const setDevMode = async (on) => {
    env.TDOC_DEBUG_ACCOUNTS = on ? 'julie@tdoc.test' : '';
  };

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  const webkit = await pw.webkit.launch({ headless: true }).catch(() => null);
  const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

  const open = async (opts = {}, which = browser) => {
    const ctx = await which.newContext(opts.phone ? PHONE : { viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: 'tdoc_sid', value: opts.sid || sid, domain: '127.0.0.1', path: '/' }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    if (opts.delayHandoff) await ctx.route(/\/(hand-off|api\/notify\/handoff)(\?|$)/, async (r) => { await new Promise((f) => setTimeout(f, opts.delayHandoff)); await r.continue(); });
    if (opts.delayLists) await ctx.route(/\/api\/(notify\/targets|docs\/[^/]+\/my-agent)/, async (r) => { await new Promise((f) => setTimeout(f, opts.delayLists)); await r.continue(); });
    const page = await ctx.newPage();
    const github = [];
    page.on('request', (r) => { if (r.url().includes('api.github.com')) github.push(r.url()); });
    const sends = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/hand-off$|\/api\/notify\/handoff$/.test(r.url())) sends.push({ path: new URL(r.url()).pathname, body: JSON.parse(r.postData() || '{}') }); });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/d/${SLUG}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { ctx, page, sends, errors, github, frame: page.frames().find((f) => f !== page.mainFrame()) };
  };
  // The phone: drawer, Reply on the card, @, the agent picked by a tap.
  // On a thread with no replies yet (pass `id` for one made before the page loaded).
  const replyInDrawer = async (page, agentRow = /Claude Code/, id = null) => {
    await page.locator('.tdoc-fab').tap();
    const row = id ? page.locator(`#tdoc-comment-layer [data-comment-id="${id}"]`).first() : page.locator('#tdoc-comment-layer');
    await row.getByRole('button', { name: 'Reply', exact: true }).first().tap();
    const box = page.locator('#tdoc-comment-layer .tdoc-reply-form textarea').first();
    await box.waitFor();
    await box.tap();
    await page.keyboard.type('@');
    await page.locator('#tdoc-mention-menu [role=option]').first().waitFor();
    await page.locator('#tdoc-mention-menu [role=option]', { hasText: agentRow }).first().tap();
    await page.keyboard.type('shorter please');
    return box;
  };
  const sendReply = (page) => page.locator('#tdoc-comment-layer .tdoc-reply-submit').first().tap();
  const selectWords = async (page, frame, id) => {
    const box = await page.locator('iframe').first().boundingBox();
    const r = await frame.evaluate((elId) => { const b = document.getElementById(elId).getBoundingClientRect(); return { x1: b.left + 2, x2: b.left + 200, y: b.top + 8 }; }, id);
    await page.mouse.move(box.x + r.x1, box.y + r.y);
    await page.mouse.down();
    await page.mouse.move(box.x + r.x2, box.y + r.y, { steps: 6 });
    await page.mouse.up();
  };

  try {
    await t('phone drawer, reply naming an agent: asks for suggestions, the status shows, the edits reach the review bar', async () => {
      await comment();
      const v = await open({ phone: true });
      const box = await replyInDrawer(v.page);
      assert.match(await v.page.locator('#tdoc-comment-layer .tdoc-reply-form').innerText(), /suggests edits/);
      await shot(v.page, 'reply-pill-390.png');
      await sendReply(v.page);
      await v.page.waitForTimeout(300);
      assert.equal(v.sends.length, 1, JSON.stringify(v.sends));
      assert.equal(v.sends[0].path, '/api/notify/handoff');
      assert.equal(v.sends[0].body.reply_as, 'suggestions');
      assert.equal(v.sends[0].body.instruction, 'address this comment', 'the comment\'s own words stay out of the payload');
      await box.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      const stored = JSON.parse(await env.META.get(`handoffs:${SLUG}`))[0];
      assert.equal(stored.reply_as, 'suggestions');
      // The agent answers with an edit, naming the comment, as tdoc-propose does.
      const proposed = await api(`/api/docs/${SLUG}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'March 14', replace: 'March 21', comment_id: v.sends[0].body.comment_ids[0] }], summary: 'New date' } });
      assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
      await v.page.locator('#tdoc-comment-layer .tdoc-review-suggestion', { hasText: 'Review suggestion' }).first().waitFor({ timeout: 12000 });
      await shot(v.page, 'review-fix-card-390.png');
      await v.page.locator('#tdoc-comment-layer .tdoc-review-suggestion', { hasText: 'Review suggestion' }).first().tap();
      await v.page.locator('.tdoc-suggest-bar').waitFor({ timeout: 5000 });
      await shot(v.page, 'review-bar-390.png');
      assert.equal(await v.page.frameLocator('iframe').locator('ins.tdoc-diff-ins').first().innerText(), '21');
      assert.deepEqual(v.errors, []);
      await api(`/api/docs/${SLUG}/suggestions/${proposed.body.suggestion.id}/reject`, { method: 'POST', cookie, body: {} });
      await v.ctx.close();
    });

    // The agent picked above is now this doc's default, which is who ⌘⇧Enter names.
    await t('desktop composer: ⌘⇧Enter hands the comment over asking for suggestions', async () => {
      const v = await open();
      await selectWords(v.page, v.frame, 'small');
      const box = v.page.locator('.tdoc-popup textarea, .tdoc-inline-composer textarea').first();
      await box.waitFor({ timeout: 5000 });
      await box.fill('date first');
      await box.press('ControlOrMeta+Shift+Enter');
      await v.page.waitForTimeout(600);
      assert.equal(v.sends.length, 1, JSON.stringify(v.sends));
      assert.equal(v.sends[0].body.reply_as, 'suggestions');
      await v.ctx.close();
    });

    await t('an agent that only answers does not leave the status up, and edits with no comment named still arrive', async () => {
      const fresh = await comment();
      const v = await open({ phone: true });
      await replyInDrawer(v.page, /Claude Code/, fresh);
      await sendReply(v.page);
      // The drawer sits over the review bar on a phone: the page's state says it.
      const working = () => v.page.frameLocator('iframe').locator('.tdoc-sugg-pill').first();
      await working().waitFor({ timeout: 5000 });
      const id = v.sends[0].body.comment_ids[0];
      const answered = await api('/api/agent/reply', { method: 'POST', token, body: { slug: SLUG, parent_id: id, text: 'It already reads that way.', status: 'answered', agent_login: 'claude', agent_name: 'claude' } });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      await working().waitFor({ state: 'detached', timeout: 15000 });
      const proposed = await api(`/api/docs/${SLUG}/suggestions`, { method: 'POST', token, body: { edits: [{ find: 'two renewals', replace: 'three renewals' }] } });
      assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
      await v.page.frameLocator('iframe').locator('ins.tdoc-diff-ins', { hasText: 'three' }).waitFor({ timeout: 10000 });
      await api(`/api/docs/${SLUG}/suggestions/${proposed.body.suggestion.id}/reject`, { method: 'POST', cookie, body: {} });
      await v.ctx.close();
    });

    await t('a local CLI other than claude keeps the plain handoff: the daemon would refuse it', async () => {
      const id = await comment();
      const v = await open({ phone: true });
      await replyInDrawer(v.page, /Codex/, id);
      await sendReply(v.page);
      await v.page.waitForTimeout(600);
      assert.equal(v.sends.length, 1, JSON.stringify(v.sends));
      assert.equal(v.sends[0].path.endsWith('/hand-off'), true);
      assert.equal(v.sends[0].body.reply_as, undefined);
      await v.ctx.close();
    });

    await t('outside dev mode: the request is what it was, to the key, and nothing polls for suggestions', async () => {
      await setDevMode(false);
      const fresh = await comment();
      const v = await open({ phone: true });
      const suggestCalls = [];
      v.page.on('request', (r) => { if (/\/suggest/.test(r.url())) suggestCalls.push(r.url()); });
      await replyInDrawer(v.page, /Claude Code/, fresh);
      assert.doesNotMatch(await v.page.locator('#tdoc-comment-layer .tdoc-reply-form').innerText(), /suggests/);
      await sendReply(v.page);
      await v.page.waitForTimeout(800);
      assert.equal(v.sends.length, 1);
      assert.equal(v.sends[0].path.endsWith('/hand-off'), true);
      assert.deepEqual(Object.keys(v.sends[0].body).sort(), ['ask_only', 'comment_id', 'recipient']);
      assert.deepEqual(suggestCalls, []);
      const stored = JSON.parse(await env.META.get(`handoffs:${SLUG}`))[0];
      assert.equal('reply_as' in stored, false);
      await setDevMode(true);
      await v.ctx.close();
    });

    await t('the reply box is done when the reply is posted, not when the delivery ends', async () => {
      const fresh = await comment();
      const v = await open({ phone: true, delayHandoff: 1500 });
      await replyInDrawer(v.page, /Claude Code/, fresh);
      const t0 = Date.now();
      await sendReply(v.page);
      await v.page.waitForFunction(() => !document.querySelector('#tdoc-comment-layer .tdoc-reply-form textarea'), null, { timeout: 8000 });
      const took = Date.now() - t0;
      assert.ok(took < 1400, `the box waited ${took}ms on a 1500ms delivery`);
      await v.ctx.close();
    });

    // A thread answered by the viewer's own Claude Code, as tdoc-agent-reply signs it.
    const agentThread = async (extra = {}, first = null) => {
      const id = await comment();
      if (first) await first(id);
      const posted = await api('/api/agent/reply', { method: 'POST', token, body: { slug: SLUG, parent_id: id, text: 'Done, take a look.', status: 'answered', agent_login: 'claude', agent_name: 'claude', ...extra } });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      return id;
    };
    const handed = async (id) => {
      const h = await api('/api/notify/handoff', { method: 'POST', cookie, body: { slug: SLUG, comment_ids: [id], recipient: { provider: 'local', server_id: 'mac-mini', agent_sub: 'mac-mini_claude' } } });
      assert.equal(h.status, 200, JSON.stringify(h.body));
    };
    const openReply = async (page, phone, id) => {
      const card = page.locator(`[data-comment-id="${id}"]`).first();
      if (phone) { await page.locator('.tdoc-fab').tap(); await card.getByRole('button', { name: 'Reply', exact: true }).first().tap(); }
      else {
        await page.locator(`.tdoc-pin[data-id="${id}"], .tdoc-pin`).first().click({ force: true });
        await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
      }
      const box = card.locator('.tdoc-reply-form textarea').first();
      await box.waitFor();
      return { card, box };
    };
    const threadOf = async (fn) => fn(await agentThread({}, handed));

    await t('phone: replying to an agent starts with its tag; typing and sending hands off, as suggestions', () => threadOf(async (id) => {
      const v = await open({ phone: true });
      const { card, box } = await openReply(v.page, true, id);
      await v.page.waitForFunction((cid) => /Claude Code/.test(document.querySelector(`[data-comment-id="${cid}"] .tdoc-reply-form textarea`)?.value || ''), id);
      await card.locator('.tdoc-agent-pill').waitFor();
      await shot(v.page, 'reply-prefilled-390.png');
      // The tag alone is not a reply.
      await card.locator('.tdoc-reply-submit').last().tap();
      await v.page.waitForTimeout(300);
      assert.equal(v.sends.length, 0, 'sent on the tag alone');
      await box.tap();
      await v.page.keyboard.press('End');
      await v.page.keyboard.type('shorter please');
      assert.match(await box.inputValue(), /Claude Code shorter please$/);
      await card.locator('.tdoc-reply-submit').last().tap();
      await v.page.waitForTimeout(600);
      assert.equal(v.sends.length, 1, JSON.stringify(v.sends));
      assert.equal(v.sends[0].body.reply_as, 'suggestions');
      assert.equal(v.sends[0].body.comment_ids[0], id);
      assert.deepEqual(v.errors, []);
      await v.ctx.close();
    }));

    await t('the tag can be deleted, stays deleted through late lists and refreshes, and the reply is plain', () => threadOf(async (id) => {
      const v = await open({ phone: true });
      const { card, box } = await openReply(v.page, true, id);
      await card.locator('.tdoc-agent-pill').waitFor();
      await box.tap();
      await v.page.keyboard.press('End');
      await v.page.keyboard.press('Backspace'); // the space after the tag
      await v.page.keyboard.press('Backspace'); // the tag, whole
      assert.equal((await box.inputValue()).trim(), '');
      await v.page.waitForTimeout(6000); // a live-sync and an agent-list poll go by
      assert.equal((await box.inputValue()).trim(), '', 'the tag came back');
      await box.tap();
      await v.page.keyboard.type('thanks');
      await card.locator('.tdoc-reply-submit').last().tap();
      await v.page.waitForTimeout(600);
      assert.equal(v.sends.length, 0, JSON.stringify(v.sends));
      await v.ctx.close();
    }));

    await t('desktop: same tag; the agent list arriving late still fills an untouched box, never one typed in', () => threadOf(async (id) => {
      const ctxV = await open({ delayLists: 1500 });
      const a = await openReply(ctxV.page, false, id);
      assert.equal(await a.box.inputValue(), '');
      await a.card.locator('.tdoc-agent-pill').waitFor({ timeout: 8000 });
      await ctxV.ctx.close();
      const typed = await open({ delayLists: 1500 });
      const b = await openReply(typed.page, false, id);
      await b.box.fill('my own words');
      await typed.page.waitForTimeout(2500);
      assert.equal(await b.box.inputValue(), 'my own words');
      await typed.ctx.close();
    }));

    await t('no tag when the latest reply is a person\'s, or the agent is not in this viewer\'s list', async () => {
      const human = await agentThread({}, handed);
      assert.equal((await api('/api/comments', { method: 'POST', cookie, body: { slug: SLUG, version: 1, text: 'Thanks', parent_id: human } })).status, 200);
      const other = await agentThread({ agent_login: 'someone-else', agent_name: 'someone else' });
      const v = await open({ phone: true });
      const a = await openReply(v.page, true, human);
      await v.page.waitForTimeout(500);
      assert.equal(await a.box.inputValue(), '');
      await v.ctx.close();
      const w = await open({ phone: true });
      const b = await openReply(w.page, true, other);
      await w.page.waitForTimeout(500);
      assert.equal(await b.box.inputValue(), '');
      await w.ctx.close();
    });

    await t('no tag on a box answering a person in that thread, or for an agent whose edits would skip review', async () => {
      const id = await comment();
      const person = await api('/api/comments', { method: 'POST', cookie, body: { slug: SLUG, version: 1, text: 'A person speaks', parent_id: id } });
      assert.equal(person.status, 200);
      await handed(id);
      assert.equal((await api('/api/agent/reply', { method: 'POST', token, body: { slug: SLUG, parent_id: id, text: 'An agent speaks', status: 'answered', agent_login: 'claude', agent_name: 'claude' } })).status, 200);
      const v = await open({ phone: true });
      await v.page.locator('.tdoc-fab').tap();
      const card = v.page.locator(`[data-comment-id="${id}"]`).first();
      await card.locator('.tdoc-replies-toggle').first().tap();
      await card.locator(`.tdoc-reply[data-comment-id="${person.body.id}"] .tdoc-reply-toggle`).tap();
      const box = card.locator('.tdoc-reply-form textarea').first();
      await box.waitFor();
      await v.page.waitForTimeout(500);
      assert.equal(await box.inputValue(), '');
      await v.ctx.close();
      const codex = await comment();
      assert.equal((await api('/api/notify/handoff', { method: 'POST', cookie, body: { slug: SLUG, comment_ids: [codex], recipient: { provider: 'local', server_id: 'mac-mini', agent_sub: 'mac-mini_codex' } } })).status, 200);
      assert.equal((await api('/api/agent/reply', { method: 'POST', token, body: { slug: SLUG, parent_id: codex, text: 'From codex', status: 'answered', agent_login: 'codex', agent_name: 'codex' } })).status, 200);
      const w = await open({ phone: true });
      const b = await openReply(w.page, true, codex);
      await w.page.waitForTimeout(500);
      assert.equal(await b.box.inputValue(), '');
      await w.ctx.close();
    });

    await t('picking another agent after @ takes the pre-filled tag\'s place', () => threadOf(async (id) => {
      const v = await open({ phone: true });
      const { card, box } = await openReply(v.page, true, id);
      await card.locator('.tdoc-agent-pill').waitFor();
      await box.tap();
      await v.page.keyboard.press('End');
      await v.page.keyboard.type('@');
      await v.page.locator('#tdoc-mention-menu [role=option]', { hasText: /Codex/ }).first().tap();
      const value = await box.inputValue();
      assert.match(value, /Codex/);
      assert.doesNotMatch(value, /Claude Code/);
      await v.page.keyboard.type('please look');
      await card.locator('.tdoc-reply-submit').last().tap();
      await v.page.waitForTimeout(600);
      assert.equal(v.sends.length, 1, JSON.stringify(v.sends));
      assert.equal(v.sends[0].body.recipient.agent_sub, 'mac-mini_codex');
      await v.ctx.close();
    }));

    // Outside dev mode: every fix above but no suggestion capability.
    const outside = (name, fn) => t(`outside dev mode: ${name}`, async () => {
      await setDevMode(false);
      try { await fn(); } finally { await setDevMode(true); }
    });
    const noTag = async (v, card, box) => {
      await v.page.waitForTimeout(1000); // the agent lists have loaded by now
      assert.equal(await box.inputValue(), '', 'the box started with a tag');
      assert.equal(await card.locator('.tdoc-agent-pill').count(), 0);
    };
    const nameAgent = async (v, box, phone, agentRow = /Claude Code/) => {
      if (phone) await box.tap(); else await box.click();
      await v.page.keyboard.type('@');
      const row = v.page.locator('#tdoc-mention-menu [role=option]', { hasText: agentRow }).first();
      if (phone) await row.tap(); else await row.click();
    };
    for (const phone of [true, false]) await outside(`${phone ? 390 : 1280}: replying to your own agent, the box starts empty; named by hand, a reply takes the plain handoff`, () => threadOf(async (id) => {
      const v = await open({ phone });
      const suggestCalls = [];
      v.page.on('request', (r) => { if (/\/suggest/.test(r.url())) suggestCalls.push(r.url()); });
      const { card, box } = await openReply(v.page, phone, id);
      await noTag(v, card, box);
      await shot(v.page, `nondev-reply-empty-${phone ? 390 : 1280}.png`);
      await nameAgent(v, box, phone);
      await card.locator('.tdoc-agent-pill').waitFor();
      assert.match(await box.inputValue(), /Claude Code/);
      const form = await card.locator('.tdoc-reply-form').innerText();
      assert.match(form, /changes the doc/, 'the box says what this agent may do');
      assert.doesNotMatch(form, /suggests/);
      await v.page.keyboard.type('shorter please');
      await card.locator('.tdoc-reply-submit').last().click();
      await v.page.waitForTimeout(600);
      assert.equal(v.sends.length, 1, JSON.stringify(v.sends));
      assert.equal(v.sends[0].path.endsWith('/hand-off'), true);
      assert.deepEqual(Object.keys(v.sends[0].body).sort(), ['ask_only', 'comment_id', 'recipient']);
      assert.deepEqual(suggestCalls, []);
      assert.equal('reply_as' in JSON.parse(await env.META.get(`handoffs:${SLUG}`))[0], false);
      assert.deepEqual(v.errors, []);
      await v.ctx.close();
    }));

    await outside('no tag for a CLI that would skip review in dev mode either', async () => {
      const codex = await comment();
      assert.equal((await api('/api/notify/handoff', { method: 'POST', cookie, body: { slug: SLUG, comment_ids: [codex], recipient: { provider: 'local', server_id: 'mac-mini', agent_sub: 'mac-mini_codex' } } })).status, 200);
      assert.equal((await api('/api/agent/reply', { method: 'POST', token, body: { slug: SLUG, parent_id: codex, text: 'From codex', status: 'answered', agent_login: 'codex', agent_name: 'codex' } })).status, 200);
      const v = await open({ phone: true });
      const { card, box } = await openReply(v.page, true, codex);
      await noTag(v, card, box);
      await v.ctx.close();
    });

    await outside('a reply that names nobody wakes nobody', () => threadOf(async (id) => {
      const v = await open({ phone: true });
      const { card, box } = await openReply(v.page, true, id);
      await noTag(v, card, box);
      const handoffs = JSON.parse(await env.META.get(`handoffs:${SLUG}`)).length;
      await box.tap();
      await v.page.keyboard.type('thanks');
      await card.locator('.tdoc-reply-submit').last().tap();
      await v.page.waitForTimeout(600);
      assert.equal(v.sends.length, 0, JSON.stringify(v.sends));
      assert.equal(JSON.parse(await env.META.get(`handoffs:${SLUG}`)).length, handoffs);
      await v.ctx.close();
    }));

    await outside('a reader answering their own agent: no tag', async () => {
      const readerSid = 'b'.repeat(32);
      await env.META.put(`session:${readerSid}`, JSON.stringify({ login: 'rita', name: 'rita', email: 'rita@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
      const readerCookie = `tdoc_sid=${readerSid}`;
      const readerToken = (await (await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie: readerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'rita' }) }), env, {})).json()).token;
      assert.equal((await api('/api/notify/local/register', { method: 'POST', token: readerToken, body: { device: 'ritabox', clis: ['claude'] } })).status, 200);
      const id = (await api('/api/comments', { method: 'POST', cookie: readerCookie, body: { slug: SLUG, version: 1, text: 'Why first?', anchor: { kind: 'text', text: 'Billing ships first' } } })).body.id;
      const asked = await api(`/api/docs/${SLUG}/my-agent`, { method: 'POST', cookie: readerCookie, body: { question: 'Why first?', comment_id: id, recipient: { provider: 'local', device: 'ritabox', cli: 'claude' } } });
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      const answered = await api('/api/agent/ask-reply', { method: 'POST', token: readerToken, body: { slug: SLUG, ask_id: asked.body.ask.ask_id, text: 'Invoices.', agent_login: 'claude', agent_name: 'Claude' } });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      const v = await open({ phone: true, sid: readerSid });
      const { card, box } = await openReply(v.page, true, id);
      await noTag(v, card, box);
      await v.ctx.close();
    });

    await outside('the reply box is done when the reply is posted, not when the delivery ends', () => threadOf(async (id) => {
      const v = await open({ phone: true, delayHandoff: 1500 });
      const { card, box } = await openReply(v.page, true, id);
      await nameAgent(v, box, true);
      await card.locator('.tdoc-agent-pill').waitFor();
      await v.page.keyboard.type('shorter please');
      const started = Date.now();
      await card.locator('.tdoc-reply-submit').last().tap();
      await box.waitFor({ state: 'detached', timeout: 5000 });
      const took = Date.now() - started;
      assert.ok(took < 1400, `the box waited ${took}ms on a 1500ms delivery`);
      await v.ctx.close();
    }));

    await outside('no GitHub search while an agent answers what was typed; it still runs when none does', async () => {
      const id = await comment();
      const v = await open({ phone: true });
      const { box } = await openReply(v.page, true, id);
      await box.tap();
      await v.page.keyboard.type('@cla');
      await v.page.locator('#tdoc-mention-menu [role=option]', { hasText: /Claude Code/ }).first().waitFor();
      await v.page.waitForTimeout(700);
      assert.deepEqual(v.github, []);
      await v.page.keyboard.type('rissa');
      await v.page.waitForTimeout(700);
      assert.equal(v.github.length, 1, JSON.stringify(v.github));
      await v.ctx.close();
    });

    // The version compare, for anybody: a doc of its own, two versions.
    const RW = 'rewrites';
    const rwDoc = (small, long, nest, evil) => `<!doctype html><html><body><h1>Plan</h1><p id="small">${small}</p><p id="long">${long}</p><ul><li id="nest">${nest}<ul><li>A child that stays</li></ul></li></ul><p id="evil">${evil}</p></body></html>`;
    const EVIL = '&lt;img src=x onerror="window.__pwned=1"&gt; is what this old paragraph happened to quote at length';
    assert.equal((await api('/api/upload', { method: 'POST', token, body: { slug: RW, version: 1, html: rwDoc(SMALL, LONG, 'The first plan had every launch happening in one single week of spring', EVIL), meta: { title: 'Rewrites' } } })).status, 200);
    assert.equal((await api('/api/upload', { method: 'POST', token, body: { slug: RW, version: 2, html: rwDoc(SMALL.replace('March 14', 'March 21'), `${LONG_NEW.slice(0, 20)}<a href="https://tdoc.dev">${LONG_NEW.slice(20, 40)}</a>${LONG_NEW.slice(40)}`, 'Launches now spread out across autumn so support can keep up', 'Nothing dangerous remains and these words share nothing with the earlier ones'), meta: { title: 'Rewrites' } } })).status, 200);
    const compare = (which, phone) => outside(`${which === browser ? 'chromium' : 'webkit'} ${phone ? 390 : 1280}: the version compare shows a rewrite as blocks, a small edit word by word`, async () => {
      const ctx = await which.newContext(phone ? PHONE : { viewport: { width: 1280, height: 800 } });
      await ctx.addCookies([{ name: 'tdoc_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/d/${RW}?compare=1`);
      const after = page.frameLocator('iframe[aria-label="New version"]');
      await after.locator('#long ins').waitFor({ timeout: 15000 });
      await shot(page, `nondev-compare-${phone ? 390 : 1280}.png`);
      const read = () => {
        const css = (el) => (el ? getComputedStyle(el).display : null);
        const q = (s) => document.querySelector(s);
        return {
          long: { del: q('#long > del.tdoc-diff-del.tdoc-diff-block')?.textContent ?? null, delDisplay: css(q('#long > del')),
            ins: q('#long > ins.tdoc-diff-ins.tdoc-diff-block')?.textContent ?? null, insDisplay: css(q('#long > ins')),
            link: q('#long > ins a')?.getAttribute('href') ?? null, delThenIns: q('#long > del + ins') !== null },
          small: { ins: [...document.querySelectorAll('#small ins')].map((e) => e.textContent), del: [...document.querySelectorAll('#small del')].map((e) => e.textContent), blocks: document.querySelectorAll('#small .tdoc-diff-block').length, display: css(q('#small del, #small ins')) },
          nest: { childRows: document.querySelectorAll('#nest li').length, emptyRows: [...document.querySelectorAll('#nest li, #nest ul')].filter((e) => !e.textContent.trim()).length },
          evil: { imgs: document.querySelectorAll('#evil img').length, pwned: window.__pwned, del: q('#evil del')?.textContent ?? null },
        };
      };
      const a = await after.locator('body').evaluate(new Function(`return (${read})()`));
      assert.equal(a.long.ins.includes('Hiring decides this'), true);
      assert.equal(a.long.insDisplay, 'block');
      assert.equal(a.long.link, 'https://tdoc.dev', 'the version\'s own markup stays');
      assert.equal(a.small.blocks, 0);
      assert.equal(a.small.display, 'inline');
      assert.deepEqual(a.nest, { childRows: 1, emptyRows: 0 });
      assert.equal(a.evil.imgs, 0);
      assert.equal(a.evil.pwned, undefined);
      if (phone) {
        // One pane: the old text then the new, in the same marks.
        assert.equal(a.long.del, LONG);
        assert.equal(a.long.delDisplay, 'block');
        assert.equal(a.long.delThenIns, true);
        assert.match(a.evil.del, /<img src=x onerror=/, 'old text shows as characters');
        assert.deepEqual(a.small, { ...a.small, ins: ['21'], del: ['14'] });
      } else {
        const before = await page.frameLocator('iframe[aria-label="Previous version"]').locator('body').evaluate(new Function(`return (${read})()`));
        assert.equal(before.long.del, LONG);
        assert.equal(before.long.delDisplay, 'block');
        assert.equal(before.long.ins, null);
        assert.equal(before.small.blocks, 0);
        assert.deepEqual(before.small.del, ['14']);
        assert.deepEqual(a.small.ins, ['21']);
        assert.deepEqual(before.nest, { childRows: 1, emptyRows: 0 });
        assert.equal(before.evil.imgs, 0);
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    });
    await compare(browser, true);
    await compare(browser, false);
    if (webkit) await compare(webkit, true);

    for (const phone of [true, false]) await t(`a deep thread is flat at ${phone ? 390 : 1440}: flush with the top comment, in order, its reply box too`, async () => {
      const id = await comment();
      let parent = id;
      const texts = [];
      for (let i = 1; i <= 7; i++) {
        texts.push(`Deep ${i}`);
        const r = await api('/api/comments', { method: 'POST', cookie, body: { slug: SLUG, version: 1, text: `Deep ${i}`, parent_id: parent } });
        assert.equal(r.status, 200);
        parent = r.body.id;
      }
      const v = await open({ phone });
      const card = v.page.locator(`[data-comment-id="${id}"]`).first();
      if (phone) await v.page.locator('.tdoc-fab').tap();
      else await v.page.locator('.tdoc-pin').first().click({ force: true });
      const toggle = card.locator('.tdoc-replies-toggle').first();
      await toggle.waitFor();
      if (phone) await toggle.tap(); else await toggle.click();
      await card.locator('.tdoc-reply').nth(6).waitFor();
      const seen = await card.evaluate((el) => {
        const rows = [...el.querySelectorAll('.tdoc-replies .tdoc-reply')];
        return { n: rows.length, texts: rows.map((r) => r.querySelector('.text').textContent.trim()), lefts: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().left)))], top: Math.round(el.querySelector('.tdoc-replies').getBoundingClientRect().left), rootText: Math.round(el.querySelector(':scope > .text, .text').getBoundingClientRect().left), nested: rows.some((r) => r.querySelector('.tdoc-reply')), border: getComputedStyle(rows[0]).borderLeftStyle, more: el.querySelectorAll('.tdoc-thread-more').length, says: el.querySelectorAll('.tdoc-reply-to').length };
      });
      assert.equal(seen.n, 7);
      assert.deepEqual(seen.texts, texts);
      assert.equal(seen.lefts.length, 1);
      assert.equal(seen.lefts[0], seen.top);
      assert.equal(seen.lefts[0], seen.rootText);
      assert.equal(seen.nested, false);
      assert.equal(seen.border, 'none');
      assert.equal(seen.more, 0);
      assert.equal(seen.says, 0, 'a chain answers the row above it, nothing to say');
      const last = card.locator('.tdoc-reply').nth(6).locator('.tdoc-reply-toggle');
      if (phone) await last.tap(); else await last.click();
      const form = card.locator('.tdoc-reply-form').first();
      await form.waitFor();
      assert.equal(Math.round((await form.boundingBox()).x), seen.lefts[0], 'the reply box lines up');
      await v.ctx.close();
    });

    // What the frame does with an edit, sent as the shell sends it.
    const post = (page, data) => page.evaluate((d) => document.querySelector('iframe').contentWindow.postMessage({ source: 'tdoc-shell', ...d }, '*'), data);
    const ITEMS = [
      { id: 's:small', find: 'on March 14', replace: 'on March 21' },
      { id: 's:long', find: LONG, replace: LONG_NEW },
      { id: 's:split', find: 'Keep this bold part of the sentence as it stands', replace: 'Everything here is different now, a new sentence in place of that one' },
    ];
    const blocks = (which, phone) => t(`${which === browser ? 'chromium' : 'webkit'} ${phone ? 390 : 1280}: a rewrite is one removed block then one added block; a small edit stays word by word; clearing restores it exactly`, async () => {
      const v = await open({ phone }, which);
      const frame = v.page.frames().find((f) => f !== v.page.mainFrame());
      const before = await frame.evaluate(() => document.body.innerHTML);
      const beforeText = await frame.evaluate(() => document.body.textContent);
      await post(v.page, { type: 'tdoc:suggestShow', items: ITEMS });
      await frame.waitForSelector('#long ins');
      await post(v.page, { type: 'tdoc:suggestFocus', id: 's:long', scroll: false });
      await shot(v.page, `blocks-${which === browser ? 'chromium' : 'webkit'}-${phone ? 390 : 1280}.png`);
      const seen = await frame.evaluate(() => {
        const css = (el) => getComputedStyle(el);
        const l = document.querySelector('#long');
        return {
          small: { del: [...document.querySelectorAll('#small del')].map((e) => e.textContent), ins: [...document.querySelectorAll('#small ins')].map((e) => e.textContent), display: css(document.querySelector('#small ins')).display, text: document.querySelector('#small').textContent.includes('Billing ships first') },
          long: { dels: l.querySelectorAll('del').length, inss: l.querySelectorAll('ins').length, del: l.querySelector('del').textContent, ins: l.querySelector('ins').textContent, delDisplay: css(l.querySelector('del')).display, insDisplay: css(l.querySelector('ins')).display, stacked: l.querySelector('del').getBoundingClientRect().bottom <= l.querySelector('ins').getBoundingClientRect().top + 1, delBg: css(l.querySelector('del')).backgroundColor, insBg: css(l.querySelector('ins')).backgroundColor, outline: css(l.querySelector('ins')).outlineStyle },
          split: { dels: document.querySelectorAll('#split del').length, insDisplay: css(document.querySelector('#split ins')).display },
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.deepEqual(seen.small.del, ['14']);
      assert.deepEqual(seen.small.ins, ['21']);
      assert.equal(seen.small.display, 'inline');
      assert.equal(seen.long.dels, 1);
      assert.equal(seen.long.inss, 1);
      assert.equal(seen.long.del, LONG);
      assert.equal(seen.long.ins, LONG_NEW);
      assert.equal(seen.long.delDisplay, 'block');
      assert.equal(seen.long.insDisplay, 'block');
      assert.ok(seen.long.stacked, 'added block under the removed block');
      assert.equal(seen.long.delBg, 'rgba(219, 58, 75, 0.13)');
      assert.equal(seen.long.insBg, 'rgba(37, 168, 91, 0.16)');
      assert.equal(seen.long.outline, 'solid', 'the focused one is outlined');
      assert.equal(seen.split.insDisplay, 'block');
      assert.ok(seen.split.dels >= 2, 'the old words stay in place across the bold');
      assert.ok(seen.overflow <= 0, `page overflows by ${seen.overflow}px`);
      await post(v.page, { type: 'tdoc:suggestClear' });
      await frame.waitForFunction(() => !document.querySelector('del,ins'));
      assert.equal(await frame.evaluate(() => document.body.textContent), beforeText);
      assert.equal(await frame.evaluate(() => { document.body.normalize(); return document.body.innerHTML; }), before);
      // Accept: the new text, as plain text, and no marks left.
      await post(v.page, { type: 'tdoc:suggestShow', items: ITEMS });
      await frame.waitForSelector('#long ins');
      await post(v.page, { type: 'tdoc:suggestSettle', id: 's:long', accepted: true });
      await frame.waitForFunction(() => !document.querySelector('#long del,#long ins'));
      assert.equal(await frame.evaluate(() => document.querySelector('#long').textContent), LONG_NEW);
      await post(v.page, { type: 'tdoc:suggestSettle', id: 's:split', accepted: true });
      await frame.waitForFunction(() => !document.querySelector('#split del,#split ins'));
      assert.match(await frame.evaluate(() => document.querySelector('#split').textContent), /^Everything here is different now, a new sentence in place of that one/);
      await v.ctx.close();
    });
    await blocks(browser, false);
    await blocks(browser, true);
    if (webkit) await blocks(webkit, true);

    await t('edits are text: markup in a rewrite or a word change shows as characters and never runs', async () => {
      const v = await open({ phone: true });
      const frame = v.page.frames().find((f) => f !== v.page.mainFrame());
      const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script> and a good many other words that share nothing at all with the old text';
      await post(v.page, { type: 'tdoc:suggestShow', items: [{ id: 's:evil', find: LONG, replace: evil }, { id: 's:word', find: 'March 14', replace: 'March <b onmouseover="window.__pwned=1">14</b>' }] });
      await frame.waitForSelector('#long ins');
      await frame.waitForTimeout(200);
      const out = await frame.evaluate(() => ({ pwned: window.__pwned, kids: document.querySelector('#long ins').children.length, text: document.querySelector('#long ins').textContent, wordKids: [...document.querySelectorAll('#small ins')].map((e) => e.children.length), img: document.querySelectorAll('img').length }));
      assert.equal(out.pwned, undefined);
      assert.equal(out.kids, 0);
      assert.equal(out.text, evil);
      assert.ok(out.wordKids.every((n) => n === 0));
      assert.equal(out.img, 0);
      await v.ctx.close();
    });
  } finally {
    await browser.close();
    if (webkit) await webkit.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
