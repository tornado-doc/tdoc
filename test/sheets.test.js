// Sheets, the pure modules: the view query (search, filters, multi-column
// sort, view state in the URL), CSV/TSV parsing and type inference, and the
// markup round trip (model → <table data-tdoc-sheet> → model, and one cell
// written back). No browser and no npm install: .xlsx parsing needs SheetJS
// and is tested in sheets-xlsx.test.js.
const assert = require('node:assert/strict');
const { parseHtml } = require('./helpers/mini-dom');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}

(async () => {
  const Q = await import('../shared/sheet-query.mjs');
  const M = await import('../shared/sheet-markup.mjs');
  const I = await import('../shared/sheet-import.mjs');

  console.log('sheets: query, import parsing, markup round trip');

  const sheet = {
    columns: [
      { name: 'Name', type: 'text' },
      { name: 'Amount', type: 'number' },
      { name: 'Due', type: 'date' },
      { name: 'Labels', type: 'tags' },
      { name: 'Done', type: 'checkbox' },
    ],
    rows: [
      { id: 'r1', cells: ['Alice', '1,200.50', '2026-03-01', ['urgent', 'q1'], '✓'] },
      { id: 'r2', cells: ['bob', '80', '2026-01-15', ['later'], ''] },
      { id: 'r3', cells: ['Carol', '', '', [], ''] },
      { id: 'r4', cells: ['dave', '-5', '2025-12-31', ['urgent'], 'yes'] },
      { id: 'r5', cells: ['Alice', '80', '2026-02-01', ['q1'], ''] },
    ],
  };
  const index = Q.buildIndex(sheet);
  const names = (order) => order.map((r) => sheet.rows[r].id);

  await t('an empty query keeps every row in document order', () => {
    assert.deepEqual(names(Q.runQuery(index, Q.emptyQuery())), ['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  await t('search matches any cell, case-insensitively, tags included', () => {
    assert.deepEqual(names(Q.runQuery(index, { search: 'ALICE', filters: {}, sort: [] })), ['r1', 'r5']);
    assert.deepEqual(names(Q.runQuery(index, { search: 'urg', filters: {}, sort: [] })), ['r1', 'r4']);
    const m = Q.searchMatches(index, Q.runQuery(index, Q.emptyQuery()), 'q1');
    assert.deepEqual(m.hits.map((h) => [sheet.rows[h.row].id, h.col]), [['r1', 3], ['r5', 3]]);
    assert.equal(m.total, 2);
  });

  await t('value filters: text exact (trimmed), tags any-of, blank as ""', () => {
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: { 0: { values: ['Alice'] } }, sort: [] })), ['r1', 'r5']);
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: { 3: { values: ['later', 'q1'] } }, sort: [] })), ['r1', 'r2', 'r5']);
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: { 3: { values: [''] } }, sort: [] })), ['r3']);
  });

  await t('range filters on numbers and dates are inclusive; blanks drop out', () => {
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: { 1: { min: 0, max: 80 } }, sort: [] })), ['r2', 'r5']);
    const jan = Q.parseDate('2026-01-01'), feb = Q.parseDate('2026-02-01');
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: { 2: { min: jan, max: feb } }, sort: [] })), ['r2', 'r5']);
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: { 4: { checked: true } }, sort: [] })), ['r1', 'r4']);
  });

  await t('filters and search combine (AND)', () => {
    assert.deepEqual(names(Q.runQuery(index, { search: 'alice', filters: { 3: { values: ['urgent'] } }, sort: [] })), ['r1']);
  });

  await t('multi-column sort: numbers numerically, blanks last both ways, stable ties', () => {
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: {}, sort: [{ col: 1, dir: 'asc' }] })), ['r4', 'r2', 'r5', 'r1', 'r3']);
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: {}, sort: [{ col: 1, dir: 'desc' }] })), ['r1', 'r2', 'r5', 'r4', 'r3']);
    // Amount desc, then Name asc breaks the 80/80 tie (Alice before bob).
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: {}, sort: [{ col: 1, dir: 'desc' }, { col: 0, dir: 'asc' }] })), ['r1', 'r5', 'r2', 'r4', 'r3']);
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: {}, sort: [{ col: 2, dir: 'asc' }] })), ['r4', 'r2', 'r5', 'r1', 'r3']);
    // Text sorts with a collator: case-insensitive.
    assert.deepEqual(names(Q.runQuery(index, { search: '', filters: {}, sort: [{ col: 0, dir: 'asc' }] })), ['r1', 'r5', 'r2', 'r3', 'r4']);
  });

  await t('toggleSort cycles asc → desc → off; shift adds a key', () => {
    let q = Q.toggleSort(Q.emptyQuery(), 1, false);
    assert.deepEqual(q.sort, [{ col: 1, dir: 'asc' }]);
    q = Q.toggleSort(q, 0, true);
    assert.deepEqual(q.sort, [{ col: 1, dir: 'asc' }, { col: 0, dir: 'asc' }]);
    q = Q.toggleSort(q, 1, true);
    assert.deepEqual(q.sort, [{ col: 1, dir: 'desc' }, { col: 0, dir: 'asc' }]);
    q = Q.toggleSort(q, 1, false);
    assert.deepEqual(q.sort, []);
  });

  await t('distinct values explode tags and count blanks', () => {
    const tags = Q.distinctValues(index, 3);
    assert.deepEqual(tags.slice(0, 2).map((v) => [v.value, v.count]), [['q1', 2], ['urgent', 2]]);
    assert(tags.some((v) => v.value === '' && v.count === 1));
    assert.deepEqual(Q.columnRange(index, 1), { min: -5, max: 1200.5 });
  });

  await t('view state survives the URL and rejects junk', () => {
    const view = { active: 'Tab 2', tabs: { 'Tab 1': { search: 'a,b', filters: { 3: { values: ['x'] }, 1: { min: 2 } }, sort: [{ col: 1, dir: 'desc' }, { col: 0, dir: 'asc' }] }, Empty: Q.emptyQuery() } };
    const text = Q.encodeView(view);
    const back = Q.decodeView(text);
    assert.equal(back.active, 'Tab 2');
    assert.deepEqual(back.tabs['Tab 1'], view.tabs['Tab 1']);
    assert(!('Empty' in back.tabs));
    assert.deepEqual(Q.decodeView('%7Bnot json'), { active: '', tabs: {} });
    assert.deepEqual(Q.decodeView(encodeURIComponent(JSON.stringify({ t: { a: { f: { '-1': { values: [1] }, x: {} }, s: 'evil,2' } } }))).tabs.a, { search: '', filters: {}, sort: [{ col: 2, dir: 'asc' }] });
    assert.equal(Q.encodeView({ active: '', tabs: { a: Q.emptyQuery() } }), '');
  });

  await t('inserting or deleting a column re-keys a saved view', () => {
    const q = { search: '', filters: { 1: { values: ['a'] }, 3: { min: 1 } }, sort: [{ col: 3, dir: 'asc' }, { col: 1, dir: 'desc' }] };
    assert.deepEqual(Q.shiftQueryColumns(q, 2, 1).filters, { 1: { values: ['a'] }, 4: { min: 1 } });
    const del = Q.shiftQueryColumns(q, 1, -1);
    assert.deepEqual(del.filters, { 2: { min: 1 } });
    assert.deepEqual(del.sort, [{ col: 2, dir: 'asc' }]);
  });

  await t('value parsing: numbers with separators, currency, parentheses; dates; checkboxes', () => {
    assert.equal(Q.parseNumber('1,234.5'), 1234.5);
    assert.equal(Q.parseNumber('$12'), 12);
    assert.equal(Q.parseNumber('(7)'), -7);
    assert.equal(Q.parseNumber('12%'), 12);
    assert.equal(Q.parseNumber('12 apples'), null);
    assert.equal(Q.parseDate('2026-01-31'), Date.UTC(2026, 0, 31));
    assert.equal(Q.parseDate('1/31/2026'), Date.UTC(2026, 0, 31));
    assert.equal(Q.parseDate('31/1/2026'), Date.UTC(2026, 0, 31));
    assert.equal(Q.parseDate('2026-02-30'), null);
    assert.equal(Q.parseDate('42'), null);
    assert.equal(Q.formatDate(Date.UTC(2026, 0, 31)), '2026-01-31');
    assert.equal(Q.parseCheckbox('✓'), true);
    assert.equal(Q.parseCheckbox('No'), false);
    assert.equal(Q.columnLetter(0), 'A');
    assert.equal(Q.columnLetter(27), 'AB');
  });

  await t('type inference', () => {
    assert.equal(Q.inferType(['1', '2.5', '-3', '1,000']), 'number');
    assert.equal(Q.inferType(['2026-01-01', '2026-02-03', '']), 'date');
    assert.equal(Q.inferType(['yes', 'no', 'yes']), 'checkbox');
    assert.equal(Q.inferType(['https://a.example', 'http://b.example/x']), 'url');
    assert.equal(Q.inferType(['open', 'closed', 'open', 'open', 'closed', 'open', 'open', 'closed', 'open']), 'tags');
    assert.equal(Q.inferType(['high', 'low'], 'Priority'), 'tags');
    assert.equal(Q.inferType(['a, b', 'c', 'b, d']), 'tags');
    assert.equal(Q.inferType(['A long sentence about one thing.', 'Another sentence that says more.']), 'text');
    assert.equal(Q.inferType(['1', '0', '1'], 'Done'), 'checkbox');
    assert.equal(Q.inferType(['1', '0', '1'], 'Count'), 'number');
    assert.equal(Q.inferType([]), 'text');
  });

  await t('CSV: quoted delimiters, doubled quotes, newlines in fields, CRLF, BOM', () => {
    const text = '﻿Name,Note,Amount\r\n"Smith, Jo","said ""hi""\nthen left",12\r\nBo,,3\r\n';
    assert.deepEqual(I.parseDelimited(text), [['Name', 'Note', 'Amount'], ['Smith, Jo', 'said "hi"\nthen left', '12'], ['Bo', '', '3']]);
    assert.equal(I.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
    assert.equal(I.detectDelimiter('a;b;c\n1;2,5;3'), ';');
    assert.deepEqual(I.parseDelimited('a,b\n1,"2'), [['a', 'b'], ['1', '2']], 'an unterminated quote ends at the end of the file');
    assert.deepEqual(I.parseDelimited('a,b\n1,x"y"'), [['a', 'b'], ['1', 'x"y"']], 'a quote inside an unquoted field is text');
  });

  await t('import: CSV → typed sheet, headers named and de-duplicated, ragged rows padded', async () => {
    const csv = 'Name,,Name,Score,When,Tags\nA,x,y,1,2026-01-02,"red, blue"\nB,,,2,1/3/2026,blue\nC\n\n';
    const out = await I.importSheetFile({ name: 'my_scores.csv', text: csv });
    assert.equal(out.title, 'my scores');
    const s = out.sheets[0];
    assert.deepEqual(s.columns.map((c) => c.name), ['Name', 'Column 2', 'Name (2)', 'Score', 'When', 'Tags']);
    assert.deepEqual(s.columns.map((c) => c.type).slice(3), ['number', 'date', 'tags']);
    assert.equal(s.rows.length, 3);
    assert.deepEqual(s.rows[1].cells[4], '2026-01-03', 'slash dates become ISO');
    assert.deepEqual(s.rows[0].cells[5], ['red', 'blue']);
    assert.deepEqual(s.rows[2].cells, ['C', '', '', '', '', []]);
    assert(/<table data-tdoc-sheet data-name="my scores">/.test(out.html));
    assert(/Imported from my_scores.csv: 3 rows\./.test(out.html));
  });

  await t('import: friendly errors for wrong type, size and emptiness', async () => {
    const msg = async (file) => { try { await I.importSheetFile(file); return null; } catch (e) { assert(e instanceof I.SheetImportError, e); return e.message; } };
    assert.match(await msg({ name: 'old.xls', text: '' }), /\.xlsx or \.csv/);
    assert.match(await msg({ name: 'notes.pdf', text: '' }), /\.csv, \.tsv or \.xlsx/);
    assert.match(await msg({ name: 'big.csv', size: 99 * 1024 * 1024, text: 'a' }), /up to 15 MB/);
    assert.match(await msg({ name: 'empty.csv', text: '\n\n' }), /no rows/);
    assert.match(await msg({ name: 'book.xlsx', bytes: new Uint8Array(4) }), /not available here/);
    const wide = Array.from({ length: 201 }, (_, i) => `c${i}`).join(',');
    assert.match(await msg({ name: 'wide.csv', text: `${wide}\n1` }), /up to 200/);
    const many = 'a,b,c\n' + '1,2,3\n'.repeat(50_001);
    assert.match(await msg({ name: 'long.csv', text: many }), /up to 50,000/);
    const heavy = Array.from({ length: 12 }, (_, c) => `c${c}`).join(',') + '\n' + Array.from({ length: 40_000 }, (_, i) => Array.from({ length: 12 }, (_, c) => `value ${c} of row ${i}`).join(',')).join('\n');
    assert.match(await msg({ name: 'heavy.csv', text: heavy }), /would be \d+\.\d MB, and a doc can be up to 8 MB/);
  });

  await t('markup round trip: model → HTML → model keeps names, types, palette, ids, tags, links', () => {
    const model = {
      name: 'Q1 <plan>',
      columns: [
        { name: 'Task', type: 'text' }, { name: 'Cost', type: 'number' }, { name: 'Due', type: 'date' },
        { name: 'Labels', type: 'tags', palette: 'urgent:red, later:gray' }, { name: 'Done', type: 'checkbox' }, { name: 'Link', type: 'url' },
      ],
      rows: [
        { id: 'r7', cells: ['Ship <b>it</b> & "go"', '1200', '2026-01-31', ['urgent', 'a & b'], 'yes', 'https://example.com/?a=1&b=2'] },
        { cells: ['Second', '', '', [], '', 'javascript:alert(1)'] },
      ],
    };
    const html = `<!doctype html><html><body>${M.tableHtml(model)}</body></html>`;
    assert(!/<b>it<\/b>/.test(html), 'cell text is escaped');
    assert(!/href="javascript/.test(html), 'only safe links become anchors');
    const doc = parseHtml(html);
    const table = doc.querySelector('table[data-tdoc-sheet]');
    const back = M.readSheetTable(table, Q.normalizeType);
    assert.equal(back.name, 'Q1 <plan>');
    assert.deepEqual(back.columns.map((c) => [c.name, c.type]), model.columns.map((c) => [c.name, c.type]));
    assert.deepEqual(back.columns.map((c) => c.key), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], 'every header gets a stable key');
    assert.deepEqual(Q.parsePalette(back.columns[3].palette), { urgent: 'red', later: 'gray' });
    assert.deepEqual(back.rows.map((r) => r.id), ['r7', 'r2']);
    assert.deepEqual(back.rows[0].cells, ['Ship <b>it</b> & "go"', '1200', '2026-01-31', ['urgent', 'a & b'], '✓', 'https://example.com/?a=1&b=2']);
    assert.deepEqual(back.rows[1].cells, ['Second', '', '', [], '', 'javascript:alert(1)']);
    assert.equal(back.rows[0].tds[5].querySelector('a').getAttribute('href'), 'https://example.com/?a=1&b=2');
    // HTML → model → HTML is a fixed point.
    const again = M.tableHtml({ name: back.name, columns: back.columns.map((c) => ({ key: c.key, name: c.name, type: c.type, palette: c.palette })), rows: back.rows.map((r) => ({ id: r.id, cells: r.cells })) });
    assert.equal(again, M.tableHtml({ ...model, rows: model.rows.map((r, i) => ({ id: r.id || `r${i + 1}`, cells: r.cells })) }).replace('>yes<', '>✓<'));
  });

  await t('writeCell writes text as text, tags as spans, links only when safe', () => {
    const doc = parseHtml(`<table data-tdoc-sheet><thead><tr><th data-type="tags">T</th><th data-type="url">U</th><th>X</th></tr></thead><tbody><tr data-row="r1"><td></td><td></td><td></td></tr></tbody></table>`);
    const table = doc.querySelector('table[data-tdoc-sheet]');
    const s = M.readSheetTable(table, Q.normalizeType);
    M.writeCell(s.rows[0].tds[0], 'tags', ['new', '<x>']);
    M.writeCell(s.rows[0].tds[1], 'url', 'www.example.com');
    M.writeCell(s.rows[0].tds[2], 'text', '<img src=x onerror=alert(1)>');
    assert.equal(s.rows[0].tds[0].innerHTML, '<span data-tag>new</span> <span data-tag>&lt;x&gt;</span>');
    assert.equal(s.rows[0].tds[1].innerHTML, '<a href="https://www.example.com">www.example.com</a>');
    assert.equal(s.rows[0].tds[2].innerHTML, '&lt;img src=x onerror=alert(1)&gt;');
    M.writeCell(s.rows[0].tds[1], 'url', 'javascript:alert(1)');
    assert.equal(s.rows[0].tds[1].innerHTML, 'javascript:alert(1)');
    assert.equal(M.nextRowId(table), 'r2');
    assert.equal(M.nextColumnKey(['c1', 'c4', '', 'x9']), 'c5');
    const re = M.readSheetTable(table, Q.normalizeType);
    assert.deepEqual(re.rows[0].cells, [['new', '<x>'], 'javascript:alert(1)', '<img src=x onerror=alert(1)>']);
  });

  await t('a header row made of <th> in <tbody> is read as the header; short rows read blank', () => {
    const doc = parseHtml('<table data-tdoc-sheet><tr><th>A</th><th data-type="number">B</th></tr><tr><td>1</td></tr></table>');
    const s = M.readSheetTable(doc.querySelector('table[data-tdoc-sheet]'), Q.normalizeType);
    assert.deepEqual(s.columns.map((c) => c.type), ['text', 'number']);
    assert.deepEqual(s.rows.map((r) => r.cells), [['1', '']]);
    assert.equal(s.rows[0].tds[1], null);
  });

  await t('the 10k × 20 query budget: index once, filter + 2-key sort under 300ms', () => {
    const big = { columns: Array.from({ length: 20 }, (_, c) => ({ name: `C${c}`, type: c % 4 === 1 ? 'number' : c % 4 === 2 ? 'tags' : 'text' })), rows: [] };
    for (let r = 0; r < 10000; r++) big.rows.push({ id: `r${r + 1}`, cells: big.columns.map((col, c) => col.type === 'number' ? String((r * 7919 + c) % 1000) : col.type === 'tags' ? [['a', 'b', 'c', 'd'][r % 4]] : `row ${r} col ${c}`) });
    const t0 = Date.now();
    const bi = Q.buildIndex(big);
    const order = Q.runQuery(bi, { search: '1', filters: { 2: { values: ['a', 'c'] } }, sort: [{ col: 1, dir: 'desc' }, { col: 0, dir: 'asc' }] });
    const ms = Date.now() - t0;
    assert(order.length > 0 && order.length < 10000);
    assert(ms < 300, `took ${ms}ms`);
  });

  await t('the view in the #hash: added beside key=value pairs, never over a plain anchor', async () => {
    const H = await import('../shell/src/document/sheet-hash.js');
    assert.equal(H.withHashView('', 'abc'), '#sheet=abc');
    assert.equal(H.withHashView('#c=12', 'abc'), '#c=12&sheet=abc');
    assert.equal(H.withHashView('#c=12&sheet=old', ''), '#c=12');
    assert.equal(H.withHashView('#intro', 'abc'), '#intro', 'a plain anchor stays');
    assert.equal(H.withHashView('#intro&x=1', 'abc'), '#intro&x=1');
    assert.equal(H.readHashView('#intro'), '');
    assert.equal(H.readHashView('#c=1&sheet=xyz'), 'xyz');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
