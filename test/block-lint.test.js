// The publish-time block check (server/block-lint.js) and the house blocks it
// points at. The check is advice on a published version: it must name loose
// text and non-house wrapper classes, stay quiet on block-shaped docs and on
// atomic artifacts, stay linear on 8 MB sheets and hostile input, and never
// turn an upload into a failure.
const fs = require('fs');
const path = require('path');
const { lint, KNOWN_CLASSES } = require('../server/block-lint');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
const page = (body, rootAttrs = '') => `<!doctype html><html${rootAttrs}><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><style>body{background:#fff}</style></head><body><main class="wrap">${body}</main></body></html>`;
const ms = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };

(async () => {
  console.log('block check (publish-time lint)\n');

  await t('the old guide\'s tiles and a custom card are flagged, with a fix hint', () => {
    const r = lint(page('<div class="tiles"><div class="tile"><b>11</b><span>what it counts</span></div></div><div class="card"><h3>A</h3>loose words</div>'));
    assert(r.loose_text === 3, `loose ${r.loose_text}`);
    assert(r.unknown_classes.map((c) => c.name).join(',') === 'tiles,tile,card', JSON.stringify(r.unknown_classes));
    assert(/div\.tile "11"/.test(r.warning) && /div\.card "loose words"/.test(r.warning), r.warning);
    assert(/warning only; the doc is published/.test(r.warning), 'says it is not a refusal');
    assert(/^Fix: .*tdoc-tiles.*data-tdoc-artifact.*components\.md$/m.test(r.warning), 'one-line fix hint');
  });

  await t('every house block, written as the guide shows it, is clean', () => {
    const r = lint(read('test/fixtures/block-first/after.html'));
    assert(r.warning === null && r.loose_text === 0 && r.unknown_class_count === 0, JSON.stringify(r));
    const all = lint(page(`<h2>H</h2><p>a <b>b</b> <a href="#">c</a></p><ul><li>x<li>y</ul><ol><li><p>z</p></li></ol>
      <blockquote>quoted</blockquote><pre>code <b>x</b></pre><hr>
      <div class="tdoc-tiles"><div class="tdoc-tile"><p class="tdoc-tile-num">11%</p><p>label</p></div></div>
      <div class="tdoc-cards"><div class="tdoc-card"><h3>A</h3><p>b</p><ul><li>c</li></ul></div></div>
      <aside class="note"><p>n</p></aside><details><summary>More</summary><p>x</p></details>
      <figure><img src="a.png" alt="a"><figcaption>cap</figcaption></figure>
      <div class="diagram-box" data-tdoc-artifact><svg viewBox="0 0 10 10"><text>label</text></svg><p class="cap">c</p></div>
      <div class="tdoc-table-scroll"><table><tr><th>h</th><td>v</td></tr></table></div><dl><dt>t</dt><dd>d</dd></dl>`));
    assert(all.warning === null, all.warning);
  });

  await t('the before fixture (old guide markup) is flagged, the after fixture is not', () => {
    const before = lint(read('test/fixtures/block-first/before.html'));
    assert(before.loose_text > 0 && before.unknown_class_count > 0, JSON.stringify(before));
    assert(lint(read('test/fixtures/block-first/after.html')).warning === null, 'after is block-shaped');
  });

  await t('artifacts are atomic: anything goes inside a figure or data-tdoc-artifact element', () => {
    const r = lint(page(`<div class="funnel" data-tdoc-artifact="Funnel"><div class="row"><span>Visits</span> 12,000</div></div>
      <section class="slide" data-tdoc-slide data-tdoc-artifact="Slide 1"><div class="top"><span class="tag">x</span></div>free text</section>
      <figure class="chart"><div class="legend">a b</div></figure>
      <figure data-tdoc-excalidraw="{}"><div class="diagram-box" data-tdoc-diagram-snapshot><svg></svg></div></figure>
      <div class="widget tdoc-artifact">text</div>`));
    assert(r.warning === null, r.warning);
  });

  await t('tables (sheets included), svg, pre, scripts, styles and comments are not read as loose text', () => {
    const r = lint(page(`<table data-tdoc-sheet data-name="T"><tr><td><div>cell div</div></td></tr><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>
      <svg><text>t</text><foreignObject><div>fo</div></foreignObject></svg><pre><div>code</div></pre><!-- <div>c</div> -->
      <template><div>tpl</div></template><style>.x{}</style><textarea>t <div></textarea><p>after</p>`));
    assert(r.loose_text === 0 && r.unknown_class_count === 0, r.warning);
    const after = lint(page('<table><tr><td>a</td></tr></table><div>stray</div>'));
    assert(after.loose_text === 1, 'scanning resumes after a skipped table');
  });

  await t('loose text right in the content root or body counts; whitespace and &nbsp; do not', () => {
    assert(lint(page('Hello there')).loose_text === 1, 'text in main.wrap');
    assert(lint('<html><body>bare text<p>x</p></body></html>').loose_text === 1, 'text in body');
    assert(lint(page('<div>\n  &nbsp; </div><div class="tdoc-tiles">\n</div>')).warning === null, 'blank is not text');
  });

  await t('unknown classes are counted per wrapper, house and root classes are not', () => {
    const r = lint(page('<section class="intro"><p>a</p></section><div class="grid"><div class="grid"><p>x</p></div></div><div class="wrap note diagram-box"><p>y</p></div><p class="lead">z <span class="num">1</span></p>'));
    assert(r.unknown_classes.map((c) => `${c.name}:${c.count}`).join(',') === 'grid:2,intro:1', JSON.stringify(r.unknown_classes));
    assert(r.loose_text === 0, 'paragraph text inside unknown wrappers is still text in a block');
    for (const cls of ['tdoc-tiles', 'tdoc-tile', 'tdoc-cards', 'tdoc-card', 'note', 'diagram-box', 'tdoc-table-scroll']) assert(KNOWN_CLASSES.includes(cls), cls);
  });

  await t('a custom design is told a report reads better as a standard doc', () => {
    const r = lint(page('<div class="hero">Big words</div>', ' data-tdoc-design="custom"'));
    assert(r.custom_design && /--custom-template/.test(r.warning), r.warning);
    assert(!lint(page('<div class="hero">Big words</div>')).custom_design, 'standard doc');
  });

  await t('output is bounded: at most five samples and eight classes, one sample per wrapper', () => {
    const body = Array.from({ length: 40 }, (_, i) => `<div class="c${i}">t${i}</div><div class="c${i}">u${i}</div>`).join('');
    const r = lint(page(body));
    assert(r.loose_text === 80 && r.loose_text_samples.length === 5 && r.unknown_classes.length === 8 && r.unknown_class_count === 40, JSON.stringify({ l: r.loose_text, s: r.loose_text_samples.length, c: r.unknown_classes.length }));
    assert(new Set(r.loose_text_samples.map((s) => s.where)).size === 5, 'samples come from different wrappers');
    assert(r.warning.split('\n').length <= 3 && r.warning.length < 900, `warning is short: ${r.warning.length}`);
  });

  await t('linear and capped: an 8 MB sheet, a 5 MB prose doc and hostile markup stay fast', () => {
    const rows = Array.from({ length: 60000 }, (_, i) => `<tr data-row="r${i}"><td>${'x'.repeat(40)}</td><td>${i}</td><td>abc &amp; def</td><td>lorem ipsum dolor</td></tr>`).join('');
    const sheet = page(`<table data-tdoc-sheet data-name="T"><tbody>${rows}</tbody></table><div>after</div>`);
    assert(sheet.length > 8e6, 'sheet is 8 MB');
    let r;
    const sheetMs = ms(() => { r = lint(sheet); });
    assert(r.loose_text === 1 && !r.truncated, 'whole sheet doc read, table skipped');
    const prose = page(Array.from({ length: 40000 }, (_, i) => `<div class="kpi"><span>${i}</span> loose</div><p>${'y'.repeat(50)}</p>`).join(''));
    const proseMs = ms(() => { r = lint(prose); });
    assert(r.truncated && /first part of the doc only/.test(r.warning), 'a capped scan says so');
    const hostile = ['<div class="a' + '<'.repeat(2e6), '<div "' + 'a<b '.repeat(1e6), '<div>' + '<p '.repeat(2e6), '<div a="' + 'x '.repeat(2e6), '<div>'.repeat(1e6) + '</span>'.repeat(1e6), '<table>'.repeat(5e5)];
    const worst = Math.max(...hostile.map((h) => ms(() => lint(h))));
    assert(sheetMs < 400 && proseMs < 1500 && worst < 1500, `sheet ${sheetMs}ms, prose ${proseMs}ms, worst hostile ${worst}ms`);
  });

  // A sheet table of n body rows (a <thead> header, or a <th> row in the body).
  const sheetTable = (name, n, thead = true) => `<div class="tdoc-table-scroll"><table data-tdoc-sheet data-name="${name}">`
    + (thead ? '<thead><tr><th data-key="c1">A</th><th data-key="c2">B</th></tr></thead><tbody>' : '<tr><th>A</th><th>B</th></tr>')
    + Array.from({ length: n }, (_, i) => `<tr data-row="r${i + 1}"><td>a${i}</td><td>${i}</td></tr>`).join('') + (thead ? '</tbody>' : '') + '</table></div>';
  const prose = '<h1>Supplier follow up</h1><p>Where each supplier stands.</p><h2>Next</h2><p>Call EGI first.</p>';

  await t('a small sheet in a prose doc is told to be a plain table; a big one and a sheet doc are not', () => {
    const r = lint(page(prose + sheetTable('CRM', 5) + sheetTable('Notes', 20, false) + sheetTable('Inventory', 21)));
    assert(r.small_sheet_count === 2 && r.small_sheets.map((x) => `${x.name}:${x.rows}x${x.cols}`).join(',') === 'CRM:5x2,Notes:20x2', JSON.stringify(r.small_sheets));
    assert(r.warning === 'Block check (a warning only; the doc is published): Small table in a doc: use a plain <table>; keep sheets for data people filter or sort, and for wide tables or long cell text ("CRM" 5 rows × 2 columns, "Notes" 20 rows × 2 columns). Guide: tdoc://authoring/structure/sheets.md', r.warning);
    assert(r.loose_text === 0 && r.unknown_class_count === 0, 'nothing else is flagged');
    // A sheet doc: a title, a line on what it is, the sheet (any size).
    const doc = lint(page('<h1>Tasks</h1><p class="sheet-note">Thirty tasks.</p><p>From the Q3 export.</p>' + sheetTable('Tasks', 3) + sheetTable('People', 2)));
    assert(doc.warning === null && doc.small_sheet_count === 0, JSON.stringify(doc));
    // Prose is three text blocks outside the sheets, or other doc content (a plain table, a figure).
    assert(lint(page('<h1>T</h1><p>a</p><p>b</p>' + sheetTable('S', 4))).small_sheet_count === 0, 'two paragraphs is still a sheet doc');
    assert(lint(page('<h1>T</h1><p>a</p><ul><li>b</li><li>c</li></ul>' + sheetTable('S', 4))).small_sheet_count === 1, 'three blocks is prose');
    assert(lint(page('<h1>T</h1>' + sheetTable('S', 4) + '<table><tr><td>x</td></tr></table>')).small_sheet_count === 1, 'a plain table beside it is a doc');
    assert(lint(page(prose + sheetTable('Big', 400))).warning === null, 'a 400-row sheet in a doc is fine');
    assert(lint(page(prose + '<table><tr><td>a</td></tr></table>')).warning === null, 'a plain table is fine');
    // Wide (more than five columns) or long cell text: a sheet is fine.
    const cols = (n, cell = 'x') => `<table data-tdoc-sheet><thead><tr>${'<th>h</th>'.repeat(n)}</tr></thead><tbody>${`<tr>${`<td>${cell}</td>`.repeat(n)}</tr>`.repeat(3)}</tbody></table>`;
    assert(lint(page(prose + cols(5))).small_sheet_count === 1 && lint(page(prose + cols(6))).warning === null, 'six columns is wide');
    assert(lint(page(prose + cols(2, 'y'.repeat(81)))).warning === null && lint(page(prose + cols(2, '<b>' + 'y'.repeat(80) + '</b> &amp;'))).small_sheet_count === 1, 'a cell over 80 characters is long text');
  });

  await t('the small-sheet line follows the block check, and its list is bounded', () => {
    const r = lint(page(prose + '<div class="tile">11%</div>' + Array.from({ length: 9 }, (_, i) => sheetTable(`T${i}`, 2)).join('')));
    const lines = r.warning.split('\n');
    assert(/^Block check .*loose text/.test(lines[0]) && /^Fix: /.test(lines[1]) && /^Small table in a doc: .*"T4" 2 rows × 2 columns, …\)\. Guide: /.test(lines[2]), r.warning);
    assert(r.small_sheet_count === 9 && r.small_sheets.length === 5, JSON.stringify(r.small_sheets));
  });

  await t('counting a sheet\'s rows stays linear: 60k-row sheets, header-only rows, rows without cells', () => {
    const big = page(prose + sheetTable('Big', 60000));
    const thOnly = page(prose + '<table data-tdoc-sheet>' + '<tr><th>x</th></tr>'.repeat(200000) + '</table>');
    const bare = page(prose + '<table data-tdoc-sheet>' + '<tr>'.repeat(300000) + '</table><p>' + 'z'.repeat(1e6) + '</p>');
    let r;
    const times = [big, thOnly, bare].map((h) => ms(() => { r = lint(h); }));
    assert(lint(thOnly).small_sheets[0].rows === 0, 'header rows are not body rows');
    assert(Math.max(...times) < 400, `times ${times.map((x) => x.toFixed(0)).join(', ')}ms`);
  });

  await t('reader.css styles every house block, and the guide shows each one\'s markup', () => {
    const css = read('server/reader.css');
    const section = css.match(/\/\* House blocks[\s\S]*?\/\* End house blocks\. \*\//);
    assert(section, 'house blocks section with its end marker');
    for (const sel of ['.tdoc-tiles', '.tdoc-tile', '.tdoc-tile-num', '.tdoc-cards', '.tdoc-card', 'aside.note', 'details', 'summary', 'figure', '.diagram-box']) {
      assert(section[0].includes(sel), `reader.css does not style ${sel}`);
    }
    assert(!/#[0-9a-f]{3,6}\b/i.test(section[0]), 'house blocks use the --td-* tokens, not colours');
    const c = read('authoring/structure/components.md');
    for (const m of ['<div class="tdoc-tiles">', '<p class="tdoc-tile-num">', '<div class="tdoc-cards">', '<div class="tdoc-card">', '<aside class="note"><p>', '<details>', '<summary>', '<figcaption>', '<div class="diagram-box" data-tdoc-artifact>']) {
      assert(c.includes(m), `components.md lost ${m}`);
    }
    assert(!/class="tiles"|class="tile"|<p class="note">/.test(c), 'components.md still teaches the pre-block tiles or note');
  });

  // ---- through the worker -------------------------------------------------
  const worker = await loadWorker();
  const env = makeEnv(worker.CommentsStore, { TDOC_UPLOAD_TOKEN: 'admin-test-token' });
  const call = async (p, o) => worker.default.fetch(req(p, o), env, { waitUntil() {} });
  const meta = (version) => ({ title: 'T', access: { visibility: 'unlisted' }, versions: Array.from({ length: version }, (_, i) => ({ n: i + 1 })) });
  const upload = async (slug, version, html) => {
    const r = await call('/api/upload', { method: 'POST', token: 'admin-test-token', body: { slug, version, html, meta: meta(version) } });
    return { status: r.status, body: await r.json() };
  };

  await t('/api/upload publishes and returns the block check as advice', async () => {
    const r = await upload('lint-old', 1, read('test/fixtures/block-first/before.html'));
    assert(r.status === 200 && r.body.ok, JSON.stringify(r.body));
    assert(/^Block check/.test(r.body.block_warning) && r.body.block_lint.loose_text > 0 && r.body.block_lint.unknown_class_count > 0, JSON.stringify(r.body));
    assert(await env.DOCS.head('docs/lint-old/v1/index.html'), 'the version is stored');
    const clean = await upload('lint-new', 1, read('test/fixtures/block-first/after.html'));
    const small = await upload('lint-sheet', 1, page(prose + sheetTable('CRM', 5)));
    assert(small.body.ok && /^Block check.*Small table in a doc/.test(small.body.block_warning) && small.body.block_lint.small_sheet_count === 1 && small.body.block_lint.small_sheets[0].rows === 5, JSON.stringify(small.body));
    assert(clean.body.ok && !('block_warning' in clean.body) && !('block_lint' in clean.body), JSON.stringify(clean.body));
  });

  await t('a new upload bakes the house blocks; a revision of an older doc that adopts them gets the section', async () => {
    const v1 = env.DOCS.map.get('docs/lint-new/v1/index.html');
    assert(/<style id="tdoc-reader"[^>]*>[\s\S]*House blocks[\s\S]*<\/style>/.test(v1), 'fresh bake carries the house blocks');
    const oldReader = '<style id="tdoc-reader" data-tdoc-template="0ld0ld00">:where(body p){margin:0 0 16px}</style>';
    const withOld = (body) => page(body).replace('</head>', `${oldReader}</head>`);
    await upload('lint-legacy', 1, withOld('<p>plain</p>'));
    assert(!/House blocks/.test(env.DOCS.map.get('docs/lint-legacy/v1/index.html')), 'an older doc that does not use them keeps its bytes');
    await upload('lint-legacy', 2, withOld('<div class="tdoc-tiles"><div class="tdoc-tile"><p class="tdoc-tile-num">1</p><p>x</p></div></div>'));
    const v2 = env.DOCS.map.get('docs/lint-legacy/v2/index.html');
    const block = v2.match(/<style id="tdoc-reader"[^>]*>([\s\S]*?)<\/style>/)[1];
    assert(block.startsWith(':where(body p)') && /\.tdoc-tile \.tdoc-tile-num/.test(block), 'section added inside the old template');
    assert((v2.match(/House blocks/g) || []).length === 1, 'added once');
    await upload('lint-legacy', 3, v2);
    assert((env.DOCS.map.get('docs/lint-legacy/v3/index.html').match(/\/\* House blocks/g) || []).length === 1, 'idempotent on re-publish');
  });

  await t('the CLI prints the server\'s block warning after a successful upload', () => {
    const src = read('bin/tdoc-publish');
    assert(/json_get block_warning/.test(src) && /printf '%s\\n' "\$block_warning" \| sed 's\/\^\/\[tdoc\] \/' >&2/.test(src), 'tdoc-publish prints block_warning to stderr');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
