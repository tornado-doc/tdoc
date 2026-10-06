const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { resolveTarget } = require('./helpers/fixture-server');
const [fixture] = require('./fixtures/tdocs/reply-activity/comments.json');

(async () => {
  const target = await resolveTarget({ e2eUser: 'preview-reviewer' });
  let browser;
  try {
    browser = await (process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium).launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = new URL('/d/reply-activity/v/2', target.url).href;
    // Exercise the published owner's existing poll, without a real account or send.
    await page.route('**/d/reply-activity/v/2', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/window\.__TDOC_SHELL__ = (.*?);<\/script>/,
        (_, json) => `window.__TDOC_SHELL__ = ${JSON.stringify({ ...JSON.parse(json), mode: 'published' })};</script>`);
      await route.fulfill({ response, body });
    });
    await page.route('**/api/notify/targets*', route => route.fulfill({ json: { default: null, candidates: [] } }));
    let replied = false, reads = 0;
    await page.route('**/api/comments*', async route => {
      assert.equal(route.request().method(), 'GET', 'the reader cannot write a status');
      const response = await route.fetch();
      const comments = await response.json();
      reads++;
      // The first response models v2 before the agent replied; subsequent
      // responses are the real local API's v2 snapshot with live v3 activity.
      if (!replied) comments.forEach(c => { c.thread_activity.agent_at = null; });
      await route.fulfill({ json: comments });
    });
    await page.goto(url);
    const pin = page.locator('.tdoc-pin[data-id="delivery"]');
    await page.locator('.tdoc-pin.is-waiting-handoff[data-id="delivery"]').waitFor();
    await page.getByText('Waiting on agent · 1 comment', { exact: false }).waitFor();
    replied = true;
    await page.getByText('Replied · 1 comment', { exact: true }).waitFor({ timeout: 20000 });
    assert(reads >= 2, 'the existing polling received the reply without a reload');
    assert(!/is-waiting-handoff/.test(await pin.getAttribute('class')), 'reply removes the pulsing class');
    assert.equal(await pin.evaluate(el => getComputedStyle(el, '::after').animationName), 'none');
    assert.equal(page.url(), url, 'v3 publishing must not navigate the v2 reader');
    const frame = page.frameLocator('iframe[aria-label="Document content"]');
    assert.equal(await frame.locator('[data-tdoc-aid="delivery"]').innerText(), 'Delivery is planned for Friday.');
    await pin.click();
    await page.locator('.tdoc-handoff-chip.is-replied').getByText('Agent replied', { exact: true }).waitFor();
    assert.equal(await page.getByText(fixture.replies[0].text, { exact: true }).count(), 0, 'v3 reply text is not inserted into v2');
    const shots = process.env.TDOC_REPLY_SHOTS;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      if (width === 390) await page.locator('.tdoc-fab').click();
      await page.locator('.tdoc-handoff-chip.is-replied:visible').waitFor();
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `replied-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload();
    await page.getByText('Replied · 1 comment', { exact: true }).waitFor();
    assert(!/is-waiting-handoff/.test(await pin.getAttribute('class')), 'reload cannot revive waiting');
    await page.goto(new URL('/d/reply-activity/v/3?comment=delivery', target.url).href);
    await page.getByRole('button', { name: '1 reply', exact: true }).click();
    await page.getByText(fixture.replies[0].text, { exact: true }).waitFor();
    assert.equal(await page.frameLocator('iframe[aria-label="Document content"]').locator('[data-tdoc-aid="delivery"]').innerText(), 'Delivery is planned for Monday.');
    assert.deepEqual(errors, []);
    console.log('PASS v2 stops pulsing after v3 reply without navigation; desktop, phone, reload and v3 reply remain correct');
  } finally { await browser?.close(); target.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
