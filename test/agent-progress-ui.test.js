// The agent progress pill on a comment card (flag agentProgress), desktop
// and phone: while the agent works, the pill names only the current stage
// ("New version") and its tooltip holds the timeline "Delivered · Reading the
// doc · Suggested 3 edits · New version · Working · N min", from the comments
// the page already polls; the agent's own status takes the current step of
// the tooltip while it is the newest fact. No detail line in the opened
// thread, no version number anywhere (Julie, 2026-11-14). With the flag off
// the chip still says "On it". Screenshots: TDOC_PROGRESS_SHOTS=<dir>.
// Run with: node test/agent-progress-ui.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { resolveTarget } = require('./helpers/fixture-server');

// Fixed per page: real handoff facts keep their clocks across polls, and the
// chip's minutes only move on its own 30 s tick.
const clock = (base = Date.now()) => (min) => new Date(base - min * 60000).toISOString();

async function open(browser, target, { flag, width, withStatus = false }) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
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
        handoff_last_version: 3, handoff_last_version_at: ago(3),
        handoff_first_version_at: ago(3),
        // The second poll brings the agent's own status (newest fact).
        handoff_progress: withStatus && reads > 1 ? { text: 'Editing the Pack section', at: ago(1) } : null,
        handoff_to: { provider: 'local', device: 'mbp', cli: 'claude', agent_name: 'claude on mbp' },
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
      assert.match(title, /^Delivered · Reading the doc · Suggested 3 edits · New version · (Working|Editing the Pack section) · 6 min$/, title);
      assert(!/handoff/i.test(await chip.innerText()), 'the word handoff is on the card');
      assert.equal(await chip.getAttribute('data-handoff-state'), 'received');
      // The pill is one short stage, the same pill as any other status, and
      // the only progress UI (Julie, 2026-11-14); the whole timeline, the
      // agent's own words included, is its tooltip.
      assert.equal((await chip.innerText()).trim(), 'New version');
      // The next poll brings the agent's own status: into the tooltip, never the pill.
      await page.waitForFunction(() => /Editing the Pack section/.test(document.querySelector('.tdoc-handoff-chip[data-handoff-progress]')?.getAttribute('title') || ''), null, { timeout: 40000 });
      assert(reads() >= 2, 'the status came with the existing comment poll');
      assert.equal(await chip.getAttribute('title'), 'Delivered · Reading the doc · Suggested 3 edits · New version · Editing the Pack section · 6 min');
      assert.equal((await chip.innerText()).trim(), 'New version');
      // The opened thread carries no grey detail line, and the card shows no
      // timeline text or version number outside the tooltip.
      assert.equal(await page.locator('.tdoc-handoff-progress-detail').count(), 0, 'the detail line is back');
      const cardText = await chip.evaluate((el) => (el.closest('.tdoc-cc, article, [class*="comment-card"]') || document.body).innerText);
      assert(!/Reading the doc|Editing the Pack section|Published v\d|\bv3\b/.test(cardText), `progress text in the card: ${cardText}`);
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
      assert(pill.w <= 12 * 16 + 1 && !pill.clipped, `the progress pill is ${pill.w}px wide or cut off at ${width}`);
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `progress-${width}.png`) });
        await chip.screenshot({ path: path.join(shots, `progress-chip-${width}.png`) });
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
    console.log('PASS progress pill: one short stage, timeline only in the tooltip, no detail line, no version number, agent status via the poll, desktop + phone; flag off keeps On it');
  } finally { await browser?.close(); target.stop(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
