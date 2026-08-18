// tornado-doc landing page (#127) — the doc served at tdoc.dev/.
// Covers the page itself (content + SEO head + CSP-safety) and the worker
// route that makes it the homepage.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'meta.json'), 'utf8'));
// Read the LATEST version, not v1. `/` serves meta.versions[last], so pinning
// this to v1 would keep asserting an archived version while the homepage
// silently drifted. Older versions stay on disk on purpose: comments are
// anchored to them, and a reader can flip back.
const latest = meta.versions[meta.versions.length - 1].n;
const html = fs.readFileSync(path.join(root, 'landing', 'tornado-doc', `v${latest}`, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');

// Exact-href extraction — not html.includes(url), which CodeQL flags as
// incomplete URL-substring sanitization (js/incomplete-url-substring-sanitization).
const hrefs = [];
{
  const re = /\bhref="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) hrefs.push(m[1]);
}
const metaContent = (key) => {
  const re = new RegExp(`<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
};

console.log('tornado-doc landing (#127)');

t('is a tdoc-shaped page', () => {
  // .wrap is one of the overlay's ARTICLE_ROOT_SEL roots — comment anchoring
  // resolves against it, so losing it silently degrades commenting.
  assert(html.includes('<div class="wrap">'), 'missing .wrap content root');
  assert(/<meta name="viewport"/.test(html), 'missing viewport');
  assert(/body\s*\{[^}]*background:\s*#fff/.test(html), 'missing body background');
});

t('runs no author JavaScript', () => {
  // Published docs run under a nonce-only CSP (cspHeader) — author <script>,
  // inline handlers, and javascript: URLs never execute. A page that needs
  // them would look fine locally in a plain file:// preview and be broken
  // live, so assert the page never depends on them.
  assert(!/<script\b/i.test(html), 'page contains a <script> tag; CSP will not run it');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'page contains an inline event handler');
  assert(!hrefs.some((h) => /^javascript:/i.test(h)), 'page contains a javascript: URL');
});

t('hero board is a sandboxed widget island', () => {
  // v39: the board is a real Game of Life, not a five-cell sprite on a
  // CSS keyframe. Computation lives in widgets/conway.html, framed with
  // sandbox="allow-scripts" and no allow-same-origin. The host stays
  // script-free; the island is a unique origin.
  assert(/<iframe\b[^>]*class="[^"]*\blife\b/.test(html), 'missing iframe.life');
  assert(/src="\/d\/tornado-doc\/v\/\d+\/widget\/conway"/.test(html),
    'iframe must point at this doc\'s /widget/conway route');
  const iframe = html.match(/<iframe\b[^>]*class="[^"]*\blife\b[^>]*>/);
  assert(iframe, 'could not isolate the life iframe');
  assert(/sandbox="allow-scripts"/.test(iframe[0]),
    `widget iframe sandbox must be allow-scripts only: ${iframe[0]}`);
  assert(!/allow-same-origin/.test(iframe[0]),
    'widget iframe must not include allow-same-origin');
  const widgetPath = path.join(root, 'landing', 'tornado-doc', `v${latest}`, 'widgets', 'conway.html');
  assert(fs.existsSync(widgetPath), `missing ${widgetPath}`);
  const widget = fs.readFileSync(widgetPath, 'utf8');
  assert(/<script\b/.test(widget), 'widget file must contain the generation script');
  assert(/nxt\[/.test(widget) && /cur\[/.test(widget),
    'widget must step a neighbour grid (nxt/cur), not animate a sprite');
  // The CSS-sprite workaround must stay gone on the host.
  assert(!/<g class="glider"/.test(html), 'CSS-sprite glider group still in the host');
  assert(!/@keyframes\s+glide/.test(html),
    'host CSS still has the sprite @keyframes glide; the island does not use it');
  // The board ran forever with no way to stop it. Control cannot live on
  // the host (no author script), so it has to live in the widget.
  assert(/<button\b[^>]*id="t"/.test(widget),
    'widget must ship a play/pause button; the host cannot reach the loop');
  assert(/timer \? 'Pause' : 'Play'/.test(widget),
    'widget button must flip between Pause and Play');
  assert(/function halt\(/.test(widget) && /function run\(/.test(widget),
    'widget must expose run/halt so the loop can stop');
  // Dark mode is one invert on html. Reaction emoji are OS bitmaps and
  // the agent mark is a brand colour, so both come back wrong unless
  // flipped a second time (same restore as overlay .tdoc-emoji).
  assert(/html\[data-tdoc-theme="dark"\]\s*\.emo/.test(html),
    'dark mode must restore mock reaction emoji after the page invert');
  assert(/html\[data-tdoc-theme="dark"\]\s*\.mc-av\.mc-logo/.test(html),
    'dark mode must restore the terracotta agent mark after the page invert');
  // e5a7d7c / e58124a: the gold ring belongs to the board, not the island.
  // The play bar sits outside .board. The island card stays opaque so a
  // dark-mode invert-of-invert does not flash a white slab.
  assert(/\.board\s*\{[^}]*border:\s*1px solid #e0b93a/.test(widget),
    'widget .board must carry the reader ring; it must not sit on iframe.life');
  assert(/iframe\.life\s*\{[^}]*background:\s*#fff/.test(html),
    'island card must stay opaque (#fff); transparent iframe comes back white in dark mode');
  assert(!/iframe\.life\s*\{[^}]*background:\s*transparent/.test(html),
    'iframe.life must not be transparent');
  assert(!/\.life\.anchored\s*\{/.test(html),
    'host must not ring the whole island; that enclosed the play control');
  // Demo chrome: blue is the page CTA. The mock bar uses a plain wordmark
  // and a grey version pill so it does not steal those two buttons.
  assert(!/\.tbar-mark\s*\{[^}]*background:\s*var\(--accent\)/.test(html),
    'demo tbar-mark must not spend the CTA blue');
  assert(/\.tbar-v\s*\{[^}]*background:\s*#f0f1f4/.test(html),
    'demo version chip must be the reader grey pill, not a blue one');
});

t('carries the SEO head', () => {
  assert(/<title>[^<]*tdoc[^<]*<\/title>/i.test(html), 'title does not mention tdoc');
  // Upper bound is Google's snippet truncation (~160 chars) — a longer one is
  // not wrong, it just gets cut mid-sentence in results.
  const desc = metaContent('description');
  assert(desc && desc.length >= 80 && desc.length <= 165, `meta description missing or badly sized (${desc && desc.length})`);
  assert(hrefs.some((h) => h === 'https://tdoc.dev/'), 'missing canonical href https://tdoc.dev/');
  assert(/rel="canonical"/.test(html), 'missing rel=canonical');
});

t('carries share-card tags', () => {
  for (const k of ['og:type', 'og:url', 'og:title', 'og:description', 'og:image']) {
    assert(metaContent(k), `missing ${k}`);
  }
  assert(metaContent('og:url') === 'https://tdoc.dev/', `og:url was ${metaContent('og:url')}`);
  assert(metaContent('twitter:card'), 'missing twitter:card');
});

t('names tdoc and tornado-doc', () => {
  // Exactly one h1, carrying the value proposition. The brand sits in the
  // wordmark and <title>; an h1 that is only the product name wastes the
  // strongest heading on a word nobody searches for yet.
  const h1s = html.match(/<h1[^>]*>/g) || [];
  assert(h1s.length === 1, `expected exactly 1 <h1>, found ${h1s.length}`);
  assert(/tdoc/.test(html), 'does not mention tdoc');
  assert(html.includes('tornado-doc'), 'does not mention tornado-doc');
  assert(!html.includes('Tornado Dog'), 'old Tornado Dog name still present');
  assert(meta.title === 'tornado-doc', `meta title was ${meta.title}`);
  assert(meta.slug === 'tornado-doc', `meta slug was ${meta.slug}`);
});

t('links to the GitHub repo and install path', () => {
  assert(hrefs.some((h) => h === 'https://github.com/tornado-doc/tdoc'), 'missing GitHub repo href');
  assert(hrefs.some((h) => h === 'https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md'), 'missing Install href');
});

t('hero stage-notes is a sibling of stage-doc', () => {
  // Nesting the notes inside .stage-doc makes the two-column grid a no-op:
  // the grid has one child, so the cards stack under the board. v2 and v3
  // both shipped that bug. stage-doc must be closed before the aside.
  const iDoc = html.indexOf('<div class="stage-doc">');
  const iAside = html.indexOf('<aside class="stage-notes">');
  assert(iDoc >= 0 && iAside > iDoc, 'missing stage-doc or stage-notes');
  const mid = html.slice(iDoc + '<div class="stage-doc">'.length, iAside);
  const opens = (mid.match(/<div\b/g) || []).length;
  const closes = (mid.match(/<\/div>/g) || []).length;
  assert(closes === opens + 1, `stage-doc still open when notes start (div net ${opens - closes})`);
});

t('phone rules actually override the desktop headline and CTA grid', () => {
  // Desktop is `h1.tagline { font-size:56px }` (specificity 0,1,1). A
  // `@media { .tagline { font-size:38px } }` rule never wins, so v6
  // wrapped to three lines at 375px. The phone override must target
  // `h1.tagline`.
  const phone = html.match(/@media \(max-width:640px\)\s*\{([\s\S]*?)\n    \}/);
  assert(phone, 'missing @media (max-width:640px)');
  assert(/h1\.tagline\s*\{[^}]*font-size:\s*\d+px/.test(phone[1]),
    '640px breakpoint must set h1.tagline font-size, not just .tagline');
  // v35: share the row. Two 232px tracks still overflow 375, so the
  // columns become 1fr 1fr and ".btn-long" ("on GitHub") hides, leaving
  // "Star 102". A lone 1fr restack is also overflow-safe but drops the
  // second button under the first; lock the two-column share.
  assert(/\.cta\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr/.test(phone[1]),
    '640px breakpoint must share the CTA row (1fr 1fr); 232+232 overflows 375');
  assert(/\.btn-long\s*\{[^}]*display:\s*none/.test(phone[1]),
    '640px must hide .btn-long so Star 102 fits the half-width track');
  // v28: loop stayed 3 col (98px, one word per line), proof-wall stayed
  // 3 col (min-content 164px, page scrollWidth 545), feature cards stayed
  // 2 col (156px). All three must become one column with the CTAs.
  assert(/\.loop,\s*\.sm-grid,\s*\.proof-wall\s*\{[^}]*grid-template-columns:\s*1fr/.test(phone[1])
      || (/\.loop\s*\{[^}]*grid-template-columns:\s*1fr/.test(phone[1])
        && /\.sm-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(phone[1])
        && /\.proof-wall\s*\{[^}]*grid-template-columns:\s*1fr/.test(phone[1])),
    '640px breakpoint must restack .loop, .sm-grid and .proof-wall to 1fr');
  // v12 lengthened the ghost label to "Star on GitHub 102". The v7 216px
  // cap wraps that label (77px vs 52px). Phone max-width must match the
  // desktop track (232px), or be absent so 1fr uses the wrap.
  const ctaRule = phone[1].match(/\.cta\s*\{[^}]*\}/);
  const maxW = ctaRule && ctaRule[0].match(/max-width:\s*(\d+)px/);
  assert(!maxW || Number(maxW[1]) >= 232,
    `640px .cta max-width is ${maxW && maxW[1]}px; "Star on GitHub 102" wraps below 232`);
  // The GitHub mark is a <use> of a 24x24 symbol. Without a viewBox the
  // used path overflows the 1em box and the grid row grows to ~77px.
  // Matched inside the button rather than immediately after it: the contents
  // are wrapped in one centring child now, so adjacency is not the invariant.
  // The invariant is that the icon carries a viewBox.
  const ghost = html.match(/<a class="btn btn-ghost"[\s\S]*?<\/a>/);
  assert(ghost, 'ghost CTA not found');
  assert(/<svg[^>]*viewBox="0 0 24 24"/.test(ghost[0]),
    'Star button icon must set viewBox so the used mark cannot stretch the pill');
  // v39 phone bug: icon / label / pill were direct flex children of the
  // button. Hiding .btn-long left an anonymous text node that collected
  // its own gap, so Star read as icon-left / pill-right. Contents must
  // be one .btn-in child; the button then centres a single item.
  assert(/\.btn-in\s*\{[^}]*display:\s*inline-flex/.test(html),
    'CTA contents must sit in one .btn-in child so a hidden .btn-long cannot become a flex gap');
  const ghosts = [...html.matchAll(/<a class="btn btn-ghost"[\s\S]*?<\/a>/g)].map((m) => m[0]);
  assert(ghosts.length >= 2, `expected two ghost CTAs, found ${ghosts.length}`);
  for (const g of ghosts) {
    assert(/<span class="btn-in">/.test(g),
      'ghost CTA must wrap icon+label+pill in .btn-in so the row stays centred on phones');
  }
  // v14 dropped height/nowrap. The used mark then overflowed 1em and the
  // Star pill measured 77px (Create stretched with it on desktop). Lock both.
  assert(/\.btn\s*\{[^}]*height:\s*52px/.test(html),
    'CTA pills must lock height:52px; without it the used GitHub mark stretches Star to ~77px');
  assert(/\.btn\s*\{[^}]*white-space:\s*nowrap/.test(html),
    'CTA pills must nowrap so Star on GitHub 102 stays one line');
  // Same class of bug as the original .tagline vs h1.tagline miss: an
  // earlier 640px size is a no-op if a later 840px block also sets
  // h1.tagline. The last media query that sets h1.tagline must be 640.
  const mediaH1 = [...html.matchAll(/@media \(max-width:(\d+)px\)\s*\{([\s\S]*?)\n    \}/g)]
    .filter((m) => /h1\.tagline\s*\{[^}]*font-size:/.test(m[2]));
  const last = mediaH1[mediaH1.length - 1];
  assert(last && last[1] === '640',
    `last h1.tagline media query is ${last && last[1]}px; 640 must come last so phones do not inherit the 840px size`);
});

t('hero comment count matches the mock thread', () => {
  // v8 nested Claude's answer as a reply. The notes column is one thread,
  // so "2 comments" is a leftover from the sibling-card layout.
  const notes = html.match(/<aside class="stage-notes">[\s\S]*?<\/aside>/);
  assert(notes, 'missing stage-notes');
  const threads = (notes[0].match(/<div class="mc">/g) || []).length;
  const replies = (notes[0].match(/<div class="mc-reply">/g) || []).length;
  assert(threads === 1, `expected 1 mock thread, found ${threads}`);
  assert(replies === 1, `expected Claude's answer as a reply, found ${replies}`);
  // v10: checked against the published conway-life doc. The real reader has
  // no "N comments" header at all; the margin holds pins, and a pin opens the
  // card. The mock follows that, so there is no label left to count.
  assert(!/class="lbl-n"/.test(notes[0]), 'the real margin has no comment-count header');
  assert(/move anchor/i.test(notes[0]), 'real cards lead with the move-anchor row');
  assert(/mc-meta/.test(notes[0]), 'real cards carry a version and date meta row');
  // Play/Pause lives in the board next to this card. Asking for the
  // absence of that control reads as a bug, not a demo.
  assert(!/without a play button/i.test(notes[0]),
    'Anna must not ask for no play button while Pause sits in the island');
});

t('agent avatar is a filled Claude disc, not a small glyph', () => {
  // The sunburst path is hollow in the middle. v11/v12 put an 18–20px
  // terracotta mark on a transparent disc; at 22px that reads as a broken
  // image. The runtime tiles already use a filled disc.
  assert(/mc-av mc-logo/.test(html), 'missing agent logo avatar');
  assert(/\.mc-av\.mc-logo\s*\{[^}]*background:\s*#D97757/i.test(html),
    'agent avatar disc must be Claude terracotta, not transparent');
  assert(/\.mc-logo svg\s*\{[^}]*fill:\s*#fff/i.test(html),
    'agent mark must be white on the terracotta disc');
});

t('loop step 2 svg is well-formed', () => {
  // v30 closed the step-2 svg after "fix them all", then left two <rect>s
  // and a second </svg> in the markup. Browsers drop the orphans, so the
  // card still drew, but the file was 2 opens / 3 closes. Count tags
  // inside the second .step-viz only.
  const vizs = [...html.matchAll(/<div class="step-viz">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert(vizs.length === 3, `expected 3 step-viz, found ${vizs.length}`);
  const opens = (vizs[1].match(/<svg\b/g) || []).length;
  const closes = (vizs[1].match(/<\/svg>/g) || []).length;
  assert(opens === closes, `step 2 svg open/close mismatch (${opens} vs ${closes}); leftover orphan markup`);
  assert(!/<rect[\s\S]*<\/svg>\s*$/.test(vizs[1].trim()) || opens === closes,
    'step 2 still has markup after the svg closed');
});

t('demos commentable artifacts', () => {
  // The page doubles as the artifact demo (#127): an <svg> and a <pre> are
  // both in the overlay's COMMENTABLE set, so a visitor can comment on them.
  // The overlay's COMMENTABLE set is img, svg, canvas, video, pre, figure,
  // section, aside, blockquote, table, details. The page must carry more than
  // one kind, so a visitor can try commenting on a picture AND on a block.
  const kinds = ['svg', 'table', 'figure', 'blockquote', 'aside'].filter((k) => new RegExp(`<${k}[\\s>]`).test(html));
  assert(kinds.includes('svg'), 'missing svg artifact');
  assert(kinds.length >= 3, `only ${kinds.length} commentable artifact kinds (${kinds.join(', ')}), expected 3+`);
  assert(/role="img"[^>]*aria-label="|aria-label="[^"]+"[^>]*role="img"/.test(html), 'svg has no aria-label');
});


t('has a compare table that admits a loss', () => {
  // A comparison where the author wins every row reads as an ad and costs more
  // trust than it buys. At least one row must put a competitor ahead.
  assert(/<table/.test(html), 'missing compare table');
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  // The invariant is that at least one row does NOT favour tdoc, not that we
  // lose outright. A `part` cell ("Coming soon") is equally honest: the reader
  // sees a row we do not win, which is what makes the other rows believable.
  const lost = rows.filter((r) => {
    const ours = r.match(/<td class="us">[\s\S]*?<\/td>/);
    return !!ours && /class="(no|part)"/.test(ours[0]);
  });
  assert(lost.length >= 1, 'every compare row favours tdoc — keep at least one row we do not win');
});

t('uses no dashes as punctuation', () => {
  // House style for this page: no em dash, en dash, or " - " as a connector.
  // Checked against visible text only, so hyphenated words and CSS/SVG values
  // (stroke-width, viewBox coords, -apple-system) are not false positives.
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const hits = text.match(/[–—]|\s-\s|&mdash;|&ndash;/g) || [];
  assert(hits.length === 0, `${hits.length} dash(es) in visible copy: ${[...new Set(hits)].join(' ')}`);
});

t('carries no unfinished placeholder content', () => {
  // The social-proof quotes and trusted-by logos must be real. This fails
  // while any NEEDS-REAL-DATA marker is left in the page, so a version
  // carrying invented testimonials cannot reach `/`.
  const markers = (html.match(/NEEDS-REAL-DATA/g) || []).length;
  assert(markers === 0, `${markers} NEEDS-REAL-DATA marker(s) left in the page`);

  // v37 filled the six quote slots. Visible PLACEHOLDER copy is no longer
  // allowed on the latest version — that was the publish blocker.
  const visible = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const drafts = (visible.match(/PLACEHOLDER/gi) || []).length;
  assert(drafts === 0, `${drafts} visible PLACEHOLDER line(s) on the latest version`);

  // People stay. Quotes must mention tdoc-shaped work, not the leftover
  // OpenTag wording. Trusted-by leftovers from that site must stay gone.
  for (const name of ['Josh', 'Brandon', 'Angela F', 'Bruce Z', 'Sam H', 'Sammy']) {
    assert(visible.includes(name), `missing ${name} on the proof wall`);
  }
  assert(!/Coinbase|ByteDance|GUAZI/i.test(visible), 'OpenTag trusted-by leftovers still visible');
  assert(/Works with/.test(visible), 'trusted-by label should be Works with, not a borrowed user list');
});

console.log('tdoc.dev / route');

t('homepage renders the landing doc, not a hardcoded page', () => {
  assert(/const LANDING_SLUG = 'tornado-doc'/.test(worker), 'missing LANDING_SLUG');
  const route = worker.match(/if \(p === '\/' && \(method === 'GET' \|\| method === 'HEAD'\)\) \{[\s\S]*?\n    \}/);
  assert(route, '/ no longer has a GET/HEAD route');
  assert(/return landingResponse\(env, req\)/.test(route[0]), '/ no longer routes through landingResponse');
  // `?notice=…` is a toast for someone bounced here from /me or an unknown
  // path. The landing doc has nowhere to render it, so that one request
  // keeps the neutral page rather than swallowing the message.
  assert(/if \(notice\) return html\(landingHtml\(env, notice\)\)/.test(route[0]),
    'a bounce notice no longer reaches the visitor');
});

t('homepage fails safe to the neutral page', () => {
  const fn = worker.match(/async function landingResponse[\s\S]*?\n}\n/);
  assert(fn, 'landingResponse not found');
  const body = fn[0];
  // Three ways the doc can be unavailable — unpublished, gated, or throwing.
  // All three must degrade to landingHtml(env), never a 404 or a sign-in
  // wall. env is load-bearing: landingHtml reads GITHUB_CLIENT_ID from it to
  // decide whether to offer sign-in, so dropping it silently hides the button.
  assert(/if \(!latest\) return html\(landingHtml\(env\)\)/.test(body), 'no fallback when the doc is unpublished');
  assert(/res\.ok \? res\.response : html\(landingHtml\(env\)\)/.test(body), 'no fallback when access is denied');
  assert(/catch \{\s*return html\(landingHtml\(env\)\);/.test(body), 'no fallback when lookup throws');
  assert(/meta\.versions\.length - 1\]/.test(body), 'does not resolve the LATEST version');
});

t('doc view and homepage share one render path', () => {
  // Regression guard: the /d/ route used to inline the whole render. If it
  // grows a second copy, the homepage and doc pages drift on access/CSP.
  assert(/async function serveDocVersion\(env, req, slug, version(, \w+)?\)/.test(worker), 'missing serveDocVersion');
  const occurrences = (worker.match(/injectOverlay\(raw,/g) || []).length;
  assert(occurrences === 1, `injectOverlay(raw, ...) called ${occurrences} times; expected exactly 1 shared call site`);
});

t('homepage bar drops the slug crumb and the version picker', () => {
  // `/` is the site, not a doc someone published. Printing the storage slug
  // ("tornado-doc") and the version it happens to be on tells a first-time
  // visitor they are reading somebody else's document. The /d/ route keeps
  // both — same render path, one flag.
  const fn = worker.match(/async function landingResponse[\s\S]*?\n}\n/);
  assert(fn, 'landingResponse not found');
  assert(/serveDocVersion\(env, req, LANDING_SLUG, Number\(latest\), true\)/.test(fn[0]),
    'homepage no longer marks the render as the landing page');
  assert(/isLanding: !!isLanding/.test(worker), 'bootCfg no longer carries isLanding');

  const overlay = fs.readFileSync(path.join(root, 'server', 'overlay.js'), 'utf8');
  const left = overlay.match(/const leftHtml = `[\s\S]*?`;\n/);
  assert(left, 'overlay leftHtml block not found');
  assert(/cfg\.isLanding \? '' :/.test(left[0]),
    'overlay still renders the slug crumb and version picker on the homepage');
  assert(/tdoc-bar-mark/.test(left[0].split('cfg.isLanding')[0]),
    'the tdoc mark must stay outside the landing conditional');

  // Share on `/` must copy the canonical homepage, not /d/tornado-doc/v/N.
  const shareFn = overlay.match(/function publicShareUrl\(\) \{[\s\S]*?\n  \}/);
  assert(shareFn, 'overlay must have a single share-URL helper');
  assert(/cfg\.isLanding/.test(shareFn[0]) && /\$\{location\.origin\}\//.test(shareFn[0]),
    'Share on the homepage must copy location.origin/');
  assert(/\/d\/\$\{encodeURIComponent\(slug\)\}\/v\/\$\{version\}/.test(shareFn[0]),
    'Share on /d/ must still copy the versioned URL');
  assert(/const url = publicShareUrl\(\)/.test(overlay),
    'share modals must use publicShareUrl, not build /d/ themselves');
});

console.log('tdoc.dev / release payload');

t('bin/tdoc-landing-release writes a clean v1 with no review thread', () => {
  // The working copy under landing/tornado-doc keeps 39 versions and the
  // review thread. Publishing that as-is would put a version picker and
  // somebody else's notes on tdoc.dev/. The release script copies only
  // the latest HTML to v1, rewrites the widget iframe, and writes [].
  const { execFileSync } = require('child_process');
  const script = path.join(root, 'bin', 'tdoc-landing-release');
  const outDir = path.join(root, '.release', 'tornado-doc');
  const previewDir = path.join(root, '.release', 'tdoc-home');
  execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  execFileSync(process.execPath, [script, 'tdoc-home'], { cwd: root, encoding: 'utf8' });

  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert(/^\.release\/$/m.test(ignore), '.release/ must be gitignored so the payload cannot be committed by mistake');

  const srcComments = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'comments.json'), 'utf8'));
  assert(Array.isArray(srcComments) && srcComments.length > 0,
    'working copy has no comments to strip; the release script would be a no-op');
  assert(meta.versions.length > 1,
    'working copy is a single version; the v39→v1 collapse would be invisible');

  const relMeta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  const relComments = JSON.parse(fs.readFileSync(path.join(outDir, 'comments.json'), 'utf8'));
  const relHtml = fs.readFileSync(path.join(outDir, 'v1', 'index.html'), 'utf8');
  assert(relMeta.slug === 'tornado-doc', `release slug was ${relMeta.slug}`);
  assert(relMeta.versions.length === 1 && relMeta.versions[0].n === 1,
    `release meta must advertise only v1, got ${JSON.stringify(relMeta.versions)}`);
  assert(!fs.existsSync(path.join(outDir, 'v2')), 'release payload still has a v2 directory');
  assert(Array.isArray(relComments) && relComments.length === 0,
    `release comments.json must be empty, got ${relComments.length} thread(s)`);
  assert(/src="\/d\/tornado-doc\/v\/1\/widget\/conway"/.test(relHtml),
    'release iframe must point at /d/tornado-doc/v/1/widget/conway');
  assert(!new RegExp(`/d/tornado-doc/v/${latest}/widget/`).test(relHtml),
    `release iframe still points at working-copy v${latest}`);
  assert(fs.existsSync(path.join(outDir, 'v1', 'widgets', 'conway.html')),
    'release payload must copy widgets/conway.html or the board 404s');

  const previewHtml = fs.readFileSync(path.join(previewDir, 'v1', 'index.html'), 'utf8');
  assert(/src="\/d\/tdoc-home\/v\/1\/widget\/conway"/.test(previewHtml),
    'custom-slug release must rewrite the iframe to that slug');

  // tdoc-publish only attaches comments.json when it is a non-empty array.
  // An empty file is the right local signal; it does not wipe a remote
  // thread that already exists (preview). First publish to tdoc.dev is clean.
  const publish = fs.readFileSync(path.join(root, 'bin', 'tdoc-publish'), 'utf8');
  assert(/type == "array" and length > 0/.test(publish),
    'tdoc-publish must skip empty comments.json so the release payload does not send a dummy list');
});

t('release payload carries the homepage access policy', () => {
  // /api/upload writes meta.access. Without it, tdoc-publish defaults a
  // brand-new access block to unlisted, and whoever publishes the homepage
  // has to remember --visibility public --history owner --commenting signed_in.
  // The payload states the policy so the flags are not load-bearing.
  const { execFileSync } = require('child_process');
  const script = path.join(root, 'bin', 'tdoc-landing-release');
  const outDir = path.join(root, '.release', 'tornado-doc');
  execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });

  const relMeta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  assert(relMeta.access && typeof relMeta.access === 'object',
    'release meta.json has no access block');
  assert(relMeta.access.visibility === 'public',
    `homepage must be public, got ${relMeta.access.visibility}`);
  assert(relMeta.access.history_visibility === 'owner',
    `homepage history must be owner-only, got ${relMeta.access.history_visibility}`);
  assert(relMeta.access.commenting === 'signed_in',
    `homepage commenting must be signed_in, got ${relMeta.access.commenting}`);
  assert(Array.isArray(relMeta.access.allowed_users) && relMeta.access.allowed_users.length === 0,
    `homepage allowlist must be empty, got ${JSON.stringify(relMeta.access.allowed_users)}`);

  const publish = fs.readFileSync(path.join(root, 'bin', 'tdoc-publish'), 'utf8');
  // The access block only matters if it is in the upload body.
  assert(/meta: \$meta\[0\]/.test(publish),
    'tdoc-publish no longer sends local meta.json, so payload access never reaches /api/upload');
  // --visibility public must merge, not replace. Otherwise the documented
  // publish line would wipe history_visibility / commenting back to defaults.
  assert(/\.access\.visibility = \(if \$vis != "" then \$vis else \(\.access\.visibility \/\/ "unlisted"\) end\)/.test(publish),
    'tdoc-publish access merge no longer keeps unspecified fields from the payload');

  const workerSrc = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  assert(/if \(incoming\.access\)/.test(workerSrc) && /incoming\.access = normalizeAccess\(validatedAccess\.access/.test(workerSrc),
    '/api/upload no longer applies incoming.access; the payload policy would be dropped');
});

