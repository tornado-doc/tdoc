// Sheet embeds (shared/sheet-embed.mjs, shared/sheet-embed-data.mjs and the
// worker's GET /api/embed/sheet): a page shows a standalone sheet by
// reference, and the data comes back under the SHEET's access rules for the
// person reading, as text, with the reference's view applied.
// Run with: node test/sheet-embed.test.js

const path = require('path');
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');

(async () => {
  const E = await import(path.join(root, 'shared', 'sheet-embed.mjs'));
  const D = await import(path.join(root, 'shared', 'sheet-embed-data.mjs'));
  const Q = await import(path.join(root, 'shared', 'sheet-query.mjs'));
  const M = await import(path.join(root, 'shared', 'sheet-markup.mjs'));

  const SHEET = M.sheetDocumentHtml({
    title: 'Q3 pipeline',
    sheets: [
      {
        name: 'Deals',
        columns: [{ name: 'Account', type: 'text' }, { name: 'Stage', type: 'tags', palette: 'won:green, lost:red' }, { name: 'Amount', type: 'number' }, { name: 'Notes', type: 'text' }],
        rows: [
          { cells: ['Acme <script>alert(1)</script>', ['won', 'q3'], '1200', 'a & b'] },
          { cells: ['Beta', ['lost'], '50', ''] },
          { cells: ['Gamma', ['won'], '9000', '<img src=x onerror=alert(1)>'] },
          { cells: ['Delta', ['open'], '300', ''] },
        ],
      },
      { name: 'Contacts', columns: [{ name: 'Name', type: 'text' }], rows: [{ cells: ['Ann'] }] },
    ],
  });
  const wonByAmount = Q.encodeView({ active: 'Deals', tabs: { Deals: { search: '', filters: { 1: { values: ['won'] } }, sort: [{ col: 2, dir: 'desc' }], totals: {} } } });

  console.log('sheet embeds: the reference');

  await t('a reference resolves only to a doc on this tdoc', () => {
    const hosts = ['tdoc.dev'];
    const ok = (src) => E.parseEmbedSrc(src, hosts);
    assert(ok('q3-pipeline').slug === 'q3-pipeline', 'bare slug');
    assert(ok('/d/q3-pipeline').slug === 'q3-pipeline', 'path');
    assert(ok('/d/q3-pipeline/').slug === 'q3-pipeline', 'path with slash');
    assert(ok('https://tdoc.dev/d/q3-pipeline').slug === 'q3-pipeline', 'full link on this host');
    const tabbed = ok('/d/q3-pipeline?sheet=2#sheet=abc');
    assert(tabbed.tab === 2 && tabbed.view === 'abc', JSON.stringify(tabbed));
    for (const bad of ['https://evil.example/d/q3-pipeline', '//evil.example/d/q3', '/d/q3-pipeline/v/3', '/d/Q3', '/d/../x', '/api/me', 'javascript:alert(1)', 'http://169.254.169.254/d/x', '/d/' + 'a'.repeat(65), '']) {
      assert(ok(bad) === null, `resolved ${bad}`);
    }
  });

  await t('attributes are read, bounded and checked again from a query', () => {
    const attrs = { 'data-tdoc-embed': 'sheet', 'data-src': '/d/q3-pipeline', 'data-tab': ' Deals ', 'data-rows': '5000', 'data-view': 'x'.repeat(9000), 'data-columns': 'Account, Amount' };
    const ref = E.readEmbedRef((n) => (n in attrs ? attrs[n] : null), []);
    assert(ref.slug === 'q3-pipeline' && ref.tab === 'Deals' && ref.rows === E.EMBED_MAX_ROWS, JSON.stringify(ref).slice(0, 200));
    assert(ref.view.length === 4000, 'view bounded');
    assert(E.readEmbedRef((n) => ({ 'data-tdoc-embed': 'video', 'data-src': '/d/x' })[n] || null) === null, 'only sheets');
    const back = E.embedRefFromQuery(new URLSearchParams(E.embedQuery(ref)));
    assert(back.slug === ref.slug && back.tab === ref.tab && back.rows === ref.rows && back.columns === ref.columns, JSON.stringify(back).slice(0, 200));
    assert(E.embedRefFromQuery(new URLSearchParams('slug=../etc')) === null, 'bad slug refused');
    assert(E.embedRefFromQuery(new URLSearchParams('slug=a&rows=-4')).rows === E.EMBED_DEFAULT_ROWS, 'rows default');
  });

  console.log('sheet embeds: the data');

  await t('one tab comes back as text, with the saved view applied', () => {
    const p = D.embedPayload(SHEET, { tab: 'deals', view: wonByAmount, rows: 10 }, Q);
    assert(p.tab === 'Deals' && p.tab_number === 1 && p.tabs === 2, JSON.stringify(p).slice(0, 200));
    assert(p.rows.length === 2 && p.rows[0].cells[0] === 'Gamma' && p.rows[1].cells[0].startsWith('Acme'), JSON.stringify(p.rows));
    assert(p.matching_rows === 2 && p.total_rows === 4 && p.filtered && p.sorted, 'counts');
    assert(Array.isArray(p.rows[1].cells[1]) && p.rows[1].cells[1].join() === 'won,q3', 'tags as a list');
    // What looked like markup in a cell is text: the frame draws it as text.
    assert(p.rows[1].cells[0] === 'Acme <script>alert(1)</script>', p.rows[1].cells[0]);
    assert(p.columns[1].palette === 'won:green, lost:red', 'palette');
  });

  await t('tab by position, rows and columns limited, unknown tab named', () => {
    const second = D.embedPayload(SHEET, { tabIndex: 2, rows: 10 }, Q);
    assert(second.tab === 'Contacts' && second.rows[0].cells[0] === 'Ann', JSON.stringify(second));
    const two = D.embedPayload(SHEET, { tab: 'Deals', rows: 2, columns: 'amount, ACCOUNT' }, Q);
    assert(two.rows.length === 2 && two.columns.map((c) => c.name).join() === 'Amount,Account' && two.hidden_columns === 2, JSON.stringify(two));
    const none = D.embedPayload(SHEET, { tab: 'Nope', rows: 2 }, Q);
    assert(none.error === 'no_tab' && none.tabs.join() === 'Deals,Contacts', JSON.stringify(none));
    assert(D.embedPayload('<h1>prose</h1><table><tr><td>x</td></tr></table>', { rows: 2 }, Q).error === 'no_sheet', 'not a sheet');
  });

  await t('the scan is linear on hostile markup and bounded on a huge sheet', () => {
    let t0 = Date.now();
    D.extractSheetTables('<table data-tdoc-sheet><tr><th>a</th></tr>' + '<a "'.repeat(300000));
    D.extractSheetTables('<table data-tdoc-sheet><tr><td>' + '<script>'.repeat(100000));
    D.extractSheetTables('<table data-tdoc-sheet>' + '<!--'.repeat(100000));
    assert(Date.now() - t0 < 1500, `hostile input took ${Date.now() - t0}ms`);
    const rows = Array.from({ length: 25000 }, (_, i) => `<tr data-row="r${i}"><td>${i}</td><td>${'w'.repeat(2000)}</td></tr>`).join('');
    const big = `<table data-tdoc-sheet data-name="X"><thead><tr><th data-type="number">n</th><th>t</th></tr></thead><tbody>${rows}</tbody></table>`;
    t0 = Date.now();
    const p = D.embedPayload(big, { rows: 500, view: '' }, Q, { maxRows: 50 });
    assert(p.rows.length === 50 && p.total_rows === D.DATA_LIMITS.rows && p.truncated, `rows ${p.rows.length} total ${p.total_rows}`);
    assert(JSON.stringify(p).length <= D.DATA_LIMITS.payloadChars + 10000, `payload ${JSON.stringify(p).length}`);
    assert(Date.now() - t0 < 5000, `big sheet took ${Date.now() - t0}ms`);
  });

  console.log('sheet embeds: GET /api/embed/sheet (the sheet\'s access, for the person reading)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const owner = await issue(worker, env, 'olivia');
  const created = '2026-01-01T00:00:00.000Z';
  async function seed(slug, access, extra = {}, html = SHEET) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title: `Secret title ${slug}`, slug, created, versions: [{ n: 1, created }],
      hosted: { account_id: owner.account_id, github_login: owner.login },
      access: { history_visibility: 'owner', commenting: 'signed_in', allowed_users: [], ...access },
      ...extra,
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, html);
  }
  await seed('s-public', { visibility: 'public' });
  await seed('s-link', { visibility: 'unlisted' });
  await seed('s-gated', { visibility: 'unlisted', signin_required: true });
  await seed('s-private', { visibility: 'private', allowed_users: ['ivan'] });
  await seed('s-team', { visibility: 'private', team: true, allowed_users: ['gina'] }, { workspace_id: 'team_one' });
  await seed('s-team-other', { visibility: 'private', team: true }, { workspace_id: 'team_one' });
  await seed('s-trashed', { visibility: 'public' }, { trashed_at: created, trashed_by: 'olivia' });
  await seed('s-prose', { visibility: 'public' }, {}, '<!doctype html><html><body><h1>Prose</h1><p>no sheet</p></body></html>');

  const stranger = await putSession(env, 'sam');
  const invited = await putSession(env, 'ivan');
  const guest = await putSession(env, 'gina');
  const memberSid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${memberSid}`, JSON.stringify({ login: 'mona', name: 'mona', avatar_url: '', created, team_ids: ['team_one'] }));
  const member = `tdoc_sid=${memberSid}`;

  const embed = async (slug, o = {}, q = '') => {
    const r = await worker.fetch(req(`/api/embed/sheet?slug=${slug}&tab=Deals&rows=3${q}`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...(o.headers || {}) }, ...o }), env, {});
    const text = r.status === 304 ? '' : await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text, r };
  };
  const readable = (res, who) => {
    assert(res.status === 200 && res.body && res.body.ok === true, `${who}: ${res.status} ${res.text.slice(0, 200)}`);
    assert(res.body.rows.length === 3 && res.body.columns[0].name === 'Account', `${who}: rows`);
  };
  const refused = (res, who) => {
    assert(res.status === 403 && res.body && res.body.error === 'no_access', `${who}: ${res.status} ${res.text.slice(0, 200)}`);
    assert(!/Secret title|Acme|Deals/.test(res.text), `${who}: leaked ${res.text}`);
  };

  await t('owner: reads every one of their sheets (cookie and CLI token)', async () => {
    for (const slug of ['s-public', 's-link', 's-gated', 's-private']) readable(await embed(slug, { cookie: owner.cookie }), `owner ${slug}`);
    readable(await embed('s-private', { token: owner.token, headers: {} }), 'owner bearer');
  });

  await t('anyone with the link / public: anonymous readers get the data', async () => {
    readable(await embed('s-public'), 'anonymous public');
    readable(await embed('s-link'), 'anonymous link');
    readable(await embed('s-link', { cookie: stranger }), 'stranger link');
  });

  await t('require sign-in: anonymous refused, any signed-in account reads', async () => {
    const anon = await embed('s-gated');
    refused(anon, 'anonymous gated');
    assert(anon.body.signed_in === false, 'says signed out');
    readable(await embed('s-gated', { cookie: stranger }), 'signed-in gated');
  });

  await t('private: only invited accounts; the refusal names nothing', async () => {
    readable(await embed('s-private', { cookie: invited }), 'invited');
    const s = await embed('s-private', { cookie: stranger });
    refused(s, 'stranger private');
    assert(s.body.signed_in === true, 'says signed in');
    refused(await embed('s-private'), 'anonymous private');
  });

  await t('team: members read; a guest reads only the sheet shared with them', async () => {
    readable(await embed('s-team', { cookie: member }), 'member');
    readable(await embed('s-team-other', { cookie: member }), 'member other');
    readable(await embed('s-team', { cookie: guest }), 'guest invited');
    refused(await embed('s-team-other', { cookie: guest }), 'guest not invited');
    refused(await embed('s-team', { cookie: stranger }), 'stranger team');
    refused(await embed('s-team'), 'anonymous team');
  });

  await t('a missing, trashed or private sheet is the same answer', async () => {
    const missing = await embed('no-such-sheet', { cookie: stranger });
    const trashed = await embed('s-trashed', { cookie: stranger });
    const priv = await embed('s-private', { cookie: stranger });
    refused(missing, 'missing'); refused(trashed, 'trashed');
    assert(missing.text === priv.text && trashed.text === priv.text, `${missing.text} / ${trashed.text} / ${priv.text}`);
    refused(await embed('s-trashed', { cookie: owner.cookie }), 'owner trashed');
  });

  await t('what a reader gets: title, link, comment count, data, never HTML', async () => {
    const r = await embed('s-public', {}, `&view=${wonByAmount}`);
    readable({ ...r, body: { ...r.body, rows: [1, 2, 3] } }, 'shape');
    assert(r.body.title === 'Secret title s-public' && r.body.href.startsWith('/d/s-public#sheet='), JSON.stringify(r.body).slice(0, 300));
    assert(r.body.rows[0].cells[0] === 'Gamma' && r.body.matching_rows === 2, 'view applied');
    assert(r.body.comments === 0, 'comment count');
    assert(r.r.headers.get('content-type').startsWith('application/json'), 'json');
    assert(/private/.test(r.r.headers.get('cache-control')) && !/public/.test(r.r.headers.get('cache-control')), r.r.headers.get('cache-control'));
    assert(!r.r.headers.get('access-control-allow-origin'), 'no CORS');
    assert(r.r.headers.get('etag'), 'etag');
    const again = await embed('s-public', { headers: { 'If-None-Match': r.r.headers.get('etag') } }, `&view=${wonByAmount}`);
    assert(again.status === 304, `revalidate ${again.status}`);
  });

  await t('open comments on the sheet are counted', async () => {
    const post = await worker.fetch(req('/api/comments', { method: 'POST', cookie: owner.cookie, body: { slug: 's-public', version: 1, text: 'check Gamma', anchor: { kind: 'document' } } }), env, {});
    assert(post.status === 200 || post.status === 201, `comment ${post.status} ${await post.text()}`);
    const r = await embed('s-public');
    assert(r.body.comments === 1, `count ${r.body.comments}`);
  });

  await t('bad input: invalid slug, another site, not a sheet, unknown tab', async () => {
    assert((await embed('../x')).status === 400, 'invalid slug');
    const cross = await embed('s-public', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert(cross.status === 403 && cross.body.error === 'cross_site', 'cross-site refused');
    const prose = await embed('s-prose');
    assert(prose.status === 422 && prose.body.error === 'not_a_sheet', `${prose.status}`);
    const tab = await worker.fetch(req('/api/embed/sheet?slug=s-public&tab=Nope', { headers: { 'Sec-Fetch-Site': 'same-origin' } }), env, {});
    const tb = await tab.json();
    assert(tab.status === 404 && tb.error === 'no_tab' && tb.tabs.join() === 'Deals,Contacts', JSON.stringify(tb));
    const tabPrivate = await worker.fetch(req('/api/embed/sheet?slug=s-private&tab=Nope', { cookie: stranger, headers: { 'Sec-Fetch-Site': 'same-origin' } }), env, {});
    assert(tabPrivate.status === 403 && !/Deals/.test(await tabPrivate.text()), 'tab names only for readers');
  });

  console.log('sheet embeds: version history');

  await t('a page\'s history sees the reference change, as one place', async () => {
    const page = (tab, rows) => `<!doctype html><html><head><title>Update</title></head><body><main><h1>Update</h1><h2>Pipeline</h2><p>The deals:</p>
<figure data-tdoc-embed="sheet" data-src="/d/s-public" data-tab="${tab}" data-rows="${rows}"><a href="/d/s-public">Q3 pipeline</a></figure>
<h2>Next</h2><p>Close Granite.</p></main></body></html>`;
    const up = (n, html) => worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'embed-page', version: n, html, meta: { title: 'Update' } } }), env, { waitUntil() {} });
    for (const [n, html] of [[1, page('Deals', 5)], [2, page('Contacts', 5)], [3, page('Contacts', 5)]]) {
      const r = await up(n, html);
      assert(r.status === 200, `upload v${n}: ${r.status} ${await r.text()}`);
    }
    // Hours apart, so each version is its own history row.
    const m = JSON.parse(await env.META.get('meta:embed-page'));
    m.versions.forEach((v) => { v.created = new Date(Date.parse('2026-11-08T09:00:00Z') + v.n * 3 * 3600000).toISOString(); });
    await env.META.put('meta:embed-page', JSON.stringify(m));
    const r = await worker.fetch(req('/api/docs/embed-page/history/summaries?rows=2-2,3-3', { cookie: owner.cookie }), env, { waitUntil() {} });
    const body = await r.json();
    assert(r.status === 200 && body.summaries && body.summaries['2-2'], JSON.stringify(body));
    assert(body.summaries['2-2'].places === 1 && body.summaries['2-2'].sections.join() === 'Pipeline', JSON.stringify(body.summaries));
    assert(body.summaries['3-3'].places === 0, `an unchanged reference is no change: ${JSON.stringify(body.summaries['3-3'])}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
