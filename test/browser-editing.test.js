// Browser acceptance for provider-owned Read / Comment / Edit modes.
// Run with: node test/browser-editing.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('browser-editing.test.js');

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
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const url = `http://127.0.0.1:${port}/d/${slug}/v/1`;
    await page.goto(url, { waitUntil: 'networkidle' });
    const frame = page.frames().find((candidate) => candidate.url().includes('/frame'));
    assert(frame, 'author frame missing');

    await test('Read mode opens existing anchors but does not create a comment selection', async () => {
      await selectParagraph(frame);
      await page.waitForTimeout(150);
      assert(await page.locator('.tdoc-popup').count() === 0, 'Read selection opened the comment composer');
    });

    await test('Comment mode turns a selection into a composer', async () => {
      await page.getByRole('radio', { name: 'Comment' }).click();
      await selectParagraph(frame);
      await page.locator('.tdoc-popup').waitFor({ timeout: 2_000 });
      await page.locator('.tdoc-popup button.x').click();
    });

    await test('Edit mode keeps changes in a recoverable draft until explicit Save', async () => {
      await page.getByRole('radio', { name: 'Edit' }).click();
      await frame.locator('#editable-paragraph').click();
      await frame.locator('#editable-paragraph').press('Meta+A');
      await frame.locator('#editable-paragraph').fill('A draft that survives reload.');
      await page.waitForTimeout(500);
      assert(!fs.existsSync(path.join(docRoot, 'v2')), 'a keystroke created v2 before Save');

      await page.reload({ waitUntil: 'networkidle' });
      const reloadedFrame = page.frames().find((candidate) => candidate.url().includes('/frame'));
      await page.getByRole('radio', { name: 'Edit' }).click();
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
      await page.getByRole('radio', { name: 'Edit' }).click();
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
      }));
      assert(dimensions.scrollWidth <= dimensions.innerWidth + 1,
        `mobile shell overflows: ${JSON.stringify(dimensions)}`);
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
