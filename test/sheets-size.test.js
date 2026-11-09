// Sheets and size, against the worker in process:
//   - a doc whose bulk is <table data-tdoc-sheet> markup may be up to 8 MB on
//     every write path (agent upload/CLI, browser save); anything else keeps
//     the ordinary cap, and so does everything outside a sheet's tables (an
//     empty sheet buys no room)
//   - the version history summary of a big sheet is a row count, not a parse
//   - a sheet cell comment is never rebound or marked lost by the aid
//     reconcile a new version runs (it is resolved in the reader by table,
//     row id and column key)
//   - the local server applies the same rule (sheetMarkupLength is the same
//     code in both runtimes)
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, issue, req } = require('./helpers/worker-harness');

const O = { Origin: 'https://tdoc.dev' };

(async () => {
  console.log('sheets: size caps, history summaries, sheet anchors');
  const { importSheetFile } = await import('../shared/sheet-import.mjs');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, { waitUntil() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const julie = await issue(worker, env, 'julie');

  // A 10,000 × 20 import, as the browser and the CLI write it.
  const names = ['Name', 'Email', 'Amount', 'Date', 'Status', 'Owner', 'Region', 'Score', 'Notes', 'Link'];
  const lines = [Array.from({ length: 20 }, (_, c) => `${names[c % 10]} ${c + 1}`).join(',')];
  for (let r = 0; r < 10000; r++) lines.push(Array.from({ length: 20 }, (_, c) => [`Customer ${r}`, `user${r}@example.com`, ((r * 13.37) % 9999).toFixed(2), `2026-0${1 + (r % 9)}-1${r % 9}`, ['open', 'won', 'lost'][r % 3], ['Ann', 'Bo', 'Cy'][r % 3], ['EMEA', 'APAC', 'NA'][r % 3], String(r % 100), `Follow up about order ${r}`, `https://example.com/o/${r}`][c % 10]).join(','));
  const big = (await importSheetFile({ name: 'customers.csv', text: lines.join('\n') })).html;
  const MB = 1024 * 1024;
  const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');
  const prose = (bytes) => `<!doctype html><html><head><title>Long</title></head><body><main><h1>Long</h1>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>'.repeat(Math.ceil(bytes / 62))}</main></body></html>`;
  const upload = (slug, html, version = 1) => call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version, html, meta: { title: slug } } });
  // The shell names the doc in the query so the edit right is checked
  // before a multi-megabyte body is read.
  const save = (slug, base, html, who = julie, named = true) => call(`/api/doc/versions${named ? `?slug=${slug}` : ''}`, { method: 'POST', cookie: who.cookie, headers: O, body: { slug, baseVersion: base, html } });
  const stranger = await issue(worker, env, 'stranger');

  await t('a 10k × 20 sheet (over 2 MB) publishes through the agent upload and saves from the browser', async () => {
    assert(big.length > 2 * MB && big.length < 8 * MB, `fixture size ${big.length}`);
    const t0 = Date.now();
    const up = await upload('big-sheet', big);
    const uploadMs = Date.now() - t0;
    assert.equal(up.status, 200, up.text.slice(0, 300));
    const edited = big.replace('<td>Customer 0</td>', '<td>Customer zero</td>');
    const t1 = Date.now();
    const saved = await save('big-sheet', 1, edited);
    assert.equal(saved.status, 200, saved.text.slice(0, 300));
    console.log(`    (${(big.length / MB).toFixed(1)} MB: upload ${uploadMs}ms, browser save ${Date.now() - t1}ms in process)`);
  });

  await t('the frame of a big sheet is served (baked once), with the loader for the viewer', async () => {
    const t0 = Date.now();
    const r = await worker.fetch(req('/d/big-sheet/v/2/frame', { cookie: julie.cookie, headers: { 'Sec-Fetch-Dest': 'iframe' } }), env, { waitUntil() {} });
    const body = await r.text();
    assert.equal(r.status, 200);
    assert(body.includes('Customer zero') && body.includes('/sheets-viewer.js?v='), 'doc and loader');
    assert(/<style id="tdoc-sheets-pending" data-tdoc-provider>table\[data-tdoc-sheet\]>tbody>tr:nth-child\(n\+201\)\{display:none\}<\/style>/.test(body), 'a removable 200-row hold, for a sheet doc only');
    console.log(`    (frame ${Date.now() - t0}ms in process)`);
  });

  await t('the sheet cap is 8 MB; a non-sheet doc and a near-empty sheet keep the ordinary 2 MB', async () => {
    const tooBig = big.replace('</tbody>', `${'<tr data-row="x"><td>' + 'y'.repeat(200) + '</td></tr>'.repeat(1)}`.repeat(1) + '</tbody>');
    const huge = tooBig.replace(/<tbody>/, '<tbody>' + '<tr data-row="pad"><td>pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad</td></tr>'.repeat(30000));
    assert(huge.length > 8 * MB, `huge ${huge.length}`);
    let r = await upload('too-big-sheet', huge);
    assert.equal(r.status, 413, 'over 8 MB');
    assert.equal(r.body.error, 'quota_upload_bytes');
    r = await upload('long-prose', prose(3 * MB));
    assert.equal(r.status, 413, 'prose over 2 MB');
    assert.equal(r.body.limit, 2 * MB);
    const smuggled = prose(2.5 * MB).replace('</main>', '<table data-tdoc-sheet data-name="T"><thead><tr><th>A</th></tr></thead><tbody><tr data-row="r1"><td>1</td></tr></tbody></table></main>');
    r = await upload('smuggled', smuggled);
    assert.equal(r.status, 413, 'an empty sheet does not lift the cap for the rest');
    assert.equal(r.body.limit, 2 * MB);
    r = await save('big-sheet', 2, smuggled);
    assert.equal(r.status, 413, 'nor on a browser save');
  });

  await t('the sheet allowance counts sheet content only: a data: image or a comment-wrapped table gets the 2 MB cap', async () => {
    const cell = (s) => `<tr data-row="r1"><td>${s}</td></tr>`;
    const sheetOf = (inner) => `<!doctype html><html><head><title>x</title></head><body><main><h1>x</h1><table data-tdoc-sheet data-name="T"><thead><tr><th data-key="c1">A</th></tr></thead><tbody>${inner}</tbody></table></main></body></html>`;
    const b64 = 'A'.repeat(3 * MB);
    const cases = {
      'a base64 image in a cell': sheetOf(cell(`<img src="data:image/png;base64,${b64}">`)),
      'a data: URL in a link': sheetOf(cell(`<a href="data:text/html;base64,${b64}">x</a>`)),
      'a script in a cell': sheetOf(cell(`<script>${'x'.repeat(3 * MB)}</script>`)),
      'a comment in a cell': sheetOf(cell(`<!--${'x'.repeat(3 * MB)}-->`)),
      'a long attribute': sheetOf(cell(`<span title="${'x'.repeat(3 * MB)}">y</span>`)),
      'a comment-wrapped fake table': `<!doctype html><html><head><title>x</title></head><body><main><h1>x</h1><!-- <table data-tdoc-sheet data-name="F"><tbody>${cell('x'.repeat(3 * MB))}</tbody></table> --><table data-tdoc-sheet data-name="T"><tbody>${cell('ok')}</tbody></table></main></body></html>`,
      'a table inside a style': `<!doctype html><html><head><title>x</title><style>/* <table data-tdoc-sheet><tr><td>${'x'.repeat(3 * MB)}</td></tr></table> */</style></head><body><main><table data-tdoc-sheet data-name="T"><tbody>${cell('ok')}</tbody></table></main></body></html>`,
      '60k one-cell sheet tables': `<!doctype html><html><head><title>x</title></head><body><main>${`<table data-tdoc-sheet><tbody>${cell('x'.repeat(60))}</tbody></table>`.repeat(60000)}</main></body></html>`,
      'one cell past the 10,000-character cell limit': sheetOf(cell('x'.repeat(3 * MB))),
      'a sheet inside an svg': `<!doctype html><html><body><svg><table data-tdoc-sheet><tbody>${cell('x'.repeat(9000)).repeat(330)}</tbody></table></svg></body></html>`,
      'a sheet inside a template': `<!doctype html><html><body><template><table data-tdoc-sheet><tbody>${cell('x'.repeat(9000)).repeat(330)}</tbody></table></template></body></html>`,
      'a sheet inside math': `<!doctype html><html><body><math><table data-tdoc-sheet><tbody>${cell('x'.repeat(9000)).repeat(330)}</tbody></table></math></body></html>`,
      'CDATA in a sheet': sheetOf(cell('x'.repeat(9000)).repeat(330) + cell('<![CDATA[ x ]]>')),
      'a quoted attribute running over a <': sheetOf(cell('x'.repeat(9000)).repeat(330) + `<tr data-row="r9"><td title="a<b">y</td></tr>`),
    };
    for (const [what, html] of Object.entries(cases)) {
      assert(utf8Bytes(html) > 2 * MB && utf8Bytes(html) < 8 * MB, `${what}: fixture is ${utf8Bytes(html)} bytes`);
      const r = await upload(`bypass-${Object.keys(cases).indexOf(what)}`, html);
      assert.equal(r.status, 413, `${what}: ${r.status}`);
      assert.equal(r.body.limit, 2 * MB, `${what}: held to 2 MB`);
    }
  });

  await t('twenty sheet tables get the allowance, twenty-one do not', async () => {
    const tables = (k) => `<!doctype html><html><body><main>${Array.from({ length: k }, (_, t) => `<table data-tdoc-sheet data-name="T${t}"><tbody>${`<tr data-row="r1"><td>${'x'.repeat(9000)}</td></tr>`.repeat(Math.ceil(330 / k) + 1)}</tbody></table>`).join('')}</main></body></html>`;
    const ok = tables(20), over = tables(21);
    assert(utf8Bytes(ok) > 2 * MB && utf8Bytes(over) > 2 * MB);
    assert.equal((await upload('tables-20', ok)).status, 200);
    const r = await upload('tables-21', over);
    assert.equal(r.status, 413);
    assert.equal(r.body.limit, 2 * MB);
  });

  await t('browser save: no session, no right to edit, or no named doc means no large body is read', async () => {
    const edited = big.replace('<td>Customer 1</td>', '<td>Customer one</td>');
    let r = await call('/api/doc/versions?slug=big-sheet', { method: 'POST', headers: O, body: { slug: 'big-sheet', baseVersion: 2, html: edited } });
    assert(r.status === 401 || r.status === 403, `signed out: ${r.status}`);
    r = await save('big-sheet', 2, edited, stranger);
    assert(r.status === 401 || r.status === 403 || r.status === 404, `not an editor: ${r.status} ${r.text.slice(0, 120)}`);
    r = await save('big-sheet', 2, edited, julie, false);
    assert.equal(r.status, 413, 'without ?slug= the body is held to the ordinary cap before authorization');
    // Two docs Julie may edit: authorized for one, the body names the other.
    assert.equal((await upload('other-sheet', '<!doctype html><html><body><p>other</p></body></html>')).status, 200);
    r = await call('/api/doc/versions?slug=other-sheet', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: 'big-sheet', baseVersion: 2, html: '<!doctype html><html><body>x</body></html>' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error, 'slug_mismatch');
  });

  await t('the size scan is linear: adversarial 2 MB inputs take under 50 ms (100 ms on CI)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    const code = src.slice(src.indexOf('var SHEET_SCAN_TAGS'), src.indexOf('function maxDocumentBytes'));
    const sheetScan = new Function(`${code}; return sheetScan;`)();
    const inputs = {
      'open tags': 'data-tdoc-sheet' + '<table '.repeat(300000),
      'sheet tables, unclosed attributes': 'data-tdoc-sheet' + '<table data-tdoc-sheet x="'.repeat(80000),
      'cells without text': '<table data-tdoc-sheet>' + '<td>'.repeat(500000) + '</table>',
      'cells with text': '<table data-tdoc-sheet>' + '<td>x</td>'.repeat(200000) + '</table>',
      'bare <': 'data-tdoc-sheet' + '<'.repeat(2 * MB),
      'bogus comments': 'data-tdoc-sheet' + '<!x'.repeat(700000),
      'colons in tags': '<table data-tdoc-sheet>' + '<a href="x:">'.repeat(150000) + '</table>',
      'nested tables': '<table data-tdoc-sheet>' + '<table>'.repeat(280000),
      'bare < in a cell': '<table data-tdoc-sheet><tr><td>' + '<'.repeat(2 * MB) + '</td></tr></table>',
      'short tags in a sheet': '<table data-tdoc-sheet>' + '<b>'.repeat(650000) + '</table>',
    };
    // 50 ms is the bound (10-20 ms on a laptop). A shared CI runner measures
    // about 2.4x slower, so there it is 100 ms; a quadratic scan takes
    // seconds either way.
    const bound = process.env.CI ? 100 : 50;
    for (const [what, input] of Object.entries(inputs)) {
      let best = Infinity;
      for (let k = 0; k < 5; k++) { const t0 = process.hrtime.bigint(); sheetScan(input); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); }
      assert(best < bound, `${what} (${input.length} chars): ${best.toFixed(1)}ms`);
    }
    const ok = sheetScan(big);
    assert(ok.tables === 1 && ok.rows === 10000 && ok.bytes > big.length * 0.6, JSON.stringify(ok));
  });

  await t('an 8 MB sheet upload (aid stamping, reconcile, frame bake) stays bounded', async () => {
    let html = big;
    const chunk = big.slice(big.indexOf('<tr data-row="r1">'), big.indexOf('<tr data-row="r300">'));
    while (html.length + chunk.length < 7.9 * MB) html = html.replace('</tbody>', chunk + '</tbody>');
    assert(html.length < 8 * MB, `fixture ${html.length}`);
    const t0 = Date.now();
    const r = await upload('eight-mb', html);
    const ms = Date.now() - t0;
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert(ms < 5000, `upload took ${ms}ms`);
    console.log(`    (${(html.length / MB).toFixed(1)} MB upload in process, aid stamping included: ${ms}ms)`);
  });

  await t('history: a big sheet\'s summary is its row count, not a parse', async () => {
    const t0 = Date.now();
    const r = await call('/api/docs/big-sheet/history/summaries?rows=2-2,1-1', { cookie: julie.cookie });
    assert.equal(r.status, 200, r.text);
    const s = r.body.summaries || r.body;
    const row = s['2-2'];
    assert(row && Array.isArray(row.rows) && row.rows[0] === 10000 && row.rows[1] === 10000 && row.places === null, JSON.stringify(row));
    assert(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  });

  await t('a sheet cell comment survives the aid reconcile of a new version', async () => {
    const small = (await importSheetFile({ name: 'team.csv', text: 'Name,Owner\nA,Ann\nB,Bo\n' })).html;
    assert.equal((await upload('team-sheet', small)).status, 200);
    const anchor = { kind: 'element', selector: 'table[data-tdoc-sheet][data-name="team"] tr[data-row="r2"] > :nth-child(2)', label: 'B2 · Owner', sheet: { table: 'team', row: 'r2', key: 'c2' } };
    const c = await call('/api/comments', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: 'team-sheet', version: 1, text: 'Is Bo right?', anchor } });
    assert.equal(c.status, 200, c.text);
    // A positional sheet anchor (no key) is not exempt: it reconciles like any element anchor.
    const positional = { kind: 'element', selector: 'table[data-tdoc-sheet][data-name="team"] tr[data-row="r1"] > :nth-child(2)', label: 'B1 · Owner', sheet: { table: 'team', row: 'r1' } };
    assert.equal((await call('/api/comments', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug: 'team-sheet', version: 1, text: 'Positional', anchor: positional } })).status, 200);
    const v2 = small.replace('<th data-key="c2"', '<th data-key="c3" data-type="text">New</th><th data-key="c2"').replace(/<tr data-row="(r\d)"><td>/g, '<tr data-row="$1"><td></td><td>');
    assert.equal((await upload('team-sheet', v2, 2)).status, 200);
    const list = await call('/api/comments?slug=team-sheet&version=2', { cookie: julie.cookie });
    const got = (Array.isArray(list.body) ? list.body : list.body.comments || []).find((x) => x.text === 'Is Bo right?');
    assert(got && got.anchor && got.anchor.kind === 'element' && got.anchor.sheet && got.anchor.sheet.key === 'c2', `not rebound or lost: ${JSON.stringify(got && got.anchor)}`);
    const pos = (Array.isArray(list.body) ? list.body : list.body.comments || []).find((x) => x.text === 'Positional');
    assert(pos && pos.anchor && !(pos.anchor.kind === 'element' && pos.anchor.selector === positional.selector), `the positional one went through the normal reconcile: ${JSON.stringify(pos && pos.anchor)}`);
  });

  await t('the local server applies the same rule with the same code', () => {
    const between = (src, a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
    const ws = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
    const ss = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    const scanW = between(ws, 'var SHEET_SCAN_TAGS', 'function hostedBaseUploadBytes');
    const scanS = between(ss, 'var SHEET_SCAN_TAGS', 'function maxDocumentBytes');
    assert(scanW.length > 1000 && scanW.trim() === scanS.trim(), 'sheetScan differs between worker.js and server.js');
    const pend = (src) => between(src, 'const SHEETS_PENDING_STYLE', '\n}\n');
    assert(pend(ws).length > 100 && pend(ws) === pend(ss), 'the sheets pending style differs between worker.js and server.js');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    assert(/const SHEET_MAX_DOC_BYTES = 8 \* 1024 \* 1024;/.test(server) && /> maxDocumentBytes\(doc\)/.test(server), 'local browser save uses the sheet rule');
    assert(!/sheetMarkupLength|sheetRowCount/.test(ws + server), 'the old regex scans are gone');
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
