// Sheets: find & replace, conditional formatting, dropdowns and fill
// series, the pure half (shared/sheet-rules.mjs). No browser and no npm
// install. Hostile input is half the point: rule JSON built to pollute or
// inject, oversized attributes, and a 10,000-row sheet evaluated inside a
// frame budget.
const assert = require('node:assert/strict');
const path = require('path');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}

(async () => {
  const R = await import('../shared/sheet-rules.mjs');
  const Q = await import('../shared/sheet-query.mjs');
  const ctx = { parseNumber: Q.parseNumber, parseDate: Q.parseDate, colors: Q.TAG_COLORS };
  const fillCtx = { parseDate: Q.parseDate, formatDate: Q.formatDate };

  console.log('sheet rules: find & replace, formats, dropdowns, fill series');

  await t('the palette names are the sheet palette\'s', () => {
    assert.deepEqual([...R.COLOR_NAMES].sort(), Object.keys(Q.TAG_COLORS).sort());
  });

  // ---- find & replace ---------------------------------------------------------------
  await t('plain text: case-insensitive unless asked, entire cell, every occurrence, literal', () => {
    let f = R.makeFinder({ find: 'ann' });
    assert.ok(f.test('Joanna')); assert.equal(f.replace('Ann and ANN', 'Bo'), 'Bo and Bo');
    f = R.makeFinder({ find: 'ann', matchCase: true });
    assert.ok(!f.test('ANN')); assert.equal(f.replace('Ann ann', 'x'), 'Ann x');
    f = R.makeFinder({ find: 'open', wholeCell: true });
    assert.ok(f.test('Open') && !f.test('Opened')); assert.equal(f.replace('OPEN', 'Done'), 'Done'); assert.equal(f.replace('Opened', 'x'), 'Opened');
    for (const [find, text, rep, out] of [['a.b', 'a.b axb', '!', '! axb'], ['(x)', '(x)(x)', '$1', '$1$1'], ['$', '$5', '€', '€5'], ['aa', 'aaa', 'b', 'ba'], ['x', 'x', '$&', '$&']]) {
      assert.equal(R.makeFinder({ find }).replace(text, rep), out, `${find} in ${text}`);
    }
    assert.equal(R.makeFinder({ find: '' }).ok, false);
    // Lowercasing that changes length (İ) never shifts the replaced span.
    assert.equal(R.makeFinder({ find: 'b' }).replace('İb', 'x'), 'İx');
  });
  await t('find & replace over a long cell stays linear', () => {
    const f = R.makeFinder({ find: 'aab' });
    const big = 'a'.repeat(200000);
    const t0 = Date.now();
    for (let k = 0; k < 20; k++) { f.test(big); f.replace(big, 'x'); }
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  });

  // ---- reading the rules: hostile JSON ------------------------------------------------
  await t('rule JSON: anything malformed or unknown is dropped, nothing pollutes', () => {
    for (const bad of [null, undefined, '', 'nope', '{', '{}', '"x"', '42', 'null', '[1,2]', '[null]', '[[]]', 'x'.repeat(70000), '[' + '['.repeat(5000) + ']'.repeat(5000) + ']']) {
      assert.deepEqual(R.parseFormatRules(bad), []);
      assert.deepEqual(R.parseValidation(bad), []);
    }
    const hostile = '[{"__proto__":{"polluted":1},"constructor":{"prototype":{"p":1}},"cols":["c1"],"when":"gt","value":5,"fill":"red","style":"x","onclick":"x"},'
      + JSON.stringify([
        { cols: ['"><script>alert(1)</script>', 'c2', 'c2', '__proto__', 'a'.repeat(65)], when: 'empty', fill: 'green' },
        { cols: ['c1'], when: 'eval', fill: 'red' },
        { cols: ['c1'], when: 'gt', value: '1', fill: '#ff0000' },
        { cols: ['c1'], when: 'gt', value: '1', fill: 'url(javascript:x)' },
        { cols: ['c1'], scale: { colors: ['white', 'green'] } },
        { cols: [], when: 'empty', fill: 'red' },
        { cols: 'c1', when: 'empty', fill: 'red' },
      ]).slice(1);
    const rules = R.parseFormatRules(hostile);
    assert.deepEqual(rules, [{ cols: ['c1'], when: 'gt', fill: 'red', value: '5' }, { cols: ['c2', '__proto__'], when: 'empty', fill: 'green' }]);
    assert.equal({}.polluted, undefined); assert.equal({}.p, undefined);
    assert.equal(Object.getPrototypeOf(rules[0]), Object.prototype);
    const many = JSON.stringify(Array.from({ length: 1000 }, () => ({ cols: ['c1'], when: 'empty', fill: 'red' })));
    assert.equal(R.parseFormatRules(many).length, R.MAX_RULES);
    const long = R.parseFormatRules(JSON.stringify([{ cols: ['c1'], when: 'textContains', value: 'a\u0000b' + 'x'.repeat(2000), fill: 'red' }]));
    assert.equal(long[0].value.length, 500); assert.ok(long[0].value.startsWith('abx'));
  });
  await t('dropdown JSON: lists only, values cleaned and capped', () => {
    const v = R.parseValidation(JSON.stringify([
      { cols: ['c1'], kind: 'list', values: ['A', ' A ', '', 3, { x: 1 }, 'B', 'c'.repeat(900)], mode: 'reject', colors: { A: 'red' } },
      { cols: ['c2'], kind: 'range', source: { col: 'c1' } },
      { cols: ['c3'], kind: 'number', min: 1 },
      { cols: ['c4'], kind: 'list', values: [] },
      { cols: ['c5'], kind: 'list', values: Array.from({ length: 900 }, (_, k) => `v${k}`) },
    ]));
    assert.equal(v.length, 2);
    assert.deepEqual(v[0], { cols: ['c1'], kind: 'list', values: ['A', '3', 'B', 'c'.repeat(500)] });
    assert.equal(v[1].values.length, 500);
  });
  await t('written back: valid JSON a sanitiser or the sheet size scan cannot mistake for a URL or markup', () => {
    const rules = [{ cols: ['c1'], when: 'textContains', fill: 'red', value: 'javascript:alert("<b>&")' }];
    const out = R.formatFormatRules(rules);
    assert.ok(!/javascript\s*:/i.test(out) && !/[<>&]/.test(out), out);
    assert.deepEqual(R.parseFormatRules(out), rules);
    assert.equal(R.formatFormatRules([]), '');
    assert.equal(R.formatFormatRules([{ cols: ['c1'], when: 'nope', fill: 'red' }]), '');
    const v = [{ cols: ['c1'], kind: 'list', values: ['a:b', "it's"] }];
    assert.deepEqual(R.parseValidation(R.formatValidation(v)), v);
  });
  await t('columns ↔ letters for the panel', () => {
    const keys = ['c1', 'c2', 'c3', 'c4', 'c5'];
    assert.equal(R.colsToRange(['c2', 'c3', 'c4', 'c1'], keys, Q.columnLetter), 'A:D');
    assert.equal(R.colsToRange(['c1', 'c3', 'c5', 'c4'], keys, Q.columnLetter), 'A, C:E');
    assert.deepEqual(R.rangeToCols('b:c, e', keys), ['c2', 'c3', 'c5']);
    assert.deepEqual(R.rangeToCols('C2:C40', keys), ['c3']);
    assert.deepEqual(R.rangeToCols('D:B', keys), ['c2', 'c3', 'c4']);
    for (const bad of ['', 'Z', '1', 'A:ZZ', 'A-B', ';;']) assert.equal(R.rangeToCols(bad, keys), null, bad);
  });

  // ---- conditional formatting -------------------------------------------------------
  const sheet = {
    columns: [{ name: 'Name', type: 'text' }, { name: 'Amount', type: 'number' }, { name: 'Due', type: 'date' }, { name: 'Note', type: 'text' }],
    rows: [
      { cells: ['Alice', '10', '2026-11-10', 'urgent fix'] },
      { cells: ['bob', '200', '2026-11-11', ''] },
      { cells: ['Carol', '', '2026-11-12', 'later'] },
      { cells: ['Dave', '50', '', '42'] },
    ],
  };
  const index = Q.buildIndex(sheet);
  const S = { keys: ['c1', 'c2', 'c3', 'c4'], types: index.cols.map((c) => c.type), cols: index.cols, size: index.size };
  const hit = (rule) => { const out = R.evaluateFormats([Object.assign({ fill: 'green' }, rule)], S, ctx); const c = S.keys.indexOf(rule.cols[0]); return out[c] ? out[c].map((s, r) => (s ? r : -1)).filter((r) => r >= 0) : []; };

  await t('each condition picks the right cells', () => {
    const want = [
      ['c2', 'gt', '40', [1, 3]], ['c2', 'lt', '50', [0]], ['c2', 'eq', '200', [1]], ['c2', 'gt', '1,000', []], ['c2', 'gt', 'abc', []],
      ['c4', 'empty', null, [1]], ['c4', 'textContains', 'URG', [0]], ['c4', 'textContains', '  ', []], ['c4', 'gt', '10', [3]],
      ['c3', 'gt', '2026-11-10', [1, 2]], ['c3', 'eq', '2026-11-11', [1]], ['c1', 'textContains', 'o', [1, 2]],
    ];
    for (const [col, when, value, rows] of want) assert.deepEqual(hit({ cols: [col], when, value }), rows, `${col} ${when} ${value}`);
  });
  await t('the first rule that matches wins; a fill is the palette\'s tint, never CSS from the doc', () => {
    const out = R.evaluateFormats([
      { cols: ['c2'], when: 'gt', value: '100', fill: 'red' },
      { cols: ['c2'], when: 'gt', value: '20', fill: 'green' },
      { cols: ['c9'], when: 'empty', fill: 'red' },
    ], S, ctx);
    assert.equal(out[1][1].css, `background:${Q.TAG_COLORS.red[0]}`);
    assert.equal(out[1][3].css, `background:${Q.TAG_COLORS.green[0]}`);
    assert.equal(out[1][0], null);
    assert.equal(out[0], null, 'columns without rules carry nothing');
  });
  await t('10,000 rows × 4 rules evaluate inside a frame budget', () => {
    const big = { columns: [{ name: 'N', type: 'number' }, { name: 'T', type: 'text' }, { name: 'D', type: 'date' }], rows: Array.from({ length: 10000 }, (_, k) => ({ cells: [String(k), `row ${k} ${k % 7 ? 'ok' : 'urgent'}`, `2026-0${1 + (k % 9)}-1${k % 9}`] })) };
    const bi = Q.buildIndex(big);
    const BS = { keys: ['c1', 'c2', 'c3'], types: bi.cols.map((c) => c.type), cols: bi.cols, size: bi.size };
    const rules = [{ cols: ['c1'], when: 'gt', value: '5000', fill: 'yellow' }, { cols: ['c1'], when: 'lt', value: '100', fill: 'blue' }, { cols: ['c2'], when: 'textContains', value: 'urgent', fill: 'red' }, { cols: ['c3'], when: 'gt', value: '2026-05-01', fill: 'gray' }];
    R.evaluateFormats(rules, BS, ctx);
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 5; k++) R.evaluateFormats(rules, BS, ctx);
    const ms = Number(process.hrtime.bigint() - t0) / 5e6;
    console.log(`    (10k rows × 4 rules: ${ms.toFixed(1)}ms)`);
    assert.ok(ms < 60, `${ms}ms`);
  });
  await t('the reviewer\'s case: 100 rules × 50 columns × 10,000 rows, capped, then each edit in milliseconds', () => {
    const cols = Array.from({ length: 50 }, (_, c) => ({ name: `C${c}`, type: c % 2 ? 'number' : 'text' }));
    const rows = Array.from({ length: 10000 }, (_, r) => ({ cells: cols.map((_, c) => (c % 2 ? String((r * 7 + c) % 1000) : `v${(r + c) % 300} x`)) }));
    const keys = cols.map((_, c) => `c${c + 1}`);
    const rules = Array.from({ length: 100 }, (_, k) => ({ cols: keys, when: ['gt', 'lt', 'eq', 'textContains', 'empty'][k % 5], value: k % 5 === 3 ? `v${k}` : String(k * 9), fill: R.COLOR_NAMES[k % 9] })).map((x) => (x.when === 'empty' ? { cols: x.cols, when: 'empty', fill: x.fill } : x));
    const shape = (idx) => ({ keys, types: idx.cols.map((c) => c.type), cols: idx.cols, size: idx.size });
    let idx = Q.buildIndex({ columns: cols, rows });
    let t0 = process.hrtime.bigint();
    const first = R.evaluateFormats(rules, shape(idx), ctx);
    const initial = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(first.skipped > 0, 'past the cap, rules are skipped and counted');
    // One cell edited: the index is rebuilt (as the viewer does) and only
    // that row is tested again.
    rows[123].cells[1] = '999999';
    idx = Q.buildIndex({ columns: cols, rows });
    t0 = process.hrtime.bigint();
    const next = R.evaluateFormats(rules, shape(idx), ctx, first);
    const edit = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`    (100 rules × 50 columns × 10k rows: ${initial.toFixed(0)}ms first, ${edit.toFixed(1)}ms per edit, ${first.skipped} rule-columns skipped)`);
    assert.ok(initial < 300, `first evaluation ${initial}ms`);
    assert.ok(edit < 30, `an edit ${edit}ms`);
    assert.equal(next.skipped, first.skipped);
    const full = R.evaluateFormats(rules, shape(idx), ctx);
    for (let c = 0; c < 50; c++) for (let r = 0; r < 10000; r += 1) if ((full[c] && full[c][r]) !== (next[c] && next[c][r]) && !(full[c][r] && next[c][r] && full[c][r].css === next[c][r].css)) throw new Error(`incremental differs at ${r},${c}`);
    assert.equal(next[1][123] && next[1][123].css, full[1][123] && full[1][123].css);
  });
  await t('incremental evaluation matches a full one; new rules, columns or rows re-evaluate in full', () => {
    const rules = [{ cols: ['c2'], when: 'gt', value: '40', fill: 'red' }, { cols: ['c4'], when: 'empty', fill: 'gray' }];
    const first = R.evaluateFormats(rules, S, ctx);
    const rows2 = sheet.rows.map((row) => ({ cells: row.cells.slice() }));
    rows2[0].cells[1] = '99'; rows2[1].cells[3] = 'now filled';
    const i2 = Q.buildIndex({ columns: sheet.columns, rows: rows2 });
    const S2 = { keys: S.keys, types: S.types, cols: i2.cols, size: i2.size };
    const inc = R.evaluateFormats(rules, S2, ctx, first), full = R.evaluateFormats(rules, S2, ctx);
    const pick = (o) => o.map((col) => col && col.map((x) => x && x.fill));
    assert.deepEqual(pick(inc), pick(full));
    assert.deepEqual(pick(inc)[1], ['red', 'red', null, 'red']);
    assert.deepEqual(pick(R.evaluateFormats([rules[0]], S2, ctx, first)), pick(R.evaluateFormats([rules[0]], S2, ctx)), 'other rules: a full run');
  });
  await t('describing rules for the panel', () => {
    assert.equal(R.describeFormat({ when: 'gt', value: '5' }), 'Greater than 5');
    assert.equal(R.describeFormat({ when: 'empty' }), 'Is empty');
    assert.equal(R.describeValidation({ kind: 'list', values: ['a', 'b', 'c', 'd', 'e'] }), 'Dropdown: a, b, c +2');
  });

  // ---- dropdowns ---------------------------------------------------------------------
  await t('a value is in the list (any case) or says so; blank passes; tags each', () => {
    const list = { kind: 'list', values: ['Open', 'Done'] };
    assert.equal(R.checkValue(list, ' done '), null);
    assert.equal(R.checkValue(list, ''), null);
    assert.match(R.checkValue(list, 'Later'), /Not in the list: Open, Done/);
    assert.equal(R.checkValue(list, ['open', 'Done']), null);
    assert.ok(R.checkValue(list, ['open', 'x']));
    assert.equal(R.checkValue(null, 'x'), null);
    assert.deepEqual(R.validationByColumn([{ cols: ['c2'], kind: 'list', values: ['b'] }, { cols: ['c2', 'c1'], kind: 'list', values: ['a'] }], ['c1', 'c2', 'c3']).map((x) => x && x.values[0]), ['a', 'b', null]);
  });

  // ---- fill series ---------------------------------------------------------------------
  await t('fill: numbers continue their step and keep their decimals', () => {
    assert.deepEqual(R.fillSeries(['1'], 3, {}, fillCtx), ['2', '3', '4']);
    assert.deepEqual(R.fillSeries(['2', '4'], 3, {}, fillCtx), ['6', '8', '10']);
    assert.deepEqual(R.fillSeries(['1.5', '2'], 2, {}, fillCtx), ['2.5', '3.0']);
    assert.deepEqual(R.fillSeries(['0.1', '0.2'], 2, {}, fillCtx), ['0.3', '0.4']);
    assert.deepEqual(R.fillSeries(['5', '10'], 2, { backward: true }, fillCtx), ['0', '-5']);
    assert.deepEqual(R.fillSeries(['3', '3'], 2, {}, fillCtx), ['3', '3']);
    assert.deepEqual(R.fillSeries(['1', '2', '4'], 3, {}, fillCtx), ['1', '2', '4'], 'an uneven step repeats');
  });
  await t('fill: dates by days or by months (end of month held)', () => {
    assert.deepEqual(R.fillSeries(['2026-11-11'], 2, {}, fillCtx), ['2026-11-12', '2026-11-13']);
    assert.deepEqual(R.fillSeries(['2026-11-01', '2026-11-08'], 2, {}, fillCtx), ['2026-11-15', '2026-11-22']);
    assert.deepEqual(R.fillSeries(['2026-12-31'], 1, {}, fillCtx), ['2027-01-01']);
    assert.deepEqual(R.fillSeries(['2026-01-15', '2026-02-15'], 3, {}, fillCtx), ['2026-03-15', '2026-04-15', '2026-05-15']);
    assert.deepEqual(R.fillSeries(['2025-12-31', '2026-01-31'], 1, {}, fillCtx), ['2026-02-28']);
    assert.deepEqual(R.fillSeries(['2026-03-02'], 1, { backward: true }, fillCtx), ['2026-03-01']);
  });
  await t('fill: leading zeros keep their width, big integers step exactly, month ends stay month ends', () => {
    assert.deepEqual(R.fillSeries(['007'], 2, {}, fillCtx), ['008', '009']);
    assert.deepEqual(R.fillSeries(['0098', '0099'], 2, {}, fillCtx), ['0100', '0101']);
    assert.deepEqual(R.fillSeries(['001'], 1, { backward: true }, fillCtx), ['000']);
    assert.deepEqual(R.fillSeries(['9007199254740993'], 2, {}, fillCtx), ['9007199254740994', '9007199254740995']);
    assert.deepEqual(R.fillSeries(['12345678901234567890', '12345678901234567900'], 1, {}, fillCtx), ['12345678901234567910']);
    assert.deepEqual(R.fillSeries(['9007199254740993', '9007199254740996', '9007199254741000'], 1, {}, fillCtx), ['9007199254740993'], 'uneven: copy');
    assert.deepEqual(R.fillSeries(['9007199254740990.5'], 1, {}, fillCtx), ['9007199254740990.5'], 'unsafe float: copy');
    assert.deepEqual(R.fillSeries(['1000000000000000'], 1, {}, fillCtx), ['1000000000000001'], 'a safe 16-digit integer steps');
    assert.deepEqual(R.fillSeries(['2026-01-31', '2026-02-28'], 3, {}, fillCtx), ['2026-03-31', '2026-04-30', '2026-05-31']);
    assert.deepEqual(R.fillSeries(['2026-04-30', '2026-06-30'], 1, {}, fillCtx), ['2026-08-31']);
    assert.deepEqual(R.fillSeries(['2026-02-28', '2026-03-28'], 1, {}, fillCtx), ['2026-04-28']);
  });
  await t('fill: text, labels, mixed values and copy repeat the source', () => {
    assert.deepEqual(R.fillSeries(['a', 'b'], 5, {}, fillCtx), ['a', 'b', 'a', 'b', 'a']);
    assert.deepEqual(R.fillSeries(['Item 1'], 2, {}, fillCtx), ['Item 1', 'Item 1']);
    assert.deepEqual(R.fillSeries(['Mon'], 2, {}, fillCtx), ['Mon', 'Mon']);
    assert.deepEqual(R.fillSeries(['1', 'x'], 3, {}, fillCtx), ['1', 'x', '1']);
    assert.deepEqual(R.fillSeries(['1', '2'], 3, { copy: true }, fillCtx), ['1', '2', '1']);
    assert.deepEqual(R.fillSeries(['1', '2', '3'], 2, { copy: true, backward: true }, fillCtx), ['3', '2']);
    assert.deepEqual(R.fillSeries(['', ''], 2, {}, fillCtx), ['', '']);
    assert.deepEqual(R.fillSeries([], 2, {}, fillCtx), []);
  });

  await t('the viewer inlines the module and its panels, with no imports', () => {
    const { sheetsViewerSource } = require(path.join(__dirname, '..', 'server', 'sheets-source.js'));
    const src = sheetsViewerSource();
    assert.ok(src.includes('var SheetRules = (function') && src.includes('var SheetRulesUI = (function'));
    assert.doesNotThrow(() => new Function(src));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
