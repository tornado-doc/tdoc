// Plain tables in a doc fit the reader, in the real shell, desktop and phone
// (Julie 2026-11-11: "I have to scroll sideways for lots of content").
//   - a standard table's columns share the width and long text wraps; one the
//     reading column cramps takes the page width beside it (up to 1200px); a
//     small table stays in the column
//   - only a table that still cannot fit scrolls, its first column held
//   - on a phone a table of more than three columns is one card per row,
//     "Column: value" lines under the first cell as a title
//   - none of it touches the author's HTML (the stored file and the served
//     elements' attributes are unchanged), print keeps the author's layout,
//     and tables the author laid out are left alone: a custom design, a table
//     with its own class or style, one in a figure, data-tdoc-table="fixed"
//   - data-tdoc-wide lets a block in a custom design take the page width
// Screenshots: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('table-fit-ui.test.js');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

const services = ['Checkout API', 'Search indexer', 'Notifications', 'Billing export', 'Auth gateway'];
const rows8 = services.map((s, k) => `<tr><td>${s}</td><td>Owner ${k + 1}</td><td>eu-west-2</td><td>${80 + k * 40} ms p95</td><td>0.${k + 1}%</td><td>Nov ${18 + k}</td><td>Route back to the old region with DNS weights and keep the old cluster warm for 72 hours after the cut-over.</td><td>Ready</td></tr>`).join('');
const head8 = '<thead><tr><th>Service</th><th>Owner</th><th>Region</th><th>Latency budget</th><th>Error budget</th><th>Window</th><th>Fallback plan</th><th>Status</th></tr></thead>';
const table8 = (attrs = '') => `<div class="tdoc-table-scroll"><table${attrs}>${head8}<tbody>${rows8}</tbody></table></div>`;
const small = '<div class="tdoc-table-scroll"><table><thead><tr><th>Owner</th><th>Team</th></tr></thead><tbody><tr><td>Ana</td><td>Payments</td></tr><tr><td>Bo</td><td>Search</td></tr></tbody></table></div>';
const many = `<div class="tdoc-table-scroll"><table><thead><tr>${Array.from({ length: 22 }, (_, i) => `<th>Metric ${i + 1}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 4 }, (_, r) => `<tr>${Array.from({ length: 22 }, (_, i) => `<td>${i ? `value_${r}_${i}_unbreakable` : `Row ${r + 1}`}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const page = (body, root = ' data-tdoc-design="tdoc"', css = '') => `<!doctype html><html lang="en"${root}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rollout</title>${css ? `<style>${css}</style>` : ''}</head><body><main class="wrap"><h1>Q4 rollout plan</h1><p>Eight services move to the new region this quarter.</p>${body}<p>Questions go to the rollout channel.</p></main></body></html>`;

