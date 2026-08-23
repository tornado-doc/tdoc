// Acceptance / boundary test for the cross-origin iframe "shell" architecture.
// See PLAN.md. Run with: node test/artifact-shell.test.js
//
// This is the DEFINITION OF DONE for the re-arch. It boots the local server
// against the committed `hostile-body-css` fixture (author sets max-width,
// margin, padding, background:#000, display:flex, transform, :root token on
// <body>) and asserts, in SHELL mode (?shell=1):
//
//   #1 ISOLATION   — the overlay top bar spans the full viewport and is not
//                    shrunk/recolored/moved by the author's body CSS, because
//                    the author document lives in an isolated (sandboxed,
//                    opaque-origin) iframe and the chrome lives in the shell.
//   #2 COMMENTS    — selecting text inside the iframe opens the composer in the
//                    shell (proves the postMessage anchoring bridge works).
//   #3 MOBILE      — narrow viewport: iframe fills width, comments in a drawer.
//
// It FAILS on main (no shell path) and PASSES when the architecture lands.
// Each phase flips one block from red to green.

const { requirePlaywrightOrSkip, resolveTarget } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('artifact-shell.test.js');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }

const SLUG = 'hostile-body-css';

(async () => {
  const target = await resolveTarget({ port: 7992 });
  const base = target.url.replace(/\/d\/.*/, '');
  const shellUrl = `${base}/d/${SLUG}/v/1?shell=1`;
  console.log(`artifact-shell boundary — ${shellUrl}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  try {
    await page.goto(shellUrl, { waitUntil: 'networkidle' });

    // --- #1 ISOLATION ---------------------------------------------------------
    await t('shell embeds the author document in an isolated iframe', async () => {
      const n = await page.evaluate(() =>
        [...document.querySelectorAll('iframe')].filter(f => /\/frame\b|\/d\//.test(f.src || '')).length);
      if (n < 1) throw new Error('no author-content iframe found in the shell document');
    });

    await t('the isolated iframe is sandboxed (opaque origin)', async () => {
      const sandbox = await page.evaluate(() => {
        const f = [...document.querySelectorAll('iframe')].find(f => /\/frame\b|\/d\//.test(f.src || ''));
        return f && f.getAttribute('sandbox');
      });
      if (!sandbox || !/allow-scripts/.test(sandbox) || /allow-same-origin/.test(sandbox)) {
        throw new Error(`iframe sandbox must be opaque-origin ("allow-scripts", no "allow-same-origin"); got ${JSON.stringify(sandbox)}`);
      }
    });

    await t('top bar spans the full viewport regardless of hostile body CSS', async () => {
      const bar = await page.evaluate(() => {
        const b = document.querySelector('.tdoc-bar');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
      });
      if (!bar) throw new Error('no .tdoc-bar in the shell document');
      if (bar.left > 4 || bar.right < bar.vw - 4) {
        throw new Error(`top bar ${bar.left}..${bar.right} does not span the ${bar.vw}px viewport — author body CSS leaked into chrome`);
      }
    });

    await t('author body CSS does not leak into the shell (background/font)', async () => {
      const leaked = await page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return { bg: cs.backgroundColor, font: cs.fontFamily, accent: getComputedStyle(document.documentElement).getPropertyValue('--td-accent').trim() };
      });
      // The author set body{background:#000}, Comic Sans, and --td-accent:#ff00ff.
      if (leaked.bg === 'rgb(0, 0, 0)') throw new Error('author body background:#000 leaked into the shell body');
      if (/comic sans/i.test(leaked.font)) throw new Error('author font leaked into the shell body');
      if (leaked.accent === '#ff00ff') throw new Error('author --td-accent token leaked into the shell');
    });

    // --- #2 COMMENTS ACROSS THE BOUNDARY -------------------------------------
    await t('selecting text inside the iframe opens the composer in the shell', async () => {
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      if (!frame) throw new Error('author-content frame not found');
      // Select the first paragraph's text inside the iframe.
      await frame.evaluate(() => {
        const p = document.getElementById('para-1');
        const r = document.createRange();
        r.selectNodeContents(p);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        const rect = p.getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mouseup', {
          clientX: rect.left + 20, clientY: rect.top + 8, bubbles: true, cancelable: true, view: window, button: 0,
        }));
      });
      await page.waitForSelector('.tdoc-popup', { timeout: 2000 });
    });

    // --- #2b EXISTING COMMENTS RENDER AS PINS --------------------------------
    await t('an existing text-anchored comment renders a pin in the shell', async () => {
      // Fresh load so the shell fetches comments, hands anchors to the probe,
      // and the probe resolves + reports pin positions back across the boundary.
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.tdoc-pin', { timeout: 3000 });
    });

    // --- #3 MOBILE ------------------------------------------------------------
    await t('narrow viewport: comments go to the drawer (fab present)', async () => {
      await page.setViewportSize({ width: 480, height: 900 });
      await page.waitForTimeout(200);
      const narrow = await page.evaluate(() => document.body.classList.contains('tdoc-narrow'));
      if (!narrow) throw new Error('shell did not enter narrow/drawer mode at 480px');
    });

  } finally {
    await browser.close();
    await target.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
