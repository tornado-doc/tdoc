// My docs rows (step 1 of the /me redesign): each row says what it is (doc /
// sheet / slides), who can open it, and what is unread on it; Recent and
// Starred say when; the setup checklist only on Docs while there are fewer
// than three docs. The words come from shell/src/docs-hub/row-meta.js; the
// fields from /api/me, driven through worker.js with fake bindings. The
// activity is read from the person's own records once per load -- never a
// comment or read-state read per row.
// Run with: node test/me-rows.test.js

const fs = require('fs');
const path = require('path');
const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const SHEET = '<h1>Budget</h1><table data-tdoc-sheet data-name="Costs"><thead><tr><th data-key="a">Item</th></tr></thead><tbody><tr data-row="1"><td>Rent</td></tr></tbody></table>';
const DECK = '<section class="slide" data-tdoc-slide><h1>Launch</h1></section><section class="slide" data-tdoc-slide><p>Two</p></section>';
const PROSE = '<h1>Plan</h1><p>A sentence to comment on.</p>';
// A prose doc that holds sheet tables (Julie's ji.market doc,
// raftbench-runs-and-plan): a doc, not a sheet [the bug].
const PROSE_WITH_SHEET = `<h1>Runs and plan</h1><p>What we ran, and what is next.</p>${SHEET.replace('<h1>Budget</h1>', '')}<h2>Next</h2><p>More prose.</p>`;

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../shell/src/docs-hub/row-meta.js'), 'utf8');
  const m = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

  console.log('My docs rows: words');
  const now = Date.parse('2026-11-10T12:00:00Z');
  const before = (s) => new Date(now - s * 1000).toISOString();

  await t('relative dates: just now, minutes, hours, days, then the date', async () => {
    eq(m.relativeTime(before(20), now), 'just now');
    eq(m.relativeTime(before(5 * 60), now), '5m ago');
    eq(m.relativeTime(before(3 * 3600), now), '3h ago');
    eq(m.relativeTime(before(2 * 86400), now), '2d ago');
    eq(m.relativeTime('2026-10-01T09:00:00Z', now), 'Oct 1');
    eq(m.relativeTime('2025-03-04T09:00:00Z', now), 'Mar 4, 2025');
    // A clock a little ahead is not "in 3 minutes".
    eq(m.relativeTime(new Date(now + 90e3).toISOString(), now), 'just now');
  });

  await t('Recent / Starred: "visited 3h ago", and never a bare "visited" [the bug]', async () => {
    eq(m.datedLabel('visited', before(3 * 3600), now), 'visited 3h ago');
    eq(m.datedLabel('starred', before(2 * 86400), now), 'starred 2d ago');
    for (const missing of [undefined, null, '', 'not a date']) eq(m.datedLabel('visited', missing, now), '', `for ${missing}`);
    assert(m.absoluteTime('2026-11-08T09:05:00Z').includes('2026'), 'the hover title names the full date');
  });

  await t('type: doc, sheet or slides, with a label', async () => {
    eq(['doc', 'sheet', 'slides', undefined, 'feedback'].map((doc_type) => m.docTypeLabel(m.docTypeOf({ doc_type }))), ['Doc', 'Sheet', 'Slides', 'Doc', 'Doc']);
  });

  await t('sharing: only you / N people / team / link / public; nothing for somebody else\'s doc', async () => {
    eq(m.sharingText({ sharing: 'private' }).short, 'Only you');
    eq(m.sharingText({ sharing: 'people', shared_with: 1 }).short, '1 person');
    eq(m.sharingText({ sharing: 'people', shared_with: 3 }).short, '3 people');
    eq(m.sharingText({ sharing: 'team' }).short, 'Team');
    eq(m.sharingText({ sharing: 'team', shared_with: 2 }).short, 'Team + 2 people');
    eq(m.sharingText({ sharing: 'link' }).short, 'Link');
    assert(/anyone with the link/i.test(m.sharingText({ sharing: 'link' }).long), 'link spelled out for the label');
    eq(m.sharingText({ sharing: 'public' }).short, 'Public');
    eq(m.sharingText({}), null);
    eq(m.sharingText({ sharing: 'something-else' }), null);
  });

  await t('activity: unread comments and agent replies, or nothing', async () => {
    eq(m.activityText({}), null);
    eq(m.activityText({ activity: { comments: 0, agent: 0 } }), null);
    eq(m.activityText({ activity: { comments: 2 } }).label, '2 new comments');
    eq(m.activityText({ activity: { comments: 1, agent: 1 } }).label, '1 new comment · 1 agent reply');
    eq(m.activityText({ activity: { comments: 1, agent: 2 } }).total, 3);
    eq(m.activityText({ activity: { agent: 3 } }).label, '3 agent replies');
  });

  await t('setup checklist: Docs tab only, and only below three docs', async () => {
    for (const view of ['recent', 'starred', 'comments', 'trash', 'settings']) {
      eq(m.onboardingChecklistShown({ view, docCount: 0 }), false, `shown on ${view}`);
    }
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 0 }), true);
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 2 }), true);
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 3 }), false);
    eq(m.onboardingChecklistShown({ view: 'docs', docCount: 24 }), false);
    eq(m.ONBOARDING_MAX_DOCS, 3);
  });

  await t('the hub mounts the checklist through that rule, not on every tab', async () => {
    const hub = fs.readFileSync(path.join(__dirname, '../shell/src/docs-hub.jsx'), 'utf8');
    const mounts = hub.match(/<OnboardingChecklist\b/g) || [];
    eq(mounts.length, 1, 'one mount');
    assert(/onboardingChecklistShown\(\{ view, docCount: hub\.docs\.length \}\) \? <OnboardingChecklist/.test(hub), 'mount is not gated by onboardingChecklistShown');
  });

  console.log('My docs rows: /api/me fields');
  const mod = await loadWorker();
  const worker = mod.default;
  const call = async (env, pathname, opts = {}, ctx = {}) => {
    const r = await worker.fetch(req(pathname, opts), env, ctx);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };

  async function seed() {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const owner = await putSession(env, 'owner');
    for (const [slug, html] of [['q-sheet', SHEET], ['q-deck', DECK], ['q-doc', PROSE], ['q-private', PROSE], ['q-mixed', PROSE_WITH_SHEET]]) {
      const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug, version: 1, html } });
      assert(up.status === 200, `upload ${slug}: ${up.status} ${up.text}`);
    }
    const access = async (slug, patch) => {
      const r = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner, body: { slug, access: patch } });
      assert(r.status === 200, `access ${slug}: ${r.status} ${r.text}`);
    };
    await access('q-sheet', { visibility: 'private', allowed_users: ['bob'] });
    await access('q-deck', { visibility: 'public' });
    await access('q-doc', { visibility: 'unlisted' });
    await access('q-private', { visibility: 'private' });
    // Somebody else's doc, opened and starred by owner.
    const bobTok = await issue(worker, env, 'bob');
    const bobUp = await call(env, '/api/upload', { method: 'POST', token: bobTok.token, body: { slug: 'bobs-doc', version: 1, html: PROSE } });
    assert(bobUp.status === 200, `bob upload ${bobUp.status}`);
    await env.META.put('recents:owner', JSON.stringify({ items: [{ slug: 'bobs-doc', at: '2026-11-09T08:00:00.000Z' }, { slug: 'q-doc', at: '2026-11-08T08:00:00.000Z' }] }));
    await env.META.put('stars:owner', JSON.stringify({ items: [{ slug: 'q-deck', at: '2026-11-07T08:00:00.000Z' }] }));
    return { env, token: tok.token, owner };
  }
  const me = async (env, cookie, ctx) => (await call(env, '/api/me', { cookie }, ctx)).body;
  const row = (list, slug) => (list || []).find((r) => r.slug === slug);

  const fixture = await seed();

  await t('publishing stamps the type on the meta, with the rule\'s version: sheet, slides, doc', async () => {
    const kinds = {};
    for (const slug of ['q-sheet', 'q-deck', 'q-doc', 'q-mixed']) {
      const { preview } = JSON.parse(await fixture.env.META.get(`meta:${slug}`));
      kinds[slug] = `${preview.kind}@${preview.kind_v}`;
    }
    eq(kinds, { 'q-sheet': 'sheet@2', 'q-deck': 'slides@2', 'q-doc': 'doc@2', 'q-mixed': 'doc@2' });
  });

  await t('rows carry doc_type and, on your own docs, the sharing state', async () => {
    const data = await me(fixture.env, fixture.owner);
    const pick = (slug) => { const r = row(data.docs, slug); return [r.doc_type, r.sharing, r.shared_with]; };
    eq(pick('q-sheet'), ['sheet', 'people', 1]);
    eq(pick('q-deck'), ['slides', 'public', undefined]);
    eq(pick('q-doc'), ['doc', 'link', undefined]);
    eq(pick('q-private'), ['doc', 'private', undefined]);
    eq(row(data.docs, 'q-mixed').doc_type, 'doc', 'prose holding a sheet table is a doc');
    // Pinning still learns the visibility from the same row.
    eq(row(data.docs, 'q-sheet').visibility, 'private');
  });

  await t('Recent and Starred rows keep their date (publicRow used to drop it) [the bug]', async () => {
    const data = await me(fixture.env, fixture.owner);
    eq(row(data.recent, 'bobs-doc').at, '2026-11-09T08:00:00.000Z');
    eq(row(data.recent, 'q-doc').at, '2026-11-08T08:00:00.000Z');
    eq(row(data.starred, 'q-deck').at, '2026-11-07T08:00:00.000Z');
  });

  await t('somebody else\'s doc says nothing about who it is shared with', async () => {
    const data = await me(fixture.env, fixture.owner);
    const bobs = row(data.recent, 'bobs-doc');
    assert(bobs && !('sharing' in bobs) && !('shared_with' in bobs) && !('visibility' in bobs), `leaked: ${JSON.stringify(bobs)}`);
    eq(row(data.recent, 'q-doc').sharing, 'link', 'your own doc in Recent says it');
  });

  await t('unread comments on a row come from the bell; reading them in the bell clears the row', async () => {
    const { env, owner } = fixture;
    const reader = await putSession(env, 'reader');
    const c = await call(env, '/api/comments', { method: 'POST', cookie: reader, body: { slug: 'q-doc', version: 1, text: 'is this final?', anchor: { kind: 'text', text: 'A sentence' } } });
    assert(c.status === 200, `comment ${c.status} ${c.text}`);
    let data = await me(env, owner);
    eq(row(data.docs, 'q-doc').activity, { comments: 1, agent: 0 });
    eq(row(data.recent, 'q-doc').activity, { comments: 1, agent: 0 }, 'the same doc in Recent');
    assert(!('activity' in row(data.docs, 'q-deck')), 'a quiet doc has no activity field');
    const read = await call(env, '/api/notifications/read', { method: 'POST', cookie: owner, body: { all: true } });
    assert(read.status === 200, `read ${read.status}`);
    data = await me(env, owner);
    assert(!('activity' in row(data.docs, 'q-doc')), `still unread: ${JSON.stringify(row(data.docs, 'q-doc'))}`);
  });

  await t('an agent reply to your comment shows on the row until you open the thread (thread-seen)', async () => {
    const { env, owner, token } = fixture;
    const c = await call(env, '/api/comments', { method: 'POST', cookie: owner, body: { slug: 'q-deck', version: 1, text: 'tighten slide two', anchor: { kind: 'text', text: 'Two' } } });
    assert(c.status === 200, `comment ${c.status} ${c.text}`);
    const reply = await call(env, '/api/agent/reply', { method: 'POST', token, body: { slug: 'q-deck', parent_id: c.body.id, text: 'Which part?', status: 'question', agent_login: 'claude' } });
    assert(reply.status === 200 && reply.body.id, `reply ${reply.status} ${reply.text}`);
    let data = await me(env, owner);
    eq(row(data.docs, 'q-deck').activity, { comments: 0, agent: 1 });
    eq(row(data.starred, 'q-deck').activity, { comments: 0, agent: 1 }, 'the same doc in Starred');
    // An older mark does not clear it.
    const stamp = Date.parse(reply.body.created);
    await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-deck', seen: { [c.body.id]: stamp - 1000 } } });
    eq(row((await me(env, owner)).docs, 'q-deck').activity, { comments: 0, agent: 1 }, 'cleared by an older mark');
    // Opening the thread marks it seen up to the reply: the row goes quiet.
    const seen = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-deck', seen: { [c.body.id]: stamp } } });
    assert(seen.status === 200, `seen ${seen.status} ${seen.text}`);
    data = await me(env, owner);
    assert(!('activity' in row(data.docs, 'q-deck')), `still unread: ${JSON.stringify(row(data.docs, 'q-deck'))}`);
    eq(await env.META.get('agent-unread:owner'), null, 'the empty record is removed');
  });

  await t('a thread already seen on another device clears the row on the next mark', async () => {
    const { env, owner, token } = fixture;
    const c = await call(env, '/api/comments', { method: 'POST', cookie: owner, body: { slug: 'q-doc', version: 1, text: 'second thought', anchor: { kind: 'text', text: 'A sentence' } } });
    const reply = await call(env, '/api/agent/reply', { method: 'POST', token, body: { slug: 'q-doc', parent_id: c.body.id, text: 'Done.', status: 'answered', agent_login: 'claude' } });
    assert(reply.status === 200, `reply ${reply.status}`);
    const stamp = Date.parse(reply.body.created);
    // The server already holds the mark (made on another device), and the
    // note lands after it -- it is written after the reply, off the request.
    const first = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-doc', seen: { [c.body.id]: stamp } } });
    assert(first.status === 200 && first.body.seen[c.body.id] === stamp, `first mark ${first.status} ${first.text}`);
    await env.META.put('agent-unread:owner', JSON.stringify({ items: [{ slug: 'q-doc', thread: c.body.id, at: reply.body.created }] }));
    eq(row((await me(env, owner)).docs, 'q-doc').activity, { comments: 0, agent: 1 });
    const again = await call(env, '/api/comments/seen', { method: 'POST', cookie: owner, body: { slug: 'q-doc', seen: { [c.body.id]: stamp } } });
    assert(again.status === 200, `seen ${again.status} ${again.text}`);
    assert(!('activity' in row((await me(env, owner)).docs, 'q-doc')), 'not cleared by a mark the server already had');
  });

  await t('no per-row reads: one inbox and one agent record per load, never a read-state key', async () => {
    const { env, owner } = fixture;
    env.META.gets.length = 0;
    await me(env, owner);
    const gets = env.META.gets;
    eq(gets.filter((k) => k.startsWith('thread-seen:')).length, 0, 'read-state reads');
    eq(gets.filter((k) => k.startsWith('inbox:')).length, 1, 'inbox reads');
    eq(gets.filter((k) => k.startsWith('agent-unread:')).length, 1, 'agent record reads');
    // Search and the Feedback tab show no badges and pay nothing for them.
    env.META.gets.length = 0;
    await call(env, '/api/me/feedback', { cookie: owner });
    eq(env.META.gets.filter((k) => k.startsWith('inbox:') || k.startsWith('agent-unread:')).length, 0, '/api/me/feedback read the activity');
  });

  await t('docs published before the type was stamped: typed from the viewer\'s own record, the doc\'s meta never written by a GET', async () => {
    const { env, owner } = fixture;
    for (const slug of ['q-sheet', 'q-deck']) {
      const meta = JSON.parse(await env.META.get(`meta:${slug}`));
      delete meta.preview.kind;
      await env.META.put(`meta:${slug}`, JSON.stringify(meta));
    }
    const metaBefore = { 'q-sheet': await env.META.get('meta:q-sheet'), 'q-deck': await env.META.get('meta:q-deck') };
    const writes = [];
    const put = env.META.put.bind(env.META);
    env.META.put = async (k, v, o) => { writes.push(k); return put(k, v, o); };
    try {
      const waits = [];
      const first = await me(env, owner, { waitUntil: (p) => waits.push(p) });
      eq(row(first.docs, 'q-sheet').doc_type, 'doc', 'unknown reads as a doc until filled');
      await Promise.all(waits);
      const second = await me(env, owner, { waitUntil: (p) => waits.push(p) });
      eq([row(second.docs, 'q-sheet').doc_type, row(second.docs, 'q-deck').doc_type], ['sheet', 'slides']);
      eq(row(second.starred, 'q-deck').doc_type, 'slides', 'Starred reads the same record');
    } finally {
      env.META.put = put;
    }
    eq(writes.filter((k) => k.startsWith('meta:')), [], 'a hub load wrote doc meta');
    eq(await env.META.get('meta:q-sheet'), metaBefore['q-sheet'], 'q-sheet meta changed');
    eq(await env.META.get('meta:q-deck'), metaBefore['q-deck'], 'q-deck meta changed');
    const cache = JSON.parse(await env.META.get('doc-types:owner'));
    eq([cache.t['q-sheet'], cache.t['q-deck']], [{ v: 2, kind: 'sheet' }, { v: 2, kind: 'slides' }]);
  });

  await t('old-rule (v1) types: "doc" and "slides" are trusted, a v1 "sheet" is ignored and detected again; GET never writes meta', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'owner');
    const owner = await putSession(env, 'owner');
    const docs = [
      ['m-stamped', PROSE_WITH_SHEET], ['m-cached', PROSE_WITH_SHEET], ['m-sheet', SHEET],
      ['m-v1-deck', DECK], ['m-v1-doc', PROSE], ['m-c-deck', DECK], ['m-c-doc', PROSE],
    ];
    for (const [slug, html] of docs) {
      const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug, version: 1, html } });
      assert(up.status === 200, `upload ${slug}: ${up.status} ${up.text}`);
    }
    // What v1 left behind: stamps without kind_v on the meta, and bare-string
    // answers in the viewer's record.
    const restamp = async (slug, kind) => {
      const meta = JSON.parse(await env.META.get(`meta:${slug}`));
      if (kind) meta.preview.kind = kind; else delete meta.preview.kind;
      delete meta.preview.kind_v;
      await env.META.put(`meta:${slug}`, JSON.stringify(meta));
    };
    await restamp('m-stamped', 'sheet');
    await restamp('m-v1-deck', 'slides');
    await restamp('m-v1-doc', 'doc');
    for (const slug of ['m-cached', 'm-c-deck', 'm-c-doc']) await restamp(slug, null);
    await env.META.put('doc-types:owner', JSON.stringify({ t: { 'm-cached': 'sheet', 'm-stamped': 'sheet', 'm-c-deck': 'slides', 'm-c-doc': 'doc' }, f: {} }));
    const metaBefore = await env.META.get('meta:m-stamped');
    const writes = [];
    const reads = [];
    const put = env.META.put.bind(env.META);
    const get = env.DOCS.get.bind(env.DOCS);
    env.META.put = async (k, v, o) => { writes.push(k); return put(k, v, o); };
    env.DOCS.get = async (k, o) => { reads.push(k); return get(k, o); };
    try {
      const waits = [];
      const first = await me(env, owner, { waitUntil: (p) => waits.push(p) });
      const types = (list, slugs) => slugs.map((slug) => row(list, slug).doc_type);
      eq(types(first.docs, ['m-stamped', 'm-cached']), ['doc', 'doc'], 'an old "sheet" is not shown');
      eq(row(first.docs, 'm-sheet').doc_type, 'sheet', 'a current stamp is');
      eq(types(first.docs, ['m-v1-deck', 'm-v1-doc', 'm-c-deck', 'm-c-doc']), ['slides', 'doc', 'slides', 'doc'], 'old doc / slides are trusted at once');
      await Promise.all(waits);
      eq([...new Set(reads.map((k) => k.split('/')[1]))].sort(), ['m-cached', 'm-stamped'], 'only the old sheets are read again');
      const cache = JSON.parse(await env.META.get('doc-types:owner'));
      eq([cache.t['m-stamped'], cache.t['m-cached']], [{ v: 2, kind: 'doc' }, { v: 2, kind: 'doc' }], 'detected again');
      eq([cache.t['m-c-deck'], cache.t['m-c-doc']], [{ v: 2, kind: 'slides' }, { v: 2, kind: 'doc' }], 'trusted answers kept');
      const second = await me(env, owner, { waitUntil: (p) => waits.push(p) });
      eq(types(second.docs, ['m-stamped', 'm-cached', 'm-c-deck', 'm-c-doc']), ['doc', 'doc', 'slides', 'doc']);
    } finally {
      env.META.put = put;
      env.DOCS.get = get;
    }
    eq(writes.filter((k) => k.startsWith('meta:')), [], 'a hub load wrote doc meta');
    eq(await env.META.get('meta:m-stamped'), metaBefore, 'meta changed on GET');
    // The next publish stamps the meta itself, with this version.
    const up = await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug: 'm-stamped', version: 2, html: PROSE_WITH_SHEET } });
    assert(up.status === 200, `republish: ${up.status} ${up.text}`);
    const { preview } = JSON.parse(await env.META.get('meta:m-stamped'));
    eq([preview.kind, preview.kind_v], ['doc', 2]);
    // A cached answer of a future version is not trusted either.
    await env.META.put('doc-types:owner', JSON.stringify({ t: { 'm-cached': { v: 3, kind: 'sheet' } }, f: {} }));
    eq(row((await me(env, owner)).docs, 'm-cached').doc_type, 'doc');
  });

  await t('a doc whose version cannot be read is marked and left alone for a day', async () => {
    const { env, owner } = fixture;
    const meta = JSON.parse(await env.META.get('meta:q-private'));
    delete meta.preview.kind;
    await env.META.put('meta:q-private', JSON.stringify(meta));
    const key = `docs/q-private/v${meta.versions[meta.versions.length - 1].n}/index.html`;
    const html = await env.DOCS.get(key);
    const saved = html && await html.text();
    await env.DOCS.delete(key);
    try {
      const waits = [];
      await me(env, owner, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
      const cache = JSON.parse(await env.META.get('doc-types:owner'));
      assert(cache.f['q-private'] > 0 && !('q-private' in cache.t), `no failure marker: ${JSON.stringify(cache)}`);
      // The next load does not try it again.
      const reads = [];
      const get = env.DOCS.get.bind(env.DOCS);
      env.DOCS.get = async (k, o) => { reads.push(k); return get(k, o); };
      const again = [];
      await me(env, owner, { waitUntil: (p) => again.push(p) });
      await Promise.all(again);
      env.DOCS.get = get;
      eq(reads.filter((k) => k.startsWith('docs/q-private/')), [], 'retried within the day');
    } finally {
      if (saved) await env.DOCS.put(key, saved);
    }
  });

  await t('type detection is linear: 2 MB of hostile markup in well under 50 ms, and still right', async () => {
    // The worker inlines shared/doc-type.mjs as code; it is tested here as is.
    const { docTypeFromHtml, SHEET_ONLY_SKIP_SELECTOR, SHEET_ONLY_MEDIA_SELECTOR } = await import(path.join(__dirname, '../shared/doc-type.mjs'));
    const workerSrc = fs.readFileSync(path.join(__dirname, '../worker/worker.js'), 'utf8');
    assert(workerSrc.includes('/* __TDOC_DOC_TYPE__ */') && !/function docTypeFromHtml\(/.test(workerSrc), 'the worker has its own copy of the rule');
    eq(docTypeFromHtml(SHEET), 'sheet');
    eq(docTypeFromHtml(DECK), 'slides');
    eq(docTypeFromHtml(PROSE), 'doc');
    eq(docTypeFromHtml('<TABLE\nclass="x" data-tdoc-sheet>'), 'sheet', 'case and newlines');
    eq(docTypeFromHtml('<div data-tdoc-sheet>'), 'doc', 'a sheet is a table');
    eq(docTypeFromHtml('<p>write data-tdoc-slide on a section</p>'), 'doc', 'text, not a tag');
    eq(docTypeFromHtml('<html data-tdoc-slides><p>x</p>'), 'doc', 'data-tdoc-slides is not data-tdoc-slide');
    eq(docTypeFromHtml('<section xdata-tdoc-slide>'), 'doc', 'part of another name');
    eq(docTypeFromHtml('<section class="a" data-tdoc-slide="s1">'), 'slides');
    // Sheet only when the doc is a pure sheet (the sheets viewer's sheet-only doc).
    eq(docTypeFromHtml(PROSE_WITH_SHEET), 'doc', 'prose with embedded sheet tables');
    eq(docTypeFromHtml(SHEET.replace('</table>', '</table><p>Notes below.</p>')), 'doc', 'prose after the table');
    eq(docTypeFromHtml(SHEET + '<img src="x.png">'), 'doc', 'a picture is more than a sheet');
    eq(docTypeFromHtml('<!doctype html><html><head><meta charset="utf-8"><title>Budget</title><style>p{}</style><script>if (a < b) go("<p>")</script></head>'
      + '<body>\n<h1>Budget</h1>\n<p class="lede sheet-note">A note.</p><!-- prose? no -->' + SHEET.replace('<h1>Budget</h1>', '') + '&nbsp;<div data-tdoc-provider>chrome</div></body></html>'), 'sheet', 'a whole sheet document: title, note, tables');
    eq(docTypeFromHtml('<h1>Two</h1>' + SHEET.replace('<h1>Budget</h1>', '').repeat(2)), 'sheet', 'several tables');
    eq(docTypeFromHtml('<table data-tdoc-sheet><tr><td><table><tr><td>x</td></tr></table>y</td></tr></table><p>after</p>'), 'doc', 'nesting counted');
    const { sheetDocumentHtml, blankSheetHtml } = await import(path.join(__dirname, '../shared/sheet-markup.mjs'));
    eq(docTypeFromHtml(blankSheetHtml()), 'sheet', 'a new blank sheet');
    eq(docTypeFromHtml(sheetDocumentHtml({ title: 'Import', note: 'From a CSV', sheets: [{ name: 'A', columns: [{ key: 'a', name: 'A' }], rows: [{ cells: ['1'] }] }] })), 'sheet', 'an imported sheet');
    // Slides: any slide section makes a deck, prose around it or not.
    eq(docTypeFromHtml('<h1>Talk</h1><p>Intro prose.</p>' + DECK + '<p>Closing prose.</p>'), 'slides', 'a doc with slide sections');
    eq(docTypeFromHtml(DECK.replace('<p>Two</p>', SHEET)), 'slides', 'a deck whose slide holds a sheet');
    // The viewer's selectors are built from the same rule.
    eq(SHEET_ONLY_SKIP_SELECTOR, 'table[data-tdoc-sheet],[data-tdoc-provider],script,style,noscript,template,h1,caption,.sheet-note');
    eq(SHEET_ONLY_MEDIA_SELECTOR, 'img,svg,video,canvas,iframe,figure');
    const viewer = fs.readFileSync(path.join(__dirname, '../server/sheets-viewer.js'), 'utf8');
    assert(viewer.includes('DocType.SHEET_ONLY_SKIP_SELECTOR') && viewer.includes('DocType.SHEET_ONLY_MEDIA_SELECTOR'), 'the viewer has its own sheet-only rule');
    const MB2 = 2 * 1024 * 1024;
    const fill = (unit) => unit.repeat(Math.ceil(MB2 / unit.length)).slice(0, MB2);
    const hostile = [
      '<div ' + fill('xdata-tdoc-slide'),
      '<' + fill('a') + ' data-tdoc-slide',
      fill('data-tdoc-sheet '),
      fill(' data-tdoc-slide'),
      fill('<table data-tdoc-sheetx'),
      '<table' + fill(' a') + ' data-tdoc-sheetx',
      fill('<a' + 'b'.repeat(60) + ' data-tdoc-slidez'),
      // The sheet-only walk: tags, attributes, quotes, comments, raw text.
      fill('<table data-tdoc-sheet>'),
      '<h1 class="' + fill('sheet-note '),
      '<table data-tdoc-sheet title="' + fill('<'),
      fill('<script>'),
      fill('<!--'),
      '<table data-tdoc-sheet>' + fill('<td a=b c="d" e>'),
      '<h1>' + fill('&nbsp;'),
      // ...and with a sheet table, so the walk runs to the end.
      '<table data-tdoc-sheet></table>' + fill('<div>'),
      '<table data-tdoc-sheet></table>' + fill('<h1></h1>'),
      '<table data-tdoc-sheet></table>' + fill('<div a=b c="d" e>'),
      '<table data-tdoc-sheet></table>' + fill('<p class="x y sheet-notex">'),
      '<table data-tdoc-sheet></table>' + fill('<script></script>'),
      fill('<table data-tdoc-sheet></table>'),
      '<table data-tdoc-sheet>' + fill('<table x>'),
    ];
    // The best of three runs: the scan, not a JIT warm-up or a GC pause
    // (test/sheets-size.test.js does the same); a quadratic one takes seconds.
    for (const html of hostile) {
      let ms = Infinity;
      for (let k = 0; k < 3; k++) {
        const started = process.hrtime.bigint();
        docTypeFromHtml(html);
        ms = Math.min(ms, Number(process.hrtime.bigint() - started) / 1e6);
      }
      assert(ms < 50, `${ms.toFixed(1)} ms on ${JSON.stringify(html.slice(0, 40))}…`);
    }
  });

  await t('sharing on Recent / Starred follows who manages the doc: a team admin sees it, a member does not', async () => {
    const env = makeEnv(mod.CommentsStore);
    const ORIGIN = { Origin: 'https://tdoc.dev' };
    const ann = await issue(worker, env, 'ann');
    const ben = await issue(worker, env, 'ben');
    const team = (await call(env, '/api/teams', { method: 'POST', cookie: ann.cookie, headers: ORIGIN, body: { name: 'Acme' } })).body.team;
    const joined = await call(env, '/api/team/join', { method: 'POST', cookie: ben.cookie, body: { token: team.invite_url.split('/').pop() } });
    assert(joined.status === 200, `join: ${joined.text}`);
    // Ben writes the doc; Ann runs the team.
    const up = await call(env, '/api/upload', { method: 'POST', token: ben.token, body: { slug: 'team-plan', version: 1, html: PROSE } });
    assert(up.status === 200, `upload ${up.text}`);
    const moved = await call(env, '/api/team/move', { method: 'POST', cookie: ben.cookie, headers: ORIGIN, body: { team: team.id, slugs: ['team-plan'] } });
    assert(moved.status === 200, `move ${moved.text}`);
    for (const who of ['ann', 'ben']) await env.META.put(`recents:${who}`, JSON.stringify({ items: [{ slug: 'team-plan', at: '2026-11-09T08:00:00.000Z' }] }));
    const annRow = row((await me(env, ann.cookie)).recent, 'team-plan');
    const benRow = row((await me(env, ben.cookie)).recent, 'team-plan');
    assert(annRow && typeof annRow.sharing === 'string', `admin sees no sharing: ${JSON.stringify(annRow)}`);
    assert(benRow && !('sharing' in benRow) && !('shared_with' in benRow), `member sees sharing: ${JSON.stringify(benRow)}`);
  });

  await t('an agent reply is noted for the last person who spoke in the thread, never an imported or unattested author', async () => {
    const { env, owner, token } = fixture;
    // Owner opens the thread, a signed-in reader (with an account) replies:
    // the reader is the one waiting.
    const reader = await issue(worker, env, 'reader2');
    const c = await call(env, '/api/comments', { method: 'POST', cookie: owner, body: { slug: 'q-doc', version: 1, text: 'first', anchor: { kind: 'text', text: 'A sentence' } } });
    const r = await call(env, '/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug: 'q-doc', version: 1, parent_id: c.body.id, text: 'agent, please check' } });
    assert(r.status === 200, `reply ${r.status} ${r.text}`);
    await env.META.delete('agent-unread:owner');
    const a = await call(env, '/api/agent/reply', { method: 'POST', token, body: { slug: 'q-doc', parent_id: c.body.id, text: 'Checked.', status: 'answered', agent_login: 'claude' } });
    assert(a.status === 200 && a.body.id, `agent reply ${a.text}`);
    const readerNote = JSON.parse(await env.META.get('agent-unread:reader2') || '{"items":[]}');
    eq(readerNote.items.map((i) => i.thread), [c.body.id], 'the last speaker');
    eq(await env.META.get('agent-unread:owner'), null, 'the thread opener was noted instead');

    // A thread whose only human author was carried in by an import, or has
    // no account or GitHub id behind the name, notes nobody.
    const recipient = (() => {
      const workerSrc = fs.readFileSync(path.join(__dirname, '../worker/worker.js'), 'utf8');
      const grab = (header) => {
        const at = workerSrc.indexOf(header);
        // The body's brace: after the parameter list, which may hold braces.
        let j = workerSrc.indexOf(') {', at) + 2, d = 0;
        for (; j < workerSrc.length; j++) {
          if (workerSrc[j] === '{') d++;
          else if (workerSrc[j] === '}') { d--; if (d === 0) { j++; break; } }
        }
        return workerSrc.slice(at, j);
      };
      return new Function(`const snapshotAt = (r) => r; const normalizeActorKey = (k) => String(k || '').toLowerCase() || null;
        ${grab('function isNonHumanAuthor(')}\n${grab('function agentReplyRecipient(')}\nreturn agentReplyRecipient;`)();
    })();
    const human = (login, extra = {}) => ({ kind: 'human', login, account_id: `acct-${login}`, ...extra });
    const thread = (author, replies = []) => ({ root: { id: 'c_1', author, created: '2026-11-01T00:00:00Z', replies } });
    eq(recipient(thread(human('ann'))), 'ann');
    eq(recipient(thread(human('ann'), [{ author: human('bob'), created: '2026-11-02T00:00:00Z' }])), 'bob');
    eq(recipient(thread(human('ann'), [{ author: { kind: 'agent', login: 'claude' }, created: '2026-11-03T00:00:00Z' }])), 'ann', 'an agent is not waiting');
    eq(recipient(thread(human('ann', { imported: true }))), '', 'imported author');
    eq(recipient(thread({ kind: 'human', login: 'ann' })), '', 'no account or GitHub id');
    eq(recipient(thread({ kind: 'human', login: 'ann', github_id: '42' })), 'ann', 'a GitHub id is enough');
    eq(recipient(thread(human('ann'), [{ author: human('bob'), created: '2026-11-02T00:00:00Z', deleted: true }])), 'ann', 'a deleted reply');
    eq(recipient(thread(human('ann'), [{ author: human('bob'), created: '2026-11-02T00:00:00Z' }]), { skip: ['bob'] }), 'ann', 'skip whoever acted');
  });

  await t('agent-reply notes are rate limited per person', async () => {
    const env = makeEnv(mod.CommentsStore);
    const tok = await issue(worker, env, 'rl-owner');
    await call(env, '/api/upload', { method: 'POST', token: tok.token, body: { slug: 'rl-doc', version: 1, html: PROSE } });
    const windowId = Math.floor(Date.now() / 3600e3);
    await env.META.put(`rl:agent-unread:rl-owner:${windowId}`, '60');
    const c = await call(env, '/api/comments', { method: 'POST', cookie: tok.cookie, body: { slug: 'rl-doc', version: 1, text: 'please', anchor: { kind: 'text', text: 'A sentence' } } });
    const a = await call(env, '/api/agent/reply', { method: 'POST', token: tok.token, body: { slug: 'rl-doc', parent_id: c.body.id, text: 'ok', status: 'answered', agent_login: 'claude' } });
    assert(a.status === 200 && a.body.id, `the reply itself must land: ${a.text}`);
    eq(await env.META.get('agent-unread:rl-owner'), null, 'noted past the limit');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
