// Signed in on a phone, the top bar keeps ⋯ (#tdoc-more-btn) on screen: the
// space chip and the account chip step aside, and the space list (My docs,
// every team with the current one checked, New team, Workspace settings) is
// a "Switch space" submenu of ⋯. Show resolved, Share and Versions stay
// reachable there; Ask AI is not a menu row (it is asked in a comment). On a
// desktop the document page has no space chip -- a doc already belongs to its
// space -- and Switch space is in the account menu.
// Run with: node test/phone-top-bar-ui.test.js

const assert = require('assert/strict');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const pw = requirePlaywrightOrSkip('phone-top-bar-ui.test.js');
const comments = require('./fixtures/resolved-visibility-comments.json');

const TEAMS = [
  { id: 'tm_befreed', name: 'BeFreed Marketing and Growth Team', role: 'admin', member_count: 4 },
  { id: 'tm_lab', name: 'Smrti Lab', role: 'member', member_count: 2 },
];

(async () => {
  const target = await resolveTarget({ e2eUser: 'alice-with-a-long-account-name' });
  const shots = process.env.TDOC_TEST_SCREENSHOTS;
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join(' | ')}`); } };
  try {
    for (const engine of ['webkit', 'chromium']) {
      const browser = await pw[engine].launch();
      try {
        const open = async (width, teams, askAi = false) => {
          const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 900 }, hasTouch: width < 700 });
          const page = await ctx.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.route('**/api/comments*', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: comments }) : r.continue()));
          await page.route('**/api/teams', (r) => r.fulfill({ json: { teams } }));
          // Ask AI is offered only on a published doc with the service on:
          // the hosted page's config, served by the local fixture server.
          if (askAi) await page.route((url) => url.pathname === new URL(target.url).pathname, async (r) => {
            const res = await r.fetch();
            const body = (await res.text()).replace('"mode":"local"', '"mode":"published","ask":{"available":true}');
            await r.fulfill({ response: res, body });
          });
          await page.goto(target.url);
          await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
          await page.locator('#tdoc-more-btn').waitFor();
          await page.waitForTimeout(300);
          return { ctx, page, errors };
        };
        for (const [teams, askAi] of [[TEAMS, false], [[], false], [TEAMS, true]]) {
          const which = (teams.length ? 'with teams' : 'without teams') + (askAi ? ', published with Ask AI' : '');
          await t(`${engine} 390px ${which}: ⋯ is on screen and carries the spaces; the drawer filters resolved`, async () => {
            const { ctx, page, errors } = await open(390, teams, askAi);
            const bar = await page.evaluate(() => {
              const more = document.getElementById('tdoc-more-btn');
              const r = more.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              const shown = (sel) => [...document.querySelectorAll(sel)].some((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
              return { r: [r.left, r.right, r.width], hit: more.contains(hit), space: shown('.tdoc-bar .tdoc-space-trigger'), account: shown('.tdoc-bar .tdoc-account-trigger'), overflow: document.documentElement.scrollWidth - innerWidth };
            });
            assert(bar.r[2] >= 40 && bar.r[0] >= 0 && bar.r[1] <= 390, `⋯ fully on screen: ${bar.r}`);
            assert(bar.hit, '⋯ is covered by something else');
            assert(!bar.space && !bar.account, `chips hidden on a phone: ${JSON.stringify(bar)}`);
            assert(bar.overflow <= 1, `bar overflows sideways: ${bar.overflow}`);
            if (shots) await page.screenshot({ path: path.join(shots, `phone-bar-${engine}-${teams.length ? 'teams' : 'solo'}.png`) });
            await page.locator('#tdoc-more-btn').click();
            await page.getByRole('menuitem', { name: /Switch space/ }).waitFor({ timeout: 5000 });
            // The local server publishes; tdoc.dev shares. Either is the doc's
            // way out, and both live in ⋯ on a phone. The modes head it.
            for (const name of [/^(Share|Publish)/, /Versions/, /Switch space/, /My account/, /Dark mode|Light mode/]) {
              const item = page.getByRole('menuitem', { name }).first();
              assert(await item.isVisible(), `${name} is in ⋯`);
            }
            assert.equal(await page.getByRole('menuitem', { name: /Ask AI|my agent|resolved/i }).count(), 0, 'Ask AI / my agent / resolved rows are back in ⋯');
            await page.getByRole('menuitem', { name: /Switch space/ }).click();
            const names = page.locator('.ui-menu-popup .tdoc-space-item-name');
            await names.first().waitFor({ timeout: 5000 });
            assert.deepEqual((await names.allTextContents()).map((s) => s.trim()), ['My docs', ...teams.map((x) => x.name), 'Workspace settings', 'New team']);
            for (const name of ['My docs', ...teams.map((x) => x.name), 'Workspace settings', 'New team']) {
              const box = await page.locator('.ui-menu-popup .tdoc-space-item-name', { hasText: name }).last().boundingBox();
              assert(box && box.x >= 0 && box.y >= 0 && box.y + box.height <= 844, `${name} visible in the space submenu: ${JSON.stringify(box)}`);
            }
            if (shots) await page.screenshot({ path: path.join(shots, `phone-bar-menu-${engine}-${teams.length ? 'teams' : 'solo'}.png`) });
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page.locator('.ui-menu-popup').first().waitFor({ state: 'detached' }).catch(() => {});
            // Resolved threads are filtered at the head of the comments drawer.
            await page.locator('.tdoc-fab').click();
            const filter = page.locator('#tdoc-comment-layer .tdoc-comment-filter');
            await filter.waitFor({ timeout: 5000 });
            await filter.getByRole('radio', { name: /Open/ }).click();
            assert.equal(await filter.getByRole('radio', { name: /Open/ }).getAttribute('aria-checked'), 'true');
            await filter.getByRole('radio', { name: /All/ }).click();
            assert.deepEqual(errors, []);
            await ctx.close();
          });
        }
        await t(`${engine} 1280px: the doc page has no space chip; Switch space and Dark mode are in the account menu`, async () => {
          const { ctx, page, errors } = await open(1280, TEAMS);
          const account = page.locator('.tdoc-bar .tdoc-account-trigger');
          await account.waitFor();
          assert.equal(await page.locator('.tdoc-bar .tdoc-space-trigger').count(), 0, 'space chip on a document page');
          assert.equal(await page.locator('.tdoc-bar .tdoc-theme-btn, #tdoc-theme-btn').count(), 0, 'standalone theme button is back');
          await account.click();
          await page.getByRole('menuitem', { name: /Dark mode|Light mode/ }).waitFor();
          await page.getByRole('menuitem', { name: /Switch space/ }).click();
          const names = page.locator('.ui-menu-popup .tdoc-space-item-name');
          await names.first().waitFor({ timeout: 5000 });
          assert.deepEqual((await names.allTextContents()).map((s) => s.trim()), ['My docs', ...TEAMS.map((x) => x.name), 'Workspace settings', 'New team']);
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await page.locator('.ui-menu-popup').first().waitFor({ state: 'detached' }).catch(() => {});
          await page.locator('#tdoc-more-btn').click();
          await page.locator('.ui-menu-popup').first().waitFor();
          assert.equal(await page.getByRole('menuitem', { name: /Switch space/ }).isVisible().catch(() => false), false, 'no Switch space row on desktop');
          if (shots) await page.screenshot({ path: path.join(shots, `desktop-bar-${engine}.png`) });
          assert.deepEqual(errors, []);
          await ctx.close();
        });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await target.stop();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
