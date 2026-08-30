// Browser acceptance for provider-owned Read / Comment / Edit modes.
// Run with: node test/browser-editing.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
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
<section id="comment-artifact" data-tdoc-artifact><p id="artifact-copy">Commentable artifact copy.</p></section>
<section id="edit-atomic" data-tdoc-edit-atomic><p>Explicitly locked widget copy.</p></section>
<img alt="Atomic artifact" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
</main></body></html>`);
  fs.writeFileSync(path.join(docRoot, 'meta.json'), JSON.stringify({
    slug, title: 'Browser editing', versions: [{ n: 1, created: new Date().toISOString() }],
  }, null, 2));

  const port = 7987;
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
      await page.getByRole('button', { name: 'Document mode: Comment' }).waitFor();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      const cursor = await frame.evaluate(() => getComputedStyle(document.body).cursor);
      assert(cursor.includes('data:image/svg+xml') && cursor.includes('crosshair'),
        `Comment mode did not expose its chat cursor: ${cursor}`);
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

    await test('Edit mode keeps changes in a recoverable draft until explicit Save', async () => {
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
      await page.waitForTimeout(500);
      assert(!fs.existsSync(path.join(docRoot, 'v2')), 'a keystroke created v2 before Save');

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
      await page.waitForURL(/\/v\/2$/, { timeout: 5_000 });
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
      }));
      assert(dimensions.scrollWidth <= dimensions.innerWidth + 1,
        `mobile shell overflows: ${JSON.stringify(dimensions)}`);
      assert(dimensions.modeWidth <= 34 && dimensions.modeLabelDisplay === 'none',
        `mobile mode control did not collapse to one icon: ${JSON.stringify(dimensions)}`);
      await page.getByRole('button', { name: /Document mode:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Comment' }).waitFor();
      await page.screenshot({ path: path.join(os.tmpdir(), 'tdoc-browser-editing-mobile.png'), fullPage: false });
    });
  } finally {
    if (browser) await browser.close();
    try { server.kill('SIGTERM'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
