// Download checks that read the output back with real third-party parsers, so
// they need `npm ci` (the offline suite runs from a bare checkout):
//   - Markdown: hostile markup stays inert through marked (GFM), as GitHub renders it
//   - Excel: the workbook read back with SheetJS (xlsx, the bundled mini build)
// The rest of the download tests are offline: test/doc-download.test.js.
const fs = require('fs');
const path = require('path');
const { parseHtml } = require('./helpers/mini-dom.js');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'doc-download');
const SHEET = fs.readFileSync(path.join(FIX, 'expenses.html'), 'utf8');
const SHELL = require(path.join(ROOT, 'server', 'shell.js'));

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  console.log('Download: output read back by marked and SheetJS (needs npm ci)');

  await t('Markdown: hostile markup renders inert through a real Markdown renderer (marked)', async () => {
    // marked is a devDependency; GFM tables on, as GitHub.
    const { marked } = require('marked');
    const o = { title: 't', baseUrl: 'https://tdoc.dev/d/a/v/1/', docUrl: 'https://tdoc.dev/d/a/v/1' };
    const X = '&lt;img src=x onerror=alert(1)&gt;';
    const cases = {
      cellBackslashPipe: `<table><tr><th>h</th><th>h2</th></tr><tr><td><code>a\\|${X}</code></td><td>z</td></tr></table>`,
      cellBackslashPipeTick: `<table><tr><th>h</th><th>h2</th></tr><tr><td><code>a\\|${X}\`</code></td><td>z</td></tr></table>`,
      cellSplitCode: `<table><tr><th>h</th><th>h2</th></tr><tr><td><code>a\\</code>|<code>${X}</code></td><td>z</td></tr></table>`,
      cellTickPipe: `<table><tr><th>h</th><th>h2</th></tr><tr><td><code>\`|${X}</code></td><td>z</td></tr></table>`,
      cellKbdLink: `<table><tr><th>h</th></tr><tr><td><kbd>\\|<a href="https://ok/">x](javascript:alert(2))</a></kbd></td></tr></table>`,
      cell: `<table><tr><td><code>${X}|</code></td><td><kbd>${X}</kbd></td></tr></table>`,
      unclosedCode: `<p><code>${X}</p><p>[x](javascript:alert(2))</p>`,
      misnested: `<p><code><b>${X}</code></b></p>`,
      linkCode: `<p><a href="https://ok/"><code>](javascript:alert(3))</code></a></p>`,
      codeLink: `<p><code><a href="https://ok/">${X}</a></code></p>`,
      heading: `<h2><code>${X}</code> &lt;b&gt;</h2>`,
      backtickBefore: `<p>a\`<code>${X}</code>\`b</p>`,
      backslashBefore: `<p>\\<code>${X}</code></p>`,
      backslashEnd: `<p><code>x\\</code>${X}</p>`,
      nested: `<p><code>a<code>\\&lt;b&gt;</code>c</code></p>`,
      spaceOnly: `<p><code> </code>${X}</p>`,
      ticks: `<p><code>\`\`\`${X}</code></p>`,
      altInCode: `<p><code><img alt="](javascript:alert(5))" src="https://i/x.png"></code></p>`,
      listItem: `<ul><li><code>${X}</li><li>${X}</li></ul>`,
      quote: `<blockquote><kbd>${X}</kbd></blockquote>`,
      autolink: `<p><code>&lt;javascript:alert(6)&gt;</code> &lt;https://x&gt;</p>`,
      entity: `<p><code>&amp;lt;img&amp;gt;</code> &amp;lt;img src=x onerror=alert(7)&amp;gt;</p>`,
      jsLink: `<p><a href="javascript:alert(9)">js</a> <a href="https://ok/a|b">pipe</a></p>`,
    };
    const titles = { title: '<img src=x onerror=alert(8)> [a](javascript:1)' };
    for (const [name, html] of Object.entries({ ...cases, title: '<p>x</p>' })) {
      const md = SHELL.documentMarkdown(html, name === 'title' ? { ...o, ...titles } : o);
      const out = marked.parse(md);
      // Only real tags count: escaped text such as "&lt;img onerror…" is inert.
      const tags = out.match(/<[a-z][^>]*>/gi) || [];
      const live = tags.filter((tag) => /^<(img|script|svg|iframe|object|embed)\b/i.test(tag) || /\son\w+\s*=/i.test(tag) || /href="\s*javascript:/i.test(tag));
      assert(!live.length, `${name}: live markup ${live.join(' ')}\n${md}\n=> ${out}`);
    }
    // The review repro, exactly: the cell holds the text, the next cell is z.
    const repro = marked.parse(SHELL.documentMarkdown(cases.cellBackslashPipe, o));
    assert(/<td>a\\\|&lt;img src=x onerror=alert\(1\)&gt;<\/td>\s*<td>z<\/td>/.test(repro), repro);
  });

  const S = await import(path.join(ROOT, 'shell', 'src', 'document', 'sheet-export.mjs'));
  const sheets = S.sheetsFromDocument(parseHtml(SHEET));

  await t('Excel: every tab, numbers and checkboxes as values, names Excel accepts', async () => {
    const XLSX = require(path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js'));
    const book = XLSX.read(S.xlsxBytes(XLSX, sheets), { type: 'array' });
    assert(JSON.stringify(book.SheetNames) === '["Q3","Q4 (plan)"]', JSON.stringify(book.SheetNames));
    const q3 = XLSX.utils.sheet_to_json(book.Sheets.Q3, { header: 1 });
    assert(JSON.stringify(q3) === JSON.stringify([['Item', 'Amount', 'Paid', 'Tags'], ['Laptop, 14"', 1899, true, 'hardware, ana'], ['Coffee', 12.5, false, 'office'], ['-SUM(A1)', -3, true, '']]), JSON.stringify(q3));
    assert(!book.Sheets.Q3.A4.f, 'text is never a formula');
    assert(JSON.stringify(S.workbookNames([{ name: 'A/B' }, { name: 'a b' }, { name: 'x'.repeat(40) }])) === JSON.stringify(['A B', 'a b 2', 'x'.repeat(31)]), 'names');
  });

  await t('Excel: a cell with line breaks keeps them; a saved column width goes along', async () => {
    const XLSX = require(path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js'));
    const M = await import(path.join(ROOT, 'shared', 'sheet-markup.mjs'));
    const doc = parseHtml(`<body>${M.tableHtml({ name: 'N', columns: [{ name: 'Note', type: 'text', width: 240, wrap: true }, { name: 'B', type: 'text' }], rows: [{ id: 'r1', cells: ['one\ntwo', 'x'] }] })}</body>`);
    const book = XLSX.read(S.xlsxBytes(XLSX, S.sheetsFromDocument(doc)), { type: 'array', cellStyles: true });
    const ws = book.Sheets.N;
    assert(ws.A2.v === 'one\ntwo', JSON.stringify(ws.A2));
    assert(ws['!cols'] && ws['!cols'][0] && Math.abs((ws['!cols'][0].wpx || 0) - 240) < 8, JSON.stringify(ws['!cols']));
  });

  await t('Excel: cell formats go along (number formats, bold, colours, fills, borders, alignment, merges) and an import keeps them', async () => {
    const XLSX = require(path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js'));
    const M = await import(path.join(ROOT, 'shared', 'sheet-markup.mjs'));
    const F = await import(path.join(ROOT, 'shared', 'sheet-format.mjs'));
    const I = await import(path.join(ROOT, 'shared', 'sheet-import.mjs'));
    const X = await import(path.join(ROOT, 'shared', 'sheet-xlsx-style.mjs'));
    const a = (f) => F.formatAttrString(f);
    const doc = parseHtml(`<body>${M.tableHtml({ name: 'Budget', columns: [{ name: 'Item', type: 'text' }, { name: 'Amount', type: 'number' }, { name: 'Share', type: 'number' }, { name: 'Due', type: 'date' }, { name: 'Note', type: 'text' }],
      merges: [{ r: 0, c: 4, rs: 2, cs: 1 }],
      rows: [
        { id: 'r1', cells: ['Laptops', '1234.5', '0.25', '2026-03-01', 'Both rows'], attrs: [a({ b: true, fill: 'yellow' }), a({ num: 'currency:USD:2' }), a({ num: 'percent:1' }), a({ num: 'date:medium' }), a({ valign: 'middle', align: 'center' })] },
        { id: 'r2', cells: ['Desks', '-80', '0.5', '2026-04-15', ''], attrs: [a({ i: true, s: true, color: 'red', border: 't r b l' }), a({ num: 'currency:EUR:0' }), '', ''] },
      ] })}</body>`);
    const bytes = S.xlsxBytes(XLSX, S.sheetsFromDocument(doc));
    const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true, bookFiles: true });
    const ws = book.Sheets.Budget;
    assert(ws.B2.t === 'n' && ws.B2.v === 1234.5 && ws.B2.w === '$1,234.50', JSON.stringify(ws.B2));
    assert(ws.C2.v === 0.25 && ws.C2.w === '25.0%', JSON.stringify(ws.C2));
    assert(ws.D2.t === 'n' && ws.D2.v === 46082 && /mmm/.test(ws.D2.z), `a date is a serial with its format: ${JSON.stringify(ws.D2)}`);
    assert(ws.B3.w === '-€80', JSON.stringify(ws.B3));
    assert(JSON.stringify(ws['!merges']) === JSON.stringify([{ s: { c: 4, r: 1 }, e: { c: 4, r: 2 } }]), JSON.stringify(ws['!merges']));
    assert(ws.A2.s && ws.A2.s.patternType === 'solid' && ws.A2.s.fgColor.rgb === 'FDF4CF', `SheetJS reads the fill back: ${JSON.stringify(ws.A2.s)}`);
    const styles = X.readXlsxStyles(XLSX, book).get('Budget');
    assert(JSON.stringify(styles.get('A2')) === JSON.stringify({ b: true, fill: 'yellow' }), JSON.stringify(styles.get('A2')));
    assert(JSON.stringify(styles.get('A3')) === JSON.stringify({ i: true, s: true, color: 'red', border: 't r b l' }), JSON.stringify(styles.get('A3')));
    assert(JSON.stringify(styles.get('E2')) === JSON.stringify({ align: 'center', valign: 'middle' }), JSON.stringify(styles.get('E2')));
    // Imported back: the same values, formats and merge.
    const out = await I.importSheetFile({ name: 'budget.xlsx', bytes }, { loadXlsx: async () => XLSX });
    const back = M.readSheetTable(parseHtml(out.html).querySelector('table'));
    assert(JSON.stringify(back.rows.map((r) => r.cells.slice(0, 4))) === JSON.stringify([['Laptops', '1234.5', '0.25', '2026-03-01'], ['Desks', '-80', '0.5', '2026-04-15']]), JSON.stringify(back.rows.map((r) => r.cells)));
    assert(JSON.stringify(back.merges) === JSON.stringify([{ r: 0, c: 4, rs: 2, cs: 1 }]), JSON.stringify(back.merges));
    const f = F.readFormats(back, back.table);
    const at = (r, c) => F.formatAttrString(f.get(r * F.KEY + c));
    assert(at(0, 0) === ' data-fmt="b" data-fill="yellow"', at(0, 0));
    assert(at(0, 1) === ' data-num="currency:USD:2"' && at(0, 2) === ' data-num="percent:1"' && at(0, 3) === ' data-num="date:medium"', [at(0, 1), at(0, 2), at(0, 3)].join());
    assert(at(1, 0) === ' data-fmt="i s" data-color="red" data-border="t r b l"' && at(1, 1) === ' data-num="currency:EUR:0"', [at(1, 0), at(1, 1)].join());
    assert(at(0, 4) === ' data-align="center" data-valign="middle"', at(0, 4));
  });

  await t('Excel import: colours map to the palette; a blank row inside a merge is kept, others dropped as before', async () => {
    const X = await import(path.join(ROOT, 'shared', 'sheet-xlsx-style.mjs'));
    assert(X.nearestColor([255, 255, 0], 'fill') === 'yellow' && X.nearestColor([255, 0, 0], 'color') === 'red' && X.nearestColor([0, 112, 192], 'fill') === 'blue', 'hues');
    assert(X.nearestColor([255, 255, 255], 'fill') === '' && X.nearestColor([0, 0, 0], 'color') === '' && X.nearestColor([128, 128, 128], 'fill') === 'gray', 'neutrals');
    const XLSX = require(path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js'));
    const I = await import(path.join(ROOT, 'shared', 'sheet-import.mjs'));
    const M = await import(path.join(ROOT, 'shared', 'sheet-markup.mjs'));
    const ws = XLSX.utils.aoa_to_sheet([['A', 'B'], ['x', 'tall'], [], ['y', 'z'], [], ['w', 'v']]);
    ws['!merges'] = [{ s: { r: 1, c: 1 }, e: { r: 2, c: 1 } }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    const out = await I.importSheetFile({ name: 's.xlsx', bytes }, { loadXlsx: async () => XLSX });
    const back = M.readSheetTable(parseHtml(out.html).querySelector('table'));
    assert(JSON.stringify(back.rows.map((r) => r.cells)) === JSON.stringify([['x', 'tall'], ['', ''], ['y', 'z'], ['w', 'v']]), JSON.stringify(back.rows.map((r) => r.cells)));
    assert(JSON.stringify(back.merges) === JSON.stringify([{ r: 0, c: 1, rs: 2, cs: 1 }]), JSON.stringify(back.merges));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
