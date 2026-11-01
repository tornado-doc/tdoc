// Exercise the real shared shell on each page type. Hosted profile metadata is
// supplied at the API/boot boundary; profile.test.js covers its session lookup.
const assert = require('assert/strict');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('account-profile-menu-ui.test.js');

function withBoot(html, update) {
  return html.replace(/(window\.__TDOC_APP_BOOT__ = )(.*?)(;<\/script>)/, (_, before, json, after) => (
    before + JSON.stringify(update(JSON.parse(json))) + after
  ));
}

(async () => {
  const target = await resolveTarget({ e2eUser: 'alice' });
  const base = new URL(target.url).origin;
  const browser = await chromium.launch({ headless: true });
  try {
    const shell = await (await fetch(`${base}/me`)).text();
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let profile = { handle: 'alice-public', suggested: 'alice-public' };
      let profileRequests = 0;
      await page.route('**/api/me/profile', route => {
        profileRequests++;
        return route.fulfill({ json: { ok: true, profile } });
      });
      await page.route(`${base}/me`, route => route.fulfill({
        contentType: 'text/html',
        body: withBoot(shell, boot => ({ ...boot, profile })),
      }));
      await page.route(`${base}/@bob`, route => route.fulfill({
        contentType: 'text/html',
        body: withBoot(shell, boot => ({
          page: 'profile', identity: boot.identity, handle: 'bob',
          login: 'bob', mine: false, docs: [], github_login: null,
        })),
      }));
      await page.route(`${base}/@alice-public`, route => route.fulfill({
        contentType: 'text/html', body: '<h1>Alice public profile</h1>',
      }));
      const openMenu = async () => {
        if (width > 700) await page.locator('.tdoc-account-trigger').click();
        else {
          await page.locator('#tdoc-more-btn').click();
          await page.getByRole('menuitem', { name: 'My account' }).click();
        }
      };
      for (const url of [target.url, `${base}/me`, `${base}/@bob`]) {
        const before = profileRequests;
        await page.goto(url);
        await openMenu();
        const item = page.getByRole('menuitem', { name: 'Public profile (@alice-public)', exact: true });
        await item.waitFor();
        assert.equal(await item.count(), 1, 'one profile entry per account menu');
        assert.equal(await page.getByRole('menuitem', { name: 'Public profile (@bob)', exact: true }).count(), 0,
          'viewing Bob never replaces the account-menu destination');
        await item.click();
        await page.waitForURL(`${base}/@alice-public`);
        await page.getByRole('heading', { name: 'Alice public profile' }).waitFor();
        assert.equal(profileRequests - before, url === `${base}/me` ? 0 : 1,
          'use supplied profile on My docs and resolve viewer in shared chrome elsewhere');
      }
      profile = { handle: null, suggested: 'alice' };
      await page.goto(target.url);
      await openMenu();
      await page.getByRole('menuitem', { name: 'Claim public profile', exact: true }).click();
      await page.getByRole('dialog', { name: 'Claim your public URL' }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/me', 'claim uses the existing My docs dialog');
      assert.equal(new URL(page.url()).hash, '', 'claim intent is consumed once');
      await page.reload();
      await page.locator('.tdoc-account-trigger').waitFor({ state: 'attached' });
      assert.equal(await page.getByRole('dialog', { name: 'Claim your public URL' }).count(), 0, 'reload does not reopen claim');
      assert.deepEqual(errors, []);
      console.log(`  ✓ ${width}px: viewer profile in document, My docs and another profile; unclaimed account flow`);
      await page.close();
    }
  } finally {
    await browser.close();
    await target.stop();
  }
})().catch(error => { console.error(error); process.exit(1); });