t('shipping the homepage ships content, not just worker code', () => {
  // deploy-tdoc-dev.yml deploys the Worker. The homepage is a doc in that
  // Worker's KV, so code-only CD leaves tdoc.dev/ on landingHtml()'s neutral
  // fallback while the run goes green — the exact failure that is invisible
  // from CI. A second workflow has to upload the doc.
  const dir = path.join(root, '.github', 'workflows');
  const code = fs.readFileSync(path.join(dir, 'deploy-tdoc-dev.yml'), 'utf8');
  assert(!/api\/upload/.test(code), 'deploy-tdoc-dev.yml now uploads docs; this guard needs rewriting');

  const wf = path.join(dir, 'publish-landing.yml');
  assert(fs.existsSync(wf), 'no workflow publishes the landing doc to tdoc.dev');
  const content = fs.readFileSync(wf, 'utf8');
  assert(/secrets\.TDOC_DEV_UPLOAD_TOKEN/.test(content),
    'publish workflow must authenticate with the tdoc.dev upload token');
  assert(/node bin\/tdoc-landing-release/.test(content),
    'publish workflow must build the release payload, not upload the working copy');
  assert(/https:\/\/tdoc\.dev\/api\/upload/.test(content), 'publish workflow does not POST to /api/upload');
  // The upload can succeed while the page still is not readable (access
  // gate, wrong slug). Green must mean the homepage actually renders.
  assert(/is still serving the neutral fallback/.test(content),
    'publish workflow must fail when tdoc.dev/ falls back to the neutral page');
  assert(/\[\[ "\$body" == \*'A doc that answers its own comments'\*/.test(content),
    'homepage verify must use bash [[ ]], not echo|grep -q under pipefail');
  assert(!/echo "\$body" \| grep -q/.test(content),
    'echo|grep -q SIGPIPEs on a 300kB landing page and fails a successful ship');
  // First merge: the live worker does not yet have landingResponse. A
  // push-triggered publish would GET tdoc.dev/ against that old worker
  // and fail the isLanding check. Wait for deploy tdoc.dev instead.
  assert(/workflow_run:/.test(content),
    'publish must wait for the worker deploy, not race it on push');
  assert(/deploy tdoc\.dev/.test(content),
    'publish must trigger off the hosted worker deploy workflow');
  assert(!/^\s+push:/m.test(content),
    'a push trigger races deploy-tdoc-dev.yml on the first merge to main');
  assert(/workflow_run\.head_sha/.test(content),
    'publish must check out the commit the Worker deploy just shipped');
  // First ship 401'd because TDOC_DEV_UPLOAD_TOKEN lived only in GitHub.
  // Token rotation is a manual dispatch input, never the automatic path.
  assert(/sync_upload_token/.test(content),
    'publish workflow must expose a manual token-sync input');
  assert(/github.event_name == 'workflow_dispatch' && inputs.sync_upload_token/.test(content),
    'token sync must be dispatch-only and opt-in');
  assert(/wrangler@4\.90\.1 secret put TDOC_UPLOAD_TOKEN/.test(content),
    'token sync must write TDOC_UPLOAD_TOKEN onto the Worker');
  const autoPath = content.split("if: github.event_name == 'workflow_dispatch' && inputs.sync_upload_token")[0];
  assert(!/secret put TDOC_UPLOAD_TOKEN/.test(autoPath),
    'the automatic workflow_run path must not rotate TDOC_UPLOAD_TOKEN');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
