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
const { requirePlaywrightOrSkip, resolveTarget, isPublishedTarget } = require('./helpers/fixture-server');
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
        more: !!document.querySelector('.tdoc-bar #tdoc-more-btn'),   // ⋯ menu (Copy as Markdown lives here now)
        theme: !!document.querySelector('.tdoc-bar #tdoc-theme-btn'),
        footer: !!document.querySelector('.tdoc-footer .tdoc-footer-row'),
      }));
      const missing = Object.keys(chrome).filter(k => !chrome[k]);
      if (missing.length) throw new Error('shell missing real chrome: ' + missing.join(', '));
    });

    await t('portal menus paint above the old-version banner', async () => {
      await page.evaluate(() => {
        const slot = document.createElement('div');
        slot.id = 'test-old-version-slot';
        slot.className = 'tdoc-oldver-slot';
        slot.innerHTML = '<div class="tdoc-oldver-strip tdoc-oldver-visible">Old version</div>';
        document.querySelector('.tdoc-bar').after(slot);
      });
      await page.click('#tdoc-version-toggle');
      await page.waitForSelector('.ui-menu-positioner');
      const layers = await page.evaluate(() => {
        const menu = document.querySelector('.ui-menu-positioner');
        const banner = document.querySelector('#test-old-version-slot .tdoc-oldver-strip');
        const menuRect = menu.getBoundingClientRect();
        const bannerRect = banner.getBoundingClientRect();
        const x = menuRect.left + Math.min(20, menuRect.width / 2);
        const y = bannerRect.top + bannerRect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          menuZ: getComputedStyle(menu).zIndex,
          bannerZ: getComputedStyle(banner).zIndex,
          overlap: menuRect.top < bannerRect.bottom && menuRect.bottom > bannerRect.top,
          hitInsideMenu: !!hit?.closest('.ui-menu-positioner'),
        };
      });
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.getElementById('test-old-version-slot')?.remove());
      if (!layers.overlap) throw new Error('fixture did not reproduce a menu/banner overlap');
      if (!layers.hitInsideMenu) {
        throw new Error(`banner painted over portal menu (menu z=${layers.menuZ}, banner z=${layers.bannerZ})`);
      }
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

    await t('⋯ → Copy as Markdown puts the doc markdown on the clipboard (with toast)', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.click('#tdoc-more-btn');
      await page.waitForSelector('.ui-menu-popup', { timeout: 2000 });
      await page.click('.ui-menu-popup [data-action="copy"]');
      await page.waitForFunction(
        () => [...document.querySelectorAll('div')].some(d => d.textContent === 'Copied as Markdown'),
        null, { timeout: 2000 }
      );
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
      await page.waitForSelector('.ui-dialog-popup', { timeout: 2000 });
      const h = await page.$eval('.ui-dialog-title', el => el.textContent);
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
          try {
            const parsed = JSON.parse(fs.readFileSync(COMMENTS_FIXTURE, 'utf8'));
            const c = parsed.find(x => x.id === 'c_fixture_1');
            if (c && c.anchor && /second paragraph/.test(c.anchor.text || '')) { anchored = c; break; }
          } catch (e) { /* server mid-write; retry */ }
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

    await t('a reply carries its own react + Reply controls, aimed at the reply (#343)', async () => {
      // Between the overlay rewrite and the React port a reply rendered as
      // author + text only: no reaction, no Reply, nowhere to go. The server
      // accepted both all along (parent_id resolves replies, /api/reactions
      // toggles on a reply id) — only the markup was missing.
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl + '&comment=r_fixture_1a', { waitUntil: 'networkidle' });
      const reply = '.tdoc-margin-comment[data-comment-id="c_fixture_1"] .tdoc-reply[data-comment-id="r_fixture_1a"]';
      await page.waitForSelector(reply, { timeout: 4000 });
      const controls = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return {
          react: !!el.querySelector(':scope > .meta .tdoc-react-add'),
          reply: !!el.querySelector(':scope > .meta .tdoc-reply-toggle'),
          stamp: (el.querySelector(':scope > .meta > span')?.textContent || '').trim(),
        };
      }, reply);
      if (!controls.react) throw new Error('reply has no reaction control');
      if (!controls.reply) throw new Error('reply has no Reply control');
      if (!controls.stamp) throw new Error('reply has no timestamp');
      await page.click(`${reply} > .meta .tdoc-reply-toggle`);
      await page.waitForSelector(`${reply} .tdoc-reply-form.open textarea`, { timeout: 2000 });
      const parent = await page.$eval(`${reply} .tdoc-reply-form`, el => el.dataset.parentId);
      if (parent !== 'r_fixture_1a') throw new Error(`reply form targets ${parent}, expected the reply itself`);
      const hint = await page.$eval(`${reply} .tdoc-reply-to`, el => el.textContent);
      if (!/tester2/.test(hint)) throw new Error(`reply form does not name who it answers: "${hint}"`);
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
        // hovering the canvas surfaces the comment pill INSIDE the frame.
        // Dispatch mousemove directly (deterministic — Playwright's hover
        // occasionally raced the probe's listener attach under full-suite load)
        // and retry until the pill is visible.
        await frame.evaluate(() => document.getElementById('art-canvas').scrollIntoView({ block: 'center' }));
        let pillVisible = false;
        for (let i = 0; i < 20 && !pillVisible; i++) {
          await frame.evaluate(() => {
            const c = document.getElementById('art-canvas');
            const r = c.getBoundingClientRect();
            c.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, view: window }));
          });
          await page.waitForTimeout(150);
          pillVisible = await frame.evaluate(() => {
            const p = document.querySelector('.tdoc-comment-pill');
            return !!(p && p.style.display !== 'none' && p.getBoundingClientRect().width > 0);
          });
        }
        if (!pillVisible) throw new Error('comment pill never appeared over the hovered canvas');
        // clicking it opens the composer in the shell (element anchor)
        await frame.click('.tdoc-comment-pill');
        await page.waitForSelector('.tdoc-popup textarea', { timeout: 3000 });
        await page.fill('.tdoc-popup textarea', 'comment on the whole canvas');
        await page.click('.tdoc-popup .submit');
        // the element comment persists with an element anchor + gets a pin
        let anchored = null;
        for (let i = 0; i < 40; i++) {
          // The server's write isn't atomic — a poll can catch the file half-
          // written. Treat a parse failure as "not yet" and keep polling.
          try {
            const parsed = JSON.parse(fs.readFileSync(COMMENTS_FIXTURE, 'utf8'));
            anchored = parsed.find(c => c.anchor && c.anchor.kind === 'element' && /canvas/i.test(c.anchor.selector || ''));
          } catch (e) { /* mid-write; retry */ }
          if (anchored) break;
          await page.waitForTimeout(50);
        }
        if (!anchored) throw new Error('element comment was not persisted with an element anchor');
        await page.waitForSelector(`.tdoc-pin[data-id="${anchored.id}"], .tdoc-pin`, { timeout: 3000 });
      } finally {
        fs.writeFileSync(COMMENTS_FIXTURE, snapshot);
      }
    });

    await t('author-doc links navigate the TOP page, not the frame', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      await frame.evaluate(() => document.getElementById('internal-link').scrollIntoView({ block: 'center' }));
      await frame.click('#internal-link');
      // the TOP page navigates to the doc path (no nested shell inside the frame)
      await page.waitForURL(/\/d\/hostile-body-css\/v\/1(?:$|[?#])/, { timeout: 4000 });
      const nested = await page.evaluate(() => document.querySelectorAll('iframe .tdoc-bar').length);
      if (nested) throw new Error('shell nested inside the frame — link navigated the iframe');
    });

    // --- #3 MOBILE ------------------------------------------------------------
    await t('narrow viewport: fab opens a comment drawer listing the comments', async () => {
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const narrow = await page.evaluate(() => document.body.classList.contains('tdoc-narrow'));
      if (!narrow) throw new Error('shell did not enter narrow/drawer mode at 480px');
      // the fab is visible (comments exist) and shows the count
      await page.waitForSelector('.tdoc-fab', { state: 'visible', timeout: 2000 });
      const count = await page.$eval('#tdoc-fab-count', el => el.textContent.trim());
      if (!(Number(count) > 0)) throw new Error(`fab count should be > 0, got ${count}`);
      // gutter pins are hidden in narrow (comments are in the drawer)
      const pinVisible = await page.evaluate(() => { const p = document.querySelector('.tdoc-pin'); return p && getComputedStyle(p).display !== 'none'; });
      if (pinVisible) throw new Error('gutter pins should be hidden in narrow mode');
      // tapping the fab opens the bottom-sheet drawer with a card per comment
      await page.click('.tdoc-fab');
      await page.waitForSelector('#tdoc-comment-layer.open', { timeout: 2000 });
      const cards = await page.evaluate(() => document.querySelectorAll('#tdoc-comment-layer .tdoc-margin-comment').length);
      if (cards < 1) throw new Error('drawer opened but has no comment cards');
      // a drawer card is fully wired (Reply control present)
      const hasReply = await page.evaluate(() => !!document.querySelector('#tdoc-comment-layer .tdoc-reply-toggle'));
      if (!hasReply) throw new Error('drawer card missing Reply control (not wired)');
    });

    await t('narrow ?comment= deep-link opens the drawer', async () => {
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto(shellUrl + '&comment=c_fixture_1', { waitUntil: 'networkidle' });
      await page.waitForSelector('#tdoc-comment-layer.open', { timeout: 3000 });
      await page.waitForSelector('#tdoc-comment-layer .tdoc-margin-comment[data-comment-id="c_fixture_1"]', { timeout: 2000 });
    });

    await t('narrow drawer: tapping a comment reveals its author anchor', async () => {
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      if (!frame) throw new Error('author frame not found');
      await frame.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(150);
      const before = await frame.evaluate(() => window.scrollY);
      await page.click('.tdoc-fab');
      await page.waitForSelector('#tdoc-comment-layer.open');
      await page.click('#tdoc-comment-layer [data-comment-id="c_fixture_1"] > .text');
      await page.waitForFunction(() => !document.querySelector('#tdoc-comment-layer'));
      await frame.waitForFunction((previous) => window.scrollY < previous, before);
      const active = await frame.evaluate(() => CSS.highlights.get('tdoc-anchor-active')?.size || 0);
      if (active !== 1) throw new Error(`expected one active anchor, got ${active}`);
    });

    await t('narrow frame: tapping a text highlight opens its comment in the drawer', async () => {
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      if (!frame) throw new Error('author frame not found');
      await frame.waitForFunction(() => (CSS.highlights.get('tdoc-anchor')?.size || 0) > 0);
      await frame.evaluate(() => {
        const range = [...CSS.highlights.get('tdoc-anchor')][0];
        let rect = range.getClientRects()[0];
        window.scrollTo(0, Math.max(0, rect.top + window.scrollY - 180));
        rect = range.getClientRects()[0];
        const target = document.elementFromPoint(rect.left + Math.min(8, rect.width / 2), rect.top + rect.height / 2);
        const init = { bubbles: true, cancelable: true, clientX: rect.left + Math.min(8, rect.width / 2), clientY: rect.top + rect.height / 2 };
        target.dispatchEvent(new MouseEvent('mousedown', init));
        target.dispatchEvent(new MouseEvent('click', init));
      });
      await page.waitForSelector('#tdoc-comment-layer.open');
      const current = await page.getAttribute('#tdoc-comment-layer .tdoc-current-comment', 'data-comment-id');
      if (current !== 'c_fixture_1') throw new Error(`highlight opened ${current || 'no comment'}, expected c_fixture_1`);
    });

    await t('dark mode keeps text highlights visibly painted', async () => {
      await page.evaluate(() => localStorage.setItem('tdoc-theme', 'light'));
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('#tdoc-theme-btn');
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      await frame.waitForFunction(() => document.documentElement.dataset.tdocTheme === 'dark');
      const paint = await frame.evaluate(() => {
        const range = [...CSS.highlights.get('tdoc-anchor')][0];
        const element = range.startContainer.parentElement;
        return getComputedStyle(element, '::highlight(tdoc-anchor)').backgroundColor;
      });
      const alpha = Number((paint.match(/[\d.]+(?=\)$)/) || ['1'])[0]);
      if (!paint || paint === 'rgba(0, 0, 0, 0)' || alpha < 0.7) {
        throw new Error(`dark highlight paint is too faint: ${paint}`);
      }
    });

    await t('hover outline clips to a horizontal scroll container, not the full graph', async () => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      const frame = page.frames().find(f => f.url().includes(SLUG) && f !== page.mainFrame());
      if (!frame) throw new Error('author frame not found');
      await frame.evaluate(() => document.getElementById('wide-graph').scrollIntoView({ block: 'center' }));
      let geo = null;
      for (let i = 0; i < 20 && !geo; i++) {
        await frame.evaluate(() => {
          const g = document.getElementById('wide-graph');
          const w = document.getElementById('scroll-wrap').getBoundingClientRect();
          g.dispatchEvent(new MouseEvent('mousemove', { clientX: w.left + 40, clientY: w.top + w.height / 2, bubbles: true, view: window }));
        });
        await page.waitForTimeout(150);
        geo = await frame.evaluate(() => {
          const o = document.querySelector('.tdoc-hover-outline');
          const p = document.querySelector('.tdoc-comment-pill');
          if (!o || o.style.display === 'none' || !p || p.style.display === 'none') return null;
          const wrap = document.getElementById('scroll-wrap').getBoundingClientRect();
          return { oRight: o.getBoundingClientRect().right, pillRight: p.getBoundingClientRect().right, wrapRight: wrap.right, graphRight: document.getElementById('wide-graph').getBoundingClientRect().right };
        });
      }
      if (!geo) throw new Error('hover outline never appeared over the wide graph');
      // sanity: the graph really overflows its container in this fixture
      if (geo.graphRight <= geo.wrapRight + 100) throw new Error('fixture graph does not overflow: ' + JSON.stringify(geo));
      if (geo.oRight > geo.wrapRight + 2) throw new Error('outline escapes the scroll container: ' + JSON.stringify(geo));
      if (geo.pillRight > geo.wrapRight + 2) throw new Error('pill escapes the scroll container: ' + JSON.stringify(geo));
    });

    await t('resizing back to wide leaves no drawer residue on screen', async () => {
      // Narrow first so the drawer DOM gets created and populated, then widen:
      // the layer must not paint (it used to fall back to absolute top-left,
      // parking a stack of comment cards in the page corner that no pin click
      // could dismiss).
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto(shellUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('.tdoc-fab', { state: 'visible', timeout: 2000 });
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.waitForTimeout(300);
      const leak = await page.evaluate(() => {
        const layer = document.getElementById('tdoc-comment-layer');
        if (!layer) return null;
        const cs = getComputedStyle(layer);
        if (cs.display === 'none') return null;
        const r = layer.getBoundingClientRect();
        return { display: cs.display, top: Math.round(r.top), left: Math.round(r.left) };
      });
      if (leak) throw new Error('drawer layer still paints in wide mode: ' + JSON.stringify(leak));
      const fabVisible = await page.evaluate(() => { const f = document.querySelector('.tdoc-fab'); return !!f && getComputedStyle(f).display !== 'none'; });
      if (fabVisible) throw new Error('fab still visible after widening');
    });

    // --- EDIT YOUR OWN COMMENT (#349) -----------------------------------------
    // Needs an identity: every assertion here is about chrome that only exists
    // for a signed-in viewer, and the default rig browses anonymously. The
    // local server makes that same login the doc owner, which is exactly what
    // proves the owner is NOT handed an edit on other people's comments.
    if (!isPublishedTarget()) {
      const authed = await resolveTarget({ port: 7994, e2eUser: 'tester' });
      const authedUrl = `${authed.url.replace(/\/d\/.*/, '')}/d/${SLUG}/v/1?shell=1`;
      const card = '.tdoc-margin-comment[data-comment-id="c_fixture_1"]';
      try {
        await t('a comment offers edit to its author and to nobody else', async () => {
          const snapshot = fs.readFileSync(COMMENTS_FIXTURE, 'utf8');
          try {
            await page.setViewportSize({ width: 1400, height: 900 });
            await page.goto(`${authedUrl}&comment=c_fixture_1`, { waitUntil: 'networkidle' });
            await page.waitForSelector(`${card} .tdoc-edit-toggle`, { timeout: 4000 });
            // …and c_fixture_4 belongs to reviewer-a. The viewer owns this doc,
            // so it still carries a delete — but never an edit.
            await page.goto(`${authedUrl}&comment=c_fixture_4`, { waitUntil: 'networkidle' });
            const other = '.tdoc-margin-comment[data-comment-id="c_fixture_4"]';
            await page.waitForSelector(`${other} .del`, { timeout: 4000 });
            const strangerEdit = await page.$(`${other} .tdoc-edit-toggle`);
            if (strangerEdit) throw new Error('the doc owner was offered an edit on someone else\'s comment');
          } finally {
            fs.writeFileSync(COMMENTS_FIXTURE, snapshot);
          }
        });

        await t('edit reads as a text control, exactly like Reply beside it', async () => {
          // It shipped as a raw <button>: ui.css lists the chrome buttons that
          // "read as text" by class, and a class missing from that list keeps
          // the UA button box — a grey chip sitting between two text links.
          await page.setViewportSize({ width: 1400, height: 900 });
          await page.goto(`${authedUrl}&comment=c_fixture_1`, { waitUntil: 'networkidle' });
          await page.waitForSelector(`${card} .tdoc-edit-toggle`, { timeout: 4000 });
          const [reply, edit] = await page.evaluate((sel) => {
            const read = (el) => {
              const c = getComputedStyle(el);
              return [c.color, c.font, c.padding, c.backgroundColor, c.borderStyle, c.borderWidth].join('|');
            };
            return [
              read(document.querySelector(`${sel} .tdoc-reply-toggle`)),
              read(document.querySelector(`${sel} .tdoc-edit-toggle`)),
            ];
          }, card);
          if (reply !== edit) {
            throw new Error(`edit does not read like Reply:\n  Reply: ${reply}\n  edit:  ${edit}`);
          }
        });

        await t('editing rewrites the comment in place and marks it edited (#349)', async () => {
          const snapshot = fs.readFileSync(COMMENTS_FIXTURE, 'utf8');
          try {
            await page.setViewportSize({ width: 1400, height: 900 });
            await page.goto(`${authedUrl}&comment=c_fixture_1`, { waitUntil: 'networkidle' });
            await page.click(`${card} .tdoc-edit-toggle`);
            await page.waitForSelector(`${card} .tdoc-edit-form textarea`, { timeout: 2000 });
            // the box opens on the current text — an edit is a correction
            const seeded = await page.$eval(`${card} .tdoc-edit-form textarea`, (el) => el.value);
            if (seeded !== 'a pin should appear for this') {
              throw new Error(`edit box did not open on the current text: ${JSON.stringify(seeded)}`);
            }
            await page.fill(`${card} .tdoc-edit-form textarea`, 'rewritten by its author');
            await page.click(`${card} .tdoc-edit-save`);
            await page.waitForSelector(`${card} .tdoc-edit-form`, { state: 'detached', timeout: 4000 });
            await page.waitForFunction(
              (sel) => document.querySelector(`${sel} .text`)?.textContent === 'rewritten by its author',
              card,
              { timeout: 4000 },
            );
            const meta = await page.$eval(`${card} .meta > span`, (el) => el.textContent);
            if (!/edited/.test(meta)) throw new Error(`edited comment is not marked: "${meta}"`);
            const stored = JSON.parse(fs.readFileSync(COMMENTS_FIXTURE, 'utf8'))
              .find((c) => c.id === 'c_fixture_1');
            if (stored.text !== 'rewritten by its author' || !stored.edited) {
              throw new Error(`edit did not persist: ${JSON.stringify(stored.text)} / ${stored.edited}`);
            }
          } finally {
            fs.writeFileSync(COMMENTS_FIXTURE, snapshot);
          }
        });
      } finally {
        await authed.stop();
      }
    }

  } finally {
    await browser.close();
    await target.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
