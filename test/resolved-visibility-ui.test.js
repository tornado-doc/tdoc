const assert = require('assert/strict');
const { resolveTarget } = require('./helpers/fixture-server');
const { chromium, webkit } = require('playwright');

const resolvedText = 'Some prose so the article column has real height for layout tests.';
const openText = 'A second section with its own heading';
const comments = require('./fixtures/resolved-visibility-comments.json');

(async () => {
  const target = await resolveTarget();
  const engine = process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/comments*', route => {
      assert.equal(route.request().method(), 'GET', 'this regression must not mutate comments');
      return route.fulfill({ json: comments });
    });
    await page.goto(target.url);
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    const getFrame = async () => {
      const element = await page.locator('iframe[aria-label="Document content"]').elementHandle();
      const frame = await element.contentFrame();
      await frame.waitForURL(url => url.pathname.includes('/frame'));
      return frame;
    };
    const frame = await getFrame();
    const highlights = () => frame.evaluate(() => Object.fromEntries([...CSS.highlights].map(([key, ranges]) => [key, [...ranges].map(r => r.toString())])));
    const settled = async (on) => {
      await frame.waitForFunction(({ on, text, openText }) => {
        const all = [...CSS.highlights].flatMap(([, ranges]) => [...ranges].map(r => r.toString()));
        return all.includes(openText) && all.includes(text) === on;
      }, { on, text: resolvedText, openText });
      const h = await highlights();
      assert(h['tdoc-anchor'].includes(openText), 'open highlight remains');
      if (!on) {
        assert.equal((h['tdoc-anchor-resolved'] || []).length, 0, 'no hidden resolved paint');
        assert.equal((h['tdoc-anchor-moved'] || []).length, 0, 'no hidden moved paint');
        assert.equal((h['tdoc-anchor-active'] || []).length, 0, 'no stale active paint');
        await page.waitForFunction(() => !document.querySelector('.tdoc-pin[data-id="resolved"],.tdoc-pin[data-id="element"],.tdoc-pin[data-id="moved"],.tdoc-pin[data-id="lost"]'));
      }
    };
    // The filter (Open / Resolved / All) docks at the top of the comment
    // column on a wide screen and heads the comments drawer on a phone.
    const filterRadio = async (name) => {
      const phone = await page.evaluate(() => innerWidth < 700);
      if (!phone) {
        const dock = page.locator('.tdoc-comment-filter-dock .tdoc-comment-filter');
        await dock.waitFor();
        return dock.getByRole('radio', { name });
      }
      const drawer = page.locator('#tdoc-comment-layer .tdoc-comment-filter');
      if (!(await drawer.isVisible().catch(() => false))) await page.locator('.tdoc-fab').click();
      await drawer.waitFor();
      return drawer.getByRole('radio', { name });
    };
    const allShown = async () => (await filterRadio(/^All$/)).getAttribute('aria-checked');
    const toggle = async () => {
      const on = (await allShown()) === 'true';
      // Keyboard activation keeps the selected card open until the filter
      // itself handles it (pointer-down on the page dismisses cards).
      // The phone drawer re-renders as it opens: find the radio again if it
      // was replaced under us.
      for (let attempt = 0; ; attempt++) {
        try {
          const control = await filterRadio(on ? /^Open/ : /^All$/);
          await control.focus({ timeout: 3000 });
          break;
        } catch (error) {
          if (attempt >= 4) throw error;
          await page.waitForTimeout(200);
        }
      }
      await page.keyboard.press('Enter');
      if (await page.locator('#tdoc-comment-layer .tdoc-comment-filter').isVisible().catch(() => false)) await page.keyboard.press('Escape');
    };
    assert.equal(await allShown(), 'true', 'fresh document defaults to showing all comments');
    await settled(true);
    // The painted underline has no DOM hover target. Moving across its range
    // still highlights the corresponding margin avatar, without a text label.
    const hoverPoint = await frame.evaluate(text => {
      const node = [...document.querySelectorAll('h1,h2,h3,p')].find(element => element.textContent.includes(text));
      const range = document.createRange(); range.selectNodeContents(node);
      const rect = range.getClientRects()[0];
      return { x: rect.x + Math.min(12, rect.width / 2), y: rect.y + rect.height / 2 };
    }, openText);
    const frameBox = await page.locator('iframe[aria-label="Document content"]').boundingBox();
    await page.mouse.move(frameBox.x + hoverPoint.x, frameBox.y + hoverPoint.y);
    await page.locator('.tdoc-pin[data-id="open"].tdoc-pin-anchor-hover').waitFor();
    await page.mouse.move(10, 10);
    await page.waitForFunction(() => !document.querySelector('.tdoc-pin[data-id="open"]')?.classList.contains('tdoc-pin-anchor-hover'));
    await toggle();
    await settled(false);
    await toggle();
    await settled(true);
    assert((await highlights())['tdoc-anchor-moved'].length > 0, 'fixture exercises moved highlights');
    await page.locator('.tdoc-pin[data-id="resolved"]').click();
    await frame.waitForFunction(() => CSS.highlights.get('tdoc-anchor-active')?.size > 0);
    await toggle();
    await settled(false);
    assert.equal(await page.locator('.tdoc-margin-comment').count(), 0, 'selected resolved card closes');

    // A real pointer click on the formerly highlighted words must not reopen it.
    const point = await frame.evaluate(text => {
      const p = [...document.querySelectorAll('p')].find(p => p.textContent === text);
      const r = document.createRange(); r.selectNodeContents(p);
      const b = r.getClientRects()[0]; return { x: b.x + 15, y: b.y + b.height / 2 };
    }, resolvedText);
    const box = await page.locator('iframe[aria-label="Document content"]').boundingBox();
    await page.mouse.click(box.x + point.x, box.y + point.y);
    await page.waitForTimeout(250); // Allow the cross-origin click message to reach React.
    assert.equal(await page.locator('.tdoc-margin-comment').count(), 0, 'hidden words have no click target');
    await settled(false);
    // A click already queued by the iframe before the filter changed must
    // not reopen a now-hidden thread or revive it when the filter is restored.
    await frame.evaluate(() => parent.postMessage({ source: 'tdoc-frame', type: 'tdoc:anchorClick', id: 'moved' }, '*'));
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.tdoc-margin-comment').count(), 0, 'stale anchor click cannot bypass visibility');
    await toggle();
    await settled(true);
    assert.equal(await page.locator('.tdoc-margin-comment').count(), 0, 'a rejected hidden click cannot revive later');
    assert.equal(((await highlights())['tdoc-anchor-active'] || []).length, 0, 'showing again does not restore selection');
    await page.locator('.tdoc-pin[data-id="resolved"]').click();
    await frame.waitForFunction(() => CSS.highlights.get('tdoc-anchor-active')?.size > 0);
    // Pointer activation dismisses the card before onClick. The probe must
    // still forget its old active target when that target becomes hidden.
    await (await filterRadio(/^Open/)).click();
    await settled(false);
    await toggle();
    await settled(true);
    assert.equal(((await highlights())['tdoc-anchor-active'] || []).length, 0, 'pointer toggle also clears selection');
    await toggle();
    await settled(false);
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    // Reload replaces the Frame object; verify persistence directly in the new frame.
    const reloaded = await getFrame();
    await reloaded.waitForFunction(text => CSS.highlights.get('tdoc-anchor')?.size === 1 && [...CSS.highlights.get('tdoc-anchor')][0].toString() === text, openText);
    await page.setViewportSize({ width: 375, height: 800 });
    await toggle();
    await reloaded.waitForFunction(() => CSS.highlights.get('tdoc-anchor')?.size === 2);
    await toggle();
    await reloaded.waitForFunction(() => CSS.highlights.get('tdoc-anchor')?.size === 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('tdoc-show-resolved')), '0');

    await page.setViewportSize({ width: 1600, height: 1000 });
    await toggle();
    await page.locator('.tdoc-pin[data-id="open"]').click();
    await reloaded.waitForFunction(text => [...(CSS.highlights.get('tdoc-anchor-active') || [])].some(r => r.toString() === text), openText);
    await toggle();
    await reloaded.waitForFunction(() => CSS.highlights.get('tdoc-anchor')?.size === 1);
    assert((await reloaded.evaluate(() => [...CSS.highlights.get('tdoc-anchor-active')].map(r => r.toString()))).includes(openText), 'selected open thread keeps its highlight');
    assert.equal(await page.locator('.tdoc-margin-comment').count(), 1, 'selected open card stays open');

    // A comment link must reveal resolved threads by enabling the filter,
    // never by painting a resolved thread while the filter still hides it.
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${target.url}?comment=resolved`);
    await page.locator('.tdoc-margin-comment').waitFor();
    assert.equal(await allShown(), 'true', 'resolved deep link must agree with the visibility switch');
    await toggle();
    await page.locator('.tdoc-margin-comment').waitFor({ state: 'detached' });
    await page.goto(`${target.url}?comment=moved`);
    const linkedFrame = await getFrame();
    await linkedFrame.waitForFunction(() => CSS.highlights.get('tdoc-anchor-moved')?.size > 0);
    assert.equal(await allShown(), 'true', 'moved resolved highlight cannot bypass the switch');
    await toggle();
    await linkedFrame.waitForFunction(() => !CSS.highlights.get('tdoc-anchor-moved')?.size && !CSS.highlights.get('tdoc-anchor-active')?.size);
    // Inspect the rendered pixels as well as the registry: older Safari can
    // retain a painted highlight after CSS.highlights.set replaces its ranges.
    await page.setViewportSize({ width: 1600, height: 1600 });
    await page.goto(target.url);
    const paintFrame = await getFrame();
    await paintFrame.waitForFunction(() => CSS.highlights.get('tdoc-anchor')?.size === 1);
    const code = paintFrame.locator('pre');
    const before = await code.screenshot();
    const paintCollections = await paintFrame.evaluateHandle(() => ({
      normal: CSS.highlights.get('tdoc-anchor'), moved: CSS.highlights.get('tdoc-anchor-moved'),
    }));
    await toggle();
    await paintFrame.waitForFunction(() => CSS.highlights.get('tdoc-anchor-moved')?.size > 0);
    assert(!before.equals(await code.screenshot()), 'resolved moved highlight must actually paint');
    await toggle();
    await paintFrame.waitForFunction(() => !CSS.highlights.get('tdoc-anchor-moved')?.size);
    assert(before.equals(await code.screenshot()), 'resolved moved highlight must disappear from pixels, not only the registry');
    for (let cycle = 0; cycle < 3; cycle++) {
      await toggle();
      await paintFrame.waitForFunction(() => CSS.highlights.get('tdoc-anchor-moved')?.size > 0);
      await toggle();
      await paintFrame.waitForFunction(() => !CSS.highlights.get('tdoc-anchor-moved')?.size);
      assert(await paintFrame.evaluate((owned) => (
        CSS.highlights.get('tdoc-anchor') === owned.normal
        && CSS.highlights.get('tdoc-anchor-moved') === owned.moved
        && owned.moved.size === 0
      ), paintCollections), 'the renderer must clear its registered ranges without replacing their owning Highlight');
      assert(before.equals(await code.screenshot()), 'repeated OFF must remove painted code ranges');
    }
    await paintCollections.dispose();
    assert.deepEqual(errors, []);
    console.log('  ✓ Resolved hides paint, targets and selected cards; restores on demand; persists on mobile; deep links still work');
  } finally { await browser.close(); await target.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
