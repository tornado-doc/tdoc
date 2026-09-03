// Browser acceptance for provider-owned Read / Comment / Edit modes.
// Run with: node test/browser-editing.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('browser-editing.test.js');
const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, error) { console.log(`  ✗ ${name}\n    ${error.message || error}`); fail++; }
async function test(name, operation) {
  try { await operation(); ok(name); } catch (error) { bad(name, error); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function waitForServer(port, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const request = http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
        response.resume(); resolve();
      });
      request.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('local editing server did not start'));
        else setTimeout(poll, 80);
      });
    })();
  });
}

function selectParagraph(frame) {
  return frame.evaluate(() => {
    const paragraph = document.getElementById('editable-paragraph');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    const rect = paragraph.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + 10, clientY: rect.top + 10,
    }));
  });
}

async function chooseMode(page, label) {
  const trigger = page.getByRole('button', { name: /Document mode:/ });
  if ((await trigger.getAttribute('aria-label')) === `Document mode: ${label}`) return;
  await trigger.click();
  await page.getByRole('menuitemradio', { name: label }).click();
  await page.getByRole('button', { name: `Document mode: ${label}` }).waitFor();
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-browser-edit-'));
  const slug = 'browser-edit';
  const docRoot = path.join(root, slug);
  fs.mkdirSync(path.join(docRoot, 'v1'), { recursive: true });
  fs.writeFileSync(path.join(docRoot, 'v1', 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Browser edit</title>
<style>body{font:18px/1.6 system-ui;margin:0}.page{max-width:720px;margin:48px auto;padding:0 24px}img{max-width:180px}</style>
</head><body><main class="page"><h1>Browser editing</h1>
<p id="editable-paragraph">Edit this sentence and save one snapshot.</p>
<p id="markdown-paragraph">Type <a href="https://example.com/markdown"><em>markdown</em></a> here.</p>
<section id="comment-artifact" data-tdoc-artifact><p id="artifact-copy">Commentable artifact copy.</p></section>
<section id="edit-atomic" data-tdoc-edit-atomic><p>Explicitly locked widget copy.</p></section>
<img alt="Atomic artifact" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
</main></body></html>`);
  fs.writeFileSync(path.join(docRoot, 'meta.json'), JSON.stringify({
    slug, title: 'Browser editing', versions: [{ n: 1, created: new Date().toISOString() }],
  }, null, 2));

  // A SECOND doc, used only by the Move anchor test. Seeding an anchored
  // comment into the doc above changes what a click on its paragraph does, and
  // the neighbouring tests start failing — this keeps that blast radius at zero.
  const anchorSlug = 'move-anchor';
  const anchorRoot = path.join(root, anchorSlug);
  fs.mkdirSync(path.join(anchorRoot, 'v1'), { recursive: true });
  fs.writeFileSync(path.join(anchorRoot, 'v1', 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Move anchor</title>
<style>body{font:18px/1.6 system-ui;margin:0}.page{max-width:720px;margin:48px auto;padding:0 24px}</style>
</head><body><main class="page"><h1>Move anchor</h1>
<p id="anchor-paragraph">Alpha bravo charlie delta echo foxtrot golf hotel india juliet.</p>
</main></body></html>`);
  fs.writeFileSync(path.join(anchorRoot, 'comments.json'), JSON.stringify([{
    id: 'c_anchored', version: 1,
    anchor: {
      kind: 'text', text: 'charlie',
      context_before: 'Alpha bravo ', context_after: ' delta echo foxtrot golf hotel india juliet.',
    },
    text: 'move me', author: { login: 'owner', name: 'owner', avatar_url: '' },
    status: 'open', created: '2026-09-01T00:00:00Z', replies: [], reactions: {},
  }], null, 2));
  fs.writeFileSync(path.join(anchorRoot, 'meta.json'), JSON.stringify({
    slug: anchorSlug, title: 'Move anchor', versions: [{ n: 1, created: new Date().toISOString() }],
  }, null, 2));

  // Not a fixed port: waitForServer below only asks whether ANYTHING answers,
  // so a port another process already held would have quietly become the
  // subject of this whole suite.
  const port = await reservePort();
  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const url = `http://127.0.0.1:${port}/d/${slug}/v/1`;
    await page.goto(url, { waitUntil: 'networkidle' });
    const frame = page.frames().find((candidate) => candidate.url().includes('/frame'));
    assert(frame, 'author frame missing');

    await test('comment-capable docs default to compact Comment mode', async () => {
      const trigger = page.getByRole('button', { name: 'Document mode: Comment' });
      await trigger.waitFor();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      const cursor = await frame.evaluate(() => getComputedStyle(document.body).cursor);
      assert(cursor.includes('data:image/svg+xml') && cursor.includes('crosshair'),
        `Comment mode did not expose its chat cursor: ${cursor}`);
      const triggerPath = await trigger.locator('svg.tdoc-comment-icon path').getAttribute('d');
      const decodedCursor = decodeURIComponent(cursor);
      assert(triggerPath && decodedCursor.includes(triggerPath),
        'Comment mode trigger and cursor use different icon geometry');
      assert(cursor.includes(' 2 2, crosshair'),
        `Comment cursor hotspot is not fixed to the droplet point: ${cursor}`);
      assert(decodedCursor.includes('fill="#1652f0"') && !decodedCursor.includes('fill="white"'),
        'Comment cursor is not rendered as a solid brand-blue mark');
      assert(decodedCursor.includes('width="24" height="24"') && !decodedCursor.includes('stroke='),
        'Comment cursor has fractional SVG scaling or a raster-like outline');
      await frame.locator('#comment-artifact').hover();
      const pill = frame.locator('.tdoc-comment-pill');
      await pill.waitFor({ state: 'visible' });
      assert(await pill.locator('svg path').getAttribute('d') === triggerPath,
        'Comment artifact pill and mode trigger use different icon geometry');
      assert(await pill.locator('svg').evaluate((icon) => getComputedStyle(icon).stroke) === 'none',
        'Comment artifact pill retained an outline around the solid icon');
    });

    await test('a click in blank space dismisses instead of commenting on the nearest word', async () => {
      // caretPositionFromPoint answers with the NEAREST caret, so a click in a
      // margin or below the last line used to select a word the pointer was
      // never over — dismissing a card and opening a different one.
      const box = await page.locator('.tdoc-doc-frame').boundingBox();
      const geometry = await frame.evaluate(() => {
        const paragraph = document.querySelector('#editable-paragraph');
        const rect = paragraph.getBoundingClientRect();
        const word = document.createRange();
        word.setStart(paragraph.firstChild, 0);
        word.setEnd(paragraph.firstChild, 4);
        const wordRect = word.getBoundingClientRect();
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          onWord: { x: wordRect.left + wordRect.width / 2, y: wordRect.top + wordRect.height / 2 },
        };
      });
      const selectionText = () => frame.evaluate(() => {
        const selection = window.getSelection();
        return selection && !selection.isCollapsed ? selection.toString() : null;
      });
      const clickAt = async (x, y) => {
        await frame.evaluate(() => window.getSelection().removeAllRanges());
        await page.mouse.click(box.x + x, box.y + y);
        await page.waitForTimeout(150);
      };

      const blankPoints = [
        ['above the first line', geometry.left + 40, geometry.top - 6],
        ['below the last line', geometry.left + 40, geometry.bottom + 6],
        ['in the left margin', geometry.left - 16, geometry.top + 8],
        ['past the end of a short line', geometry.right - 20, geometry.top + 12],
      ];
      for (const [where, x, y] of blankPoints) {
        await clickAt(x, y);
        const stray = await selectionText();
        assert(!stray, `a click ${where} selected ${JSON.stringify(stray)}`);
      }

      await clickAt(geometry.onWord.x, geometry.onWord.y);
      assert(await selectionText(), 'a click on the word itself stopped selecting it');

      // That last click opened the composer on purpose. Leave the page as this
      // test found it, or the suite's later modes inherit an open popup.
      await page.locator('.tdoc-popup button.x').click();
      await frame.evaluate(() => window.getSelection().removeAllRanges());
    });

    await test('while a card is open, a click anywhere outside it only dismisses', async () => {
      // Dismissal must not hit-test. Whatever is under the pointer — another
      // anchor, plain prose, blank space — the click that closes a card does
      // not also open the next thing.
      const box = await page.locator('.tdoc-doc-frame').boundingBox();
      const geometry = await frame.evaluate(() => {
        const paragraph = document.querySelector('#editable-paragraph');
        const text = paragraph.firstChild;
        const spot = (from, to) => {
          const range = document.createRange();
          range.setStart(text, from); range.setEnd(text, to);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        };
        const rect = paragraph.getBoundingClientRect();
        return { first: spot(0, 4), later: spot(10, 18), blank: { x: rect.right - 20, y: rect.top + 12 } };
      });
      const clickAt = async (point) => {
        await page.mouse.click(box.x + point.x, box.y + point.y);
        await page.waitForTimeout(250);
      };
      const openCount = () => page.locator('.tdoc-popup, .tdoc-margin-comment.active').count();

      await clickAt(geometry.first);
      assert(await openCount() > 0, 'a click on a word no longer opens the composer');

      // A second word: the open composer must close, and this word must not
      // become a new one.
      await clickAt(geometry.later);
      assert(await openCount() === 0, 'clicking another word opened something instead of dismissing');

      await clickAt(geometry.first);
      assert(await openCount() > 0, 'precondition: composer did not reopen');
      await clickAt(geometry.blank);
      assert(await openCount() === 0, 'clicking blank space left the composer open');

      // With nothing open, a click on a word still starts a comment.
      await clickAt(geometry.first);
      assert(await openCount() > 0, 'dismissal state leaked: a fresh click stopped opening the composer');
      await page.locator('.tdoc-popup button.x').click();
      await frame.evaluate(() => window.getSelection().removeAllRanges());
    });

    await test('dismissal spares the drag and the artifact pill', async () => {
      // Three things the dismiss-first rule broke when it was first written.
      // Each is a separate path into the same comment UI.
      const box = await page.locator('.tdoc-doc-frame').boundingBox();
      const geometry = await frame.evaluate(() => {
        const paragraph = document.querySelector('#editable-paragraph');
        const text = paragraph.firstChild;
        const span = (from, to) => {
          const range = document.createRange();
          range.setStart(text, from); range.setEnd(text, to);
          return range.getBoundingClientRect();
        };
        const first = span(0, 4), tail = span(10, 20);
        const artifact = document.querySelector('#comment-artifact').getBoundingClientRect();
        return {
          first: { x: first.left + first.width / 2, y: first.top + first.height / 2 },
          drag: { x1: tail.left + 1, x2: tail.right - 1, y: tail.top + tail.height / 2 },
          artifact: { x: artifact.left + artifact.width / 2, y: artifact.top + 12 },
        };
      });
      const openCount = () => page.locator('.tdoc-popup, .tdoc-margin-comment.active').count();
      const clickAt = async (point) => {
        await page.mouse.click(box.x + point.x, box.y + point.y);
        await page.waitForTimeout(250);
      };

      // 1. A drag while something is open is a selection, not a dismissal.
      //    Clearing on mousedown unmounted the focused composer, and losing
      //    that focus wiped the selection mid-drag.
      await clickAt(geometry.first);
      assert(await openCount() > 0, 'precondition: a word click did not open the composer');
      await page.mouse.move(box.x + geometry.drag.x1, box.y + geometry.drag.y);
      await page.mouse.down();
      await page.mouse.move(box.x + geometry.drag.x2, box.y + geometry.drag.y, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      assert(await openCount() > 0, 'a drag while something was open reported no selection');
      await page.locator('.tdoc-popup button.x').click().catch(() => {});
      await page.waitForTimeout(200);

      // 2. The artifact pill is our own UI, but while a card is open it is
      //    outside that card like anything else: it dismisses, it does not
      //    open an element comment.
      await clickAt(geometry.first);
      assert(await openCount() > 0, 'precondition: composer did not reopen');
      // Dispatch the hover inside the frame: Playwright's own hover() checks
      // actionability against the top document, where the open composer sits
      // over the artifact and the check never settles.
      await frame.evaluate(() => {
        const element = document.querySelector('#comment-artifact');
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + 12,
        }));
      });
      await frame.locator('.tdoc-comment-pill').waitFor({ state: 'visible' });
      const pill = await frame.locator('.tdoc-comment-pill').boundingBox();
      assert(pill, 'hovering the artifact did not show the comment pill');
      await page.mouse.click(box.x + pill.x + pill.width / 2, box.y + pill.y + pill.height / 2);
      await page.waitForTimeout(400);
      assert(await openCount() === 0, 'clicking the artifact pill opened a comment instead of dismissing');

      await frame.evaluate(() => window.getSelection().removeAllRanges());
    });

    await test('Read mode opens existing anchors but does not create a comment selection', async () => {
      await chooseMode(page, 'Read');
      await selectParagraph(frame);
      await page.waitForTimeout(150);
      assert(await page.locator('.tdoc-popup').count() === 0, 'Read selection opened the comment composer');
    });

    await test('Read mode copies the selected document text', async () => {
      const paragraph = frame.locator('#editable-paragraph');
      await paragraph.click();
      await paragraph.selectText();
      const fallback = await frame.evaluate(() => {
        const data = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        return {
          prevented: event.defaultPrevented,
          text: data.getData('text/plain'),
          html: data.getData('text/html'),
        };
      });
      assert(fallback.prevented && fallback.text === 'Edit this sentence and save one snapshot.',
        `frame copy fallback did not preserve selected text: ${JSON.stringify(fallback)}`);
      assert(/Edit this sentence/.test(fallback.html), 'frame copy fallback omitted HTML content');
      await page.keyboard.press(`${PRIMARY_MODIFIER}+c`);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert(copied === 'Edit this sentence and save one snapshot.',
        `Read copy returned the wrong text: ${JSON.stringify(copied)}`);
    });

    await test('Comment mode turns a selection into a composer', async () => {
      await chooseMode(page, 'Comment');
      await selectParagraph(frame);
      await page.locator('.tdoc-popup').waitFor({ timeout: 2_000 });
      await page.locator('.tdoc-popup button.x').click();
    });

    await test('Comment mode visibly paints a selection before mouseup', async () => {
      const liveState = await frame.evaluate(() => {
        const paragraph = document.getElementById('editable-paragraph');
        const box = paragraph.getBoundingClientRect();
        paragraph.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: box.left + 28, clientY: box.top + 12,
        }));
        const draggingCursor = getComputedStyle(paragraph).cursor;
        const text = paragraph.firstChild;
        const range = document.createRange();
        range.setStart(text, 0); range.setEnd(text, 9);
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return {
          supported: Boolean(window.CSS?.highlights && window.Highlight),
          painted: Boolean(window.CSS?.highlights?.has('tdoc-selecting')),
          fallback: getComputedStyle(document.getElementById('editable-paragraph'), '::selection').backgroundColor,
          draggingCursor,
        };
      });
      assert(liveState.draggingCursor === 'text',
        `drag selection did not switch to the precise I-beam cursor: ${JSON.stringify(liveState)}`);
      assert(liveState.fallback !== 'rgba(0, 0, 0, 0)' && liveState.fallback !== 'transparent',
        `native live-selection fallback is invisible: ${JSON.stringify(liveState)}`);
      if (liveState.supported) assert(liveState.painted, 'CSS Highlight live selection was not painted');
      await frame.evaluate(() => {
        window.getSelection().removeAllRanges();
        window.dispatchEvent(new Event('blur'));
      });
    });

    await test('Comment mode turns a word click into a precise text anchor', async () => {
      await frame.locator('#editable-paragraph').click({ position: { x: 28, y: 12 } });
      const quote = page.locator('.tdoc-popup .head .h');
      await quote.waitFor({ timeout: 2_000 });
      const selected = await quote.textContent();
      assert(/^"[^"\s]+"$/.test(selected), `word click did not create a compact text anchor: ${selected}`);
      await page.locator('.tdoc-popup button.x').click();
    });

    await test('Edit mode supports bold, italic, undo, and redo shortcuts', async () => {
      await chooseMode(page, 'Edit');
      await frame.locator('[data-tdoc-editor-root]').waitFor();
      const copy = frame.locator('#artifact-copy');

      await copy.click();
      await copy.selectText();
      await page.keyboard.press(`${PRIMARY_MODIFIER}+b`);
      assert(/<(b|strong)>/.test(await copy.innerHTML()), 'primary+B did not apply bold');

      await page.keyboard.press(`${PRIMARY_MODIFIER}+z`);
      assert(!/<(b|strong)>/.test(await copy.innerHTML()), 'primary+Z did not undo bold');
      await page.keyboard.press(`${PRIMARY_MODIFIER}+Shift+z`);
      assert(/<(b|strong)>/.test(await copy.innerHTML()), 'primary+Shift+Z did not redo bold');

      await copy.selectText();
      await page.keyboard.press(`${PRIMARY_MODIFIER}+i`);
      assert(/<(i|em)>/.test(await copy.innerHTML()), 'primary+I did not apply italic');

      await page.keyboard.press(`${PRIMARY_MODIFIER}+z`);
      await page.keyboard.press(`${PRIMARY_MODIFIER}+z`);
      await page.getByText('No changes').waitFor({ timeout: 2_000 });
      assert(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
        'Save stayed enabled after undo returned the document to its baseline');
    });

    await test('returning edited content to the baseline disables Save', async () => {
      const paragraph = frame.locator('#editable-paragraph');
      const original = await paragraph.textContent();
      await paragraph.fill('Temporary edit.');
      await page.getByText('Checking changes...').waitFor({ timeout: 1_000 });
      assert(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
        'Save was enabled before the debounced document diff settled');
      await page.getByText('Unsaved draft').waitFor({ timeout: 2_000 });
      await paragraph.fill(original);
      await page.getByText('No changes').waitFor({ timeout: 2_000 });
      await page.waitForTimeout(450);
      const state = await page.evaluate(() => ({
        status: document.querySelector('.tdoc-editor-status')?.textContent,
        disabled: document.querySelector('.tdoc-editor-commit .primary')?.disabled,
      }));
      assert(state.disabled, `Save stayed enabled after content matched the baseline again: ${JSON.stringify(state)}`);
    });

    await test('typing markdown at the start of a block formats it, and undo restores the marks', async () => {
      await chooseMode(page, 'Edit');
      await frame.locator('#markdown-paragraph').click();
      await frame.evaluate(() => {
        const paragraph = document.getElementById('markdown-paragraph');
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.keyboard.type('## ');
      const markdownState = await frame.evaluate(() => {
        const heading = document.querySelector('[data-tdoc-editor-root] h2');
        const link = heading && heading.querySelector('a');
        return {
          hasMarkdown: typeof window.tdocEditMarkdown,
          heading: heading ? heading.textContent : null,
          linkHref: link ? link.getAttribute('href') : null,
          emphasis: Boolean(link && link.querySelector('em')),
        };
      });
      assert(markdownState.hasMarkdown === 'object' && /Type markdown here/.test(markdownState.heading || ''),
        `## space did not turn the block into an h2: ${JSON.stringify(markdownState)}`);
      assert(markdownState.linkHref === 'https://example.com/markdown' && markdownState.emphasis,
        `block conversion flattened existing inline HTML: ${JSON.stringify(markdownState)}`);
      await page.keyboard.press(`${PRIMARY_MODIFIER}+z`);
      const afterUndo = await frame.evaluate(() => {
        const node = document.getElementById('markdown-paragraph');
        return { tag: node && node.tagName, text: node && node.textContent };
      });
      assert(afterUndo.tag === 'P' && /##/.test(afterUndo.text || ''),
        `undo did not restore the markdown marks: ${JSON.stringify(afterUndo)}`);
    });

    await test('Edit mode survives an immediate refresh and waits for explicit Save', async () => {
      await chooseMode(page, 'Edit');
      await frame.locator('[data-tdoc-editor-root]').waitFor();
      const editability = await frame.evaluate(() => ({
        artifact: document.getElementById('artifact-copy').isContentEditable,
        explicitAtomic: document.getElementById('edit-atomic').isContentEditable,
      }));
      assert(editability.artifact, 'commentable artifact copy was incorrectly locked in Edit mode');
      assert(!editability.explicitAtomic, 'explicit editing-atomic widget was editable');
      await frame.locator('#editable-paragraph').click();
      await frame.locator('#editable-paragraph').press('Meta+A');
      await frame.locator('#editable-paragraph').fill('A draft that survives reload.');
      assert(!fs.existsSync(path.join(docRoot, 'v2')), 'a keystroke created v2 before Save');

      // Do not wait for the 350ms comparison debounce: recovery persistence is
      // required to happen on the input turn, before an automatic refresh.
      await page.reload({ waitUntil: 'networkidle' });
      const reloadedFrame = page.frames().find((candidate) => candidate.url().includes('/frame'));
      await chooseMode(page, 'Edit');
      await page.waitForFunction(() => {
        const iframe = document.querySelector('.tdoc-doc-frame');
        return iframe && iframe.contentWindow;
      });
      await page.waitForTimeout(300);
      assert(await reloadedFrame.locator('#editable-paragraph').textContent() === 'A draft that survives reload.',
        'browser draft was not restored after reload');

      await reloadedFrame.locator('#editable-paragraph').selectText();
      await page.getByRole('button', { name: 'Bold' }).click();
      await page.getByRole('button', { name: 'Add link' }).click();
      await page.locator('#tdoc-editor-link-url').fill('https://example.com/edited');
      await page.getByRole('button', { name: 'Add link', exact: true }).last().click();
      await page.screenshot({ path: path.join(os.tmpdir(), 'tdoc-browser-editing-desktop.png'), fullPage: false });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const firstPublish = page.getByRole('button', { name: 'Save and publish' });
      if (await firstPublish.isVisible().catch(() => false)) await firstPublish.click();
      await page.waitForURL(/\/v\/2/, { timeout: 8_000 });
      await page.waitForLoadState('networkidle');
      assert(fs.existsSync(path.join(docRoot, 'v2', 'index.html')), 'explicit Save did not create v2');
      const saved = fs.readFileSync(path.join(docRoot, 'v2', 'index.html'), 'utf8');
      assert(/<(b|strong)>/.test(saved) && saved.includes('A draft that survives reload.'), 'bold formatting was not saved');
      assert(/href="https:\/\/example\.com\/edited"/.test(saved), 'link formatting was not saved');
      assert(!/data-tdoc-provider|data-tdoc-editor|tdoc-frame-probe/.test(saved),
        'provider/editor markup leaked into the author snapshot');
    });

    await test('stale Save shows a conflict and keeps the browser draft', async () => {
      await chooseMode(page, 'Edit');
      const v2Frame = page.frames().find((candidate) => candidate.url().includes('/frame'));
      await v2Frame.locator('#editable-paragraph').click();
      await v2Frame.locator('#editable-paragraph').press('Meta+A');
      await v2Frame.locator('#editable-paragraph').fill('Unsaved stale draft.');
      try {
        await page.getByText('Unsaved draft').waitFor({ timeout: 2_000 });
      } catch (error) {
        const state = await v2Frame.evaluate(() => ({
          editing: document.documentElement.hasAttribute('data-tdoc-editing'),
          root: document.querySelector('[data-tdoc-editor-root]')?.tagName || null,
          text: document.getElementById('editable-paragraph')?.textContent,
        }));
        const shell = await page.evaluate(() => ({
          status: document.querySelector('.tdoc-editor-status')?.textContent,
          disabled: document.querySelector('.tdoc-editor-commit .primary')?.disabled,
        }));
        throw new Error(`${error.message}; frame=${JSON.stringify(state)} shell=${JSON.stringify(shell)}`);
      }
      const external = await context.request.post(`http://127.0.0.1:${port}/api/doc/versions`, {
        data: {
          slug, baseVersion: 2,
          html: '<!doctype html><html><body><main><p>External v3</p></main></body></html>',
        },
      });
      assert(external.status() === 200, `external save failed with ${external.status()}`);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const again = page.getByRole('button', { name: 'Save and publish' });
      if (await again.isVisible().catch(() => false)) await again.click();
      await page.getByRole('heading', { name: 'A newer version exists' }).waitFor({ timeout: 3_000 });
      assert(await v2Frame.locator('#editable-paragraph').textContent() === 'Unsaved stale draft.',
        'conflict discarded the in-frame draft');
      assert(fs.existsSync(path.join(docRoot, 'v3')), 'external writer did not create v3');
      assert(!fs.existsSync(path.join(docRoot, 'v4')), 'stale browser save created v4');
    });

    await test('mobile editor chrome fits without horizontal overflow', async () => {
      await page.getByRole('button', { name: 'Keep editing' }).click();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(200);
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        toolbarWidth: Math.round(document.querySelector('.tdoc-editor-toolbar').getBoundingClientRect().width),
        modeWidth: Math.round(document.querySelector('.tdoc-mode-trigger').getBoundingClientRect().width),
        modeLabelDisplay: getComputedStyle(document.querySelector('.tdoc-mode-label')).display,
        versionDisplay: getComputedStyle(document.querySelector('#tdoc-version-toggle')).display,
        publishDisplay: getComputedStyle(document.querySelector('#tdoc-publish-btn')).display,
        themeDisplay: getComputedStyle(document.querySelector('#tdoc-theme-btn')).display,
        accountDisplay: getComputedStyle(document.querySelector('.tdoc-account-trigger')).display,
      }));
      assert(dimensions.scrollWidth <= dimensions.innerWidth + 1,
        `mobile shell overflows: ${JSON.stringify(dimensions)}`);
      assert(dimensions.modeWidth === 44 && dimensions.modeLabelDisplay === 'none',
        `mobile mode control did not collapse to one icon: ${JSON.stringify(dimensions)}`);
      assert(['versionDisplay', 'publishDisplay', 'themeDisplay', 'accountDisplay'].every((key) => dimensions[key] === 'none'),
        `secondary controls leaked into the mobile primary bar: ${JSON.stringify(dimensions)}`);
      await page.getByRole('button', { name: /Document mode:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Comment' }).waitFor();
      await page.screenshot({ path: path.join(os.tmpdir(), 'tdoc-browser-editing-mobile.png'), fullPage: false });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.locator('.ui-menu-popup').waitFor();
      const moreLabels = await page.locator('.ui-menu-popup .ui-menu-item').allTextContents();
      for (const label of ['Publish', 'Copy as Markdown', 'My docs', 'Sign out']) {
        assert(moreLabels.some((value) => value.trim() === label), `${label} missing from mobile More: ${moreLabels.join(', ')}`);
      }
      assert(moreLabels.some((value) => /^Versionsv\d+$/.test(value.trim())), `version submenu missing from mobile More: ${moreLabels.join(', ')}`);
      assert(moreLabels.some((value) => /^(Dark|Light) mode$/.test(value.trim())), `theme missing from mobile More: ${moreLabels.join(', ')}`);
      await page.screenshot({ path: path.join(os.tmpdir(), 'tdoc-mobile-topbar.png'), fullPage: false });
      await page.locator('.tdoc-version-submenu-trigger').click();
      const versionPopup = page.locator('.tdoc-version-submenu');
      await versionPopup.waitFor();
      assert(/v2 · current/.test(await versionPopup.locator('.tdoc-version-item.current').textContent()),
        'current version missing from mobile version submenu');
      assert(await versionPopup.evaluate((popup) => getComputedStyle(popup).overflowY) === 'auto',
        'mobile version submenu is not scrollable');
      await page.screenshot({ path: path.join(os.tmpdir(), 'tdoc-mobile-version-submenu.png'), fullPage: false });
    });
    // Last on purpose: it navigates away from the doc every test above shares.
    await test('Move anchor lands the new anchor while the card stays open', async () => {
      // Re-anchoring keeps the card open so the author can click the new spot.
      // Counting that as "something is open" swallowed the click, and the anchor
      // silently never moved — no error, no toast, nothing to notice.
      // The mobile test above leaves the viewport at phone width, where comments
      // live in a drawer rather than the margin rail.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`http://127.0.0.1:${port}/d/${anchorSlug}/v/1`, { waitUntil: 'networkidle' });
      const anchorFrame = page.frames().find((candidate) => candidate.url().includes('/frame'));
      assert(anchorFrame, 'author frame missing on the move-anchor doc');
      // The pin is the signal that comments loaded AND the anchor resolved.
      // Clicking the word before that lands on plain prose and opens a composer.
      await page.locator('.tdoc-pin').first().waitFor();
      // Mode carries across the navigation, and the tests above end in Edit —
      // where a click on an anchor is a caret, not a comment.
      await chooseMode(page, 'Comment');
      const box = await page.locator('.tdoc-doc-frame').boundingBox();
      const wordAt = (word) => anchorFrame.evaluate((needle) => {
        const text = document.querySelector('#anchor-paragraph').firstChild;
        const from = text.nodeValue.indexOf(needle);
        const range = document.createRange();
        range.setStart(text, from); range.setEnd(text, from + needle.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, word);
      const clickWord = async (word) => {
        const point = await wordAt(word);
        await page.mouse.click(box.x + point.x, box.y + point.y);
        await page.waitForTimeout(400);
      };

      // The card only renders once it is open, so open it from its anchor first.
      await clickWord('charlie');
      const reanchor = page.locator('.tdoc-reanchor-btn').first();
      await reanchor.waitFor().catch(async () => {
        const seen = await page.evaluate(() => [...document.querySelectorAll('[class*="tdoc-"]')]
          .map((node) => node.className)
          .filter((name) => typeof name === 'string' && /comment|drawer|popup/.test(name)));
        throw new Error(`clicking the anchor did not open its card; saw ${JSON.stringify(seen)}`);
      });
      await reanchor.click();
      await page.locator('.tdoc-reanchor-banner').waitFor();
      // The banner renders before the frame has been told it is re-anchoring;
      // clicking into that gap picks nothing and the anchor never moves. Caught
      // as a 1-in-2 flake, not a failure.
      await page.waitForTimeout(300);
      await clickWord('hotel');

      await page.waitForFunction(async (slugName) => {
        const list = await (await fetch(`/api/comments?slug=${slugName}&version=1`)).json();
        return list.some((entry) => entry.anchor && entry.anchor.text === 'hotel');
      }, anchorSlug, { timeout: 10_000 }).catch(() => {});

      const anchors = await page.evaluate(async (slugName) => {
        const list = await (await fetch(`/api/comments?slug=${slugName}&version=1`)).json();
        return list.map((entry) => entry.anchor && entry.anchor.text);
      }, anchorSlug);
      assert(anchors.includes('hotel'),
        `Move anchor did not land: anchors are ${JSON.stringify(anchors)}`);
    });
  } finally {
    if (browser) await browser.close();
    try { server.kill('SIGTERM'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
