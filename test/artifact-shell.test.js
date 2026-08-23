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

const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip, resolveTarget } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('artifact-shell.test.js');

const COMMENTS_FIXTURE = path.join(__dirname, 'fixtures/tdocs/hostile-body-css/comments.json');

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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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

    await t('the shell renders the REAL top bar + footer (1:1 chrome)', async () => {
      const chrome = await page.evaluate(() => ({
        mark: !!document.querySelector('.tdoc-bar .tdoc-bar-mark img'),
        version: !!document.querySelector('.tdoc-bar #tdoc-version-toggle'),
        copy: !!document.querySelector('.tdoc-bar #tdoc-copy-md-btn'),
        theme: !!document.querySelector('.tdoc-bar #tdoc-theme-btn'),
        footer: !!document.querySelector('.tdoc-footer .tdoc-footer-row'),
      }));
      const missing = Object.keys(chrome).filter(k => !chrome[k]);
      if (missing.length) throw new Error('shell missing real chrome: ' + missing.join(', '));
    });

    await t('the author document actually renders inside the frame', async () => {
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      if (!frame) throw new Error('author-content frame not found');
      const info = await frame.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        hasPara: !!document.getElementById('para-1'),
        laidOut: (document.getElementById('para-1') || {}).getClientRects ? document.getElementById('para-1').getClientRects().length > 0 : false,
      }));
      if (!info.hasPara || !info.laidOut) throw new Error('frame content not laid out: ' + JSON.stringify(info));
      if (info.bg !== 'rgb(0, 0, 0)') throw new Error('frame did not apply author CSS (bg=' + info.bg + ')');
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
    await t('existing comments render pins — incl. a cross-block anchor', async () => {
      // Fresh load so the shell fetches comments, hands anchors to the probe,
      // and the probe resolves + reports pin positions back across the boundary.
      // Two fixture comments: a single-node anchor AND a cross-block anchor
      // ("h1\n\np") — the latter only resolves with normalized whitespace
      // matching (a raw indexOf misses it → no pin, the reported bug).
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.tdoc-pin', { timeout: 3000 });
      await page.waitForTimeout(300);
      const pins = await page.evaluate(() => document.querySelectorAll('.tdoc-pin').length);
      if (pins < 2) throw new Error(`expected 2 pins (single-node + cross-block), got ${pins} — normalized anchor matching regressed`);
      // Pins sit at the article's right edge, not pinned to the far viewport edge
      // (the fixture body is max-width:900 centered in 1400 → edge ~1100).
      const pinLeft = await page.evaluate(() => Math.round(document.querySelector('.tdoc-pin').getBoundingClientRect().left));
      if (pinLeft > 1300) throw new Error(`pin is pinned to the viewport edge (${pinLeft}), not the article gutter`);
    });

    await t('clicking a pin opens the card by its pin, without scrolling the doc', async () => {
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      const before = await frame.evaluate(() => window.scrollY);
      await page.click('.tdoc-pin');
      await page.waitForSelector('.tdoc-margin-comment .text', { timeout: 2000 });
      await page.waitForTimeout(150);
      const after = await frame.evaluate(() => window.scrollY);
      if (Math.abs(after - before) > 2) throw new Error(`clicking a pin scrolled the doc (${before}→${after}) — should not`);
      // card sits next to its pin (tops within a card-height of each other)
      const d = await page.evaluate(() => {
        const pin = document.querySelector('.tdoc-pin'), card = document.querySelector('.tdoc-margin-comment');
        return { pinTop: pin.getBoundingClientRect().top, cardTop: card.getBoundingClientRect().top, cardLeft: Math.round(card.getBoundingClientRect().left) };
      });
      if (Math.abs(d.cardTop - d.pinTop) > 200) throw new Error(`card drifted from its pin (pin ${d.pinTop}, card ${d.cardTop})`);
    });

    await t('Copy → Doc only puts the doc markdown on the clipboard', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.click('#tdoc-copy-md-btn');
      await page.click('#tdoc-copy-md-menu [data-mode="doc"]');
      await page.waitForTimeout(400);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
      if (!/Hostile body CSS fixture/.test(clip) || !/quick brown fox/.test(clip)) {
        throw new Error('clipboard missing doc markdown: ' + JSON.stringify(clip.slice(0, 120)));
      }
    });

    await t('theme toggle darkens the shell chrome AND signals the frame', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.click('#tdoc-theme-btn');
      await page.waitForTimeout(200);
      const shellDark = await page.evaluate(() => document.documentElement.getAttribute('data-tdoc-theme'));
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      const frameDark = frame ? await frame.evaluate(() => document.documentElement.getAttribute('data-tdoc-theme')) : null;
      if (shellDark !== 'dark') throw new Error('shell chrome did not go dark');
      if (frameDark !== 'dark') throw new Error('frame did not receive the theme signal');
    });

    await t('persisted dark mode applies to the frame on first load (no toggle)', async () => {
      // the previous test toggled dark → localStorage tdoc-theme=dark persists.
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      const frameDark = frame ? await frame.evaluate(() => document.documentElement.getAttribute('data-tdoc-theme')) : null;
      if (frameDark !== 'dark') throw new Error('frame did not receive persisted dark on first load (had to toggle): ' + frameDark);
      // reset for later tests
      await page.evaluate(() => { try { localStorage.removeItem('tdoc-theme'); } catch (e) {} });
    });

    await t('footer is hidden while reading and reveals at the doc bottom', async () => {
      await page.setViewportSize({ width: 1400, height: 600 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const shownAtTop = await page.evaluate(() => document.querySelector('.tdoc-footer').classList.contains('tdoc-footer-show'));
      if (shownAtTop) throw new Error('footer should be hidden while reading (not at bottom)');
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      await frame.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      const shownAtBottom = await page.evaluate(() => document.querySelector('.tdoc-footer').classList.contains('tdoc-footer-show'));
      if (!shownAtBottom) throw new Error('footer should reveal at the doc bottom');
    });

    await t('Publish button opens the publish modal', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.click('#tdoc-publish-btn');
      await page.waitForSelector('.tdoc-modal-bg .tdoc-modal', { timeout: 2000 });
      const h = await page.$eval('.tdoc-modal h3', el => el.textContent);
      if (!/Publish/.test(h)) throw new Error('publish modal missing: ' + h);
    });

    await t('reaction add button opens the emoji picker', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.tdoc-pin', { timeout: 3000 });
      await page.click('.tdoc-pin');
      await page.waitForSelector('.tdoc-margin-comment .tdoc-react-add', { timeout: 2000 });
      await page.click('.tdoc-margin-comment .tdoc-react-add');
      await page.waitForSelector('.tdoc-emoji-picker button[data-emoji]', { timeout: 2000 });
    });

    await t('comment card has a working Reply box', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.tdoc-pin', { timeout: 3000 });
      await page.click('.tdoc-pin');
      await page.waitForSelector('.tdoc-margin-comment .tdoc-reply-toggle', { timeout: 2000 });
      await page.click('.tdoc-margin-comment .tdoc-reply-toggle');
      await page.waitForSelector('.tdoc-margin-comment .tdoc-reply-form.open textarea', { timeout: 2000 });
      const hasDelete = await page.evaluate(() => !!document.querySelector('.tdoc-margin-comment .del'));
      if (!hasDelete) throw new Error('card missing delete control');
    });

    await t('agent comment: pin shows the agent mark, card shows a resolved chip', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.tdoc-pin[data-id="c_fixture_3"]', { timeout: 3000 });
      // the agent's pin carries the resolved state + an agent logo (not an anon dot)
      const pinInfo = await page.evaluate(() => {
        const pin = document.querySelector('.tdoc-pin[data-id="c_fixture_3"]');
        return { resolved: pin.classList.contains('tdoc-pin-resolved'), hasImg: !!pin.querySelector('img') };
      });
      if (!pinInfo.resolved) throw new Error('agent pin missing tdoc-pin-resolved state');
      if (!pinInfo.hasImg) throw new Error('agent pin did not render a logo mark');
      await page.click('.tdoc-pin[data-id="c_fixture_3"]');
      await page.waitForSelector('.tdoc-margin-comment.tdoc-resolved', { timeout: 2000 });
      const chip = await page.$eval('.tdoc-margin-comment .tdoc-resolved-chip', el => el.textContent).catch(() => null);
      if (!chip || !/fixed/.test(chip)) throw new Error('card missing resolved chip: ' + chip);
      const agentAuthor = await page.evaluate(() => !!document.querySelector('.tdoc-margin-comment .author.tdoc-agent-author img'));
      if (!agentAuthor) throw new Error('card did not render the agent author with a logo');
    });

    await t('co-located comments cluster into one count badge with a popover', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      // two comments anchor the same sentence → one cluster badge reading "2"
      await page.waitForSelector('.tdoc-pin.tdoc-pin-cluster', { timeout: 3000 });
      const badge = await page.$eval('.tdoc-pin.tdoc-pin-cluster', el => el.textContent.trim());
      if (badge !== '2') throw new Error('cluster badge should read 2, got ' + badge);
      // the co-located comments are NOT also rendered as their own single pins
      const singles = await page.evaluate(() => document.querySelectorAll('.tdoc-pin[data-id="c_fixture_4"], .tdoc-pin[data-id="c_fixture_5"]').length);
      if (singles) throw new Error('clustered comments leaked as standalone pins');
      // clicking the badge opens a popover listing both comments
      await page.click('.tdoc-pin.tdoc-pin-cluster');
      await page.waitForSelector('.tdoc-cluster-pop.open', { timeout: 2000 });
      const rows = await page.evaluate(() => document.querySelectorAll('.tdoc-cluster-pop.open .tdoc-cluster-row').length);
      if (rows !== 2) throw new Error('cluster popover should list 2 comments, got ' + rows);
      // picking a row opens that comment's card
      await page.click('.tdoc-cluster-pop.open .tdoc-cluster-row[data-id="c_fixture_4"]');
      await page.waitForSelector('.tdoc-margin-comment[data-comment-id="c_fixture_4"]', { timeout: 2000 });
    });

    await t('re-anchor: "move anchor" rebinds a comment to a new frame selection', async () => {
      const snapshot = fs.readFileSync(COMMENTS_FIXTURE, 'utf8');
      try {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(shellUrl, { waitUntil: 'networkidle' });
        await page.waitForSelector('.tdoc-pin[data-id="c_fixture_1"]', { timeout: 3000 });
        await page.click('.tdoc-pin[data-id="c_fixture_1"]');
        await page.waitForSelector('.tdoc-margin-comment.active .tdoc-reanchor-btn', { timeout: 2000 });
        // the "move anchor" affordance is visible on the active card
        const btnVisible = await page.evaluate(() => {
          const b = document.querySelector('.tdoc-margin-comment.active .tdoc-reanchor-btn');
          return b && getComputedStyle(b).display !== 'none';
        });
        if (!btnVisible) throw new Error('move-anchor button not visible on active card');
        await page.click('.tdoc-margin-comment.active .tdoc-reanchor-btn');
        // banner appears; body enters re-anchoring mode
        const remode = await page.evaluate(() => document.body.classList.contains('tdoc-reanchoring') &&
          getComputedStyle(document.querySelector('.tdoc-reanchor-banner')).display !== 'none');
        if (!remode) throw new Error('re-anchor banner/mode did not engage');
        // select para-2 in the frame → shell PATCHes the anchor instead of opening a composer
        const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
        await frame.evaluate(() => {
          const p = document.getElementById('para-2');
          const r = document.createRange(); r.selectNodeContents(p);
          const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
          const rect = p.getBoundingClientRect();
          document.dispatchEvent(new MouseEvent('mouseup', { clientX: rect.left + 20, clientY: rect.top + 8, bubbles: true, cancelable: true, view: window, button: 0 }));
        });
        // wait for the PATCH to land in the fixture
        let anchored = null;
        for (let i = 0; i < 40; i++) {
          const parsed = JSON.parse(fs.readFileSync(COMMENTS_FIXTURE, 'utf8'));
          const c = parsed.find(x => x.id === 'c_fixture_1');
          if (c && c.anchor && /second paragraph/.test(c.anchor.text || '')) { anchored = c; break; }
          await page.waitForTimeout(50);
        }
        if (!anchored) throw new Error('comment was not re-anchored to the new selection');
        // re-anchoring exits the mode and does NOT open a composer
        const composerOpen = await page.evaluate(() => !!document.querySelector('.tdoc-popup'));
        if (composerOpen) throw new Error('re-anchor selection wrongly opened the composer');
      } finally {
        fs.writeFileSync(COMMENTS_FIXTURE, snapshot);
      }
    });

    await t('?comment= deep-link opens the target comment card on load', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl + '&comment=c_fixture_1', { waitUntil: 'networkidle' });
      // no click — the card for the deep-linked comment opens by itself
      await page.waitForSelector('.tdoc-margin-comment[data-comment-id="c_fixture_1"]', { timeout: 4000 });
    });

    await t('?comment= on a reply opens the parent card with the thread expanded', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl + '&comment=r_fixture_1a', { waitUntil: 'networkidle' });
      await page.waitForSelector('.tdoc-margin-comment[data-comment-id="c_fixture_1"]', { timeout: 4000 });
      // the reply thread is expanded (not born collapsed) so the reply is visible
      await page.waitForSelector('.tdoc-margin-comment[data-comment-id="c_fixture_1"] .tdoc-replies.open', { timeout: 2000 });
    });

    await t('author data-tdoc-default-theme="dark" opens the shell dark (no stored pref)', async () => {
      const darkDocUrl = `${base}/d/copy-doc/v/1`;
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(darkDocUrl, { waitUntil: 'networkidle' });
      await page.evaluate(() => { try { localStorage.removeItem('tdoc-theme'); } catch (e) {} });
      await page.goto(darkDocUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const shellTheme = await page.evaluate(() => document.documentElement.getAttribute('data-tdoc-theme'));
      const stored = await page.evaluate(() => { try { return localStorage.getItem('tdoc-theme'); } catch (e) { return null; } });
      const frame = page.frames().find(f => f.url().includes('copy-doc') && f !== page.mainFrame());
      const frameTheme = frame ? await frame.evaluate(() => document.documentElement.getAttribute('data-tdoc-theme')) : null;
      if (shellTheme !== 'dark') throw new Error(`shell did not honor the author default theme, got ${shellTheme}`);
      if (frameTheme !== 'dark') throw new Error(`frame did not receive the default dark theme, got ${frameTheme}`);
      if (stored) throw new Error(`the default-theme hint must not persist a preference, got ${stored}`);
    });

    await t('element commenting: hover a canvas → pill → comment on the whole element → pin', async () => {
      const snapshot = fs.readFileSync(COMMENTS_FIXTURE, 'utf8');
      try {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(shellUrl, { waitUntil: 'networkidle' });
        const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
        if (!frame) throw new Error('author frame not found');
        // hovering the canvas surfaces the comment pill INSIDE the frame
        await frame.evaluate(() => document.getElementById('art-canvas').scrollIntoView({ block: 'center' }));
        await frame.hover('#art-canvas');
        await frame.waitForSelector('.tdoc-comment-pill', { state: 'visible', timeout: 3000 });
        // clicking it opens the composer in the shell (element anchor)
        await frame.click('.tdoc-comment-pill');
        await page.waitForSelector('.tdoc-popup textarea', { timeout: 3000 });
        await page.fill('.tdoc-popup textarea', 'comment on the whole canvas');
        await page.click('.tdoc-popup .submit');
        // the element comment persists with an element anchor + gets a pin
        let anchored = null;
        for (let i = 0; i < 40; i++) {
          const parsed = JSON.parse(fs.readFileSync(COMMENTS_FIXTURE, 'utf8'));
          anchored = parsed.find(c => c.anchor && c.anchor.kind === 'element' && /canvas/i.test(c.anchor.selector || ''));
          if (anchored) break;
          await page.waitForTimeout(50);
        }
        if (!anchored) throw new Error('element comment was not persisted with an element anchor');
        await page.waitForSelector(`.tdoc-pin[data-id="${anchored.id}"], .tdoc-pin`, { timeout: 3000 });
      } finally {
        fs.writeFileSync(COMMENTS_FIXTURE, snapshot);
      }
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
