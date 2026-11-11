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
  const TEAM = 't_00000000000000aa';
  await seed('s-team', { visibility: 'private', team: true, allowed_users: ['gina'] }, { workspace_id: TEAM });
  await seed('s-team-other', { visibility: 'private', team: true }, { workspace_id: TEAM });
  await seed('s-trashed', { visibility: 'public' }, { trashed_at: created, trashed_by: 'olivia' });
  await seed('s-prose', { visibility: 'public' }, {}, '<!doctype html><html><body><h1>Prose</h1><p>no sheet</p></body></html>');

  const stranger = await putSession(env, 'sam');
  const invited = await putSession(env, 'ivan');
  const guest = await putSession(env, 'gina');
  const memberSid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${memberSid}`, JSON.stringify({ login: 'mona', name: 'mona', avatar_url: '', created, team_ids: [TEAM] }));
  const member = `tdoc_sid=${memberSid}`;

  // The pages that embed: who published each one's latest version matters.
  const mallory = await issue(worker, env, 'mallory');
  const tess = await issue(worker, env, 'tess');
  await env.META.put(`account-teams:${tess.account_id}`, JSON.stringify([TEAM]));
  async function seedPage(slug, by, access, extra = {}, versions = null) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title: slug, slug, created, versions: versions || [{ n: 1, created, by: by.account_id, by_account: by.account_id }],
      hosted: { account_id: by.account_id, github_login: by.login },
      access: { history_visibility: 'owner', commenting: 'signed_in', allowed_users: [], ...access },
      ...extra,
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, '<!doctype html><html><body><h1>Page</h1><figure data-tdoc-embed="sheet" data-src="/d/s-private"><a href="/d/s-private">x</a></figure></body></html>');
  }
  await seedPage('page-owner', owner, { visibility: 'public' });
  await seedPage('page-mallory', mallory, { visibility: 'public' });
  await seedPage('page-team', tess, { visibility: 'public' }, { workspace_id: TEAM });
  await seedPage('page-team-private', tess, { visibility: 'private', team: true }, { workspace_id: TEAM });
  await seedPage('page-private', owner, { visibility: 'private' });
  const tom = await issue(worker, env, 'tom');
  await env.META.put(`account-teams:${tom.account_id}`, JSON.stringify([TEAM]));
  const gail = await issue(worker, env, 'gail');
  const v = (n, extra) => ({ n, created, ...extra });
  // Two team members wrote it.
  await seedPage('page-team-two', tess, { visibility: 'private', team: true }, { workspace_id: TEAM }, [v(1, { by_account: tess.account_id }), v(2, { source: 'browser', by_account: tom.account_id })]);
  // A guest editor's browser save (by an account that cannot read the sheet), then the owner's.
  await seedPage('page-guest-edit', owner, { visibility: 'public' }, {}, [v(1, { by_account: owner.account_id }), v(2, { source: 'browser', by_account: gail.account_id }), v(3, { by_account: owner.account_id })]);
  // A save from before writers were recorded (a Google/email session: no login, no id).
  await seedPage('page-unnamed', owner, { visibility: 'public' }, {}, [v(1, { by_account: owner.account_id }), v(2, { source: 'browser', author: '' })]);
  // A version from before by_account, even by the owner's agent.
  await seedPage('page-legacy', owner, { visibility: 'public' }, {}, [v(1, { by: owner.account_id })]);

  const embed = async (slug, o = {}, q = '') => {
    const page = o.page === undefined ? 'page-owner' : o.page;
    const pv = o.pv === undefined ? (JSON.parse(await env.META.get(`meta:${page}`) || '{"versions":[]}').versions || []).reduce((m, x) => Math.max(m, x.n), 0) : o.pv;
    const r = await worker.fetch(req(`/api/embed/sheet?${page ? `page=${page}&pv=${pv}&` : ''}slug=${slug}&tab=Deals&rows=3${q}`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...(o.headers || {}) }, ...o }), env, {});
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
    const page = 'page-team';
    readable(await embed('s-team', { cookie: member, page }), 'member');
    readable(await embed('s-team-other', { cookie: member, page }), 'member other');
    readable(await embed('s-team', { cookie: guest, page }), 'guest invited');
    refused(await embed('s-team-other', { cookie: guest, page }), 'guest not invited');
    refused(await embed('s-team', { cookie: stranger, page }), 'stranger team');
    refused(await embed('s-team', { page }), 'anonymous team');
  });

  await t('the page\'s author must be able to read the sheet too (no confused deputy)', async () => {
    // ivan may read s-private; mallory, who published the page, may not.
    const deputy = await embed('s-private', { cookie: invited, page: 'page-mallory' });
    refused(deputy, 'author without access');
    const priv = await embed('s-private', { cookie: stranger });
    assert(deputy.text === priv.text.replace('"signed_in":true', '"signed_in":true'), `${deputy.text} / ${priv.text}`);
    // The same reader, on a page whose author can read the sheet.
    readable(await embed('s-private', { cookie: invited, page: 'page-owner' }), 'author with access');
    // A public sheet: anybody's page may show it.
    readable(await embed('s-public', { page: 'page-mallory' }), 'public sheet, any author');
  });

  await t('a team page published by a member who can read the team sheet works', async () => {
    readable(await embed('s-team-other', { cookie: member, page: 'page-team-private' }), 'team page, team sheet');
    refused(await embed('s-team-other', { cookie: stranger, page: 'page-team-private' }), 'reader who cannot read the page');
  });

  await t('every writer of the page must be able to read the sheet, on every version', async () => {
    readable(await embed('s-private', { cookie: invited, page: 'page-owner' }), 'owner-only page');
    // v2 by a guest editor who cannot read the sheet, v3 by the owner: refused
    // on the latest, and an old version never embeds at all.
    refused(await embed('s-private', { cookie: owner.cookie, page: 'page-guest-edit' }), 'guest editor then owner');
    const old = await embed('s-private', { cookie: owner.cookie, page: 'page-guest-edit', pv: 2 });
    assert(old.status === 409 && old.body.error === 'old_version' && !/Secret|Acme/.test(old.text), `old version: ${old.status} ${old.text}`);
    // A version that names no account is never guessed to be the owner's.
    // The page answers before the sheet is looked at (the link stays), the
    // same for a sheet that exists and one that does not.
    for (const pg of ['page-unnamed', 'page-legacy']) {
      const r1 = await embed('s-private', { cookie: owner.cookie, page: pg });
      const r2 = await embed('no-such-sheet', { cookie: owner.cookie, page: pg });
      assert(r1.status === 409 && r1.body.error === 'page_unattributed' && r1.text === r2.text, `${pg}: ${r1.status} ${r1.text} / ${r2.text}`);
    }
  });

  await t('a team page whose writers can all read the team sheet works; one who left the team stops it', async () => {
    readable(await embed('s-team-other', { cookie: member, page: 'page-team-two' }), 'two team writers');
    await env.META.put(`account-teams:${tom.account_id}`, JSON.stringify([]));
    refused(await embed('s-team-other', { cookie: member, page: 'page-team-two' }), 'a writer left the team');
    await env.META.put(`account-teams:${tom.account_id}`, JSON.stringify([TEAM]));
  });

  await t('every write path records the writer\'s account (by_account)', async () => {
    // Agent / CLI / MCP publish (all /api/upload).
    const up = await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'page-written', version: 1, html: '<!doctype html><html><body><h1>W</h1><p>x</p></body></html>', meta: { title: 'W', versions: [{ n: 1, by_account: gail.account_id }] } } }), env, { waitUntil() {} });
    assert(up.status === 200, `upload ${up.status} ${await up.text()}`);
    let m = JSON.parse(await env.META.get('meta:page-written'));
    assert(m.versions[0].by_account === owner.account_id, `upload: ${JSON.stringify(m.versions[0])}`);
    // A browser save.
    const save = await worker.fetch(req('/api/doc/versions', { method: 'POST', cookie: owner.cookie, headers: { Origin: 'https://tdoc.dev' }, body: { slug: 'page-written', baseVersion: 1, html: '<!doctype html><html><body><h1>W</h1><p>y</p></body></html>' } }), env, { waitUntil() {} });
    assert(save.status === 200, `save ${save.status} ${await save.text()}`);
    m = JSON.parse(await env.META.get('meta:page-written'));
    assert(m.versions[1].by_account === owner.account_id, `browser save: ${JSON.stringify(m.versions[1])}`);
    readable(await embed('s-private', { cookie: invited, page: 'page-written' }), 'a page written on the new paths');
  });

  await t('the reader must be able to read the page, and the shell must name it', async () => {
    refused(await embed('s-public', { page: 'page-private' }), 'anonymous, private page');
    readable(await embed('s-public', { cookie: owner.cookie, page: 'page-private' }), 'owner, own private page');
    assert((await embed('s-public', { page: '' })).status === 400, 'no page');
    assert((await embed('s-public', { page: '..%2Fx' })).status === 400, 'bad page');
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
    const tab = await worker.fetch(req('/api/embed/sheet?page=page-owner&pv=1&slug=s-public&tab=Nope', { headers: { 'Sec-Fetch-Site': 'same-origin' } }), env, {});
    const tb = await tab.json();
    assert(tab.status === 404 && tb.error === 'no_tab' && tb.tabs.join() === 'Deals,Contacts', JSON.stringify(tb));
    const tabPrivate = await worker.fetch(req('/api/embed/sheet?page=page-owner&pv=1&slug=s-private&tab=Nope', { cookie: stranger, headers: { 'Sec-Fetch-Site': 'same-origin' } }), env, {});
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
