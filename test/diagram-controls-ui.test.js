const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const frameProbeSource = require('../server/frame-probe-source');

// Reproduce maui-trip/v/5: author styles size the map's SVG, but also match
// the provider's pencil icon inside that same figure.
const fixture = `<!doctype html><html><head><style>
${fs.readFileSync(path.join(__dirname, '../server/reader.css'), 'utf8')}
body { margin:0; }
.wrap { box-sizing:border-box; padding:24px; }
.diagram-box { overflow-x:auto; margin:24px 0; }
.diagram-box svg { display:block; height:auto; }
#fig-map svg { width:672px; min-width:640px; max-width:none !important; }
#fig-map [data-tdoc-diagram-snapshot] { overflow-x:auto; }
</style></head><body><main class="wrap"><h2>Where things are</h2>
<p>The map stays wide enough to read; its controls stay compact.</p>
<figure id="fig-map" class="diagram-box" data-tdoc-artifact="Map"
 aria-label="Map" data-tdoc-excalidraw='{"type":"excalidraw","elements":[]}'>
<div data-tdoc-diagram-snapshot><svg viewBox="0 0 672 200" role="img" aria-label="Map snapshot">
<rect x="1" y="1" width="670" height="198" fill="#dde7f9" stroke="#a9c0ee"/>
<text x="24" y="60" font-family="sans-serif" font-size="22">Map snapshot</text>
</svg></div></figure></main></body></html>`;

(async () => {
  const engine = process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent('<iframe title="Document content" sandbox="allow-scripts" style="border:0;width:100%;height:780px"></iframe><style>body{margin:0}</style>');
      const frame = page.frames()[1];
      await frame.setContent(fixture);
      await frame.addScriptTag({ content: frameProbeSource() });
      const button = frame.getByRole('button', { name: 'Edit diagram', exact: true });
      await button.waitFor();
      for (const mode of ['read', 'comment', 'edit']) {
        await page.evaluate(mode => document.querySelector('iframe').contentWindow.postMessage(
          { source: 'tdoc-shell', type: 'tdoc:mode', mode }, '*'), mode);
        await frame.locator(`html[data-tdoc-interaction-mode="${mode}"]`).waitFor();
        const geometry = await button.evaluate(button => {
          const icon = button.querySelector('svg');
          const range = document.createRange();
          range.selectNodeContents(button.querySelector('span'));
          const box = button.getBoundingClientRect();
          const iconBox = icon.getBoundingClientRect();
          const style = getComputedStyle(icon);
          return {
            width: box.width, height: box.height, left: box.left, right: box.right,
            iconWidth: iconBox.width, iconHeight: iconBox.height, iconMargin: style.margin,
            lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
          };
        });
        assert.equal(geometry.iconWidth, 16, `${width}px ${mode}: map styles stretched the pencil`);
        assert.equal(geometry.iconHeight, 16, `${width}px ${mode}: pencil height changed`);
        assert.equal(geometry.iconMargin, '0px', 'reader imagery margins must not pad the icon');
        assert(geometry.width < 180 && geometry.height === 44, 'edit action stays compact with a 44px touch target');
        assert.equal(geometry.lines, 1, 'edit label stays on one line');
        assert(geometry.left >= 0 && geometry.right <= width, 'edit action stays reachable on phones');
        assert.equal(await frame.locator('[data-tdoc-diagram-snapshot] > svg').evaluate(
          svg => svg.getBoundingClientRect().width), 672, 'author map dimensions remain intact');
        if (mode === 'read' && process.env.TDOC_TEST_SCREENSHOTS) {
          fs.mkdirSync(process.env.TDOC_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.TDOC_TEST_SCREENSHOTS,
            `diagram-controls-${process.env.TDOC_TEST_BROWSER || 'chromium'}-${width}-read.png`) });
        }
      }
      if (process.env.TDOC_TEST_SCREENSHOTS) {
        fs.mkdirSync(process.env.TDOC_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TDOC_TEST_SCREENSHOTS,
          `diagram-controls-${process.env.TDOC_TEST_BROWSER || 'chromium'}-${width}.png`) });
      }
      // The button still sends the original figure identity and scene to the shell.
      await page.evaluate(() => {
        window.diagramMessages = [];
        window.addEventListener('message', event => {
          if (event.data.type === 'tdoc:diagramOpen') window.diagramMessages.push(event.data);
        });
      });
      await button.click();
      await page.waitForFunction(() => window.diagramMessages.length === 1);
      assert.equal(await page.evaluate(() => window.diagramMessages[0].id), 'fig-map');
      console.log(`✓ compact diagram action, intact snapshot and working click at ${width}px`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
