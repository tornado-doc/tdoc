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
  const prose = (bytes) => `<!doctype html><html><head><title>Long</title></head><body><main><h1>Long</h1>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>'.repeat(Math.ceil(bytes / 62))}</main></body></html>`;
  const upload = (slug, html, version = 1) => call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version, html, meta: { title: slug } } });
  const save = (slug, base, html) => call('/api/doc/versions', { method: 'POST', cookie: julie.cookie, headers: O, body: { slug, baseVersion: base, html } });

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
    assert(/table\[data-tdoc-sheet\]>tbody>tr:nth-child\(n\+201\)\{display:none\}/.test(body), 'only 200 rows laid out before the viewer');
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
    const v2 = small.replace('<th data-key="c2"', '<th data-key="c3" data-type="text">New</th><th data-key="c2"').replace(/<tr data-row="(r\d)"><td>/g, '<tr data-row="$1"><td></td><td>');
    assert.equal((await upload('team-sheet', v2, 2)).status, 200);
    const list = await call('/api/comments?slug=team-sheet&version=2', { cookie: julie.cookie });
    const got = (Array.isArray(list.body) ? list.body : list.body.comments || []).find((x) => x.text === 'Is Bo right?');
    assert(got && got.anchor && got.anchor.kind === 'element' && got.anchor.sheet && got.anchor.sheet.key === 'c2', `not rebound or lost: ${JSON.stringify(got && got.anchor)}`);
  });

  await t('the local server applies the same rule with the same code', () => {
    const fnOf = (src) => src.slice(src.indexOf('function sheetMarkupLength(html) {'), src.indexOf('\n}\n', src.indexOf('function sheetMarkupLength(html) {')));
    const w = fnOf(fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8'));
    const s = fnOf(fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8'));
    assert(w.length > 100 && w === s, 'sheetMarkupLength differs between worker.js and server.js');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    assert(/const SHEET_MAX_DOC_BYTES = 8 \* 1024 \* 1024;/.test(server) && /> maxDocumentBytes\(doc\)/.test(server), 'local browser save uses the sheet rule');
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
