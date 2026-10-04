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
        for (const width of [1280, 390, 320]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          let connected = false, skipped = false, failSkip = false;
          let revised = true, manualSteps = {}, failCheck = false;
          const record = () => ({ started: true, agent_connected: true, first_doc: 'sample-doc', commented: true, revised, notify_connected: connected, notify_setup_skipped: skipped, manual_steps: manualSteps });
          const mutations = [], errors = [];
          page.on('pageerror', e => errors.push(e.message));
          await page.route(`${base}/me`, route => route.fulfill({ contentType: 'text/html', body:
            html.replace(/(window\.__TDOC_APP_BOOT__ = )(.*?)(;<\/script>)/, (_, a, json, z) => a + JSON.stringify({
              ...JSON.parse(json), onboarding: record(),
            }) + z),
          }));
          await page.route('**/api/onboarding', route => route.fulfill({ json: { record: record() } }));
          await page.route('**/api/onboarding?notify=1', route => route.fulfill({ json: { record: {}, notify_connected: connected } }));
          await page.route('**/api/onboarding/step', async route => {
            if (failCheck) return route.fulfill({ status: 500, json: { error: 'failed' } });
            const body = route.request().postDataJSON();
            manualSteps[body.step] = body.done;
            return route.fulfill({ json: { ok: true } });
          });
          await page.route('**/api/onboarding/event', async route => {
            const body = route.request().postDataJSON(); mutations.push(body.action);
            if (failSkip) return route.fulfill({ status: 500, json: { error: 'Could not save' } });
            if (body.action === 'notify_setup_skipped') skipped = true;
            return route.fulfill({ json: { ok: true, record: { notify_setup_skipped: 'now' } } });
          });
          await page.goto(`${base}/me`);
          const checklist = page.getByRole('region', { name: 'Finish setting up' });
          const row = checklist.getByRole('listitem', { name: 'Step 5: Connect Raft (optional)' });
          const toggle = row.getByRole('button', { name: 'Step 5: Connect Raft (optional)' });
          await toggle.waitFor();
          assert.equal(await checklist.locator('li').count(), 5, 'fifth step lives in the original list');
          assert.equal(await checklist.locator('li').nth(4).getAttribute('aria-label'), 'Step 5: Connect Raft (optional)');
          assert.equal(await checklist.locator('li.done').count(), 4, 'all four required steps complete before Raft');
          await row.getByText('Optional', { exact: true }).waitFor();
          assert.equal(await page.getByRole('dialog').count(), 0, 'no modal');
          const style = el => { const s = getComputedStyle(el); return [s.gridTemplateColumns, s.gap, s.padding]; };
          assert.deepEqual(await toggle.evaluate(style), await checklist.locator('li a').first().evaluate(style), 'same row grid and spacing');
          const checks = checklist.getByRole('checkbox');
          assert.equal(await checks.count(), 5);
          // Native keyboard operation, independent of the row link.
          await checks.first().focus();
          await checks.first().press('Space');
          await page.waitForFunction(() => !document.querySelector('.onb-tick').checked);
          assert.equal(page.url(), `${base}/me`, 'checkbox does not navigate');
          await page.reload();
          assert.equal(await checks.first().isChecked(), false, 'manual undo survives reload over automatic completion');
          for (let i = 0; i < 5; i++) {
            await checks.nth(i).setChecked(true);
            await page.waitForFunction(() => !document.querySelector('.onb-tick').disabled);
          }
          assert.equal(await checklist.locator('li.done').count(), 5, 'all five checks strike through');
          await page.reload();
          assert.equal(await checklist.locator('li.done').count(), 5, 'completed list remains available to undo');
          failCheck = true;
          await checks.last().click();
          await checklist.getByRole('alert').waitFor();
          assert.equal(await checks.last().isChecked(), true, 'failed save keeps prior value');
          failCheck = false;
          await checks.last().uncheck();
          await page.waitForFunction(() => !document.querySelectorAll('.onb-tick')[4].checked);
          assert(!connected && !skipped && !mutations.length, 'manual checks do not forge connection or skip');
          manualSteps = {};
          await page.reload();
          await toggle.click();
          await row.getByRole('button', { name: 'Copy prompt' }).click();
          assert.equal(await row.getByText('Raft connected.', { exact: false }).count(), 0, 'copy is not connection');
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no mobile horizontal overflow');
          connected = true;
          await row.getByText('Raft connected.', { exact: false }).waitFor();
          assert.deepEqual(mutations, [], 'connection does not send comments or forge completion');
          await row.getByRole('button', { name: 'Finish tutorial' }).click();
          await checklist.waitFor({ state: 'hidden' });
          assert.equal(page.url(), `${base}/me`, 'finishing stays on My docs');
          await page.reload();
          await checklist.waitFor({ state: 'hidden' });
          connected = false;
          await page.reload();
          await toggle.waitFor();
          failSkip = true;
          await row.getByRole('button', { name: 'Skip for now' }).click();
          await row.getByRole('alert').waitFor();
          assert(await row.isVisible(), 'failed skip stays recoverable');
          failSkip = false;
          await row.getByRole('button', { name: 'Skip for now' }).click();
          await checklist.waitFor({ state: 'hidden' });
          await page.reload();
          await checklist.waitFor({ state: 'hidden' });
          assert(mutations.every(a => a === 'notify_setup_skipped'));
          skipped = false;
          revised = false;
          await page.reload();
          await row.waitFor();
          assert.equal(await toggle.count(), 0, 'fifth step visible but locked until revision');
          assert.equal(await checklist.locator('li').count(), 5);
          await page.goto(target.url);
          assert.equal(await page.getByRole('button', { name: 'Step 5: Connect Raft (optional)' }).count(), 0, 'no standalone document step');
          assert.deepEqual(errors, []);
          await page.close();
          console.log(`PASS ${name} ${width}px: My docs fifth row, real completion, skip persistence and recovery`);
        }
      } finally { await browser.close(); }
    }
  } finally { await target.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
