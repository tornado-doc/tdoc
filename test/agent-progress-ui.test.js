// The agent progress pill on a comment card (flag agentProgress), desktop
// and phone: while the agent works, the pill names the current step in plain
// words with the agent's name ("Claude updated the doc"), from the comments
// the page already polls. Tapping it opens the step list under it inside the
// comment (a check per finished step; a spinner on the current one while the
// agent is still working, with its own note as a muted line under it);
// collapsed by default. Its tooltip holds the whole line, the agent's own
// status included; no version number anywhere (Julie, 2026-11-14). With the
// flag off the chip still says "On it". Screenshots: TDOC_PROGRESS_SHOTS=<dir>.
// Run with: node test/agent-progress-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { resolveTarget } = require('./helpers/fixture-server');

// Fixed per page: real handoff facts keep their clocks across polls, and the
// chip's minutes only move on its own 30 s tick.
const clock = (base = Date.now()) => (min) => new Date(base - min * 60000).toISOString();

async function open(browser, target, { flag, width, withStatus = false, working = false }) {
  const phone = width < 600;
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: phone, isMobile: phone && browser.browserType().name() !== 'firefox' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((on) => { window.__TDOC_FLAGS__ = { agentProgress: on }; window.__TDOC_COMMENT_POLL_MS = 2000; }, flag);
  const url = new URL('/d/reply-activity/v/3?comment=delivery', target.url).href;
  await page.route('**/api/notify/targets*', (route) => route.fulfill({ json: { default: null, candidates: [] } }));
  let reads = 0;
  const ago = clock();
  await page.route('**/api/comments*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const comments = await response.json();
    reads++;
    for (const c of comments) {
      if (c.id !== 'delivery') continue;
      // Picked up and working: open, no agent reply yet.
      Object.assign(c, {
        status: 'open', applied_in: null, replies: [],
        thread_activity: { ...(c.thread_activity || {}), agent_at: null },
        handoff_status: 'sent', handoff_at: ago(7),
        handoff_delivery: { status: 'delivered', at: ago(7), first_at: ago(7) },
        handoff_acked_at: ago(6),
        handoff_suggested_edits: 3, handoff_suggested_at: ago(4),
        // `working`: still at it (latest step: 3 edits), no version yet.
        handoff_last_version: working ? null : 3, handoff_last_version_at: working ? null : ago(3),
        handoff_first_version_at: working ? null : ago(3),
        // The second poll brings the agent's own status (newest fact).
        handoff_progress: withStatus && reads > 1 ? { text: 'Editing the Pack section', at: ago(1) } : null,
        handoff_to: { provider: 'local', device: 'mbp', cli: 'claude', agent_name: 'Claude' },
      });
    }
    await route.fulfill({ json: comments });
  });
  await page.goto(url);
  return { page, errors, reads: () => reads };
}

