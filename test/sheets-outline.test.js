// Sheets, structure: the pure half (shared/sheet-outline.mjs). Groups as runs
// of outline levels (nested, up to 3), collapsed by the document's default or
// a reader's view, hidden rows, where groups sit in a filtered view, freeze,
// and the markup round trip
// (attributes read through cleaners, written back, as strings and on elements).
// No browser and no npm install.
const assert = require('node:assert/strict');
const { parseHtml } = require('./helpers/mini-dom');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; }
}

(async () => {
  const O = await import('../shared/sheet-outline.mjs');
  const M = await import('../shared/sheet-markup.mjs');
  console.log('sheets: outline, hidden, freeze, markup round trip');

  const axis = (levels, hidden = [], collapsed = {}) => {
    const n = levels.length;
    const a = { level: Uint8Array.from(levels), hidden: new Uint8Array(n), collapsed: new Uint8Array(n), any: true };
    hidden.forEach((i) => { a.hidden[i] = 1; });
    Object.keys(collapsed).forEach((i) => { a.collapsed[i] = collapsed[i]; });
    return a;
  };
  const ids = (n) => Array.from({ length: n }, (_, i) => `r${i + 1}`);
  const brief = (groups) => groups.map((g) => [g.level, g.start, g.end, g.parent]);

  await t('cleaners: levels 1..3, freeze 0..10, collapsed levels as a list', () => {
    assert.equal(O.cleanLevel('2'), 2);
    assert.equal(O.cleanLevel('7'), 3);
    for (const bad of ['0', '-1', '1.5', 'x', '', null, 'expression(alert(1))']) assert.equal(O.cleanLevel(bad), 0, String(bad));
    assert.equal(O.cleanFreeze('3'), 3);
    assert.equal(O.cleanFreeze('99'), 10);
    assert.equal(O.cleanFreeze('-2', 1), 1);
    assert.equal(O.cleanFreeze(null, 1), 1);
    assert.equal(O.parseCollapsed('1 3'), 0b101);
    assert.equal(O.parseCollapsed('2,9,x,1.0'), 0b010, 'only whole levels 1..3');
    assert.equal(O.formatCollapsed(0b011), '1 2');
  });

  await t('groups are runs of a level or deeper; nested groups know their parent', () => {
    //            0  1  2  3  4  5  6  7  8
    const lv = [0, 1, 1, 2, 2, 1, 0, 1, 3];
    assert.deepEqual(brief(O.groupsOf(Uint8Array.from(lv))), [
      [1, 1, 5, -1], [2, 3, 4, 0], [1, 7, 8, -1], [2, 8, 8, 2], [3, 8, 8, 3],
    ]);
    assert.equal(O.maxLevel(O.groupsOf(Uint8Array.from(lv))), 3);
    assert.deepEqual(O.groupsOf(new Uint8Array(4)), []);
  });

  await t('collapsed: the document default on the group\'s first row, a reader\'s view over it', () => {
    const lv = [0, 1, 1, 2, 2, 0];
    const a = axis(lv, [], { 3: 0b10 });
    const g = O.groupsOf(a.level);
    const id = ids(6);
    assert.deepEqual(Array.from(O.shownMask(a, g, id, {})), [1, 1, 1, 0, 0, 1], 'level-2 group collapsed by default');
    assert.deepEqual(Array.from(O.shownMask(a, g, id, { '2:r4': false })), [1, 1, 1, 1, 1, 1], 'the reader opened it');
    assert.deepEqual(Array.from(O.shownMask(a, g, id, { '1:r2': true })), [1, 0, 0, 0, 0, 1], 'collapsing the outer hides the inner');
    assert.equal(O.groupKey(g[0], id), '1:r2');
  });

  await t('the view order: hidden rows always out, collapsed rows out unless sorted (flat)', () => {
    const a = axis([0, 1, 1, 0, 0], [4], { 1: 1 });
    const g = O.groupsOf(a.level);
    const shown = O.shownMask(a, g, ids(5), {});
    assert.deepEqual(Array.from(O.applyToOrder([0, 1, 2, 3, 4], a, shown, false)), [0, 3]);
    assert.deepEqual(Array.from(O.applyToOrder([3, 2, 1, 0, 4], a, shown, true)), [3, 2, 1, 0], 'sorted: groups show open, hidden stays hidden');
  });

  await t('spans: where each group sits in a filtered view, markers for collapsed groups and hidden runs', () => {
    // rows 0..7; group A (level 1) 1..4 holding group B (level 2) 2..3; group C 6..7 collapsed; row 5 hidden.
    const a = axis([0, 1, 2, 2, 1, 0, 1, 1], [5], { 6: 1 });
    const g = O.groupsOf(a.level), id = ids(8);
    const shown = O.shownMask(a, g, id, {});
    // A filter drops row 3.
    const pass = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 1]);
    const order = [0, 1, 2, 4].filter((r) => shown[r]);
    const sp = O.spans(g, a, id, {}, order, pass);
    const byKey = Object.fromEntries(sp.groups.map((s) => [s.key, s]));
    assert.deepEqual([byKey['1:r2'].i0, byKey['1:r2'].i1, byKey['1:r2'].collapsed], [1, 3, false]);
    assert.deepEqual([byKey['2:r3'].i0, byKey['2:r3'].i1, byKey['2:r3'].count], [2, 2, 1], 'the filtered row is not counted');
    assert.deepEqual([byKey['1:r7'].collapsed, byKey['1:r7'].at, byKey['1:r7'].count], [true, 4, 2], 'collapsed C: a marker at the end');
    assert.deepEqual(sp.hidden.map((h) => [h.start, h.end, h.at]), [[5, 5, 4]]);
    // Collapse A: B is under it and gets no marker of its own.
    const view = { '1:r2': true };
    const shown2 = O.shownMask(a, g, id, view);
    const sp2 = O.spans(g, a, id, view, [0].filter((r) => shown2[r]), pass);
    assert.deepEqual(sp2.groups.map((s) => s.key), ['1:r2', '1:r7']);
  });

  await t('show a level: Excel\'s 1 2 3 buttons', () => {
    const g = O.groupsOf(Uint8Array.from([0, 1, 2, 2, 1, 3]));
    const id = ids(6);
    const keys = (v) => Object.keys(v).filter((k) => v[k]).sort();
    assert.deepEqual(keys(O.viewForLevel(g, id, 1)), ['1:r2', '2:r3', '2:r6', '3:r6']);
    assert.deepEqual(keys(O.viewForLevel(g, id, 2)), ['2:r3', '2:r6', '3:r6']);
    assert.deepEqual(keys(O.viewForLevel(g, id, 4)), []);
  });

  await t('regroup: a range one level deeper (at most 3) or shallower (at least 0)', () => {
    assert.deepEqual(Array.from(O.regroup(Uint8Array.from([0, 1, 3, 0]), 1, 2, 1)), [0, 2, 3, 0]);
    assert.deepEqual(Array.from(O.regroup(Uint8Array.from([0, 1, 3, 0]), 0, 3, -1)), [0, 0, 2, 0]);
  });

  const sheetHtml = `<table data-tdoc-sheet data-name="Budget" data-freeze-rows="2" data-freeze-cols="0">
    <thead><tr><th data-key="c1">Item</th><th data-key="c2" data-group="1" data-collapsed="1">Q1</th><th data-key="c3" data-group="1">Q2</th><th data-key="c4" data-hidden>Notes</th></tr></thead>
    <tbody>
      <tr data-row="r1"><td>Team</td><td>1</td><td>2</td><td></td></tr>
      <tr data-row="r2" data-group="1"><td>a</td><td>1</td><td>2</td><td></td></tr>
      <tr data-row="r3" data-group="2" data-collapsed="2 1 7"><td>b</td><td>1</td><td>2</td><td></td></tr>
      <tr data-row="r4" data-hidden data-group="banana"><td>c</td><td>1</td><td>2</td><td></td></tr>
    </tbody></table>`;

  await t('markup round trip: read from the table (cleaned), written onto a bare copy, read back the same', () => {
    const read = (html) => {
      const table = parseHtml(html).querySelector('table');
      const sheet = M.readSheetTable(table);
      return { table, sheet, rows: O.readAxis(sheet.rows.map((r) => r.tr)), cols: O.readAxis(sheet.columns.map((c) => c.th)), t: O.readTable(table) };
    };
    const a = read(sheetHtml);
    assert.deepEqual(a.t, { freezeRows: 2, freezeCols: 0 });
    assert.deepEqual(Array.from(a.rows.level), [0, 1, 2, 0], 'an unreadable level is no level');
    assert.deepEqual(Array.from(a.rows.hidden), [0, 0, 0, 1]);
    assert.equal(a.rows.collapsed[2], 0b011, 'levels 1 and 2 (7 dropped)');
    assert.deepEqual(Array.from(a.cols.level), [0, 1, 1, 0]);
    assert.deepEqual(Array.from(a.cols.hidden), [0, 0, 0, 1]);
    // A bare copy (no structure attributes), then the writers.
    const bare = sheetHtml.replace(/ data-(group|collapsed|hidden|freeze-rows|freeze-cols)(="[^"]*")?/g, '');
    const b = read(bare);
    assert.equal(b.rows.any || b.cols.any, false);
    O.writeFreeze(b.table, a.t.freezeRows, a.t.freezeCols);
    b.sheet.rows.forEach((row, r) => { O.writeLevel(row.tr, a.rows.level[r]); O.writeHidden(row.tr, a.rows.hidden[r]); for (let l = 1; l <= 3; l++) if (a.rows.collapsed[r] & (1 << (l - 1))) O.writeCollapsed(row.tr, l, true); });
    b.sheet.columns.forEach((col, c) => { O.writeLevel(col.th, a.cols.level[c]); O.writeHidden(col.th, a.cols.hidden[c]); if (a.cols.collapsed[c]) O.writeCollapsed(col.th, 1, true); });
    assert.equal(b.sheet.rows[2].tr.getAttribute('data-collapsed'), '1 2');
    assert.equal(b.sheet.rows[3].tr.getAttribute('data-hidden'), '');
    assert.equal(b.table.getAttribute('data-freeze-cols'), '0');
    const again = { rows: O.readAxis(b.sheet.rows.map((r) => r.tr)), cols: O.readAxis(b.sheet.columns.map((c) => c.th)), t: O.readTable(b.table) };
    for (const k of ['level', 'hidden', 'collapsed']) {
      assert.deepEqual(Array.from(again.rows[k]), Array.from(a.rows[k]), `rows ${k}`);
      assert.deepEqual(Array.from(again.cols[k]), Array.from(a.cols[k]), `cols ${k}`);
    }
    assert.deepEqual(again.t, a.t);
  });

  await t('writers: defaults leave no attribute; ungrouping drops a collapsed level it no longer has', () => {
    const table = parseHtml(sheetHtml).querySelector('table');
    O.writeFreeze(table, 0, 1);
    assert.equal(table.hasAttribute('data-freeze-rows') || table.hasAttribute('data-freeze-cols'), false, 'freeze 0 rows / 1 column is the default');
    const tr = table.querySelector('tr[data-row="r3"]');
    O.writeLevel(tr, 1);
    assert.equal(tr.getAttribute('data-collapsed'), '1');
    O.writeLevel(tr, 0);
    assert.equal(tr.hasAttribute('data-group') || tr.hasAttribute('data-collapsed'), false);
    O.writeHidden(tr, true); O.writeHidden(tr, false);
    assert.equal(tr.hasAttribute('data-hidden'), false);
  });

  await t('tab strip order: data-order first (cleaned), the rest after in document order', () => {
    const tab = (name, order) => ({ name, table: { getAttribute: (a) => (a === 'data-order' ? order : null) } });
    const names = (list) => O.stripOrder(list).map((x) => x.name).join();
    assert.equal(names([tab('A'), tab('B'), tab('C')]), 'A,B,C');
    assert.equal(names([tab('A', '2'), tab('B', '0'), tab('C', '1')]), 'B,C,A');
    assert.equal(names([tab('A', '1'), tab('New'), tab('B', '0')]), 'B,A,New', 'a tab added later comes last');
    assert.equal(names([tab('A', '-1'), tab('B', 'x'), tab('C', '0')]), 'C,A,B', 'bad orders are no order');
    assert.equal(O.cleanOrder('1000'), null);
  });

  await t('structureAttrs: the same attributes as a string, cleaned', () => {
    assert.equal(O.structureAttrs({ level: 2, collapsed: [2, 3, 1], hidden: true }), ' data-group="2" data-collapsed="1 2" data-hidden');
    assert.equal(O.structureAttrs({ level: '"><script>' }), '');
    const html = `<table data-tdoc-sheet><thead><tr><th>A</th></tr></thead><tbody><tr data-row="r1"${O.structureAttrs({ level: 3, collapsed: [3] })}><td>x</td></tr></tbody></table>`;
    const tr = parseHtml(html).querySelector('tr[data-row]');
    const ax = O.readAxis([tr]);
    assert.deepEqual([ax.level[0], ax.collapsed[0]], [3, 0b100]);
  });

  await t('10,000 rows with 2,000 nested groups: read, groups, view and spans in well under 100 ms', () => {
    const n = 10000, lv = new Uint8Array(n), coll = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const k = i % 5; lv[i] = k === 0 ? 0 : k < 3 ? 1 : 2; if (k === 1 && i % 10 === 1) coll[i] = 1; }
    const a = { level: lv, hidden: new Uint8Array(n), collapsed: coll, any: true };
    const id = ids(n);
    const t0 = process.hrtime.bigint();
    const g = O.groupsOf(a.level);
    const shown = O.shownMask(a, g, id, {});
    const order = O.applyToOrder(Array.from({ length: n }, (_, i) => i), a, shown, false);
    const sp = O.spans(g, a, id, {}, order, null);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(g.length, 4000);
    assert.equal(order.length, 2000 + 1000 * 4, 'half the level-1 groups collapsed');
    assert.ok(sp.groups.length >= 3000);
    assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
