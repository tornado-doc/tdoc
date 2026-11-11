// Sheets, cell formatting (shared/sheet-format.mjs): the whitelisted cell
// attributes read back exactly and nothing else (hostile values read as no
// format), number formats show as Google Sheets would and map to and from
// Excel's codes, merged cells (rowspan / colspan) read at the right columns,
// and a table laid out flat and merged again keeps its merges through rows
// and columns added or removed. No browser and no npm install.
const assert = require('node:assert/strict');
const { parseHtml } = require('./helpers/mini-dom');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}

(async () => {
  const F = await import('../shared/sheet-format.mjs');
  const M = await import('../shared/sheet-markup.mjs');
  console.log('sheets: cell formatting markup');

  const table = (body, head = '<th data-key="c1">A</th><th data-key="c2">B</th><th data-key="c3">C</th>') =>
    parseHtml(`<table data-tdoc-sheet data-name="T"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`).querySelector('table');

  await t('a format round-trips through the markup, attribute for attribute', () => {
    const f = { b: true, s: true, color: 'red', fill: 'yellow', align: 'center', valign: 'top', border: 't l', num: F.parseNum('currency:EUR:1') };
    const html = `<table data-tdoc-sheet><thead><tr><th>A</th></tr></thead><tbody><tr data-row="r1"><td${F.formatAttrString(f)}>5</td></tr></tbody></table>`;
    assert.match(html, /data-fmt="b s" data-color="red" data-fill="yellow" data-align="center" data-valign="top" data-border="t l" data-num="currency:EUR:1"/);
    const td = parseHtml(html).querySelector('td');
    const back = F.readFormat(td);
    assert.deepEqual(back, { b: true, s: true, color: 'red', fill: 'yellow', align: 'center', valign: 'top', border: 't l', num: { kind: 'currency', cur: 'EUR', dec: 1 } });
    // Written onto a cell, then cleared.
    const td2 = parseHtml('<table><tr><td>x</td></tr></table>').querySelector('td');
    F.writeFormat(td2, back);
    assert.deepEqual(F.readFormat(td2), back);
    F.writeFormat(td2, null);
    assert.equal(td2.hasAttributes(), false);
  });

  await t('hostile or unknown values read as no format; only the whitelist is ever written', () => {
    const hostile = [
      'data-fmt="b onclick=alert(1)" data-color="red;background:url(javascript:alert(1))" data-fill="#ff0000" data-align="justify" data-valign="baseline" data-border="x y" data-num="currency:XYZ:2"',
      'data-color="expression(alert(1))" data-num="number:99" data-fill="RED&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"',
      'data-num="date:%Y%m" data-fmt="' + 'b '.repeat(60) + '"',
      'data-num="percent:-1" data-border="t r b l t r b l t r b l t r b l t r b l t r b l t r b l t r b l t r b l"',
      'data-num="__proto__" data-color="constructor" data-fill="toString"',
    ];
    for (const attrs of hostile) {
      const td = parseHtml(`<table><tr><td ${attrs}>1</td></tr></table>`).querySelector('td');
      const f = F.readFormat(td);
      // Whatever survives is a whitelisted token, and serialises as one.
      if (f) {
        Object.keys(f).forEach((k) => assert.ok(['b', 'i', 's', 'color', 'fill', 'align', 'valign', 'border', 'num'].includes(k), k));
        if (f.color) assert.ok(F.COLORS.includes(f.color));
        if (f.fill) assert.ok(F.COLORS.includes(f.fill));
        const s = F.formatAttrString(f);
        assert.doesNotMatch(s, /[<>()]|javascript|url|expression|onerror/i);
      }
    }
    assert.equal(F.readFormat(parseHtml(`<table><tr><td ${hostile[0]}>1</td></tr></table>`).querySelector('td')).b, true, 'the valid token in a list is kept');
    assert.equal(F.readFormat(parseHtml(`<table><tr><td ${hostile[1]}>1</td></tr></table>`).querySelector('td')), null);
    assert.equal(F.readFormat(parseHtml(`<table><tr><td ${hostile[4]}>1</td></tr></table>`).querySelector('td')), null);
    // A format object with junk in it writes only valid attributes.
    const s = F.formatAttrString({ b: 'yes', color: 'red" onmouseover="x', fill: 'blue', num: 'currency:usd:2', border: 'l l t', align: 'middle' });
    assert.equal(s, ' data-fmt="b" data-fill="blue" data-border="t l" data-num="currency:USD:2"');
  });

  await t('number formats show like a spreadsheet; text and blanks are left as written', () => {
    const show = (v, spec) => F.displayValue(v, F.parseNum(spec));
    assert.equal(show('1234.5', 'number:2'), '1,234.50');
    assert.equal(show('1,234.567', 'number:0'), '1,235');
    assert.equal(show('-1234.5', 'currency:USD:2'), '-$1,234.50');
    assert.equal(show('1234.5', 'currency:EUR:0'), '€1,235');
    assert.equal(show('1234', 'currency:JPY'), '¥1,234');
    assert.equal(show('0.256', 'percent:1'), '25.6%');
    assert.equal(show('25%', 'percent:0'), '25%');
    assert.equal(show('(12)', 'number:1'), '-12.0');
    assert.equal(show('n/a', 'number:2'), 'n/a');
    assert.equal(show('', 'currency:USD:2'), '');
    assert.equal(show('2026-03-01', 'date:us'), '3/1/2026');
    assert.equal(show('2026-03-01', 'date:eu'), '01/03/2026');
    assert.equal(show('2026-03-01', 'date:medium'), 'Mar 1, 2026');
    assert.equal(show('2026-09-26', 'date:long'), 'September 26, 2026');
    assert.equal(show('2026-03-01 15:05', 'time:12'), '3:05 PM');
    assert.equal(show('2026-03-01 00:05', 'time:12'), '12:05 AM');
    assert.equal(show('09:30', 'time:24'), '09:30');
    assert.equal(show('2026-03-01 15:05', 'datetime:medium'), 'Mar 1, 2026 3:05 PM');
    assert.equal(show('next week', 'date:us'), 'next week');
    assert.equal(show('1234.5', 'text'), '1234.5');
    assert.equal(F.numSpec(F.stepDecimals('3.14159', null, -1)), 'number:4');
    assert.equal(F.numSpec(F.stepDecimals('3', F.parseNum('currency:USD:2'), 1)), 'currency:USD:3');
    assert.equal(F.numSpec(F.stepDecimals('3', F.parseNum('number:0'), -1)), 'number:0');
  });

  await t('number formats map to Excel codes and back', () => {
    for (const spec of ['number:2', 'number:0', 'percent:1', 'currency:USD:2', 'currency:EUR:0', 'currency:GBP:2', 'date:iso', 'date:us', 'date:eu', 'date:medium', 'date:long', 'time:24', 'time:12', 'datetime:medium', 'text']) {
      const n = F.parseNum(spec);
      assert.equal(F.numSpec(F.fromExcelFormat(F.excelFormat(n))), spec, spec);
    }
    assert.equal(F.numSpec(F.fromExcelFormat('_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)')), 'currency:USD:2');
    assert.equal(F.numSpec(F.fromExcelFormat('[$€-407] #,##0.00')), 'currency:EUR:2');
    assert.equal(F.numSpec(F.fromExcelFormat('0.00%')), 'percent:2');
    assert.equal(F.numSpec(F.fromExcelFormat('#,##0')), 'number:0');
    assert.equal(F.numSpec(F.fromExcelFormat('d-mmm-yy')), 'date:medium');
    assert.equal(F.fromExcelFormat('General'), null);
    assert.equal(F.fromExcelFormat('0'), null);
  });

  await t('merged cells read at their columns; covered slots are empty, the rest unshifted', () => {
    const tb = table('<tr data-row="r1"><td colspan="2">wide</td><td>c1</td></tr><tr data-row="r2"><td rowspan="2">tall</td><td>b2</td><td>c2</td></tr><tr data-row="r3"><td>b3</td><td>c3</td></tr>');
    const s = M.readSheetTable(tb);
    assert.deepEqual(s.rows.map((r) => r.cells), [['wide', '', 'c1'], ['tall', 'b2', 'c2'], ['', 'b3', 'c3']]);
    assert.deepEqual(s.merges, [{ r: 0, c: 0, rs: 1, cs: 2 }, { r: 1, c: 0, rs: 2, cs: 1 }]);
    assert.equal(s.rows[2].tds[0], null);
    assert.equal(s.rows[2].tds[1].textContent, 'b3');
    // Spans past the table's edge are cut to it; junk spans are 1.
    const tb2 = table('<tr data-row="r1"><td colspan="9" rowspan="abc">x</td></tr><tr data-row="r2"><td rowspan="-3">a</td><td>b</td><td>c</td></tr>');
    const s2 = M.readSheetTable(tb2);
    assert.deepEqual(s2.merges, [{ r: 0, c: 0, rs: 1, cs: 3 }]);
    assert.deepEqual(s2.rows[1].cells, ['a', 'b', 'c']);
  });

  await t('the writer leaves covered cells out and writes the attributes it is given', () => {
    const html = M.tableHtml({ name: 'T', columns: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], merges: [{ r: 0, c: 0, rs: 2, cs: 2 }],
      rows: [{ cells: ['top', 'x', 'y'], attrs: [F.formatAttrString({ b: true })] }, { cells: ['', '', 'z'] }] });
    assert.match(html, /<td data-fmt="b" colspan="2" rowspan="2">top<\/td><td>y<\/td><\/tr>/);
    assert.match(html, /<tr data-row="r2"><td>z<\/td><\/tr>/);
    const s = M.readSheetTable(parseHtml(html).querySelector('table'));
    assert.deepEqual(s.rows.map((r) => r.cells), [['top', '', 'y'], ['', '', 'z']]);
  });

  await t('laid out flat and merged again: a merge survives rows and columns added or removed', () => {
    const tb = table('<tr data-row="r1"><td colspan="2" rowspan="2">m</td><td>c1</td></tr><tr data-row="r2"><td>c2</td></tr><tr data-row="r3"><td>a3</td><td>b3</td><td>c3</td></tr>');
    const ths = () => M.headerCells(tb);
    // A row added inside the merge grows it; a column added inside it too.
    F.withMerges(tb, ths, () => {
      const rows = tb.tBodies[0].rows;
      assert.equal(rows[0].cells.length, 3, 'flat: every slot has a cell');
      const tr = tb.ownerDocument.createElement('tr');
      tr.setAttribute('data-row', 'r4');
      for (let k = 0; k < 3; k++) tr.appendChild(tb.ownerDocument.createElement('td'));
      tb.tBodies[0].insertBefore(tr, rows[1]);
      const th = tb.ownerDocument.createElement('th'); th.setAttribute('data-key', 'c4');
      ths()[0].parentElement.insertBefore(th, ths()[1]);
      tb.tBodies[0].rows.forEach((row) => row.insertBefore(tb.ownerDocument.createElement('td'), row.cells[1]));
    });
    let s = M.readSheetTable(tb);
    assert.deepEqual(s.merges, [{ r: 0, c: 0, rs: 3, cs: 3 }]);
    assert.deepEqual(s.rows.map((r) => r.id), ['r1', 'r4', 'r2', 'r3']);
    assert.deepEqual(s.rows[3].cells, ['a3', '', 'b3', 'c3']);
    // The merge's top row deleted: what is left of it stays merged.
    F.withMerges(tb, ths, () => { tb.tBodies[0].rows[0].remove(); });
    s = M.readSheetTable(tb);
    assert.deepEqual(s.merges, [{ r: 0, c: 0, rs: 2, cs: 3 }]);
    assert.equal(s.rows.length, 3);
    // Unmerge everything.
    F.withMerges(tb, ths, () => {}, () => []);
    s = M.readSheetTable(tb);
    assert.deepEqual(s.merges, []);
    assert.ok(s.rows.every((r) => r.tds.every(Boolean)));
  });

  await t('readFormats is sparse, and nothing for a sheet without formats', () => {
    const plain = table('<tr data-row="r1"><td>a</td><td>b</td><td>c</td></tr>');
    assert.equal(F.readFormats(M.readSheetTable(plain), plain), null);
    const tb = table('<tr data-row="r1"><td>a</td><td data-fmt="i">b</td><td data-color="nope">c</td></tr>');
    const map = F.readFormats(M.readSheetTable(tb), tb);
    assert.deepEqual([...map.keys()], [1]);
    assert.deepEqual(map.get(1), { i: true });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
