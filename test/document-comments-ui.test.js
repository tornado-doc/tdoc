const fs = require('fs');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium, webkit } = requirePlaywrightOrSkip('document-comments-ui.test.js');

const commentsFile = path.join(__dirname, 'fixtures/tdocs/hostile-body-css/comments.json');
const initial = fs.readFileSync(commentsFile, 'utf8');
const shots = process.env.TDOC_UI_SHOTS;
let failures = 0;
async function check(name, run) {
  try { await run(); console.log(`  ✓ ${name}`); }
  catch (error) { failures++; console.error(`  ✗ ${name}: ${error.message}`); }
}

(async () => {
  const seeded = JSON.parse(initial);
  for (let i = 0; i < 12; i++) seeded.push({
    id: `c_document_${i}`, version: 1,
    text: i === 1 ? 'What should change in this report?' : `Whole-document thought ${i}`,
    author: { login: i % 2 ? 'editor' : 'tester', avatar_url: '/tdoc_logo.png' },
    status: i === 2 ? 'applied' : 'open', ...(i === 2 ? { applied_in: 1 } : {}),
    created: `2026-08-22T00:00:${String(i + 6).padStart(2, '0')}Z`,
    anchor: null, replies: i === 1 ? [{ id: 'r_document_ai', parent_id: 'c_document_1',
      text: 'The public AI answer', author: { kind: 'agent', login: 'tdoc-ai' },
      created: '2026-08-22T00:01:00Z' }] : [],
  });
  fs.writeFileSync(commentsFile, JSON.stringify(seeded));
  let server;
  try {
    server = await resolveTarget({ e2eUser: 'tester' });
    const url = `${server.url.replace(/\/d\/.*/, '')}/d/hostile-body-css/v/1?shell=1`;
    for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const width of [1400, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 850 } });
          try {
            await page.goto(url, { waitUntil: 'networkidle' });
            const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('hostile-body-css'));
            await check(`${engineName} ${width}: document comments have one title pin and no spacer`, async () => {
              const pin = page.locator('.tdoc-pin-document');
              await pin.waitFor({ timeout: 5000 });
              if (await pin.count() !== 1) throw new Error('whole-document comments were not grouped');
              const layout = await frame.evaluate(() => ({
                titleY: document.querySelector('h1').getBoundingClientRect().top,
                spacer: !!document.querySelector('[data-tdoc-document-comments-slot]'),
              }));
              if (layout.spacer) throw new Error('old inline spacer still changes the document');
              const pinBox = await pin.boundingBox();
              const frameBox = await page.locator('iframe').boundingBox();
              if (Math.abs(pinBox.y - frameBox.y - layout.titleY) > 45) throw new Error('pin is not beside the title');
              if (pinBox.x + pinBox.width > width + 1) throw new Error('pin extends beyond viewport');
              const avatar = await pin.locator('img').first().boundingBox();
              if (!avatar || avatar.width > 24 || avatar.height > 24) throw new Error(`document avatar exceeds its pin: ${JSON.stringify(avatar)}`);
            });
            if (width === 1400) {
              await check(`${engineName}: one click expands all title comments, with internal scrolling`, async () => {
                await page.locator('.tdoc-pin-document').click();
                const cards = page.locator('.tdoc-cluster-cards .tdoc-margin-comment[data-comment-id]');
                await cards.first().waitFor();
                if (await cards.count() !== 12) throw new Error(`expected 12 cards, got ${await cards.count()}; popovers=${await page.locator('.tdoc-cluster-cards').count()}; ids=${(await cards.evaluateAll((nodes) => nodes.map((node) => node.dataset.commentId))).join(',')}`);
                const size = await page.locator('.tdoc-cluster-cards').evaluate((el) => ({
                  top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom,
                  scroll: el.scrollHeight, visible: el.clientHeight,
                }));
                if (size.top < 48 || size.bottom > 834 || size.scroll <= size.visible) throw new Error(`cluster overflows viewport or cannot scroll: ${JSON.stringify(size)}`);
                const avatar = await cards.first().locator('.author img').boundingBox();
                if (!avatar || avatar.width > 24 || avatar.height > 24) throw new Error(`comment avatar exceeds its card: ${JSON.stringify(avatar)}`);
                if (shots && engineName === 'chromium') await page.screenshot({ path: path.join(shots, 'document-avatars-desktop.png') });
                await cards.first().getByRole('button', { name: 'More actions' }).click();
                if (await page.getByRole('menuitem', { name: /Re-anchor|Move anchor/ }).count()) throw new Error('whole-document comment offers re-anchor');
              });
            } else {
              await check(`${engineName}: phone pin opens document comments first and restores filters`, async () => {
                await page.locator('.tdoc-pin-document').click();
                const drawer = page.locator('#tdoc-comment-layer');
                await drawer.waitFor();
                await drawer.getByText('Whole-document thought 0').waitFor();
                const avatar = await drawer.locator('.tdoc-margin-comment .author img').first().boundingBox();
                if (!avatar || avatar.width > 24 || avatar.height > 24) throw new Error(`phone avatar exceeds its card: ${JSON.stringify(avatar)}`);
                if (shots && engineName === 'chromium') {
                  await page.waitForTimeout(300);
                  await page.screenshot({ path: path.join(shots, 'document-avatars-phone.png') });
                }
                const filter = drawer.locator('.tdoc-comment-filter');
                await filter.waitFor({ timeout: 5000 });
                const ids = await drawer.locator('.tdoc-margin-comment[data-comment-id]').evaluateAll((cards) => cards.map((card) => card.dataset.commentId));
                if (!ids[0]?.startsWith('c_document_') || ids.slice(0, 11).some((id) => !id.startsWith('c_document_'))) {
                  throw new Error(`document comments are not first: ${ids.slice(0, 12)}`);
                }
                await filter.getByRole('radio', { name: /Resolved/ }).click({ timeout: 5000 });
                await drawer.getByText('Whole-document thought 2').waitFor();
                if (await drawer.getByText('Whole-document thought 0').count()) throw new Error('Resolved filter still shows open comment');
                await filter.getByRole('radio', { name: 'All' }).click();
                await drawer.getByText('Whole-document thought 0').waitFor();
              });
              if (engineName === 'chromium') await check('phone drawer can snap from partial to full height', async () => {
                const drawer = page.locator('#tdoc-comment-layer');
                const handle = drawer.locator('.tdoc-drawer-handle');
                const before = await drawer.boundingBox();
                const box = await handle.boundingBox();
                const x = box.x + box.width / 2, y = box.y + box.height / 2;
                const cdp = await page.context().newCDPSession(page);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
                for (let step = 1; step <= 10; step++) {
                  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 17 * step }] });
                }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await page.waitForTimeout(300);
                const after = await drawer.boundingBox();
                if (after.y >= before.y - 100 || after.y > 30) throw new Error(`drawer did not expand: ${before.y} → ${after.y}`);
                const filter = drawer.locator('.tdoc-comment-filter-row');
                if (!(await filter.isVisible())) throw new Error('filter disappeared in full drawer');
              });
            }
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
    }
  } finally {
    if (server) await server.stop();
    fs.writeFileSync(commentsFile, initial);
  }
  if (failures) process.exitCode = 1;
})().catch((error) => { fs.writeFileSync(commentsFile, initial); console.error(error); process.exitCode = 1; });
