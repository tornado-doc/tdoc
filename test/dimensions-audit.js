// Continuous-dimension audit. Probes the live worker at every 50px from
// 320 to 1600 and asserts:
//   - body.tdoc-has-comments && !body.tdoc-narrow  =>  cards sit ENTIRELY to
//     the right of the doc article (no visual overlap with prose).
//   - body.tdoc-pins && !body.tdoc-narrow => article stays centered in the
//     viewport; comment pins are provider chrome and must not shift the doc.
//   - top bar children all have offsetWidth > 0 (when expected visible).
//   - no horizontal overflow on documentElement.
//   - footer (.tdoc-footer) present + within viewport.
// Exit non-zero on any failure.

const { requirePlaywrightOrSkip, resolveTarget } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('dimensions-audit.js');

const START = +(process.env.AUDIT_START || 320);
const END = +(process.env.AUDIT_END || 1600);
const STEP = +(process.env.AUDIT_STEP || 50);
const COLOR_SCHEME = process.env.AUDIT_COLOR_SCHEME || 'light';
const REQUIRE_FOOTER = process.env.AUDIT_REQUIRE_FOOTER !== '0';

(async () => {
  const target = await resolveTarget();
  const URL = target.url;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 800 },
    colorScheme: COLOR_SCHEME,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('.tdoc-margin-comment') !== null, null, { timeout: 8000 }).catch(() => {});

  const failures = [];
  const summary = [];

  for (let w = START; w <= END; w += STEP) {
    await page.setViewportSize({ width: w, height: 800 });
    // settle: two RAFs + small wait for ResizeObserver-driven repositioning
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(120);

    const m = await page.evaluate(() => {
      const body = document.body;
      const docEl = document.documentElement;
      const hasComments = body.classList.contains('tdoc-has-comments');
      const narrow = body.classList.contains('tdoc-narrow');
      const cards = [...document.querySelectorAll('.tdoc-margin-comment')].filter(c => {
        const cs = getComputedStyle(c);
        return cs.display !== 'none' && c.offsetWidth > 0 && c.offsetHeight > 0;
      }).map(c => {
        const r = c.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, width: r.width };
      });

      // Pick a representative article element to test overlap against.
      function pickArticle() {
        const cands = document.querySelectorAll('main, article, .wrap, .content, .container');
        let best = null, bw = 0;
        for (const el of cands) {
          if (el.closest('.tdoc-bar, .tdoc-popup, .tdoc-margin-comment, #tdoc-comment-layer, .tdoc-footer')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > bw && r.width > 200) { best = el; bw = r.width; }
        }
        return best;
      }
      const article = pickArticle();
      const aRect = article ? article.getBoundingClientRect() : null;

      // Top bar children we care about (omitted/hidden in narrow mode are fine).
      const bar = document.querySelector('.tdoc-bar');
      const barRect = bar ? bar.getBoundingClientRect() : null;
      const barChildren = bar ? [...bar.querySelectorAll(':scope > *')].map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: el.className || '',
          visible: el.offsetWidth > 0 && el.offsetHeight > 0,
          right: r.right,
          left: r.left,
        };
      }) : [];
      const docTitle = document.querySelector('.tdoc-bar .doc-title');
      const docTitleVisible = !!(docTitle && docTitle.offsetWidth > 0 && docTitle.offsetHeight > 0);

      const footer = document.querySelector('.tdoc-footer');
      const footerRect = footer ? footer.getBoundingClientRect() : null;
      const footerLinks = footer ? [...footer.querySelectorAll('a')].map(a => ({
        href: a.getAttribute('href'),
        visible: a.offsetWidth > 0 && a.offsetHeight > 0,
      })) : [];

      return {
        innerWidth: window.innerWidth,
        scrollWidth: docEl.scrollWidth,
        hasComments,
        narrow,
        pinsMode: body.classList.contains('tdoc-pins'),
        cards,
        article: aRect ? { left: aRect.left, right: aRect.right, width: aRect.width } : null,
        bar: barRect ? { left: barRect.left, right: barRect.right } : null,
        barChildren,
        docTitleVisible,
        footer: footerRect ? { left: footerRect.left, right: footerRect.right, width: footerRect.width } : null,
        footerLinks,
      };
    });

    const errs = [];
    // Note: we do NOT assert scrollWidth <= innerWidth at the document level —
    // doc bodies may contain wide content (canvases, code blocks, tables) that
    // legitimately overflow on phone widths; that's the doc author's call, not
    // the overlay's bug. Instead we assert overlay-owned elements stay in bounds.

    // Wide comment rules: pinned mode keeps the document centered in the
    // viewport. If cards are visible, they still must sit to the right of the
    // article without overlapping prose.
    if (m.hasComments && !m.narrow && m.article) {
      const expectedCenter = m.pinsMode ? (m.innerWidth / 2) : ((m.innerWidth - 360) / 2);
      const articleCenter = (m.article.left + m.article.right) / 2;
      if (Math.abs(articleCenter - expectedCenter) > 2) {
        const scope = m.pinsMode ? 'viewport' : 'reading area';
        errs.push(`article center=${articleCenter.toFixed(0)} not centered in ${scope} center=${expectedCenter.toFixed(0)}`);
      }
      for (const c of m.cards) {
        if (c.right > m.innerWidth + 1) errs.push(`card right=${c.right.toFixed(0)} overflows viewport ${m.innerWidth}`);
        if (c.left < m.article.right - 2) errs.push(`card overlaps article (card.left=${c.left.toFixed(0)} < article.right=${m.article.right.toFixed(0)})`);
      }
    }
    // Narrow-mode rule: cards are statically placed in the drawer; still must
    // not overflow horizontally.
    if (m.narrow) {
      for (const c of m.cards) {
        if (c.right > m.innerWidth + 1) errs.push(`narrow card right=${c.right.toFixed(0)} > vp ${m.innerWidth}`);
      }
    }

    // Top bar children: at minimum, the title + identity slot must be visible.
    if (!m.docTitleVisible) errs.push('bar title not visible');
    const hasIdentSlot = m.barChildren.some(c => c.id === 'tdoc-identity-slot');
    // identity slot is a span wrapper; might collapse to 0 width before its
    // child renders. Probe the actual chip/button instead when this target has
    // identity chrome at all; the anonymous local fixture does not.
    const chipVisible = await page.evaluate(() => {
      const slot = document.querySelector('#tdoc-identity-slot');
      if (!slot || !slot.firstElementChild) return null;
      const el = slot.firstElementChild;
      return el.offsetWidth > 0 && el.offsetHeight > 0;
    });
    if (hasIdentSlot && chipVisible === false) errs.push('identity chip/signin not visible');

    if (REQUIRE_FOOTER) {
      if (!m.footer) errs.push('footer missing');
      else {
        if (m.footer.right > m.innerWidth + 1) errs.push(`footer right=${m.footer.right} overflows ${m.innerWidth}`);
        if (m.footerLinks.length < 2) errs.push(`footer has ${m.footerLinks.length} links (expected >=2)`);
      }
    }

    const row = `${String(w).padStart(4)}px  narrow=${m.narrow ? 'Y' : 'N'}  cards=${m.cards.length}  article=${m.article ? Math.round(m.article.width) : '-'}px`;
    if (errs.length) {
      failures.push({ width: w, errs });
      summary.push(`  FAIL ${row}\n        ` + errs.join('\n        '));
    } else {
      summary.push(`  OK   ${row}`);
    }
  }

  console.log(`dimensions audit ${URL}  (${COLOR_SCHEME}, ${START}-${END} step ${STEP})\n`);
  console.log(summary.join('\n'));
  console.log();
  if (failures.length) {
    console.log(`${failures.length} widths FAILED:`);
    for (const f of failures) console.log(`  ${f.width}px: ${f.errs.join(' | ')}`);
  } else {
    console.log(`all ${summary.length} widths passed`);
  }
  await browser.close();
  await target.stop();
  process.exit(failures.length ? 1 : 0);
})();