(async () => {
  const target = await resolveTarget({ e2eUser: 'preview-reviewer' });
  let browser;
  try {
    browser = await (process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium).launch();
    const shots = process.env.TDOC_PROGRESS_SHOTS;
    for (const width of [1440, 390]) {
      const { page, errors, reads } = await open(browser, target, { flag: true, width, withStatus: true });
      if (width === 390 && !(await page.locator('.tdoc-handoff-chip:visible').count())) {
        await page.locator('.tdoc-fab').click().catch(() => {});
      }
      const chip = page.locator('.tdoc-handoff-chip[data-handoff-progress]:visible').first();
      await chip.waitFor({ timeout: 20000 });
      const title = await chip.getAttribute('title');
      assert.match(title, /^Sent to Claude · Claude is reading · Claude suggested 3 edits · Claude updated the doc · (Editing the Pack section · )?6 min$/, title);
      assert(!/handoff/i.test(await chip.innerText()), 'the word handoff is on the card');
      assert.equal(await chip.getAttribute('data-handoff-state'), 'received');
      // The pill names the current step in plain words, the same pill as any
      // other status (Julie, 2026-11-14).
      assert.equal((await chip.textContent()).trim(), 'Claude updated the doc');
      // The next poll brings the agent's own status: into the tooltip, never the pill.
      await page.waitForFunction(() => /Editing the Pack section/.test(document.querySelector('.tdoc-handoff-chip[data-handoff-progress]')?.getAttribute('title') || ''), null, { timeout: 40000 });
      assert(reads() >= 2, 'the status came with the existing comment poll');
      assert.equal(await chip.getAttribute('title'), 'Sent to Claude · Claude is reading · Claude suggested 3 edits · Claude updated the doc · Editing the Pack section · 6 min');
      assert.equal((await chip.textContent()).trim(), 'Claude updated the doc');
      // Collapsed by default: the comment shows no steps and no version.
      assert.equal(await chip.getAttribute('role'), 'button');
      assert.equal(await chip.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.tdoc-handoff-steps').count(), 0, 'the steps are open before the pill was tapped');
      assert.equal(await page.locator('.tdoc-handoff-progress-detail').count(), 0, 'the old detail line is back');
      const card = chip.locator('xpath=ancestor::article[1]');
      const cardText = async () => card.innerText();
      assert(!/is reading|Editing the Pack section|Published|\bv3\b/.test(await cardText()), `progress text in the closed card: ${await cardText()}`);
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `progress-collapsed-${width}.png`) });
      }
      // Tap (phone) or click (desktop): the steps open under the pill.
      if (width < 600) await chip.tap(); else await chip.click();
      const steps = page.locator('.tdoc-handoff-steps:visible').first();
      await steps.waitFor({ timeout: 5000 });
      assert.equal(await chip.getAttribute('aria-expanded'), 'true');
      assert.equal(await chip.getAttribute('aria-controls'), await steps.getAttribute('id'));
      const lines = (await steps.locator('.tdoc-handoff-step-line').allTextContents()).map((t) => t.trim());
      assert.deepEqual(lines, ['Sent to Claude', 'Claude is reading', 'Claude suggested 3 edits', 'Claude updated the doc']);
      // "Claude updated the doc" ends the turn: every step is checked, no
      // spinner, and so no note under a current step.
      assert.equal(await steps.locator('.tdoc-handoff-step-mark.is-done').count(), 4);
      assert.equal(await steps.locator('.tdoc-handoff-step-mark.is-current').count(), 0);
      assert.equal(await steps.locator('.tdoc-handoff-step-note').count(), 0);
      assert(!/Editing the Pack section|Published|\bv3\b|version/i.test(await steps.innerText()), 'the note or a version is in the steps');
      // The list sits inside the comment, under the pill, and the card stayed put.
      const box = await steps.evaluate((el) => {
        const c = el.closest('article').getBoundingClientRect();
        const p = document.querySelector('.tdoc-handoff-chip[data-handoff-progress]').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { inside: r.left >= c.left && r.right <= c.right + 1 && r.top >= p.bottom - 1, h: r.height };
      });
      assert(box.inside && box.h > 0, `the steps are not under the pill inside the comment: ${JSON.stringify(box)}`);
      if (shots) {
        await page.waitForTimeout(300); // the caret's turn
        await page.screenshot({ path: path.join(shots, `progress-expanded-${width}.png`) });
        await card.screenshot({ path: path.join(shots, `progress-expanded-card-${width}.png`) });
      }
      // Again: collapsed. On desktop the keyboard opens it too.
      if (width < 600) await chip.tap(); else await chip.click();
      await page.waitForFunction(() => !document.querySelector('.tdoc-handoff-steps'), null, { timeout: 5000 });
      assert.equal(await chip.getAttribute('aria-expanded'), 'false');
      if (width >= 600) {
        await chip.focus();
        await page.keyboard.press('Enter');
        await steps.waitFor({ timeout: 5000 });
        await page.keyboard.press(' ');
        await page.waitForFunction(() => !document.querySelector('.tdoc-handoff-steps'), null, { timeout: 5000 });
      }
      const pill = await chip.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const plain = document.createElement('span');
        plain.className = 'tdoc-handoff-chip';
        plain.textContent = 'On it';
        el.parentElement.appendChild(plain);
        const h = plain.getBoundingClientRect().height;
        plain.remove();
        return { h: r.height, plainH: h, w: r.width, clipped: el.scrollWidth > el.clientWidth + 1, ws: cs.whiteSpace };
      });
      assert(Math.abs(pill.h - pill.plainH) <= 1, `the progress pill is ${pill.h}px tall, a plain pill ${pill.plainH}px, at ${width}`);
      assert(pill.w <= 16 * 16 + 1 && !pill.clipped, `the progress pill is ${pill.w}px wide or cut off at ${width}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
    // Still working (latest step: 3 edits): a spinner on the current step and
    // the agent's own note as a muted line under it; never in the pill.
    for (const width of [1440, 390]) {
      const { page, errors } = await open(browser, target, { flag: true, width, withStatus: true, working: true });
      if (width === 390 && !(await page.locator('.tdoc-handoff-chip:visible').count())) {
        await page.locator('.tdoc-fab').click().catch(() => {});
      }
      const chip = page.locator('.tdoc-handoff-chip[data-handoff-progress]:visible').first();
      await chip.waitFor({ timeout: 20000 });
      await page.waitForFunction(() => /Editing the Pack section/.test(document.querySelector('.tdoc-handoff-chip[data-handoff-progress]')?.getAttribute('title') || ''), null, { timeout: 40000 });
      assert.equal((await chip.textContent()).trim(), 'Claude suggested 3 edits');
      if (width < 600) await chip.tap(); else await chip.click();
      const steps = page.locator('.tdoc-handoff-steps:visible').first();
      await steps.waitFor({ timeout: 5000 });
      const lines = (await steps.locator('.tdoc-handoff-step-line').allTextContents()).map((t) => t.trim());
      assert.deepEqual(lines, ['Sent to Claude', 'Claude is reading', 'Claude suggested 3 edits']);
      assert.equal(await steps.locator('.tdoc-handoff-step-mark.is-done').count(), 2);
      const current = steps.locator('.tdoc-handoff-step[aria-current="step"]');
      assert.equal(await current.count(), 1);
      assert.equal(await current.getAttribute('data-step'), 'suggested');
      assert.equal(await current.locator('.tdoc-handoff-step-mark.is-current').count(), 1);
      assert.equal(await steps.locator('.tdoc-handoff-step-note').count(), 1);
      assert.equal((await current.locator('.tdoc-handoff-step-note').textContent()).trim(), 'Editing the Pack section');
      assert(!/Editing/.test(await chip.textContent()), 'the note is in the pill');
      if (shots) {
        await page.waitForTimeout(300); // the caret's turn
        await page.screenshot({ path: path.join(shots, `progress-working-expanded-${width}.png`) });
        await chip.locator('xpath=ancestor::article[1]').screenshot({ path: path.join(shots, `progress-working-expanded-card-${width}.png`) });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    // Flag off: the chip is the plain "On it" it was.
    const { page, errors } = await open(browser, target, { flag: false, width: 1440 });
    const plain = page.locator('.tdoc-handoff-chip:visible').first();
    await plain.waitFor({ timeout: 20000 });
    assert.equal((await plain.innerText()).trim(), 'On it');
    assert.equal(await page.locator('.tdoc-handoff-chip[data-handoff-progress]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS progress pill: plain step with the agent name, tap/click/keyboard opens the step list inside the comment, collapsed by default, finished turn all checked, spinner + note only while working, whole line in the tooltip, no version number, desktop + phone; flag off keeps On it');
  } finally { await browser?.close(); target.stop(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
