// Sheets: formulas (shared/sheet-formula.mjs). The parser and its
// precedence, every function the engine has, errors, references (A1, $A$1,
// ranges, whole columns, other tabs), cycles, the dependency graph and its
// incremental recompute, reference rewriting (insert/delete, fill, rename,
// Excel), hostile input (length, depth, time and work budgets) and speed.
// No browser and no npm install.
const assert = require('node:assert/strict');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}

(async () => {
  const F = await import('../shared/sheet-formula.mjs');
  const Q = await import('../shared/sheet-query.mjs');
  const NOW = Date.UTC(2026, 10, 11, 15, 30);
  // A sheet from a grid: '=…' strings are formulas.
  const sheet = (name, grid, types) => ({
    name, types, rows: grid.length, cols: Math.max(0, ...grid.map((r) => r.length)),
    cell: (r, c) => { const v = grid[r][c]; return typeof v === 'string' && v[0] === '=' ? { f: v } : v === undefined ? null : v; },
  });
  const book = (...sheets) => { const wb = F.createWorkbook({ now: () => NOW }); wb.load(sheets); return wb; };
  const ev = (f) => book(sheet('S', [[f]])).display('S', 0, 0);
  const shown = (wb, name, a1) => {
    const m = /^([A-Z]+)(\d+)$/.exec(a1);
    let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
    return wb.display(name, Number(m[2]) - 1, c - 1);
  };

  console.log('sheets: formulas');

  await t('operators and precedence follow the spreadsheet', () => {
    assert.equal(ev('=1+2*3'), '7');
    assert.equal(ev('=(1+2)*3'), '9');
    assert.equal(ev('=-2^2'), '4');
    assert.equal(ev('=2^3^2'), '64');
    assert.equal(ev('=10-2-3'), '5');
    assert.equal(ev('=50%'), '0.5');
    assert.equal(ev('=1+2&"x"'), '3x');
    assert.equal(ev('=1+1=2'), 'TRUE');
    assert.equal(ev('="a"<"B"'), 'TRUE');
    assert.equal(ev('=1<"a"'), 'TRUE');
    assert.equal(ev('="A"="a"'), 'TRUE');
    assert.equal(ev('=2<>2'), 'FALSE');
    assert.equal(ev('=0.1+0.2'), '0.3');
    assert.equal(ev('=1/3'), '0.3333333333');
    assert.equal(ev('= 1 +  2 '), '3');
    assert.equal(ev('=SUM(1;2)'), '3');
  });

  await t('errors: #DIV/0!, #VALUE!, #NAME?, #REF!, #N/A, #NUM!, #ERROR!', () => {
    assert.equal(ev('=1/0'), '#DIV/0!');
    assert.equal(ev('="x"+1'), '#VALUE!');
    assert.equal(ev('=NOPE(1)'), '#NAME?');
    assert.equal(ev('=foo'), '#NAME?');
    assert.equal(ev('=Missing!A1'), '#REF!');
    assert.equal(ev('=MATCH(9,1,0)'), '#N/A');
    assert.equal(ev('=1e200*1e200'), '#NUM!');
    assert.equal(ev('=1+'), '#ERROR!');
    assert.equal(ev('=SUM(1'), '#ERROR!');
    assert.equal(ev('=IF()'), '#N/A');
    assert.equal(ev('=#N/A'), '#N/A');
    assert.equal(ev('=IFERROR(1/0,"none")'), 'none');
  });

  await t('math, logic and text functions', () => {
    const cases = {
      '=SUM(1,2,"3")': '6', '=AVERAGE(2,4)': '3', '=MIN(4,2,8)': '2', '=MAX(4,2,8)': '8', '=COUNT(1,"2","x",TRUE)': '3', '=COUNTA(1,"",TRUE)': '3',
      '=IF(1>2,"y","n")': 'n', '=IF(TRUE,"y")': 'y', '=IF(FALSE,"y")': 'FALSE', '=IFS(FALSE,1,TRUE,2)': '2', '=IFS(FALSE,1)': '#N/A',
      '=AND(TRUE,1)': 'TRUE', '=AND(TRUE,0)': 'FALSE', '=OR(FALSE,0,1)': 'TRUE', '=NOT(0)': 'TRUE',
      '=ROUND(2.345,2)': '2.35', '=ROUND(-2.5,0)': '-3', '=ROUND(1234,-2)': '1200', '=ROUNDUP(1.21,1)': '1.3', '=ROUNDDOWN(-1.29,1)': '-1.2', '=ABS(-3)': '3',
      '=CONCAT("a",1,TRUE)': 'a1TRUE', '=CONCATENATE("a","b")': 'ab', '=TEXTJOIN("-",TRUE,"a","","b")': 'a-b', '=TEXTJOIN("-",FALSE,"a","","b")': 'a--b',
      '=LEFT("hello",2)': 'he', '=LEFT("hello")': 'h', '=RIGHT("hello",3)': 'llo', '=MID("hello",2,3)': 'ell', '=LEN("héllo")': '5',
      '=TRIM("  a   b  ")': 'a b', '=UPPER("x")': 'X', '=LOWER("Y")': 'y', '=SUBSTITUTE("a-b-c","-","+")': 'a+b+c', '=SUBSTITUTE("a-b-c","-","+",2)': 'a-b+c',
      '=VALUE("1,200")': '1200', '=VALUE("15%")': '0.15', '=VALUE("x")': '#VALUE!',
      '=TEXT(1234.567,"#,##0.00")': '1,234.57', '=TEXT(0.256,"0.0%")': '25.6%', '=TEXT(5,"$0.00")': '$5.00', '=TEXT(-5,"0;(0)")': '(5)', '=TEXT(1234567,"0.00E+00")': '1.23E+06', '=TEXT(3.5,"0.##")': '3.5',
    };
    for (const [f, want] of Object.entries(cases)) assert.equal(ev(f), want, f);
  });

  await t('dates are serial numbers and show as dates', () => {
    assert.equal(ev('=DATE(2026,3,1)'), '2026-03-01');
    assert.equal(ev('=DATE(2026,14,1)'), '2027-02-01');
    assert.equal(ev('=DATE(2026,3,1)+30'), '2026-03-31');
    assert.equal(ev('=DATE(2026,3,1)-DATE(2026,1,1)'), '59');
    assert.equal(ev('=TODAY()'), '2026-11-11');
    assert.equal(ev('=YEAR(DATE(2026,3,1))&"/"&MONTH(DATE(2026,3,1))&"/"&DAY(DATE(2026,3,1))'), '2026/3/1');
    assert.equal(ev('=YEAR("2024-02-29")'), '2024');
    assert.equal(ev('=DATEDIF(DATE(2020,1,15),DATE(2026,3,1),"Y")'), '6');
    assert.equal(ev('=DATEDIF(DATE(2020,1,15),DATE(2026,3,1),"M")'), '73');
    assert.equal(ev('=DATEDIF(DATE(2026,1,1),DATE(2026,3,1),"D")'), '59');
    assert.equal(ev('=DATEDIF(DATE(2020,1,15),DATE(2026,3,1),"YM")'), '1');
    assert.equal(ev('=DATEDIF(DATE(2026,3,1),DATE(2020,1,1),"Y")'), '#NUM!');
    assert.equal(ev('=TEXT(DATE(2026,3,1),"mmm d, yyyy")'), 'Mar 1, 2026');
    assert.equal(ev('=TEXT(DATE(2026,3,1),"dddd dd/mm/yy")'), 'Sunday 01/03/26');
  });

  await t('references: cells, ranges, absolute, whole columns, other tabs', () => {
    const wb = book(sheet('Main', [
      ['Apple', 3, 1.5, '=B1*C1'],
      ['Pear', 5, 2, '=$B$2*C2'],
      ['Fig', 2, 4, '=B3*C3'],
      ['Total', '=SUM(B1:B3)', '=SUM(B:B)', "='Other Tab'!A1*2"],
      ['=Data!B2', '=SUM(Data!A1:B2)', '=MAX(1:3)', null],
    ]), sheet('Other Tab', [[10]]), sheet('Data', [[1, 2], [3, 4]]));
    assert.equal(shown(wb, 'Main', 'D1'), '4.5');
    assert.equal(shown(wb, 'Main', 'D2'), '10');
    assert.equal(shown(wb, 'Main', 'B4'), '10');
    assert.equal(shown(wb, 'Main', 'C4'), '30');
    assert.equal(shown(wb, 'Main', 'D4'), '20');
    assert.equal(shown(wb, 'Main', 'A5'), '4');
    assert.equal(shown(wb, 'Main', 'B5'), '10');
    assert.equal(shown(wb, 'Main', 'C5'), '10');
    assert.equal(wb.display('Main', 0, 0), null, 'a literal cell has no display');
    assert.equal(wb.formula('Main', 3, 1), '=SUM(B1:B3)');
  });

  await t('lookups: VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH', () => {
    const wb = book(sheet('S', [
      ['Apple', 3, 10],
      ['Pear', 5, 20],
      ['Fig', 8, 30],
      ['=VLOOKUP("pear",A1:C3,3,FALSE)', '=VLOOKUP(6,B1:C3,2)', '=VLOOKUP("kiwi",A1:C3,2,FALSE)', '=VLOOKUP("P*",A1:C3,2,FALSE)'],
      ['=HLOOKUP(5,A2:C3,2,FALSE)', '=XLOOKUP("Fig",A1:A3,C1:C3)', '=XLOOKUP("kiwi",A1:A3,C1:C3,"none")', '=XLOOKUP(6,B1:B3,A1:A3,,-1)'],
      ['=INDEX(A1:C3,2,3)', '=INDEX(A1:A3,MATCH(8,B1:B3,0))', '=MATCH(6,B1:B3)', '=SUM(INDEX(A1:C3,0,3))'],
      ['=XLOOKUP(6,B1:B3,A1:A3,,1)', '=MATCH("fig",A1:A3,0)', '=INDEX(A1:C3,4,1)', '=VLOOKUP("Fig",A1:C3,4,FALSE)'],
    ]));
    assert.deepEqual(['A4', 'B4', 'C4', 'D4'].map((a) => shown(wb, 'S', a)), ['20', '20', '#N/A', '5']);
    assert.deepEqual(['A5', 'B5', 'C5', 'D5'].map((a) => shown(wb, 'S', a)), ['8', '30', 'none', 'Pear']);
    assert.deepEqual(['A6', 'B6', 'C6', 'D6'].map((a) => shown(wb, 'S', a)), ['20', 'Fig', '2', '60']);
    assert.deepEqual(['A7', 'B7', 'C7', 'D7'].map((a) => shown(wb, 'S', a)), ['Fig', '3', '#REF!', '#REF!']);
  });

  await t('COUNTIF(S), SUMIF(S), AVERAGEIF with criteria and wildcards', () => {
    const wb = book(sheet('S', [
      ['pear', 3, 'x'], ['Peach', 5, ''], ['fig', 8, 'x'], ['', 1, 'y'],
      ['=COUNTIF(B1:B4,">2")', '=COUNTIF(A1:A4,"pe*")', '=COUNTIF(A1:A4,"")', '=COUNTIF(A1:A4,"<>")'],
      ['=SUMIF(A1:A4,"p*",B1:B4)', '=SUMIFS(B1:B4,C1:C4,"x",B1:B4,">3")', '=AVERAGEIF(B1:B4,">=3")', '=COUNTIFS(A1:A4,"?ig",C1:C4,"x")'],
      ['=COUNTIF(B1:B4,5)', '=COUNTIF(C1:C4,"=x")', '=SUMIF(B1:B4,"<>5")', '=SUMIFS(B1:B3,C1:C4,"x")'],
    ]));
    assert.deepEqual(['A5', 'B5', 'C5', 'D5'].map((a) => shown(wb, 'S', a)), ['3', '2', '1', '3']);
    assert.deepEqual(['A6', 'B6', 'C6', 'D6'].map((a) => shown(wb, 'S', a)), ['8', '8', '5.3333333333', '1']);
    assert.deepEqual(['A7', 'B7', 'C7', 'D7'].map((a) => shown(wb, 'S', a)), ['1', '2', '12', '#VALUE!']);
  });

  await t('literal cells read by column type', () => {
    const deps = { parseNumber: Q.parseNumber, parseDate: Q.parseDate };
    assert.equal(F.cellValue('number', '1,200.50', deps), 1200.5);
    assert.equal(F.cellValue('number', '$12', deps), 12);
    assert.equal(F.cellValue('number', '15%', deps), 0.15);
    assert.equal(F.cellValue('number', 'n/a', deps), 'n/a');
    assert.equal(F.cellValue('date', '2026-03-01', deps), F.serialFromMs(Date.UTC(2026, 2, 1)));
    assert.equal(F.cellValue('checkbox', '✓', deps), true);
    assert.equal(F.cellValue('checkbox', '', deps), null);
    assert.equal(F.cellValue('text', '42', deps), 42);
    assert.equal(F.cellValue('text', 'Alice', deps), 'Alice');
    assert.equal(F.cellValue('tags', ['a', 'b'], deps), 'a, b');
    assert.equal(F.cellValue('text', '  ', deps), null);
    // A date column's formula shows as a date.
    const wb = book(sheet('S', [[F.cellValue('date', '2026-03-01', deps), '=A1+7', '=A1-A1']], ['date', 'text', 'text']));
    assert.equal(wb.display('S', 0, 1), '2026-03-08');
    assert.equal(wb.display('S', 0, 2), '0');
  });

  await t('a cycle is #CYCLE!, and so is what reads it; a self-reference too', () => {
    const wb = book(sheet('S', [['=A2+1', 5], ['=A3+1'], ['=A1'], ['=A1*2', '=B1*2'], ['=A5']]));
    assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'B4', 'A5'].map((a) => shown(wb, 'S', a)), ['#CYCLE!', '#CYCLE!', '#CYCLE!', '#CYCLE!', '10', '#CYCLE!']);
    const wb2 = book(sheet('S', [[1, '=SUM(A1:B1)']]));
    assert.equal(wb2.display('S', 0, 1), '#CYCLE!');
  });

  await t('incremental recompute touches only dependents, across tabs', () => {
    const main = [[1, '=A1*2', '=B1+1', 'x'], [2, '=A2*2', '=SUM(B:B)', '=Rates!A1*A1']];
    const rates = [[3]];
    const wb = book(sheet('Main', main), sheet('Rates', rates));
    assert.equal(shown(wb, 'Main', 'C2'), '6');
    main[0][0] = 10;
    const changed = wb.update(sheet('Main', main)).map((x) => x.sheet + '!' + x.r + ',' + x.c).sort();
    assert.deepEqual(changed, ['Main!0,1', 'Main!0,2', 'Main!1,2', 'Main!1,3'].sort());
    assert.equal(shown(wb, 'Main', 'C1'), '21');
    assert.equal(shown(wb, 'Main', 'C2'), '24');
    rates[0][0] = 4;
    assert.deepEqual(wb.update(sheet('Rates', rates)).map((x) => x.sheet + '!' + x.r + ',' + x.c), ['Main!1,3']);
    assert.equal(shown(wb, 'Main', 'D2'), '40');
    // An edit to a formula, and a formula removed.
    main[1][1] = '=A2*100';
    wb.update(sheet('Main', main));
    assert.equal(shown(wb, 'Main', 'C2'), '220');
    main[1][1] = 5;
    wb.update(sheet('Main', main));
    assert.equal(shown(wb, 'Main', 'C2'), '25');
    assert.equal(wb.display('Main', 1, 1), null);
    // Nothing changed: nothing recomputed.
    assert.deepEqual(wb.update(sheet('Main', main)), []);
    // A new row: the whole book again, and whole-column refs see it.
    main.push([0, 7]);
    wb.update(sheet('Main', main));
    assert.equal(shown(wb, 'Main', 'C2'), '32');
  });

  await t('a missing tab is #REF!; adding it fixes the reference', () => {
    const wb = book(sheet('Main', [['=Later!A1+1']]));
    assert.equal(wb.display('Main', 0, 0), '#REF!');
    wb.update(sheet('Later', [[41]]));
    assert.equal(wb.display('Main', 0, 0), '42');
  });

  await t('insert and delete rows and columns shift references', () => {
    const at = (f, o) => F.shiftFormula(f, Object.assign({ target: 'S', host: 'S' }, o));
    assert.equal(at('=A1+A5+$A$6', { axis: 'row', at: 2, count: 2 }), '=A1+A7+$A$8');
    assert.equal(at('=SUM(A1:A5)', { axis: 'row', at: 2, count: 1 }), '=SUM(A1:A6)');
    assert.equal(at('=SUM(A:A)', { axis: 'row', at: 0, count: 1 }), '=SUM(A:A)');
    assert.equal(at('=A3', { axis: 'row', at: 2, count: -1 }), '=#REF!');
    assert.equal(at('=A4*2', { axis: 'row', at: 2, count: -1 }), '=A3*2');
    assert.equal(at('=SUM(A1:A5)', { axis: 'row', at: 1, count: -2 }), '=SUM(A1:A3)');
    assert.equal(at('=SUM(A2:A3)', { axis: 'row', at: 1, count: -2 }), '=SUM(#REF!)');
    assert.equal(at('=SUM(A3:A6)', { axis: 'row', at: 1, count: -3 }), '=SUM(A2:A3)');
    assert.equal(at('=B1+$C1+D:D', { axis: 'col', at: 1, count: 1 }), '=C1+$D1+E:E');
    assert.equal(at('=B1+C1', { axis: 'col', at: 1, count: -1 }), '=#REF!+B1');
    assert.equal(at('=Other!A5+A5', { axis: 'row', at: 0, count: 1 }), '=Other!A5+A6');
    assert.equal(F.shiftFormula("='My Tab'!A5+A5", { target: 'my tab', host: 'S', axis: 'row', at: 0, count: 1 }), "='My Tab'!A6+A5");
    assert.equal(at('=1:3', { axis: 'row', at: 0, count: 1 }), '=2:4');
    // What is not a reference stays as written.
    assert.equal(at('=IF(A5 > 1, "A5", sum( a5 ))', { axis: 'row', at: 0, count: 1 }), '=IF(A6 > 1, "A5", sum( A6 ))');
  });

  await t('fill and paste move relative references, keep $ ones', () => {
    assert.equal(F.offsetFormula('=A1*$B$1+B$1+$C1', 2, 1), '=B3*$B$1+C$1+$C3');
    assert.equal(F.offsetFormula('=SUM(A1:A3)', 1, 0), '=SUM(A2:A4)');
    assert.equal(F.offsetFormula('=A1', -1, 0), '=#REF!');
    assert.equal(F.offsetFormula('=Data!A1', 3, 0), '=Data!A4');
  });

  await t('a renamed tab is renamed in formulas', () => {
    assert.equal(F.renameSheetIn("=Data!A1+'data'!B2+A1", 'Data', 'Q3 data'), "='Q3 data'!A1+'Q3 data'!B2+A1");
    assert.equal(F.renameSheetIn("='Q3 data'!A1", 'Q3 data', 'Sales'), '=Sales!A1');
  });

  await t('Excel: the header row is row 1 there', () => {
    assert.equal(F.fromExcel('SUM(B2:B10)*$C$2'), '=SUM(B1:B9)*$C$1');
    assert.equal(F.fromExcel('SUM(B1:B10)'), '=SUM(B1:B9)');
    assert.equal(F.fromExcel('A1+1'), '=#REF!+1');
    assert.equal(F.fromExcel('SUM(A:A)'), '=SUM(A:A)');
    assert.equal(F.fromExcel("'Sheet 2'!A3", { names: new Map([['sheet 2', 'Sheet 2']]) }), "='Sheet 2'!A2");
    assert.equal(F.toExcel('=SUM(B1:B9)*$C$1'), 'SUM(B2:B10)*$C$2');
    assert.equal(F.toExcel('=Data!A1', { names: new Map([['data', 'Data 2']]) }), "'Data 2'!A2");
    assert.deepEqual(F.unsupportedFunctions('=SUMPRODUCT(A1:A2)+SUM(1)'), ['SUMPRODUCT']);
    assert.deepEqual(F.unsupportedFunctions('=_xlfn.XLOOKUP(1,A:A,B:B)'), []);
  });

  await t('hostile: too long, too deep, too many tokens are #ERROR! at once', () => {
    const cases = [
      '=' + '('.repeat(5000) + '1' + ')'.repeat(5000),
      '=' + '-'.repeat(100000) + '1',
      '="' + 'x'.repeat(9000) + '"',
      '=' + 'SUM('.repeat(200) + '1' + ')'.repeat(200),
      '=' + Array(3000).fill('1').join('+'),
      '={1,2}',
      "='unterminated!A1",
    ];
    for (const f of cases) {
      const t0 = Date.now();
      assert.equal(ev(f), '#ERROR!', f.slice(0, 20));
      assert.ok(Date.now() - t0 < 100, 'fast');
    }
    // No regular expression from sheet text: a pathological wildcard is linear.
    const wb = book(sheet('S', [['a'.repeat(10000), '=COUNTIF(A1,"*a*a*a*a*a*a*a*a*a*a*a*a*b")', '=COUNTIF(A1,"*a*a*a*a*a")']]));
    assert.equal(wb.display('S', 0, 1), '0');
    assert.equal(wb.display('S', 0, 2), '1');
    // Text results are capped, never built huge.
    assert.equal(ev('=SUBSTITUTE("' + 'a'.repeat(5000) + '","a","' + 'b'.repeat(100) + '")'), '#VALUE!');
    // Values that look like code are only text.
    assert.equal(ev('="<img src=x onerror=alert(1)>"'), '<img src=x onerror=alert(1)>');
    assert.equal(ev('=constructor'), '#NAME?');
    assert.equal(ev('=__proto__(1)'), '#NAME?');
  });

  await t('hostile: a workbook that would read too much stops with #BUSY!, quickly', () => {
    const rows = 50000;
    const t0 = Date.now();
    const wb = F.createWorkbook({ limits: { timeMs: 300 } });
    wb.load([sheet('S', Array.from({ length: rows }, (_, r) => ['x'.repeat(200), r < 3000 ? '=CONCAT(A:A)&COUNTIF(A:A,"*x*x*x*x*y")&' + r : null]))]);
    const ms = Date.now() - t0;
    assert.ok(wb.stats.busy, 'over budget');
    assert.ok(ms < 3000, `stopped in ${ms} ms`);
    const shownBusy = Array.from({ length: 3000 }, (_, r) => wb.display('S', r, 1)).filter((v) => v === '#BUSY!').length;
    assert.ok(shownBusy > 0);
    // A work cap holds even without a clock.
    const wb2 = F.createWorkbook({ limits: { work: 100000, timeMs: 1e9 } });
    wb2.load([sheet('S', Array.from({ length: 1000 }, (_, r) => [r, '=SUM($A$1:A' + (r + 1) + ')']))]);
    assert.ok(wb2.stats.busy);
    // A long chain is computed without deep recursion.
    const chain = Array.from({ length: 50000 }, (_, r) => [r ? '=A' + r + '+1' : 1]);
    const wb3 = book(sheet('S', chain));
    assert.equal(wb3.display('S', 49999, 0), '50000');
  });

  await t('speed: 10,000 formulas compute in well under 200 ms, an edit faster still', () => {
    const N = 10000;
    const grid = Array.from({ length: N }, (_, r) => [
      'Item ' + r, r % 97, (r % 13) + 0.5,
      '=B' + (r + 1) + '*C' + (r + 1),
    ]);
    // Plus summaries that read whole columns and look things up.
    grid[0].push('=SUM(D:D)', '=AVERAGE(B:B)', '=VLOOKUP("Item 9000",A:D,4,FALSE)', '=COUNTIF(B:B,">50")');
    const s = sheet('S', grid);
    const wb = F.createWorkbook();
    let t0 = performance.now();
    wb.load([s]);
    const full = performance.now() - t0;
    assert.equal(wb.stats.busy, false);
    assert.equal(wb.stats.formulas, N + 4);
    assert.ok(full < 200, `full recompute of ${N} formulas: ${full.toFixed(1)} ms`);
    grid[5][1] = 1000;
    t0 = performance.now();
    const changed = wb.update(sheet('S', grid));
    const inc = performance.now() - t0;
    assert.ok(changed.length <= 5, `only dependents: ${changed.length}`);
    assert.ok(inc < 100, `incremental: ${inc.toFixed(1)} ms`);
    console.log(`    (10,000 formulas: full ${full.toFixed(1)} ms, one edit ${inc.toFixed(1)} ms)`);
  });

  await t('Excel: import keeps formulas (moved under the header), export writes them back', async () => {
    let XLSX;
    try { XLSX = require('xlsx'); } catch { console.log('    (skipped: no SheetJS without npm install)'); return; }
    const I = await import('../shared/sheet-import.mjs');
    const X = await import('../shell/src/document/sheet-export.mjs');
    const { parseHtml } = require('./helpers/mini-dom');
    // A workbook as Excel writes it: a header row, formulas with cached values.
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Item', 'Qty', 'Price', 'Total'], ['Paper', 3, 4.5, 13.5], ['Pens', 10, 1.2, 12], [], ['Sum', null, null, 25.5]]);
    ws.D2.f = 'B2*C2'; ws.D3.f = 'B3*C3'; ws.D5.f = 'SUM(D1:D3)';
    ws.B5 = { t: 'n', v: 9, f: 'SUMPRODUCT(B2:B3,C2:C3)' };
    const other = XLSX.utils.aoa_to_sheet([['Ref'], [0]]);
    other.A2.f = "'Line items'!D5*2";
    XLSX.utils.book_append_sheet(wb, ws, 'Line items');
    XLSX.utils.book_append_sheet(wb, other, 'Other');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    const out = await I.importSheetFile({ name: 'book.xlsx', bytes }, { loadXlsx: async () => XLSX });
    const items = out.sheets[0];
    assert.deepEqual(items.rows[0].formulas, [null, null, null, '=B1*C1']);
    assert.equal(items.rows.length, 4, 'the blank row stays: references count rows');
    assert.equal(items.rows[3].formulas[3], '=SUM(D1:D2)', 'a range from the header starts under it');
    assert.equal(items.rows[3].formulas[1], null, 'SUMPRODUCT is not computed here: the value stays');
    assert.equal(items.rows[3].cells[1], '9');
    assert.equal(out.sheets[1].rows[0].formulas[0], "='Line items'!D4*2");
    assert.ok(out.warnings.some((w) => /SUMPRODUCT/.test(w)), out.warnings.join(' | '));
    assert.match(out.html, /<td data-formula="=B1\*C1">13\.5<\/td>/);
    // Export: the doc's formulas back into a workbook, rows moved down.
    const doc = parseHtml(out.html);
    const sheets = X.sheetsFromDocument(doc);
    assert.deepEqual(sheets[0].formulas.map((x) => x.f), ['=B1*C1', '=B2*C2', '=SUM(D1:D2)']);
    const back = XLSX.read(X.xlsxBytes(XLSX, sheets), { type: 'array' });
    const s1 = back.Sheets[back.SheetNames[0]], s2 = back.Sheets[back.SheetNames[1]];
    assert.equal(s1.D2.f, 'B2*C2');
    assert.equal(s1.D5.f, 'SUM(D2:D3)');
    assert.equal(s1.D2.v, 13.5);
    assert.equal(s2.A2.f, "'Line items'!D5*2");
    assert.equal(s1.B5.f, undefined, 'no formula the sheet does not compute');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
