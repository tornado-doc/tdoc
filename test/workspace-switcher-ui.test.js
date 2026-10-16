// Top-bar workspace switcher: shows the current space, lists My docs and
// every team with the current one checked, and New team; the only switcher
// (the old pill row is gone), on a phone too.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('workspace-switcher-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function withBoot(html, update) {
  return html.replace(/(window\.__TDOC_APP_BOOT__ = )(.*?)(;<\/script>)/, (_, b, j, a) => b + JSON.stringify(update(JSON.parse(j))) + a);
}
const TEAMS = [{ id: 'tm_befreed', name: 'BeFreed', role: 'admin', member_count: 4 }, { id: 'tm_lab', name: 'Smrti Lab', role: 'member', member_count: 2 }];

(async () => {
  console.log('Workspace switcher UI');
  const target = await resolveTarget({ e2eUser: 'alice' });
  const base = new URL(target.url).origin;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
  try {
    const shell = await (await fetch(`${base}/me`)).text();
    const open = async (width, query) => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.route(`${base}/me*`, (r) => r.fulfill({ contentType: 'text/html', body: withBoot(shell, (boot) => ({ ...boot, teams: TEAMS, team_docs: [], team_folders: {} })) }));
      await page.goto(`${base}/me${query}`);
      return page;
    };
    await t('desktop: shows the current team and switches from the menu', async () => {
      const page = await open(1280, '?team=tm_befreed');
      const trigger = page.locator('.tdoc-space-trigger');
      await trigger.waitFor();
      assert.equal((await trigger.locator('.name').textContent()).trim(), 'BeFreed');
      await trigger.click();
      const items = page.locator('.ui-menu-popup .tdoc-space-item-name');
      await items.first().waitFor();
      assert.deepEqual((await items.allTextContents()).map((s) => s.trim()), ['My docs', 'BeFreed', 'Smrti Lab', 'New team']);
      assert.equal(await page.locator('.ui-menu-popup .tdoc-space-check').count(), 1);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'switcher-desktop.png') }); }
      await page.getByRole('menuitem', { name: 'Smrti Lab' }).click();
      await page.getByRole('heading', { name: 'Smrti Lab' }).waitFor();
      await page.close();
    });
    await t('My docs is the current space without ?team; New team opens the dialog', async () => {
      const page = await open(1280, '');
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'New team' }).click();
      await page.getByRole('dialog', { name: 'New team' }).waitFor();
      await page.close();
    });
    await t('phone: the switcher is there and the old pill row is gone', async () => {
      const page = await open(390, '?team=tm_befreed');
      const trigger = page.locator('.tdoc-space-trigger');
      await trigger.waitFor();
      assert.equal(await trigger.isVisible(), true);
      assert.equal(await page.locator('.tm-spaces').count(), 0, 'the pill row is back');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'switcher-phone.png') });
      await page.close();
    });
    await t('on My docs, switching happens in place', async () => {
      const page = await open(1280, '');
      await page.locator('.tdoc-space-trigger').click();
      await page.getByRole('menuitem', { name: 'BeFreed' }).click();
      await page.getByRole('heading', { name: 'BeFreed' }).waitFor();
      assert.match(page.url(), /team=tm_befreed/);
      await page.close();
    });
  } finally { await browser.close(); await target.stop(); }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