const DOCS = {
  fit: page(table8() + '<h2>Owners</h2>' + small),
  many: page(many),
  styled: page(table8(' class="pricing"') + table8(' style="width:100%"') + '<figure>' + table8() + '<figcaption>In a figure</figcaption></figure>' + table8(' data-tdoc-table="fixed"'), ' data-tdoc-design="tdoc"', '.pricing td{color:#333}'),
  custom: page(table8() + '<figure data-tdoc-wide><div style="height:40px;background:#eee"></div><figcaption>Wide figure</figcaption></figure>', ' data-tdoc-design="custom"', 'main{max-width:560px;margin:0 auto}'),
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-table-fit-'));
  for (const [slug, html] of Object.entries(DOCS)) {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: slug, versions: [{ n: 1, created: new Date().toISOString() }] }));
  }
  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await new Promise((ok, no) => http.get(`${base}/`, (r) => { r.resume(); ok(); }).on('error', no)); break; } catch { await new Promise((r) => setTimeout(r, 80)); }
  }
  const browser = await chromium.launch();
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  async function open(ctx, slug) {
    const p = await ctx.newPage();
    await p.goto(`${base}/d/${slug}/v/1`);
    await p.frameLocator('iframe[aria-label="Document content"]').locator('h1').waitFor({ timeout: 15000 });
    const frame = p.frames().find((f) => f.url().includes('/frame'));
    await frame.waitForFunction(() => (document.querySelector('style#tdoc-provider-table-layout') || {}).textContent);
    await p.waitForTimeout(400);
    return { p, frame };
  }
  // Per table: its wrapper's box, the column's width, whether it scrolls, how it displays.
  const tables = (frame) => frame.evaluate(() => [...document.querySelectorAll('table')].map((t) => {
    const w = t.parentElement, main = document.querySelector('main');
    const long = [...t.querySelectorAll('td')].find((td) => td.textContent.length > 60);
    return { w: Math.round(w.getBoundingClientRect().width), left: Math.round(w.getBoundingClientRect().left), col: main.clientWidth, vw: innerWidth,
      scrolls: w.scrollWidth > w.clientWidth + 1, display: getComputedStyle(t).display, row: getComputedStyle(t.rows[1] || t.rows[0]).display,
      lines: long ? Math.round(long.getBoundingClientRect().height / parseFloat(getComputedStyle(long).lineHeight)) : 0,
      sticky: getComputedStyle(t.rows[1] ? t.rows[1].cells[0] : t.rows[0].cells[0]).position,
      label: t.rows[1] && t.rows[1].cells[1] ? getComputedStyle(t.rows[1].cells[1], '::before').content : '' };
  }));
  const overflow = (frame) => frame.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log('plain tables fit the reader');
  try {
    await test('desktop: an 8-column table takes the page width beside the column, fits and wraps; a small table stays in the column', async () => {
      const { p, frame } = await open(desktop, 'fit');
      const [wide, two] = await tables(frame);
      assert(wide.w > wide.col + 200 && wide.w <= 1200 && !wide.scrolls && wide.lines >= 2, `wide: ${JSON.stringify(wide)}`);
      assert(wide.left >= 24 && wide.left + wide.w <= wide.vw - 24, `within the page: ${JSON.stringify(wide)}`);
      assert(two.w <= two.col + 1 && !two.scrolls, `small: ${JSON.stringify(two)}`);
      assert(await overflow(frame) <= 1, 'no sideways page scroll');
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, 'table-fit-desktop.png'), fullPage: true }); }
      // Print keeps the author's layout: no page width, no cards.
      await p.emulateMedia({ media: 'print' });
      const [printed] = await tables(frame);
      assert(printed.w <= printed.col + 1, `print: ${JSON.stringify(printed)}`);
      await p.close();
    });

    await test('desktop: a table too wide to fit even at the page width scrolls, its first column held', async () => {
      const { p, frame } = await open(desktop, 'many');
      const [t] = await tables(frame);
      assert(t.scrolls && t.w <= 1200 && t.sticky === 'sticky', JSON.stringify(t));
      assert(await overflow(frame) <= 1, 'the page itself does not scroll sideways');
      await p.close();
    });

    await test('phone: more than three columns read as one card per row, labelled; two columns stay a table', async () => {
      const { p, frame } = await open(phone, 'fit');
      const [wide, two] = await tables(frame);
      assert(wide.display === 'block' && wide.row === 'block' && !wide.scrolls && wide.label === '"Owner: "', `cards: ${JSON.stringify(wide)}`);
      assert(two.display === 'table', `two columns: ${JSON.stringify(two)}`);
      assert(await overflow(frame) <= 1, 'no sideways page scroll');
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'table-fit-phone.png'), fullPage: true });
      await p.emulateMedia({ media: 'print' });
      assert((await tables(frame))[0].display === 'table', 'print: a table, not cards');
      await p.close();
    });

    await test('tables the author laid out are left alone: own class, own style, in a figure, data-tdoc-table="fixed", a custom design', async () => {
      for (const ctx of [desktop, phone]) {
        for (const slug of ['styled', 'custom']) {
          const { p, frame } = await open(ctx, slug);
          const list = await tables(frame);
          for (const t of list) assert(t.w <= t.col + 1 && t.display === 'table' && t.sticky !== 'sticky', `${slug}: ${JSON.stringify(t)}`);
          await p.close();
        }
      }
    });

    await test('data-tdoc-wide gives a block in a custom design the page width', async () => {
      const { p, frame } = await open(desktop, 'custom');
      const w = await frame.evaluate(() => ({ fig: document.querySelector('figure').getBoundingClientRect().width, col: document.querySelector('main').clientWidth }));
      assert(w.fig > w.col + 300, JSON.stringify(w));
      await p.close();
    });

    await test('the author\'s HTML is untouched: the stored file and the served elements\' attributes', async () => {
      for (const slug of Object.keys(DOCS)) {
        const file = path.join(root, slug, 'v1', 'index.html');
        const before = fs.readFileSync(file, 'utf8');
        for (const ctx of [desktop, phone]) {
          const { p, frame } = await open(ctx, slug);
          await p.setViewportSize({ width: ctx === desktop ? 1000 : 360, height: 800 });
          await p.waitForTimeout(300);
          const same = await frame.evaluate((src) => {
            const attrs = (root) => [...root.querySelectorAll('main table, main th, main td, main tr, main .tdoc-table-scroll, main figure')]
              .filter((e) => !e.closest('[data-tdoc-provider]'))
              .map((e) => e.localName + ':' + e.getAttributeNames().filter((a) => a !== 'data-tdoc-aid').sort().join(',') + ':' + (e.getAttribute('style') || ''));
            const a = attrs(document), b = attrs(new DOMParser().parseFromString(src, 'text/html'));
            return { ok: JSON.stringify(a) === JSON.stringify(b), a: a.slice(0, 6), b: b.slice(0, 6) };
          }, before);
          assert(same.ok, `${slug}: ${JSON.stringify(same)}`);
          await p.close();
        }
        assert(fs.readFileSync(file, 'utf8') === before, `${slug}: stored file unchanged`);
      }
    });
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
