const assert = require('assert/strict');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const engines = requirePlaywrightOrSkip('optional-agent-onboarding-ui.test.js');

(async () => {
  const target = await resolveTarget({ e2eUser: 'alice' });
  const base = new URL(target.url).origin;
  try {
    const html = await (await fetch(`${base}/me`)).text();
    for (const name of ['chromium', 'webkit']) {
      const browser = await engines[name].launch();
      try {
        for (const width of [1280, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          let connected = false, skipped = false, failSkip = false;
          let revised = true, shared = false, firstDoc = 'sample-doc';
          const record = () => ({ started: true, agent_connected: true, first_doc: firstDoc, commented: true, revised, shared, notify_setup_skipped: skipped });
          const mutations = [], errors = [];
          page.on('pageerror', e => errors.push(e.message));
          await page.route(`${base}/me`, route => route.fulfill({ contentType: 'text/html', body:
            html.replace(/(window\.__TDOC_APP_BOOT__ = )(.*?)(;<\/script>)/, (_, a, json, z) => a + JSON.stringify({
              ...JSON.parse(json), onboarding: record(),
            }) + z),
          }));
          await page.route('**/api/onboarding', route => route.fulfill({ json: { record: record() } }));
          await page.route('**/api/onboarding?notify=1', route => route.fulfill({ json: { record: {}, notify_connected: connected } }));
          await page.route('**/api/onboarding/event', async route => {
            const body = route.request().postDataJSON(); mutations.push(body.action);
            if (failSkip) return route.fulfill({ status: 500, json: { error: 'Could not save' } });
            if (body.action === 'notify_setup_skipped') skipped = true;
            if (body.action === 'share_link_copied') shared = true;
            return route.fulfill({ json: { ok: true, record: { notify_setup_skipped: 'now' } } });
          });
          await page.goto(`${base}/me`);
          assert.equal(await page.getByRole('region', { name: 'Connect your Raft agent (optional)' }).count(), 0, 'not on My docs');
          await page.goto(target.url);
          const card = page.getByRole('region', { name: 'Connect your Raft agent (optional)' });
          await card.waitFor();
          await card.getByText('Final step · Optional').waitFor();
          assert.equal(await page.getByRole('dialog').count(), 0, 'final tutorial step is inline');
          await card.getByRole('button', { name: 'Connect agent', exact: true }).click();
          await card.getByRole('button', { name: 'Copy prompt' }).click();
          assert.equal(await card.getByText('Raft agent connected', { exact: true }).count(), 0, 'copy is not connection');
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no mobile horizontal overflow');
          const stepBox = await card.boundingBox();
          const frameBox = await page.locator('iframe[aria-label="Document content"]').boundingBox();
          assert(frameBox.y >= stepBox.y + stepBox.height - 1, 'expanded final step stays above the document');
          connected = true;
          await card.getByRole('heading', { name: 'Raft agent connected' }).waitFor();
          assert.deepEqual(mutations, [], 'connection does not send comments or forge completion');
          await card.getByRole('button', { name: 'Finish tutorial' }).click();
          await card.waitFor({ state: 'hidden' });
          assert.equal(page.url(), target.url, 'finishing stays on the tutorial document');
          await page.reload();
          await card.waitFor({ state: 'hidden' });
          connected = false;
          await page.reload();
          await card.waitFor();
          failSkip = true;
          await card.getByRole('button', { name: 'Skip for now' }).click();
          await card.getByRole('alert').waitFor();
          assert(await card.isVisible(), 'failed skip stays recoverable');
          failSkip = false;
          await card.getByRole('button', { name: 'Skip for now' }).click();
          await card.waitFor({ state: 'hidden' });
          await page.reload();
          await card.waitFor({ state: 'hidden' });
          assert(mutations.every(a => a === 'notify_setup_skipped'));
          skipped = false;
          revised = false;
          await page.reload();
          await page.locator('iframe[aria-label="Document content"]').waitFor();
          assert.equal(await card.count(), 0, 'not before the agent revises the tutorial');
          revised = true;
          firstDoc = 'another-doc';
          await page.reload();
          await page.locator('iframe[aria-label="Document content"]').waitFor();
          assert.equal(await card.count(), 0, 'not on unrelated docs');
          firstDoc = 'sample-doc';
          await page.goto(target.olderUrl);
          await page.locator('iframe[aria-label="Document content"]').waitFor();
          assert.equal(await card.count(), 0, 'not on an older tutorial version');
          shared = true;
          await page.goto(target.url);
          await card.waitFor();
          assert(await card.isVisible(), 'sharing cannot skip the final step');
          assert.deepEqual(errors, []);
          await page.close();
          console.log(`PASS ${name} ${width}px: optional connection, real completion, skip persistence and recovery`);
        }
      } finally { await browser.close(); }
    }
  } finally { await target.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
