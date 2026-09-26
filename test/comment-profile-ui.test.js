// UI acceptance for the profile URLs supplied by the hosted comments API.
// The worker/account resolution contract is exercised in profile.test.js.
const assert = require('assert/strict');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('comment-profile-ui.test.js');

(async () => {
  const target = await resolveTarget();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/comments?*', async route => {
        const response = await route.fetch();
        const comments = await response.json();
        comments[0].author = { login:'alice', name:'Alice', avatar_url:'/tdoc_logo.png', profile_url:'/@alice-public' };
        comments[0].replies[0].author = { login:'bob', name:'Bob', avatar_url:'/tdoc_logo.png', profile_url:'/@bob' };
        await route.fulfill({ response, json: comments });
      });
      await page.route('**/@*', route => route.fulfill({ contentType:'text/html', body:'<h1>Public profile</h1>' }));
      const openThread = async () => {
        await page.goto(target.url);
        if (width > 700) {
          const frame = page.frameLocator('iframe[aria-label="Document content"]');
          await frame.getByText('A second section with its own heading').scrollIntoViewIfNeeded();
          await page.locator('.tdoc-pin').first().click();
        } else {
          await page.locator('.tdoc-fab').click();
        }
        await page.getByRole('link', {name:"View Alice's public profile"}).waitFor();
      };
      await openThread();
      assert.equal(new URL(page.url()).pathname, new URL(target.url).pathname, 'comment pin opens a comment, not a profile');
      const authorLink = page.getByRole('link', {name:"View Alice's public profile"});
      assert.equal(await authorLink.getAttribute('href'), '/@alice-public');
      assert.equal(await authorLink.locator('img').count(), 1);
      // Enter verifies a real, keyboard-accessible link; clicking the image
      // below independently exercises pointer behavior inside reply cards.
      await authorLink.focus();
      await authorLink.press('Enter');
      await page.waitForURL('**/@alice-public');
      await page.getByRole('heading', {name:'Public profile'}).waitFor();
      await openThread();
      await page.locator('.tdoc-replies-toggle').click();
      await page.getByRole('link', {name:"View Bob's public profile"}).locator('img').click();
      await page.waitForURL('**/@bob');
      assert.deepEqual(errors, []);
      console.log(`  ✓ ${width}px: comment pin, author keyboard link, reply avatar navigation`);
      await page.close();
    }
  } finally {
    await browser.close();
    await target.stop();
  }
})().catch(error => { console.error(error); process.exit(1); });
