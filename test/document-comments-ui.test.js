const fs = require('fs');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium, webkit } = requirePlaywrightOrSkip('document-comments-ui.test.js');

const commentsFile = path.join(__dirname, 'fixtures/tdocs/hostile-body-css/comments.json');
const initial = fs.readFileSync(commentsFile, 'utf8');
let failures = 0;
async function check(name, run) {
  try { await run(); console.log(`  ✓ ${name}`); }
  catch (error) { failures++; console.error(`  ✗ ${name}: ${error.message}`); }
}

(async () => {
  const seeded = JSON.parse(initial);
  seeded.push({
    id: 'c_document_existing', version: 1, text: 'A comment on the whole document',
    author: { login: 'tester' }, status: 'open', created: '2026-08-22T00:00:06Z',
    anchor: null, replies: [],
  }, {
    id: 'c_document_ai', version: 1, text: 'What should change in this report?',
    author: { login: 'tester' }, status: 'open', created: '2026-08-22T00:00:07Z',
    anchor: null, replies: [{ id: 'r_document_ai', parent_id: 'c_document_ai',
      text: 'The public AI answer', author: { kind: 'agent', login: 'tdoc-ai' },
      created: '2026-08-22T00:00:08Z' }],
  });
  fs.writeFileSync(commentsFile, JSON.stringify(seeded));
  let server;
  try {
    server = await resolveTarget({ e2eUser: 'tester' });
    const base = server.url.replace(/\/d\/.*/, '');
    const url = `${base}/d/hostile-body-css/v/1?shell=1`;
    for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const width of [1400, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 850 } });
          try {
            await page.goto(url, { waitUntil: 'networkidle' });
            await check(`${engineName} ${width}: existing whole-document and AI threads appear below title`, async () => {
              const section = page.locator('.tdoc-document-comments');
              await section.getByText('A comment on the whole document').waitFor({ timeout: 5000 });
              await section.getByText('What should change in this report?').waitFor({ timeout: 5000 });
              if (await page.locator('.tdoc-pin[data-id="c_document_existing"], .tdoc-pin[data-id="c_document_ai"]').count()) {
                throw new Error('document comment leaked into margin pin');
              }
              const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('hostile-body-css'));
              const slot = await frame.evaluate(() => {
                const heading = document.querySelector('h1');
                const spacer = document.querySelector('[data-tdoc-document-comments-slot]');
                return { follows: spacer.previousElementSibling === heading, height: spacer.getBoundingClientRect().height,
                  nextTop: heading.nextElementSibling.getBoundingClientRect().top };
              });
              if (!slot.follows || slot.height < 80) throw new Error(`slot does not reserve space after h1: ${JSON.stringify(slot)}`);
              const card = section.locator('[data-comment-id="c_document_existing"]');
              const border = await card.evaluate((node) => getComputedStyle(node).borderTopColor);
              if (border !== 'rgb(232, 234, 237)') throw new Error(`idle card has an emphasized border: ${border}`);
              await card.getByRole('button', { name: 'More actions' }).click();
              if (await page.getByRole('menuitem', { name: /Re-anchor|Move anchor/ }).count()) throw new Error('whole-document comment offers re-anchor');
              await page.keyboard.press('Escape');
            });
            if (width === 1400 && engineName === 'chromium') {
              await check('desktop: wheel over the inline section scrolls the document', async () => {
                const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('hostile-body-css'));
                await frame.evaluate(() => {
                  const filler = document.createElement('div');
                  filler.style.height = '2000px';
                  filler.setAttribute('data-scroll-fixture', '');
                  document.body.append(filler);
                });
                await page.locator('.tdoc-document-comments').hover();
                await page.mouse.wheel(0, 280);
                await frame.waitForFunction(() => window.scrollY > 0, null, { timeout: 3000 });
                const scrolled = await frame.evaluate(() => window.scrollY);
                if (!scrolled) throw new Error('wheel did not scroll the frame');
              });
              await check('explicit custom template keeps comments outside a nested title hero', async () => {
                const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('hostile-body-css'));
                await frame.evaluate(() => {
                  const hero = document.createElement('div');
                  hero.setAttribute('data-custom-hero', '');
                  document.querySelector('h1').before(hero);
                  hero.append(document.querySelector('h1'));
                  document.documentElement.setAttribute('data-tdoc-design', 'custom');
                });
                await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({
                  source: 'tdoc-shell', type: 'tdoc:anchors', comments: [],
                }, '*'));
                await frame.waitForFunction(() => {
                  const slot = document.querySelector('[data-tdoc-document-comments-slot]');
                  return slot === document.body.lastElementChild;
                });
                const outsideHero = await frame.evaluate(() => !document.querySelector('[data-custom-hero]').contains(
                  document.querySelector('[data-tdoc-document-comments-slot]')));
                if (!outsideHero) throw new Error('custom hero contains document comments');
              });
            }
            if (width === 390 && engineName === 'chromium') {
              await check('phone: inline Add a comment creates a null-anchor thread', async () => {
                await page.locator('.tdoc-document-comment-add').click();
                const inline = page.locator('.tdoc-document-comments .tdoc-inline-composer');
                await inline.waitFor();
                if (!(await inline.getByText('On this document').count())) throw new Error('composer has no document label');
                await inline.locator('textarea').fill('New inline whole-document thought');
                await inline.getByRole('button', { name: 'Comment', exact: true }).click();
                await page.locator('.tdoc-document-comments').getByText('New inline whole-document thought').waitFor();
                const saved = JSON.parse(fs.readFileSync(commentsFile, 'utf8'))
                  .find((item) => item.text === 'New inline whole-document thought');
                if (!saved || saved.anchor !== null) throw new Error('new thread was not saved at document level');
              });
              await check('phone: without h1 the same section moves to the document top', async () => {
                const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('hostile-body-css'));
                await frame.evaluate(() => { document.querySelector('h1').remove(); window.dispatchEvent(new Event('resize')); });
                await page.waitForFunction(() => document.querySelector('.tdoc-document-comments')?.getBoundingClientRect().top < 145);
                const atTop = await frame.evaluate(() => {
                  const root = document.body;
                  return root.firstElementChild?.hasAttribute('data-tdoc-document-comments-slot');
                });
                if (!atTop) throw new Error('slot did not move to document top');
              });
            }
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
    }
    fs.writeFileSync(commentsFile, initial);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
      await page.goto(url, { waitUntil: 'networkidle' });
      await check('empty document section shows only the quiet Add a comment row', async () => {
        await page.locator('.tdoc-document-comment-add').waitFor();
        if (await page.locator('.tdoc-document-comments h2, .tdoc-document-comment-row').count()) {
          throw new Error('empty section has a heading or an empty card');
        }
      });
      await page.close();
    } finally { await browser.close(); }
  } finally {
    if (server) await server.stop();
    fs.writeFileSync(commentsFile, initial);
  }
  if (failures) process.exitCode = 1;
})().catch((error) => { fs.writeFileSync(commentsFile, initial); console.error(error); process.exitCode = 1; });
