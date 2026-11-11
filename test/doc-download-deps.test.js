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


  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
